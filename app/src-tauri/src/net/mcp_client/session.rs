//! One MCP session over streamable HTTP (spec §4.2): `initialize` with
//! version negotiation, `notifications/initialized`, then `tools/list` and
//! `tools/call`.
//!
//! - We offer `2025-11-25` and accept `2025-11-25`, `2025-06-18` and
//!   `2025-03-26`. Any other answer is `mcpProtocol`, and the session the
//!   server may have opened is ended with a best-effort `DELETE`.
//! - A `400` to `initialize` is `mcpModernOnly` when it carries `-32022` or
//!   `-32020` (the transport decides) and `mcpProtocol` otherwise.
//! - A `404` to a request that carried a session id means the server dropped
//!   the session: we initialize once more and retry the request once.
//! - `tools/list` reads at most 10 pages and 200 tools, de-duplicated by name;
//!   a server without `capabilities.tools` is not asked.
//! - `tools/call` waits for one of two permits per server, refuses arguments
//!   over 32 KiB, and compacts the result (`tools.rs`). A JSON-RPC error
//!   answer is `mcpToolError` with the server text redacted and capped.
//! - Server text (name, version, errors) is capped; `instructions` is only
//!   flagged, never kept.

use std::collections::HashSet;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use super::tools::{cap, compact_result, sanitize_tool, McpCallResult, McpToolInfo, MAX_RESULT_CHARS};
use super::transport::{delete_session, post_rpc_in, Endpoint, Exchange, Limits, RpcError, RpcReply};
use crate::net::error::{redact_text, NetError, NetErrorKind};
use crate::net::NetState;

/// The protocol version we offer.
pub const OFFERED: &str = "2025-11-25";
/// The versions we accept in the server's answer.
pub const ACCEPTED: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];
/// `clientInfo.name`.
pub const CLIENT_NAME: &str = "labnoteO-Desktop";
/// Pages of `tools/list` read at most.
pub const MAX_PAGES: usize = 10;
/// Tools kept at most.
pub const MAX_TOOLS: usize = 200;
/// Serialised arguments of one call, at most (bytes).
pub const MAX_ARGS: usize = 32 * 1024;
/// Chars of a server's error text kept.
pub const MAX_ERROR: usize = 500;
/// Simultaneous calls per server.
pub const CALLS_PER_SERVER: usize = 2;
/// Chars of the server's name, title or version kept.
pub const MAX_SERVER_TEXT: usize = 200;
/// The longest `nextCursor` followed.
const MAX_CURSOR: usize = 4096;
/// The JSON-RPC id of `initialize`; later requests count up from 2.
const INIT_ID: u64 = 1;

/// What the server said about itself in `initialize` (all capped).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub version: String,
    pub protocol_version: String,
    /// The server sent `instructions` (the text itself is not kept).
    pub has_instructions: bool,
    /// The server declared `capabilities.tools`.
    #[serde(skip)]
    pub has_tools: bool,
}

/// An open session. `Debug` hides the session id (see `Exchange`).
#[derive(Debug)]
pub struct Session {
    ex: Exchange,
    info: ServerInfo,
    sem: Arc<Semaphore>,
    next_id: u64,
    client_version: String,
}

impl Session {
    pub fn info(&self) -> &ServerInfo {
        &self.info
    }

    pub fn exchange(&self) -> &Exchange {
        &self.ex
    }

    /// The per-server call permits (two).
    pub fn permits(&self) -> Arc<Semaphore> {
        self.sem.clone()
    }
}

fn protocol(message: &str) -> NetError {
    NetError::new(NetErrorKind::McpProtocol, message)
}

fn text_at(v: &Value, pointer: &str) -> Option<String> {
    v.pointer(pointer).and_then(Value::as_str).map(|s| cap(s, MAX_SERVER_TEXT))
}

/// `initialize` + `notifications/initialized`.
pub async fn open(ep: &Endpoint, app_version: &str) -> Result<Session, NetError> {
    open_in(&NetState::default(), None, ep, app_version).await
}

/// `open`, cancellable through `net.cancel(request_id)`.
pub async fn open_in(net: &NetState, request_id: Option<&str>, ep: &Endpoint, app_version: &str) -> Result<Session, NetError> {
    let (ex, info) = initialize(net, request_id, ep, app_version).await?;
    Ok(Session {
        ex,
        info,
        sem: Arc::new(Semaphore::new(CALLS_PER_SERVER)),
        next_id: INIT_ID + 1,
        client_version: app_version.to_string(),
    })
}

