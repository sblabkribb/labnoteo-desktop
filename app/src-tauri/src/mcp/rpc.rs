//! JSON-RPC and the request checks for the MCP server (C1, C2), ported in
//! behaviour from vendor `src/llm/mcpServer.ts` (`handle`,
//! `buildInitializeResult`, `isAllowedOrigin`, `timingSafeEqual`,
//! `isAuthorized`). Rust answers `initialize`, `ping`, `tools/list` and
//! `prompts/list` itself; `tools/call` goes to the webview through a
//! [`Bridge`] (C3). `prompts/get` is validated here and then forwarded over
//! the same bridge as a read call named `prompt:<name>`, which the webview
//! fills (ai-context spec §10.2). `tools/call` refuses `prompt:*` names, so an
//! MCP client cannot reach the prompt route through it.

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

/// The app's term rule (2026-11-11), the same sentence as the webview's
/// `KOREAN_TERMS_INSTRUCTION` (labnote/port/aiCommon.ts): an agent that answers
/// in Korean keeps "Workflow" and "Unit Operation" in English, as the Korean UI does.
pub const KOREAN_TERMS_INSTRUCTION: &str = "When you write Korean, keep the terms \"Workflow\" and \"Unit Operation\" in English (never 워크플로, 단위 공정 or 유닛 오퍼레이션; \"UO\" is fine where space is tight), with the Korean particle that fits the English word (Workflow를, Workflow가, Workflow로, Unit Operation을, Unit Operation이, Unit Operation으로); other words stay Korean.";

/// The `InitializeResult` (vendor `buildInitializeResult`). `capabilities`
/// advertises only what is served: a fixed tool list and a fixed prompt list
/// (both `listChanged: false`), no resources, no sampling. `instructions`
/// carries the Korean term rule to every client, also one that never fills a prompt.
pub fn initialize_result(version: &str) -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": { "tools": { "listChanged": false }, "prompts": { "listChanged": false } },
        "serverInfo": { "name": "labnoteo", "version": version },
        "instructions": KOREAN_TERMS_INSTRUCTION,
    })
}

/// The prompt names served by `prompts/list` and accepted by `prompts/get`.
const PROMPT_NAMES: [&str; 2] = ["draft-unit-operation", "continue-workflow"];

/// The bridge-call prefix for a forwarded `prompts/get`. `tools/call` refuses
/// any name starting with it.
const PROMPT_PREFIX: &str = "prompt:";

/// The static `prompts/list` result (ai-context spec §10.2). The webview fills
/// the prompts; the planning-only rule and the Korean term rule
/// (`KOREAN_TERMS_INSTRUCTION`) are stated in the filled text.
pub fn prompt_list() -> Value {
    json!({ "prompts": [
        {
            "name": "draft-unit-operation",
            "description": "Draft the planning sections of one unit operation from its experiment's context (never results or QC).",
            "arguments": [
                { "name": "notePath", "required": true },
                { "name": "unitOp", "required": false },
                { "name": "sections", "required": false, "description": "comma-separated planning sections" }
            ]
        },
        {
            "name": "continue-workflow",
            "description": "Propose the next unit operation(s) of a workflow, or the first of the next workflow, using the experiment chain.",
            "arguments": [
                { "name": "notePath", "required": true },
                { "name": "goal", "required": false }
            ]
        }
    ] })
}

