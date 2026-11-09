//! JSON-RPC and the request checks for the MCP server (C1, C2), ported in
//! behaviour from vendor `src/llm/mcpServer.ts` (`handle`,
//! `buildInitializeResult`, `isAllowedOrigin`, `timingSafeEqual`,
//! `isAuthorized`). Rust answers `initialize`, `ping` and `tools/list` itself;
//! `tools/call` goes to the webview through a [`Bridge`] (C3).

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use subtle::ConstantTimeEq;

/// The MCP revision served (vendor `MCP_PROTOCOL_VERSION`).
pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// One entry of the tool catalog the webview hands over on start. Not secret.
/// `mutates` stays in Rust: `tools/list` never shows it.
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub mutates: bool,
}

/// How a forwarded `tools/call` ended.
#[derive(Debug)]
pub enum CallOutcome {
    /// The `CallToolResult`, answered as the JSON-RPC `result`.
    Result(Value),
    /// A JSON-RPC error `{code, message}`.
    RpcError(i64, String),
    /// Nothing is answered: the connection is closed without a response.
    NoReply,
}

/// Where `tools/call` goes (the webview, Task 34).
pub trait Bridge: Send + Sync + 'static {
    fn call(&self, name: String, args: Value, mutates: bool) -> BoxFuture<'static, CallOutcome>;
}

/// What the HTTP layer sends for one JSON-RPC message.
#[derive(Debug)]
pub enum Reply {
    /// A JSON body with this HTTP status.
    Json(u16, Value),
    /// A notification: 202 and an empty body.
    Accepted,
    /// Close the connection without a response.
    NoReply,
}

/// The `InitializeResult` (vendor `buildInitializeResult`). `capabilities`
/// advertises only what is served: a fixed tool list (`listChanged: false`),
/// no resources, no prompts, no sampling.
pub fn initialize_result(version: &str) -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "labnoteo", "version": version },
    })
}