async fn initialize(
    net: &NetState,
    request_id: Option<&str>,
    ep: &Endpoint,
    app_version: &str,
) -> Result<(Exchange, ServerInfo), NetError> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": INIT_ID,
        "method": "initialize",
        "params": {
            "protocolVersion": OFFERED,
            "capabilities": {},
            "clientInfo": {"name": CLIENT_NAME, "version": app_version},
        },
    });
    let reply = post_rpc_in(net, request_id, ep, &Exchange::default(), Some(INIT_ID), body, Limits::REQUEST)
        .await
        .map_err(|e| {
            if e.kind == NetErrorKind::Status && e.status == Some(400) {
                protocol("the server refused to start a session")
            } else {
                e
            }
        })?;
    let RpcReply::Response { result, error, session } = reply else {
        return Err(protocol("the server did not answer initialize"));
    };
    let ended = Exchange { session: session.clone(), protocol: None };
    let result = match (result, error) {
        (Some(r), None) if r.is_object() => r,
        _ => {
            delete_session(ep, &ended).await;
            return Err(protocol("the server refused to start a session"));
        }
    };
    let version = result.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    if !ACCEPTED.contains(&version) {
        delete_session(ep, &ended).await;
        return Err(protocol("the server's MCP version is not supported"));
    }
    let info = ServerInfo {
        name: text_at(&result, "/serverInfo/name").unwrap_or_default(),
        title: text_at(&result, "/serverInfo/title").filter(|t| !t.trim().is_empty()),
        version: text_at(&result, "/serverInfo/version").unwrap_or_default(),
        protocol_version: version.to_string(),
        has_instructions: result.get("instructions").and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty()),
        has_tools: result.pointer("/capabilities/tools").is_some_and(|t| !t.is_null()),
    };
    let ex = Exchange { session, protocol: Some(version.to_string()) };
    let note = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
    if let Err(e) = post_rpc_in(net, request_id, ep, &ex, None, note, Limits::REQUEST).await {
        delete_session(ep, &ex).await;
        return Err(e);
    }
    Ok((ex, info))
}

/// One request in the session. A `404` to a request that carried a session
/// id re-initializes once and retries once.
async fn request(
    s: &mut Session,
    net: &NetState,
    request_id: Option<&str>,
    ep: &Endpoint,
    method: &str,
    params: Value,
    limits: Limits,
) -> Result<(Option<Value>, Option<RpcError>), NetError> {
    let mut renewed = false;
    loop {
        let id = s.next_id;
        s.next_id += 1;
        let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params.clone()});
        match post_rpc_in(net, request_id, ep, &s.ex, Some(id), body, limits).await {
            Ok(RpcReply::Response { result, error, .. }) => return Ok((result, error)),
            Ok(RpcReply::Accepted) => return Err(protocol("the server did not answer")),
            Err(e)
                if !renewed
                    && e.kind == NetErrorKind::Status
                    && e.status == Some(404)
                    && s.ex.session.is_some() =>
            {
                renewed = true;
                let (ex, info) = initialize(net, request_id, ep, &s.client_version).await?;
                s.ex = ex;
                s.info = info;
            }
            Err(e) => return Err(e),
        }
    }
}

/// The server's tools: at most 10 pages and 200 tools, de-duplicated by name.
/// `true` when the list was cut.
pub async fn list_tools(s: &mut Session, ep: &Endpoint) -> Result<(Vec<McpToolInfo>, bool), NetError> {
    list_tools_in(s, &NetState::default(), None, ep).await
}

/// `list_tools`, cancellable through `net.cancel(request_id)`.
pub async fn list_tools_in(
    s: &mut Session,
    net: &NetState,
    request_id: Option<&str>,
    ep: &Endpoint,
) -> Result<(Vec<McpToolInfo>, bool), NetError> {
    let mut tools: Vec<McpToolInfo> = Vec::new();
    if !s.info.has_tools {
        return Ok((tools, false));
    }
    let mut seen = HashSet::new();
    let mut cursor: Option<String> = None;
    for page in 0..MAX_PAGES {
        let params = match &cursor {
            Some(c) => json!({"cursor": c}),
            None => json!({}),
        };
        let (result, error) = request(s, net, request_id, ep, "tools/list", params, Limits::REQUEST).await?;
        let result = match (result, error) {
            (Some(r), None) => r,
            _ => return Err(protocol("the server could not list its tools")),
        };
        let Some(items) = result.get("tools").and_then(Value::as_array) else {
            return Err(protocol("the server sent no tool list"));
        };
        for raw in items {
            let Some(tool) = sanitize_tool(raw) else { continue };
            if !seen.insert(tool.name.clone()) {
                continue;
            }
            if tools.len() >= MAX_TOOLS {
                return Ok((tools, true));
            }
            tools.push(tool);
        }
        cursor = match result.get("nextCursor").and_then(Value::as_str) {
            None | Some("") => return Ok((tools, false)),
            Some(c) if c.len() > MAX_CURSOR => return Ok((tools, true)),
            Some(c) => Some(c.to_string()),
        };
        if page + 1 == MAX_PAGES {
            return Ok((tools, true));
        }
    }
    Ok((tools, true))
}