/// Checks a `prompts/get` request: a known name, `arguments` absent or an
/// object whose values are all strings, and a non-empty `notePath`. Returns
/// the name and the arguments to forward, or the `-32602` message.
fn validate_prompt_get(params: Option<&Value>) -> Result<(String, Value), String> {
    let name = match params.and_then(|p| p.get("name")) {
        Some(Value::String(n)) if PROMPT_NAMES.contains(&n.as_str()) => n.clone(),
        Some(Value::String(n)) => return Err(format!("Unknown prompt: {n}")),
        _ => return Err("Unknown prompt: missing name".to_string()),
    };
    let args = match params.and_then(|p| p.get("arguments")) {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        Some(_) => return Err("Invalid prompt arguments: expected an object of strings".to_string()),
    };
    if let Some((k, _)) = args.iter().find(|(_, v)| !v.is_string()) {
        return Err(format!("Invalid prompt argument {k}: expected a string"));
    }
    if !args.get("notePath").and_then(Value::as_str).is_some_and(|p| !p.is_empty()) {
        return Err("Missing required prompt argument: notePath".to_string());
    }
    Ok((name, Value::Object(args)))
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
        Some("prompts/list") => Reply::Json(200, rpc_result(id, prompt_list())),
        Some("prompts/get") => match validate_prompt_get(rpc.get("params")) {
            Err(message) => Reply::Json(200, rpc_error(id, -32602, &message)),
            // Prompts only read: the read timeout applies, and a timeout comes
            // back as `TIMEOUT_CODE`, as for tools.
            Ok((name, args)) => match bridge.call(format!("{PROMPT_PREFIX}{name}"), args, false).await {
                CallOutcome::Result(r) => Reply::Json(200, rpc_result(id, r)),
                CallOutcome::RpcError(code, message) => Reply::Json(200, rpc_error(id, code, &message)),
                CallOutcome::NoReply => Reply::NoReply,
            },
        },
        Some("tools/call") => {
            let params = rpc.get("params");
            let name = js_string(params.and_then(|p| p.get("name")));
            // The prompt route is reachable only through `prompts/get`.
            if name.starts_with(PROMPT_PREFIX) {
                return Reply::Json(200, rpc_error(id, -32602, &format!("Unknown tool: {name}")));
            }
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
    fn initialize_result_tells_clients_to_keep_workflow_and_unit_operation_in_english() {
        let r = initialize_result("0.0.0");
        let text = r["instructions"].as_str().unwrap();
        assert_eq!(text, KOREAN_TERMS_INSTRUCTION);
        assert!(text.contains("\"Workflow\"") && text.contains("\"Unit Operation\""));
        assert!(text.contains("Korean"));
    }

    #[test]
    fn initialize_result_claims_tools_and_prompts_but_not_resources_or_list_changed() {
        assert_eq!(
            initialize_result("0.0.0")["capabilities"],
            json!({"tools": {"listChanged": false}, "prompts": {"listChanged": false}})
        );
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

    // ---- MCP prompts (spec §10.2) ----

    use futures_util::future::BoxFuture;
    use std::sync::{Arc, Mutex};

    type Calls = Arc<Mutex<Vec<(String, Value, bool)>>>;

    /// Records each forwarded call and answers with a fixed outcome.
    struct FakeBridge {
        calls: Calls,
        outcome: fn() -> CallOutcome,
    }

    impl Bridge for FakeBridge {
        fn call(&self, name: String, args: Value, mutates: bool) -> BoxFuture<'static, CallOutcome> {
            self.calls.lock().unwrap().push((name, args, mutates));
            let o = (self.outcome)();
            Box::pin(async move { o })
        }
    }

    fn prompt_result() -> CallOutcome {
        CallOutcome::Result(json!({
            "description": "d",
            "messages": [{"role": "user", "content": {"type": "text", "text": "hello"}}]
        }))
    }

    fn fake(outcome: fn() -> CallOutcome) -> (FakeBridge, Calls) {
        let calls: Calls = Arc::default();
        (FakeBridge { calls: calls.clone(), outcome }, calls)
    }

    fn run(body: Value, bridge: &FakeBridge) -> Value {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let bytes = serde_json::to_vec(&body).unwrap();
        match rt.block_on(dispatch(&bytes, &[], bridge)) {
            Reply::Json(status, v) => {
                assert_eq!(status, 200);
                v
            }
            other => panic!("unexpected reply {other:?}"),
        }
    }

    fn get(params: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": 7, "method": "prompts/get", "params": params})
    }

    #[test]
    fn prompt_list_has_exactly_the_two_prompts_with_their_arguments() {
        let l = prompt_list();
        let prompts = l["prompts"].as_array().unwrap();
        let names: Vec<&str> = prompts.iter().map(|p| p["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["draft-unit-operation", "continue-workflow"]);
        for p in prompts {
            assert!(p["description"].as_str().is_some_and(|d| !d.is_empty()));
            assert_eq!(p["arguments"][0], json!({"name": "notePath", "required": true}));
        }
        let arg_names = |p: &Value| -> Vec<String> {
            p["arguments"].as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap().to_string()).collect()
        };
        assert_eq!(arg_names(&prompts[0]), ["notePath", "unitOp", "sections"]);
        assert_eq!(prompts[0]["arguments"][1]["required"], false);
        assert_eq!(prompts[0]["arguments"][2]["required"], false);
        assert_eq!(prompts[0]["arguments"][2]["description"], "comma-separated planning sections");
        assert_eq!(arg_names(&prompts[1]), ["notePath", "goal"]);
        assert_eq!(prompts[1]["arguments"][1]["required"], false);
        assert!(prompts[0]["description"].as_str().unwrap().contains("never results or QC"));
    }

    #[test]
    fn prompts_list_is_answered_by_rust() {
        let (b, calls) = fake(prompt_result);
        let v = run(json!({"jsonrpc": "2.0", "id": 1, "method": "prompts/list"}), &b);
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"], prompt_list());
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn invalid_prompts_get_is_refused_without_calling_the_bridge() {
        for params in [
            json!({"name": "nope", "arguments": {"notePath": "labnote/001_A/x.md"}}),
            json!({"arguments": {"notePath": "labnote/001_A/x.md"}}),
            json!({"name": 5, "arguments": {"notePath": "a.md"}}),
            json!({"name": "prompt:draft-unit-operation", "arguments": {"notePath": "a.md"}}),
            json!({"name": "draft-unit-operation", "arguments": {"notePath": "a.md", "unitOp": 2}}),
            json!({"name": "draft-unit-operation", "arguments": {"notePath": "a.md", "sections": null}}),
            json!({"name": "draft-unit-operation", "arguments": {"notePath": ["a.md"]}}),
            json!({"name": "draft-unit-operation", "arguments": "notePath=a.md"}),
            json!({"name": "draft-unit-operation", "arguments": ["a.md"]}),
            json!({"name": "draft-unit-operation", "arguments": {}}),
            json!({"name": "continue-workflow", "arguments": {"goal": "g"}}),
            json!({"name": "continue-workflow"}),
            json!({"name": "continue-workflow", "arguments": {"notePath": ""}}),
            json!("draft-unit-operation"),
        ] {
            let (b, calls) = fake(prompt_result);
            let v = run(get(params.clone()), &b);
            assert_eq!(v["id"], 7, "{params}");
            assert_eq!(v["error"]["code"], -32602, "{params}");
            assert!(calls.lock().unwrap().is_empty(), "bridge called for {params}");
        }
        let (b, calls) = fake(prompt_result);
        let v = run(json!({"jsonrpc": "2.0", "id": 7, "method": "prompts/get"}), &b);
        assert_eq!(v["error"]["code"], -32602);
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn valid_prompts_get_is_forwarded_as_a_read_with_the_prompt_prefix() {
        let (b, calls) = fake(prompt_result);
        let args = json!({"notePath": "labnote/001_A/001_WF.md", "unitOp": "2", "sections": "Input,Method"});
        let v = run(get(json!({"name": "draft-unit-operation", "arguments": args})), &b);
        assert_eq!(v["id"], 7);
        assert_eq!(v["result"]["messages"][0]["content"]["text"], "hello");
        assert_eq!(v["result"]["description"], "d");
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0], ("prompt:draft-unit-operation".to_string(), args, false));
    }

    #[test]
    fn continue_workflow_get_is_forwarded_too() {
        let (b, calls) = fake(prompt_result);
        let v = run(get(json!({"name": "continue-workflow", "arguments": {"notePath": "labnote/001_A/README.md"}})), &b);
        assert!(v.get("result").is_some());
        let calls = calls.lock().unwrap();
        assert_eq!(calls[0].0, "prompt:continue-workflow");
        assert!(!calls[0].2);
    }

    #[test]
    fn a_bridge_timeout_on_prompts_get_maps_to_the_timeout_code() {
        let (b, _) = fake(|| CallOutcome::RpcError(crate::mcp::bridge::TIMEOUT_CODE, "timed out".into()));
        let v = run(get(json!({"name": "draft-unit-operation", "arguments": {"notePath": "a.md"}})), &b);
        assert_eq!(v["error"]["code"], -32001);
        assert_eq!(v["error"]["message"], "timed out");
    }

    #[test]
    fn a_webview_scope_error_on_prompts_get_is_passed_through() {
        let (b, _) = fake(|| CallOutcome::RpcError(-32602, "not in an experiment".into()));
        let v = run(get(json!({"name": "draft-unit-operation", "arguments": {"notePath": "a.md"}})), &b);
        assert_eq!(v["error"]["code"], -32602);
        assert_eq!(v["error"]["message"], "not in an experiment");
    }

    #[test]
    fn tools_call_cannot_reach_the_prompt_route() {
        for name in ["prompt:draft-unit-operation", "prompt:continue-workflow", "prompt:", "prompt:anything"] {
            let (b, calls) = fake(prompt_result);
            let v = run(
                json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": name, "arguments": {"notePath": "a.md"}}}),
                &b,
            );
            assert_eq!(v["error"]["code"], -32602, "{name}");
            assert!(calls.lock().unwrap().is_empty(), "bridge called for {name}");
        }
    }

    #[test]
    fn ordinary_tools_call_is_still_forwarded() {
        let (b, calls) = fake(prompt_result);
        run(json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "read_note", "arguments": {}}}), &b);
        assert_eq!(calls.lock().unwrap()[0].0, "read_note");
    }
}