/// Whether a request's `Origin` may proceed (vendor `isAllowedOrigin`). The MCP
/// spec requires this against DNS rebinding: a page on `evil.com` can resolve
/// a name to 127.0.0.1, but it cannot forge the `Origin` its browser attaches.
///
/// - An absent or empty header means the caller is not a browser (an MCP
///   client, curl): allowed, as in the plugin.
/// - Otherwise the scheme must be `http` or `https` and the host exactly
///   `localhost`, `127.0.0.1` or `[::1]` (ASCII case-insensitive), with an
///   optional numeric port. A name that merely contains a loopback name
///   (`localhost.evil.com`, `127.0.0.1.evil.com`) is refused.
/// - Anything unparseable (`null`, `garbage`, `file://`) is refused instead of
///   waved through. Stricter than the plugin's WHATWG parse in two corners: a
///   userinfo part (`http://x@localhost`) and non-canonical spellings
///   (`http://127.1`, `[0:0::1]`) are refused; browsers never send either.
pub fn is_allowed_origin(origin: Option<&str>) -> bool {
    let origin = match origin {
        None | Some("") => return true,
        Some(o) => o,
    };
    let lower = origin.to_ascii_lowercase();
    let rest = match lower.strip_prefix("http://").or_else(|| lower.strip_prefix("https://")) {
        Some(r) => r,
        None => return false,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return false;
    }
    let (host, port) = if let Some(after) = authority.strip_prefix('[') {
        match after.split_once(']') {
            Some((inner, tail)) => (&authority[..inner.len() + 2], tail),
            None => return false,
        }
    } else {
        match authority.find(':') {
            Some(i) => (&authority[..i], &authority[i..]),
            None => (authority, ""),
        }
    };
    let port_ok = match port.strip_prefix(':') {
        None => port.is_empty(),
        Some("") => true,
        Some(p) => p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u16>().is_ok(),
    };
    port_ok && matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// Whether the `Host` header names this server: exactly `127.0.0.1:<port>` or
/// `localhost:<port>`, ASCII case-insensitive (C2). A DNS-rebinding page sends
/// its own name here even with a stolen token.
pub fn is_allowed_host(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else { return false };
    let Some((name, p)) = host.rsplit_once(':') else { return false };
    p == port.to_string() && (name.eq_ignore_ascii_case("127.0.0.1") || name.eq_ignore_ascii_case("localhost"))
}

/// Constant-time string compare (vendor `timingSafeEqual`): unequal lengths
/// return at once (the length is not secret), equal lengths compare every byte.
pub fn ct_str_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

/// Whether an `Authorization` header carries the current token (vendor
/// `isAuthorized`). No token set means no access.
pub fn is_authorized(header: Option<&str>, token: &str) -> bool {
    !token.is_empty() && ct_str_eq(header.unwrap_or(""), &format!("Bearer {token}"))
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// JS `String(v ?? '')` for the few shapes a client may send.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// One JSON-RPC message, after every HTTP check passed (vendor `handle` from
/// the body parse on).
pub async fn dispatch(body: &[u8], tools: &[ToolInfo], bridge: &dyn Bridge) -> Reply {
    let rpc: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return Reply::Json(400, rpc_error(Value::Null, -32700, "Parse error")),
    };
    // A batch or a bare value: the plugin threw here (`'id' in 5`); answer
    // JSON-RPC's Invalid Request instead (2025-06-18 has no batches).
    let Some(rpc): Option<&Map<String, Value>> = rpc.as_object() else {
        return Reply::Json(400, rpc_error(Value::Null, -32600, "Invalid Request"));
    };
    // No `id` member: a notification, which gets no body
    // (`notifications/initialized` closes the handshake this way).
    let Some(id) = rpc.get("id").cloned() else { return Reply::Accepted };
    let method = rpc.get("method");
    match method.and_then(Value::as_str) {
        Some("initialize") => Reply::Json(200, rpc_result(id, initialize_result(env!("CARGO_PKG_VERSION")))),
        Some("ping") => Reply::Json(200, rpc_result(id, json!({}))),
        Some("tools/list") => {
            let list: Vec<Value> = tools
                .iter()
                .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": t.input_schema }))
                .collect();
            Reply::Json(200, rpc_result(id, json!({ "tools": list })))
        }
        Some("tools/call") => {
            let params = rpc.get("params");
            let name = js_string(params.and_then(|p| p.get("name")));
            let args = match params.and_then(|p| p.get("arguments")) {
                None | Some(Value::Null) => json!({}),
                Some(a) => a.clone(),
            };
            // The tool itself declares whether it mutates; a name not in the
            // catalog goes as a read, and the webview answers it `isError`
            // (C3, plugin behaviour).
            let mutates = tools.iter().find(|t| t.name == name).is_some_and(|t| t.mutates);
            match bridge.call(name, args, mutates).await {
                CallOutcome::Result(r) => Reply::Json(200, rpc_result(id, r)),
                CallOutcome::RpcError(code, message) => Reply::Json(200, rpc_error(id, code, &message)),
                CallOutcome::NoReply => Reply::NoReply,
            }
        }
        _ => {
            let shown = match method {
                None => "undefined".to_string(),
                Some(m) => js_string(Some(m)),
            };
            Reply::Json(200, rpc_error(id, -32601, &format!("Method not found: {shown}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Mirrors vendor tests/plugin/mcpServer.test.ts `buildInitializeResult`.
    #[test]
    fn initialize_result_advertises_the_protocol_revision_and_the_version() {
        let r = initialize_result("0.77.0");
        assert_eq!(r["protocolVersion"], MCP_PROTOCOL_VERSION);
        assert_eq!(r["serverInfo"], json!({"name": "labnoteo", "version": "0.77.0"}));
    }

    #[test]
    fn initialize_result_claims_tools_but_not_resources_prompts_or_list_changed() {
        assert_eq!(initialize_result("0.0.0")["capabilities"], json!({"tools": {"listChanged": false}}));
    }

    // Mirrors vendor `isAllowedOrigin`.
    #[test]
    fn origin_absent_or_empty_is_allowed() {
        assert!(is_allowed_origin(None));
        assert!(is_allowed_origin(Some("")));
    }

    #[test]
    fn loopback_origins_are_allowed() {
        for o in [
            "http://localhost",
            "http://localhost:3987",
            "http://127.0.0.1:3987",
            "https://127.0.0.1:3987",
            "http://[::1]:3987",
            "http://localhost:5173",
            "HTTP://LOCALHOST:3987",
            "http://localhost/",
        ] {
            assert!(is_allowed_origin(Some(o)), "{o}");
        }
    }

    #[test]
    fn non_loopback_origins_are_refused() {
        for o in [
            "http://evil.com",
            "https://evil.com:3987",
            "http://rebind.evil.com",
            "http://localhost.evil.com",
            "http://notlocalhost",
            "http://127.0.0.1.evil.com",
            "http://evil.com@localhost",
            "http://localhost:99999",
            "http://localhost:abc",
            "http://[::2]:3987",
        ] {
            assert!(!is_allowed_origin(Some(o)), "{o}");
        }
    }

    #[test]
    fn non_http_or_unparseable_origins_are_refused() {
        for o in ["file://", "app://obsidian.md", "not a url", "null", "http://", "http:localhost", "garbage"] {
            assert!(!is_allowed_origin(Some(o)), "{o}");
        }
    }

    #[test]
    fn host_must_be_loopback_with_the_server_port() {
        assert!(is_allowed_host(Some("127.0.0.1:3987"), 3987));
        assert!(is_allowed_host(Some("localhost:3987"), 3987));
        assert!(is_allowed_host(Some("LOCALHOST:3987"), 3987));
        for h in [None, Some(""), Some("127.0.0.1"), Some("localhost"), Some("127.0.0.1:3988"), Some("evil.example:3987"), Some("[::1]:3987"), Some("0.0.0.0:3987"), Some("localhost:3987 ")] {
            assert!(!is_allowed_host(h, 3987), "{h:?}");
        }
    }

    // Mirrors vendor `timingSafeEqual` and `isAuthorized` (#107).
    #[test]
    fn authorization_accepts_only_the_current_token() {
        assert!(is_authorized(Some("Bearer new-token"), "new-token"));
        assert!(!is_authorized(Some("Bearer old-token"), "new-token"));
        assert!(!is_authorized(Some("Bearer new-tokem"), "new-token"));
        assert!(!is_authorized(Some("Bearer new-toke"), "new-token"));
        assert!(!is_authorized(Some("Bearer new-token-and-more"), "new-token"));
        assert!(!is_authorized(Some("bearer new-token"), "new-token"));
        assert!(!is_authorized(Some(""), "new-token"));
        assert!(!is_authorized(None, "new-token"));
    }

    #[test]
    fn authorization_refuses_everything_while_no_token_is_set() {
        assert!(!is_authorized(Some("Bearer "), ""));
        assert!(!is_authorized(Some(""), ""));
        assert!(!is_authorized(None, ""));
    }

    #[test]
    fn constant_time_eq_matches_vendor_timing_safe_equal() {
        assert!(ct_str_eq("Bearer abc", "Bearer abc"));
        assert!(!ct_str_eq("Bearer abc", "Bearer abd"));
        assert!(!ct_str_eq("short", "much longer"));
        assert!(!ct_str_eq("", "Bearer abc"));
        assert!(!ct_str_eq("Bearer ab", "Bearer abc"));
    }

    #[test]
    fn tool_info_reads_the_webview_catalog_shape() {
        let t: ToolInfo = serde_json::from_value(json!({
            "name": "n", "description": "d", "inputSchema": {"type": "object"}, "mutates": true
        }))
        .unwrap();
        assert!(t.mutates);
        assert_eq!(t.input_schema, json!({"type": "object"}));
    }
}