/// Calls one tool. `args` must be a JSON object (or null for none) of at most
/// 32 KiB serialised.
pub async fn call_tool(s: &mut Session, ep: &Endpoint, name: &str, args: Value) -> Result<McpCallResult, NetError> {
    call_tool_in(s, &NetState::default(), None, ep, name, args).await
}

/// `call_tool`, cancellable through `net.cancel(request_id)`.
pub async fn call_tool_in(
    s: &mut Session,
    net: &NetState,
    request_id: Option<&str>,
    ep: &Endpoint,
    name: &str,
    args: Value,
) -> Result<McpCallResult, NetError> {
    let args = match args {
        Value::Null => json!({}),
        Value::Object(_) => args,
        _ => return Err(NetError::new(NetErrorKind::BadInput, "the tool arguments must be an object")),
    };
    if serde_json::to_vec(&args).map(|b| b.len()).unwrap_or(usize::MAX) > MAX_ARGS {
        return Err(NetError::new(NetErrorKind::BadInput, "the tool arguments are too large"));
    }
    let _permit = s
        .sem
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| NetError::new(NetErrorKind::Cancelled, "the session was closed"))?;
    let token = ep.token.as_deref();
    let params = json!({"name": name, "arguments": args});
    let (result, error) = request(s, net, request_id, ep, "tools/call", params, Limits::CALL).await?;
    if let Some(e) = error {
        let message = cap(&redact_text(&e.message, token), MAX_ERROR);
        return Err(NetError::new(NetErrorKind::McpToolError, message).redact(token));
    }
    let result = result.filter(Value::is_object).ok_or_else(|| protocol("the server sent no tool result"))?;
    Ok(compact_result(&result, MAX_RESULT_CHARS))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::config::Url;
    use crate::net::mcp_client::fake::{fake, fixed, json_body, rpc_error, FakeMcp, Reply};
    use crate::net::testserver::{Canned, Recorded};
    use std::time::Duration;
    use tauri::async_runtime::block_on;

    const TOKEN: &str = "test-token-123";

    fn ep(url: &str) -> Endpoint {
        Endpoint { url: Url::parse(url).unwrap(), token: Some(TOKEN.to_string()), allow_http: false }
    }

    fn body_of(r: &Recorded) -> Value {
        serde_json::from_str(&r.body).unwrap_or(Value::Null)
    }

    /// Answers with `result` under the request's own id.
    fn ok(result: Value) -> Reply {
        Box::new(move |r| json_body(&json!({"jsonrpc": "2.0", "id": body_of(r)["id"], "result": result})))
    }

    /// An `initialize` answer.
    fn init(version: &str, session: Option<&'static str>, tools: bool) -> Reply {
        let mut result = json!({
            "protocolVersion": version,
            "capabilities": {},
            "serverInfo": {"name": "Fake MCP", "version": "1.2.3"},
            "instructions": "Use me well.",
        });
        if tools {
            result["capabilities"]["tools"] = json!({"listChanged": true});
        }
        Box::new(move |r| {
            let c = json_body(&json!({"jsonrpc": "2.0", "id": body_of(r)["id"], "result": result}));
            match session {
                Some(s) => c.header("Mcp-Session-Id", s),
                None => c,
            }
        })
    }

    fn accepted() -> Reply {
        fixed(Canned::status(202))
    }

    /// A fake that opens a session `s-1` with tools, then serves `rest`.
    fn opened(rest: Vec<Reply>) -> FakeMcp {
        let mut script = vec![init("2025-06-18", Some("s-1"), true), accepted()];
        script.extend(rest);
        fake(script)
    }

    fn tool(name: &str) -> Value {
        json!({"name": name, "description": format!("tool {name}"), "inputSchema": {"type": "object"}})
    }

    #[test]
    fn initialize_offers_our_version_and_sends_initialized_with_the_session() {
        let f = opened(vec![]);
        let e = ep(&f.url);
        let s = block_on(open(&e, "0.9.0")).unwrap();
        let b = body_of(&f.request(0));
        assert_eq!(b["method"], "initialize");
        assert_eq!(b["params"]["protocolVersion"], OFFERED);
        assert_eq!(b["params"]["capabilities"], json!({}));
        assert_eq!(b["params"]["clientInfo"], json!({"name": "labnoteO-Desktop", "version": "0.9.0"}));
        assert_eq!(f.request(0).header("mcp-protocol-version"), None);
        let n = f.request(1);
        assert_eq!(body_of(&n), json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        assert_eq!(n.header("mcp-session-id"), Some("s-1"));
        assert_eq!(n.header("mcp-protocol-version"), Some("2025-06-18"));
        let info = s.info();
        assert_eq!((info.name.as_str(), info.version.as_str()), ("Fake MCP", "1.2.3"));
        assert_eq!(info.protocol_version, "2025-06-18");
        assert!(info.has_instructions && info.has_tools);
        assert_eq!(s.exchange().protocol.as_deref(), Some("2025-06-18"));
        // The instructions text is not kept anywhere.
        assert!(!format!("{s:?}").contains("Use me well"));
        assert!(!serde_json::to_string(info).unwrap().contains("Use me well"));
    }

    #[test]
    fn every_accepted_version_is_taken() {
        for v in ACCEPTED {
            let f = fake(vec![init(v, None, false), accepted()]);
            let s = block_on(open(&ep(&f.url), "1")).unwrap();
            assert_eq!(s.info().protocol_version, v);
        }
    }

    #[test]
    fn an_old_version_is_a_protocol_error_and_the_session_is_deleted() {
        let f = fake(vec![init("2024-11-05", Some("s-old"), true), fixed(Canned::status(405))]);
        let err = block_on(open(&ep(&f.url), "1")).unwrap_err();
        assert_eq!(err.kind, NetErrorKind::McpProtocol);
        assert_eq!(f.count(), 2);
        let d = f.request(1);
        assert_eq!(d.method, "DELETE");
        assert_eq!(d.header("mcp-session-id"), Some("s-old"));
    }

    #[test]
    fn bad_request_to_initialize_is_modern_only_or_protocol() {
        let modern = json!({"jsonrpc": "2.0", "id": 1,
            "error": {"code": -32022, "message": "unsupported", "data": {"supported": ["2026-07-28"]}}});
        let mismatch = rpc_error(json!(null), -32020, "header mismatch");
        for (body, kind) in [
            (modern, NetErrorKind::McpModernOnly),
            (mismatch, NetErrorKind::McpModernOnly),
            (rpc_error(json!(1), -32600, "bad"), NetErrorKind::McpProtocol),
        ] {
            let f = fake(vec![fixed(Canned::status(400).header("Content-Type", "application/json").body(body.to_string()))]);
            let err = block_on(open(&ep(&f.url), "1")).unwrap_err();
            assert_eq!(err.kind, kind, "{body}");
        }
        let f = fake(vec![fixed(Canned::status(400).body("nope"))]);
        assert_eq!(block_on(open(&ep(&f.url), "1")).unwrap_err().kind, NetErrorKind::McpProtocol);
    }

    #[test]
    fn a_json_rpc_error_to_initialize_is_a_protocol_error() {
        let f = fake(vec![fixed(json_body(&rpc_error(json!(1), -32603, "boom")))]);
        assert_eq!(block_on(open(&ep(&f.url), "1")).unwrap_err().kind, NetErrorKind::McpProtocol);
    }

    #[test]
    fn requests_after_initialize_carry_the_session() {
        let strict: Reply = Box::new(|r| {
            if r.header("mcp-session-id") != Some("s-1") {
                return Canned::status(400).body("session required");
            }
            json_body(&json!({"jsonrpc": "2.0", "id": body_of(r)["id"], "result": {"tools": [tool("a")]}}))
        });
        let f = opened(vec![strict]);
        let e = ep(&f.url);
        let mut s = block_on(open(&e, "1")).unwrap();
        let (tools, truncated) = block_on(list_tools(&mut s, &e)).unwrap();
        assert_eq!((tools.len(), truncated), (1, false));
        let r = f.request(2);
        assert_eq!(r.header("mcp-protocol-version"), Some("2025-06-18"));
        assert_eq!(r.header("authorization"), Some("Bearer test-token-123"));
    }

    #[test]
    fn a_404_reinitializes_once_and_retries_once() {
        let f = opened(vec![
            fixed(Canned::status(404)),
            init("2025-11-25", Some("s-2"), true),
            accepted(),
            ok(json!({"tools": [tool("a")]})),
        ]);
        let e = ep(&f.url);
        let mut s = block_on(open(&e, "1")).unwrap();
        let (tools, _) = block_on(list_tools(&mut s, &e)).unwrap();
        assert_eq!(tools[0].name, "a");
        assert_eq!(f.count(), 6);
        assert_eq!(body_of(&f.request(3))["method"], "initialize");
        assert_eq!(f.request(3).header("mcp-session-id"), None);
        let retried = f.request(5);
        assert_eq!(body_of(&retried)["method"], "tools/list");
        assert_eq!(retried.header("mcp-session-id"), Some("s-2"));
        assert_eq!(retried.header("mcp-protocol-version"), Some("2025-11-25"));
        assert_eq!(s.info().protocol_version, "2025-11-25");

        let f = opened(vec![
            fixed(Canned::status(404)),
            init("2025-06-18", Some("s-2"), true),
            accepted(),
            fixed(Canned::status(404)),
        ]);
        let e = ep(&f.url);
        let mut s = block_on(open(&e, "1")).unwrap();
        let err = block_on(list_tools(&mut s, &e)).unwrap_err();
        assert_eq!((err.kind, err.status), (NetErrorKind::Status, Some(404)));
        assert_eq!(f.count(), 6);
    }

    #[test]
    fn tools_list_follows_pages_and_drops_duplicates() {
        let mut big = tool("big");
        big["inputSchema"]["description"] = json!("x".repeat(17_000));
        let mut long = tool("long");
        long["description"] = json!("d".repeat(3000));
        let f = opened(vec![
            ok(json!({"tools": [tool("a"), tool("b")], "nextCursor": "p2"})),
            ok(json!({"tools": [tool("b"), big, {"name": "bad name"}], "nextCursor": "p3"})),
            ok(json!({"tools": [long, tool("a")]})),
        ]);
        let e = ep(&f.url);
        let mut s = block_on(open(&e, "1")).unwrap();
        let (tools, truncated) = block_on(list_tools(&mut s, &e)).unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "big", "long"]);
        assert!(!truncated);
        assert_eq!(body_of(&f.request(2))["params"], json!({}));
        assert_eq!(body_of(&f.request(3))["params"], json!({"cursor": "p2"}));
        assert_eq!(body_of(&f.request(4))["params"], json!({"cursor": "p3"}));
        assert!(tools[2].too_large && tools[2].input_schema.is_none());
        assert_eq!(tools[3].description.chars().count(), 1000);
    }

    #[test]
    fn tools_list_keeps_200_tools_and_10_pages() {
        let many: Vec<Value> = (0..250).map(|i| tool(&format!("t{i}"))).collect();
        let f = opened(vec![ok(json!({"tools": many}))]);
        let e = ep(&f.url);
        let mut s = block_on(open(&e, "1")).unwrap();
        let (tools, truncated) = block_on(list_tools(&mut s, &e)).unwrap();
        assert_eq!((tools.len(), truncated), (200, true));

        let pages: Vec<Reply> = (0..12).map(|i| ok(json!({"tools": [tool(&format!("p{i}"))], "nextCursor": "more"}))).collect();
        let f = opened(pages);
        let e = ep(&f.url);
        let mut s = block_on(open(&e, "1")).unwrap();
        let (tools, truncated) = block_on(list_tools(&mut s, &e)).unwrap();
        assert_eq!((tools.len(), truncated), (10, true));
        assert_eq!(f.count(), 2 + 10);
    }

    #[test]
    fn a_server_without_tools_is_not_asked() {
        let f = fake(vec![init("2025-06-18", None, false), accepted(), ok(json!({"tools": [tool("a")]}))]);
        let e = ep(&f.url);
        let mut s = block_on(open(&e, "1")).unwrap();
        assert_eq!(block_on(list_tools(&mut s, &e)).unwrap(), (vec![], false));
        assert_eq!(f.count(), 2);
    }

    #[test]
    fn tool_calls_join_text_and_mark_errors_and_images() {
        let f = opened(vec![
            ok(json!({"content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]})),
            ok(json!({"isError": true, "content": [{"type": "text", "text": "no such part"}]})),
            ok(json!({"content": [{"type": "text", "text": "z".repeat(50_000)}]})),
            ok(json!({"content": [{"type": "image", "data": "AAAA", "mimeType": "image/png"}]})),
        ]);
        let e = ep(&f.url);
        let mut s = block_on(open(&e, "1")).unwrap();
        let r = block_on(call_tool(&mut s, &e, "get_part", json!({"id": "BBa_1"}))).unwrap();
        assert_eq!(r, McpCallResult { text: "a\nb".into(), is_error: false, truncated: false, omitted: 0 });
        let sent = body_of(&f.request(2));
        assert_eq!(sent["method"], "tools/call");
        assert_eq!(sent["params"], json!({"name": "get_part", "arguments": {"id": "BBa_1"}}));
        let r = block_on(call_tool(&mut s, &e, "get_part", Value::Null)).unwrap();
        assert!(r.is_error);
        assert_eq!(r.text, "no such part");
        assert_eq!(body_of(&f.request(3))["params"]["arguments"], json!({}));
        let r = block_on(call_tool(&mut s, &e, "x", json!({}))).unwrap();
        assert!(r.truncated);
        assert_eq!(r.text.chars().count(), 12_000);
        let r = block_on(call_tool(&mut s, &e, "x", json!({}))).unwrap();
        assert_eq!((r.text.as_str(), r.omitted), ("[image omitted]", 1));
    }

    #[test]
    fn a_json_rpc_error_to_a_call_is_a_capped_redacted_tool_error() {
        let message = format!("bad token {TOKEN} {}", "y".repeat(2000));
        let f = opened(vec![Box::new(move |r| json_body(&rpc_error(body_of(r)["id"].clone(), -32000, &message)))]);
        let e = ep(&f.url);
        let mut s = block_on(open(&e, "1")).unwrap();
        let err = block_on(call_tool(&mut s, &e, "x", json!({}))).unwrap_err();
        assert_eq!(err.kind, NetErrorKind::McpToolError);
        assert!(err.message.chars().count() <= MAX_ERROR);
        assert!(err.message.starts_with("bad token ***"));
        assert!(!serde_json::to_string(&err).unwrap().contains(TOKEN));
        assert!(!format!("{err:?}").contains(TOKEN));
    }

    #[test]
    fn a_huge_result_is_too_large() {
        let huge = json!({"jsonrpc": "2.0", "id": 2, "result": {"content": [{"type": "text", "text": "q".repeat(10 << 20)}]}});
        let f = opened(vec![fixed(json_body(&huge))]);
        let e = ep(&f.url);
        let mut s = block_on(open(&e, "1")).unwrap();
        let err = block_on(call_tool(&mut s, &e, "x", json!({}))).unwrap_err();
        assert_eq!(err.kind, NetErrorKind::TooLarge);
    }

    #[test]
    fn bad_arguments_are_refused_before_anything_is_sent() {
        let f = opened(vec![]);
        let e = ep(&f.url);
        let mut s = block_on(open(&e, "1")).unwrap();
        let err = block_on(call_tool(&mut s, &e, "x", json!(["a"]))).unwrap_err();
        assert_eq!(err.kind, NetErrorKind::BadInput);
        let err = block_on(call_tool(&mut s, &e, "x", json!({"q": "w".repeat(MAX_ARGS)}))).unwrap_err();
        assert_eq!(err.kind, NetErrorKind::BadInput);
        assert_eq!(f.count(), 2);
    }

    #[test]
    fn a_third_call_waits_for_a_permit() {
        let f = opened(vec![ok(json!({"content": [{"type": "text", "text": "done"}]}))]);
        let e = ep(&f.url);
        let mut s = block_on(open(&e, "1")).unwrap();
        let permits = s.permits();
        // Two calls in flight hold both permits.
        let first = permits.clone().try_acquire_owned().unwrap();
        let _second = permits.clone().try_acquire_owned().unwrap();
        let waited = block_on(async {
            tokio::time::timeout(Duration::from_millis(300), call_tool(&mut s, &e, "x", json!({}))).await
        });
        assert!(waited.is_err(), "the third call did not wait");
        assert_eq!(f.count(), 2, "nothing was sent while waiting");
        drop(first);
        let r = block_on(call_tool(&mut s, &e, "x", json!({}))).unwrap();
        assert_eq!(r.text, "done");
    }
}
