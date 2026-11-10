//! One streamable-HTTP exchange with an MCP server (spec §4.2, "legacy"
//! streamable HTTP, protocol 2025-03-26 to 2025-11-25).
//!
//! - Every message is a `POST <url>` with `Content-Type: application/json`,
//!   `Accept: application/json, text/event-stream`, `Authorization: Bearer`
//!   when the server has a token, and `MCP-Protocol-Version` /
//!   `Mcp-Session-Id` when the `Exchange` holds them.
//! - The answer is `application/json` (one object, or an array whose element
//!   with our id is taken) or `text/event-stream` (frames with empty data,
//!   notifications, server requests and other ids are skipped; the stream
//!   stops at the response with our id). Any other content type is
//!   `mcpProtocol`.
//! - A stream that ends before our response resumes with `GET` +
//!   `Last-Event-ID` (at most twice, after `min(retry, 5 s)`) when an event id
//!   was seen; otherwise it is `noResult`.
//! - 202 is `Accepted`; 401/403 `mcpAuth`; 3xx `redirect` (never followed);
//!   400 with JSON-RPC `-32022` or `-32020` `mcpModernOnly`; other non-2xx
//!   `status`. A session id outside visible ASCII or over 1 KiB is
//!   `mcpProtocol`.
//! - A token never goes to a non-loopback `http://` origin unless allowed
//!   (`insecure`, nothing sent). The token is redacted from every response
//!   text before it is parsed, and from every error.
//! - Every wait (head, each chunk) ends within `Limits::idle`, the whole
//!   exchange within `Limits::total`; bodies are capped.

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use serde::Deserialize;
use serde_json::Value;

use crate::net::config::Url;
use crate::net::error::{redact_text, NetError, NetErrorKind};
use crate::net::http::{
    cancelled, client, header_map, net_error, redirect_error, refuse_insecure, take_utf8, too_large, Registration,
};
use crate::net::sse::SseParser;
use crate::net::NetState;

/// The longest session id kept (bytes).
pub const MAX_SESSION_ID: usize = 1024;
/// How many times a stream that ended early is resumed.
pub const MAX_RESUMES: usize = 2;
/// The longest wait before a resume, whatever `retry:` said.
pub const MAX_RESUME_DELAY: Duration = Duration::from_secs(5);
/// The wait before a resume when the server sent no `retry:`.
pub const DEFAULT_RESUME_DELAY: Duration = Duration::from_secs(1);
/// How long a best-effort `DELETE` of a session may take.
pub const DELETE_TIMEOUT: Duration = Duration::from_secs(5);

const ACCEPT_POST: &str = "application/json, text/event-stream";
const ACCEPT_SSE: &str = "text/event-stream";

/// The server a message goes to. `Debug` prints the token as `***`.
pub struct Endpoint {
    pub url: Url,
    pub token: Option<String>,
    /// Set when the vault's `allowHttpOrigins` holds the URL's origin.
    pub allow_http: bool,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint")
            .field("url", &self.url.as_str())
            .field("token", &self.token.as_ref().map(|_| "***"))
            .field("allow_http", &self.allow_http)
            .finish()
    }
}

/// What a message carries from earlier ones: the session id the server gave
/// and the negotiated protocol version. `Debug` hides the session id.
#[derive(Clone, Default, PartialEq)]
pub struct Exchange {
    pub session: Option<String>,
    pub protocol: Option<String>,
}

impl std::fmt::Debug for Exchange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Exchange")
            .field("session", &self.session.as_ref().map(|_| "***"))
            .field("protocol", &self.protocol)
            .finish()
    }
}

/// Time and size limits of one exchange (spec §4.3).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limits {
    /// The whole exchange, resumes included.
    pub total: Duration,
    /// Each wait: the answer's head, then each chunk.
    pub idle: Duration,
    /// A JSON body, or all SSE bytes together (resumes included).
    pub max_body: usize,
    /// One SSE frame.
    pub max_frame: usize,
}

impl Limits {
    /// `initialize` and `tools/list`: 20 s each.
    pub const REQUEST: Limits =
        Limits { total: Duration::from_secs(20), idle: Duration::from_secs(20), max_body: 4 << 20, max_frame: 1 << 20 };
    /// `tools/call`: 60 s in all, 30 s of silence.
    pub const CALL: Limits =
        Limits { total: Duration::from_secs(60), idle: Duration::from_secs(30), max_body: 4 << 20, max_frame: 1 << 20 };
}

/// A JSON-RPC error object. `message` already has the token redacted; it is
/// server text (untrusted).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RpcError {
    pub code: i64,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

/// The answer to one POST.
#[derive(PartialEq)]
pub enum RpcReply {
    /// 202, or any 2xx to a notification.
    Accepted,
    /// The JSON-RPC response with our id; `session` is the `Mcp-Session-Id`
    /// the answer carried (already checked).
    Response { result: Option<Value>, error: Option<RpcError>, session: Option<String> },
}

/// Hides the session id.
impl std::fmt::Debug for RpcReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcReply::Accepted => f.write_str("Accepted"),
            RpcReply::Response { result, error, session } => f
                .debug_struct("Response")
                .field("result", result)
                .field("error", error)
                .field("session", &session.as_ref().map(|_| "***"))
                .finish(),
        }
    }
}

/// Sends one JSON-RPC message (`id` is `None` for a notification).
pub async fn post_rpc(ep: &Endpoint, ex: &Exchange, id: Option<u64>, body: Value, limits: Limits) -> Result<RpcReply, NetError> {
    post_rpc_in(&NetState::default(), None, ep, ex, id, body, limits).await
}

/// `post_rpc`, cancellable through `net.cancel(request_id)` when an id is
/// given (the stream is dropped on cancel).
#[allow(clippy::too_many_arguments)]
pub async fn post_rpc_in(
    net: &NetState,
    request_id: Option<&str>,
    ep: &Endpoint,
    ex: &Exchange,
    id: Option<u64>,
    body: Value,
    limits: Limits,
) -> Result<RpcReply, NetError> {
    let token = ep.token.as_deref();
    let run = async {
        refuse_insecure(&ep.url, ep.token.is_some(), ep.allow_http)?;
        let headers = request_headers(ep, ex, ACCEPT_POST, true, None)?;
        let bytes = serde_json::to_vec(&body).map_err(|_| NetError::new(NetErrorKind::BadInput, "the message is not JSON"))?;
        let timed = async {
            tokio::time::timeout(limits.total, exchange(ep, ex, headers, bytes, id, limits))
                .await
                .unwrap_or_else(|_| Err(timed_out()))
        };
        match request_id {
            None => timed.await,
            Some(rid) => {
                let notify = net.register(rid)?;
                let _registration = Registration { net, id: rid };
                tokio::select! {
                    r = timed => r,
                    _ = notify.notified() => Err(cancelled()),
                }
            }
        }
    };
    run.await.map_err(|e| e.redact(token))
}

/// Ends a session: `DELETE` with its id, best effort (every failure, 405
/// included, is ignored). Nothing is sent without a session id.
pub async fn delete_session(ep: &Endpoint, ex: &Exchange) {
    if ex.session.is_none() || refuse_insecure(&ep.url, ep.token.is_some(), ep.allow_http).is_err() {
        return;
    }
    let Ok(headers) = request_headers(ep, ex, ACCEPT_POST, false, None) else { return };
    let _ = client().delete(ep.url.clone()).headers(headers).timeout(DELETE_TIMEOUT).send().await;
}

/// The wait before a resume: the server's `retry:` capped at 5 s, 1 s without one.
pub fn resume_delay(retry_ms: Option<u64>) -> Duration {
    retry_ms.map(Duration::from_millis).unwrap_or(DEFAULT_RESUME_DELAY).min(MAX_RESUME_DELAY)
}

fn timed_out() -> NetError {
    NetError::new(NetErrorKind::Timeout, "the server did not answer in time")
}

fn protocol(message: &str) -> NetError {
    NetError::new(NetErrorKind::McpProtocol, message)
}

fn no_result() -> NetError {
    NetError::new(NetErrorKind::NoResult, "the stream ended without an answer")
}

async fn within<T>(limit: Duration, fut: impl std::future::Future<Output = T>) -> Result<T, NetError> {
    tokio::time::timeout(limit, fut).await.map_err(|_| timed_out())
}

fn request_headers(ep: &Endpoint, ex: &Exchange, accept: &str, json: bool, last_event_id: Option<&str>) -> Result<HeaderMap, NetError> {
    let mut h: Vec<(&'static str, String)> = vec![("Accept", accept.to_string())];
    if json {
        h.push(("Content-Type", "application/json".to_string()));
    }
    if let Some(token) = &ep.token {
        h.push(("Authorization", format!("Bearer {token}")));
    }
    if let Some(p) = &ex.protocol {
        h.push(("MCP-Protocol-Version", p.clone()));
    }
    if let Some(s) = &ex.session {
        h.push(("Mcp-Session-Id", s.clone()));
    }
    if let Some(last) = last_event_id {
        h.push(("Last-Event-ID", last.to_string()));
    }
    header_map(&h)
}

/// The media type of `Content-Type`, lower-cased, without parameters.
fn media_type(resp: &reqwest::Response) -> String {
    resp.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// The answer's `Mcp-Session-Id`, checked: visible ASCII only, 1 to 1 KiB.
fn session_of(resp: &reqwest::Response) -> Result<Option<String>, NetError> {
    let Some(v) = resp.headers().get("mcp-session-id") else { return Ok(None) };
    let b = v.as_bytes();
    if b.is_empty() || b.len() > MAX_SESSION_ID || !b.iter().all(|c| (0x21..=0x7e).contains(c)) {
        return Err(protocol("the server sent an unusable session id"));
    }
    Ok(Some(String::from_utf8_lossy(b).into_owned()))
}

/// `401` / `403`: the token is missing, wrong or expired. Server text is not kept.
fn auth_error() -> NetError {
    NetError::new(NetErrorKind::McpAuth, "the server refused the token")
}

/// Answers whose status is not 2xx, after redirects and auth were handled.
fn status_error(status: u16, text: &str, token: Option<&str>) -> NetError {
    if status == 400 && is_modern_only(text) {
        return NetError::new(NetErrorKind::McpModernOnly, "the server supports only a newer MCP version");
    }
    NetError::status(status, text, token)
}

/// A JSON-RPC error `-32022` (unsupported protocol version) or `-32020`
/// (header mismatch): a server that speaks only the 2026 protocol.
fn is_modern_only(text: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return false };
    let items = match v {
        Value::Array(a) => a,
        other => vec![other],
    };
    items.iter().any(|m| matches!(m.pointer("/error/code").and_then(Value::as_i64), Some(-32022) | Some(-32020)))
}

/// Checks the head of an answer: redirect, auth, other non-2xx.
async fn check_head(resp: reqwest::Response, url: &Url, limits: Limits, token: Option<&str>) -> Result<reqwest::Response, NetError> {
    let status = resp.status().as_u16();
    if (300..400).contains(&status) {
        return Err(redirect_error(&resp, url));
    }
    if status == 401 || status == 403 {
        // `WWW-Authenticate` is not read further: no OAuth discovery (spec §4.2).
        return Err(auth_error());
    }
    if !(200..300).contains(&status) {
        let bytes = read_body(resp, limits).await?;
        return Err(status_error(status, &String::from_utf8_lossy(&bytes), token));
    }
    Ok(resp)
}

async fn exchange(
    ep: &Endpoint,
    ex: &Exchange,
    headers: HeaderMap,
    body: Vec<u8>,
    id: Option<u64>,
    limits: Limits,
) -> Result<RpcReply, NetError> {
    let token = ep.token.as_deref();
    let req = client().post(ep.url.clone()).headers(headers).body(body);
    let resp = within(limits.idle, req.send()).await?.map_err(net_error)?;
    let resp = check_head(resp, &ep.url, limits, token).await?;
    let session = session_of(&resp)?;
    let Some(id) = id.filter(|_| resp.status().as_u16() != 202) else {
        return Ok(RpcReply::Accepted);
    };
    match media_type(&resp).as_str() {
        "application/json" => {
            let bytes = read_body(resp, limits).await?;
            let text = redact_text(&String::from_utf8_lossy(&bytes), token);
            let v: Value = serde_json::from_str(&text).map_err(|_| protocol("the answer is not JSON"))?;
            let (result, error) = pick_response(v, id).ok_or_else(|| protocol("the answer has no response to this message"))?;
            Ok(RpcReply::Response { result, error, session })
        }
        "text/event-stream" => {
            let (result, error) = read_sse(resp, ep, ex, id, limits).await?;
            Ok(RpcReply::Response { result, error, session })
        }
        _ => Err(protocol("the server answered with an unexpected content type")),
    }
}

/// The response to `id` in a JSON value (one message or a batch). Requests
/// and notifications (anything with `method`) are not responses.
fn pick_response(v: Value, id: u64) -> Option<(Option<Value>, Option<RpcError>)> {
    let items = match v {
        Value::Array(a) => a,
        other => vec![other],
    };
    for mut m in items {
        let Some(obj) = m.as_object_mut() else { continue };
        if obj.contains_key("method") || !(obj.contains_key("result") || obj.contains_key("error")) {
            continue;
        }
        if obj.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        let error = match obj.remove("error") {
            Some(e) => Some(serde_json::from_value::<RpcError>(e).unwrap_or(RpcError {
                code: 0,
                message: String::new(),
                data: None,
            })),
            None => None,
        };
        return Some((obj.remove("result"), error));
    }
    None
}

/// Reads a whole body: `tooLarge` past `max_body` (before reading when
/// `Content-Length` says so), each chunk within `idle`.
async fn read_body(resp: reqwest::Response, limits: Limits) -> Result<Vec<u8>, NetError> {
    if resp.content_length().is_some_and(|n| n > limits.max_body as u64) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = within(limits.idle, stream.next()).await? {
        let chunk = chunk.map_err(net_error)?;
        if body.len() + chunk.len() > limits.max_body {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Reads an SSE answer to our response, resuming when it ends early.
async fn read_sse(
    first: reqwest::Response,
    ep: &Endpoint,
    ex: &Exchange,
    id: u64,
    limits: Limits,
) -> Result<(Option<Value>, Option<RpcError>), NetError> {
    let mut received = 0usize;
    let mut last_id: Option<String> = None;
    let mut retry: Option<u64> = None;
    let mut resumes = 0usize;
    let mut resp = first;
    loop {
        let mut parser = SseParser::default();
        let found = read_stream(resp, &mut parser, &mut received, id, limits, ep.token.as_deref()).await?;
        if let Some(r) = found {
            return Ok(r);
        }
        if let Some(l) = parser.last_event_id() {
            last_id = Some(l.to_string());
        }
        if let Some(r) = parser.retry() {
            retry = Some(r);
        }
        let Some(last) = last_id.as_deref() else { return Err(no_result()) };
        if resumes >= MAX_RESUMES {
            return Err(no_result());
        }
        resumes += 1;
        tokio::time::sleep(resume_delay(retry)).await;
        let headers = request_headers(ep, ex, ACCEPT_SSE, false, Some(last))?;
        let req = client().get(ep.url.clone()).headers(headers);
        let got = within(limits.idle, req.send()).await?.map_err(net_error)?;
        let got = check_head(got, &ep.url, limits, ep.token.as_deref()).await?;
        if media_type(&got) != "text/event-stream" {
            return Err(protocol("the server answered the resume with an unexpected content type"));
        }
        resp = got;
    }
}

/// Reads one SSE stream until our response (`Some`) or its end (`None`). A
/// broken connection counts as an end (it may be resumed).
async fn read_stream(
    resp: reqwest::Response,
    parser: &mut SseParser,
    received: &mut usize,
    id: u64,
    limits: Limits,
    token: Option<&str>,
) -> Result<Option<(Option<Value>, Option<RpcError>)>, NetError> {
    let mut stream = resp.bytes_stream();
    let mut tail = Vec::new();
    loop {
        let Some(chunk) = within(limits.idle, stream.next()).await? else { return Ok(None) };
        let Ok(chunk) = chunk else { return Ok(None) };
        *received += chunk.len();
        if *received > limits.max_body {
            return Err(too_large());
        }
        tail.extend_from_slice(&chunk);
        let text = take_utf8(&mut tail);
        for frame in parser.push(&text) {
            if frame.data.len() > limits.max_frame {
                return Err(too_large());
            }
            if frame.data.trim().is_empty() {
                continue;
            }
            let data = redact_text(&frame.data, token);
            // A frame that is not JSON is skipped like any other foreign event.
            let Ok(v) = serde_json::from_str::<Value>(&data) else { continue };
            if let Some(r) = pick_response(v, id) {
                return Ok(Some(r));
            }
        }
        if parser.pending_len() + tail.len() > limits.max_frame {
            return Err(too_large());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::mcp_client::fake::{echo_auth, fake, fixed, frame, json_body, result, rpc_error, sse, sse_paced, Reply};
    use crate::net::testserver::{serve, Canned};
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Instant;
    use tauri::async_runtime::block_on;

    const TOKEN: &str = "test-token-123";

    fn ep(url: &str, token: Option<&str>) -> Endpoint {
        Endpoint { url: Url::parse(url).unwrap(), token: token.map(str::to_string), allow_http: false }
    }

    fn lim() -> Limits {
        Limits { total: Duration::from_secs(5), idle: Duration::from_secs(2), max_body: 4 << 20, max_frame: 1 << 20 }
    }

    fn msg(id: u64) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "tools/list", "params": {}})
    }

    fn post(url: &str, token: Option<&str>, id: u64) -> Result<RpcReply, NetError> {
        block_on(post_rpc(&ep(url, token), &Exchange::default(), Some(id), msg(id), lim()))
    }

    fn result_of(r: RpcReply) -> Value {
        match r {
            RpcReply::Response { result: Some(v), error: None, .. } => v,
            other => panic!("not a result: {other:?}"),
        }
    }

    #[test]
    fn headers_follow_the_exchange_and_the_token() {
        let f = fake(vec![fixed(json_body(&result(1, json!({})))), fixed(json_body(&result(2, json!({}))))]);
        let ex = Exchange { session: Some("sess-1".into()), protocol: Some("2025-06-18".into()) };
        block_on(post_rpc(&ep(&f.url, Some(TOKEN)), &ex, Some(1), msg(1), lim())).unwrap();
        let r = f.request(0);
        assert_eq!((r.method.as_str(), r.path.as_str()), ("POST", "/mcp"));
        assert_eq!(r.header("accept"), Some("application/json, text/event-stream"));
        assert_eq!(r.header("content-type"), Some("application/json"));
        assert_eq!(r.header("authorization"), Some("Bearer test-token-123"));
        assert_eq!(r.header("mcp-protocol-version"), Some("2025-06-18"));
        assert_eq!(r.header("mcp-session-id"), Some("sess-1"));
        assert_eq!(serde_json::from_str::<Value>(&r.body).unwrap(), msg(1));
        // No token, no session, no version: none of those headers.
        post(&f.url, None, 2).unwrap();
        let r = f.request(1);
        assert_eq!(r.header("authorization"), None);
        assert_eq!(r.header("mcp-protocol-version"), None);
        assert_eq!(r.header("mcp-session-id"), None);
    }

    #[test]
    fn json_reply_with_session_and_charset() {
        let f = fake(vec![
            fixed(json_body(&result(1, json!({"ok": 1}))).header("Mcp-Session-Id", "abc-123")),
            fixed(json_body(&result(2, json!({"ok": 2}))).header("Content-Type", "Application/JSON; charset=utf-8")),
        ]);
        match post(&f.url, None, 1).unwrap() {
            RpcReply::Response { result, error, session } => {
                assert_eq!(result, Some(json!({"ok": 1})));
                assert_eq!(error, None);
                assert_eq!(session.as_deref(), Some("abc-123"));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(result_of(post(&f.url, None, 2).unwrap()), json!({"ok": 2}));
    }

    #[test]
    fn json_array_reply_picks_our_id_and_error_answers_are_kept() {
        let batch = json!([
            {"jsonrpc": "2.0", "method": "notifications/message", "params": {}},
            {"jsonrpc": "2.0", "id": 7, "method": "ping"},
            result(8, json!("other")),
            result(7, json!("ours")),
        ]);
        let f = fake(vec![fixed(json_body(&batch)), fixed(json_body(&rpc_error(json!(3), -32601, "no such method")))]);
        assert_eq!(result_of(post(&f.url, None, 7).unwrap()), json!("ours"));
        match post(&f.url, None, 3).unwrap() {
            RpcReply::Response { result: None, error: Some(e), .. } => {
                assert_eq!((e.code, e.message.as_str()), (-32601, "no such method"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn json_without_our_id_or_other_content_types_are_protocol_errors() {
        let f = fake(vec![
            fixed(json_body(&result(9, json!({})))),
            fixed(Canned::status(200).header("Content-Type", "text/html").body("<html>portal</html>")),
            fixed(Canned::status(200).header("Content-Type", "application/json").body("not json")),
        ]);
        for _ in 0..3 {
            assert_eq!(post(&f.url, None, 1).unwrap_err().kind, NetErrorKind::McpProtocol);
        }
    }

    #[test]
    fn sse_skips_priming_notifications_requests_and_other_ids() {
        let mut stream = String::new();
        stream.push_str("id: p0\r\ndata:\r\n\r\n");
        stream.push_str(&frame(&json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": {}})));
        stream.push_str(&frame(&json!({"jsonrpc": "2.0", "id": 1, "method": "sampling/createMessage", "params": {}})));
        stream.push_str(&frame(&result(99, json!("not ours"))));
        stream.push_str(": keepalive\n\n");
        stream.push_str(&format!("data: {}\r\n\r\n", result(1, json!({"text": "노트 작성"}))));
        let bytes = stream.as_bytes();
        // Split mid-line, mid-CRLF and in the middle of a 3-byte Hangul char.
        let hangul = stream.find("노").unwrap() + 1;
        let crlf = stream.find("\r\n").unwrap() + 1;
        let cuts = [0, crlf, 40, hangul, bytes.len()];
        let chunks: Vec<&[u8]> = cuts.windows(2).map(|w| &bytes[w[0]..w[1]]).collect();
        let f = fake(vec![fixed(sse(&chunks))]);
        assert_eq!(result_of(post(&f.url, None, 1).unwrap()), json!({"text": "노트 작성"}));
    }

    #[test]
    fn sse_frame_over_the_cap_is_too_large() {
        let mut l = lim();
        l.max_frame = 1024;
        let big = format!("data: {}", "x".repeat(2000));
        // An unfinished frame over the cap.
        let f = fake(vec![fixed(sse(&[big.as_bytes()]))]);
        let e = block_on(post_rpc(&ep(&f.url, None), &Exchange::default(), Some(1), msg(1), l)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::TooLarge);
        // A whole frame over the cap in one chunk.
        let whole = format!("{big}\n\n");
        let f = fake(vec![fixed(sse(&[whole.as_bytes()]))]);
        let e = block_on(post_rpc(&ep(&f.url, None), &Exchange::default(), Some(1), msg(1), l)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::TooLarge);
    }

    #[test]
    fn sse_total_over_the_cap_is_too_large() {
        let mut l = lim();
        l.max_body = 2048;
        let note = frame(&json!({"jsonrpc": "2.0", "method": "notifications/message", "params": {"x": "y".repeat(500)}}));
        let chunks: Vec<&[u8]> = (0..6).map(|_| note.as_bytes()).collect();
        let f = fake(vec![fixed(sse(&chunks))]);
        let e = block_on(post_rpc(&ep(&f.url, None), &Exchange::default(), Some(1), msg(1), l)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::TooLarge);
    }

    #[test]
    fn sse_idle_and_total_timeouts() {
        // Silent for longer than `idle`.
        let mut l = lim();
        l.idle = Duration::from_millis(200);
        let f = fake(vec![fixed(sse_paced(&[b": hi\n\n", b": late\n\n"], Duration::from_millis(600)))]);
        let t = Instant::now();
        let e = block_on(post_rpc(&ep(&f.url, None), &Exchange::default(), Some(1), msg(1), l)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Timeout);
        assert!(t.elapsed() < Duration::from_millis(1500));
        // Keepalives keep coming, but the whole exchange runs past `total`.
        let mut l = lim();
        l.total = Duration::from_millis(300);
        let keepalives: Vec<&[u8]> = (0..20).map(|_| b": k\n\n".as_slice()).collect();
        let f = fake(vec![fixed(sse_paced(&keepalives, Duration::from_millis(50)))]);
        let e = block_on(post_rpc(&ep(&f.url, None), &Exchange::default(), Some(1), msg(1), l)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Timeout);
    }

    #[test]
    fn a_stream_ending_after_an_event_id_resumes_with_get() {
        let f = fake(vec![
            fixed(sse(&[b"retry: 10\nid: e1\ndata:\n\n"]).header("Mcp-Session-Id", "s-9")),
            fixed(sse(&[frame(&result(1, json!("resumed"))).as_bytes()])),
        ]);
        let ex = Exchange { session: Some("s-9".into()), protocol: Some("2025-11-25".into()) };
        let t = Instant::now();
        let r = block_on(post_rpc(&ep(&f.url, Some(TOKEN)), &ex, Some(1), msg(1), lim())).unwrap();
        assert!(t.elapsed() < Duration::from_millis(900), "retry 10 ms is honoured");
        match r {
            RpcReply::Response { result, session, .. } => {
                assert_eq!(result, Some(json!("resumed")));
                assert_eq!(session.as_deref(), Some("s-9"), "the POST's session id is kept");
            }
            other => panic!("{other:?}"),
        }
        let g = f.request(1);
        assert_eq!(g.method, "GET");
        assert_eq!(g.header("last-event-id"), Some("e1"));
        assert_eq!(g.header("accept"), Some("text/event-stream"));
        assert_eq!(g.header("authorization"), Some("Bearer test-token-123"));
        assert_eq!(g.header("mcp-session-id"), Some("s-9"));
        assert_eq!(g.header("mcp-protocol-version"), Some("2025-11-25"));
    }

    #[test]
    fn resume_is_tried_at_most_twice_and_uses_the_newest_id() {
        let f = fake(vec![
            fixed(sse(&[b"retry: 10\nid: e1\ndata:\n\n"])),
            fixed(sse(&[b"id: e2\ndata:\n\n"])),
            fixed(sse(&[b": nothing new\n\n"])),
            fixed(json_body(&result(1, json!("never asked")))),
        ]);
        assert_eq!(post(&f.url, None, 1).unwrap_err().kind, NetErrorKind::NoResult);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(f.count(), 3);
        assert_eq!(f.request(1).header("last-event-id"), Some("e1"));
        assert_eq!(f.request(2).header("last-event-id"), Some("e2"));
    }

    #[test]
    fn a_stream_ending_without_an_event_id_is_no_result() {
        let f = fake(vec![fixed(sse(&[frame(&json!({"jsonrpc": "2.0", "method": "notifications/x"})).as_bytes()]))]);
        assert_eq!(post(&f.url, None, 1).unwrap_err().kind, NetErrorKind::NoResult);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(f.count(), 1);
    }

    #[test]
    fn resume_delay_is_capped_at_five_seconds() {
        assert_eq!(resume_delay(Some(10)), Duration::from_millis(10));
        assert_eq!(resume_delay(Some(60_000)), Duration::from_secs(5));
        assert_eq!(resume_delay(None), Duration::from_secs(1));
    }

    #[test]
    fn accepted_for_202_and_for_notifications() {
        let f = fake(vec![fixed(Canned::status(202)), fixed(Canned::status(202)), fixed(json_body(&json!({})))]);
        assert_eq!(post(&f.url, None, 1).unwrap(), RpcReply::Accepted);
        let note = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        let e = ep(&f.url, None);
        assert_eq!(block_on(post_rpc(&e, &Exchange::default(), None, note.clone(), lim())).unwrap(), RpcReply::Accepted);
        assert_eq!(block_on(post_rpc(&e, &Exchange::default(), None, note, lim())).unwrap(), RpcReply::Accepted);
    }

    #[test]
    fn auth_failures_are_mcp_auth_without_the_token() {
        let f = fake(vec![echo_auth(401), echo_auth(403)]);
        for _ in 0..2 {
            let e = post(&f.url, Some(TOKEN), 1).unwrap_err();
            assert_eq!(e.kind, NetErrorKind::McpAuth);
            assert!(!serde_json::to_string(&e).unwrap().contains(TOKEN));
            assert!(!format!("{e:?}").contains(TOKEN));
        }
    }

    #[test]
    fn redirects_are_not_followed() {
        let second = serve(vec![Canned::ok("{}")]);
        let f = fake(vec![fixed(Canned::status(307).header("Location", format!("{}/steal", second.url)))]);
        let e = post(&f.url, Some(TOKEN), 1).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Redirect);
        assert_eq!(e.location.as_deref(), Some(second.url.as_str()));
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(second.request_count(), 0);
    }

    #[test]
    fn bad_request_with_modern_codes_is_modern_only() {
        let modern = |code: i64| -> Reply {
            let body = rpc_error(Value::Null, code, "unsupported").to_string();
            fixed(Canned::status(400).header("Content-Type", "application/json").body(body))
        };
        let f = fake(vec![
            modern(-32022),
            modern(-32020),
            modern(-32600),
            fixed(Canned::status(404).header("Content-Type", "application/json").body("{}")),
        ]);
        assert_eq!(post(&f.url, None, 1).unwrap_err().kind, NetErrorKind::McpModernOnly);
        assert_eq!(post(&f.url, None, 1).unwrap_err().kind, NetErrorKind::McpModernOnly);
        let e = post(&f.url, None, 1).unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(400)));
        let e = post(&f.url, None, 1).unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(404)));
    }

    #[test]
    fn unusable_session_ids_are_protocol_errors() {
        let ok = json_body(&result(1, json!({})));
        let f = fake(vec![
            fixed(ok.clone().header("Mcp-Session-Id", "has space")),
            fixed(ok.clone().header("Mcp-Session-Id", "x".repeat(1025))),
            fixed(ok.clone().header("Mcp-Session-Id", "caf\u{e9}")),
            fixed(ok.clone().header("Mcp-Session-Id", "x".repeat(1024))),
        ]);
        for _ in 0..3 {
            assert_eq!(post(&f.url, None, 1).unwrap_err().kind, NetErrorKind::McpProtocol);
        }
        assert!(post(&f.url, None, 1).is_ok());
    }

    #[test]
    fn a_token_to_plain_http_off_this_computer_is_insecure_and_nothing_is_sent() {
        let t = Instant::now();
        let e = block_on(post_rpc(&ep("http://10.255.255.1:9/mcp", Some(TOKEN)), &Exchange::default(), Some(1), msg(1), lim()))
            .unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Insecure);
        assert!(t.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn cancel_mid_stream_drops_the_stream() {
        let f = fake(vec![fixed(sse_paced(&[b"id: p\ndata:\n\n", b": late\n\n"], Duration::from_millis(100)).chunk(
            Duration::from_secs(3),
            b": later\n\n",
        ))]);
        let net = Arc::new(NetState::default());
        let (n2, url) = (net.clone(), f.url.clone());
        let t = Instant::now();
        let h = std::thread::spawn(move || {
            block_on(post_rpc_in(&n2, Some("m1"), &ep(&url, Some(TOKEN)), &Exchange::default(), Some(1), msg(1), lim()))
        });
        std::thread::sleep(Duration::from_millis(400));
        assert!(net.cancel("m1"));
        assert_eq!(h.join().unwrap().unwrap_err().kind, NetErrorKind::Cancelled);
        assert!(t.elapsed() < Duration::from_secs(2));
        assert!(!net.cancel("m1"), "a finished request is forgotten");
    }

    #[test]
    fn the_token_never_appears_in_errors_replies_or_debug() {
        let echoed = rpc_error(json!(1), -32000, &format!("bad token {TOKEN}"));
        let f = fake(vec![
            echo_auth(500),
            fixed(sse(&[frame(&echoed).as_bytes()])),
            fixed(json_body(&result(1, json!({"echo": format!("Bearer {TOKEN}")})))),
        ]);
        let e = post(&f.url, Some(TOKEN), 1).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Status);
        assert!(e.body.as_deref().unwrap().contains("***"));
        assert!(!serde_json::to_string(&e).unwrap().contains(TOKEN));
        assert!(!format!("{e:?}").contains(TOKEN));
        let r = post(&f.url, Some(TOKEN), 1).unwrap();
        assert!(!format!("{r:?}").contains(TOKEN));
        match r {
            RpcReply::Response { error: Some(err), .. } => assert_eq!(err.message, "bad token ***"),
            other => panic!("{other:?}"),
        }
        let r = post(&f.url, Some(TOKEN), 1).unwrap();
        assert!(!format!("{r:?}").contains(TOKEN));
        let endpoint = ep("https://mcp.example/mcp", Some(TOKEN));
        assert!(!format!("{endpoint:?}").contains(TOKEN));
        let ex = Exchange { session: Some("secret-session".into()), protocol: None };
        assert!(!format!("{ex:?}").contains("secret-session"));
    }

    #[test]
    fn delete_session_sends_delete_only_with_a_session_and_ignores_405() {
        let f = fake(vec![fixed(Canned::status(405))]);
        let e = ep(&f.url, Some(TOKEN));
        block_on(delete_session(&e, &Exchange::default()));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(f.count(), 0, "no session, nothing sent");
        let ex = Exchange { session: Some("s-1".into()), protocol: Some("2025-06-18".into()) };
        block_on(delete_session(&e, &ex));
        let r = f.request(0);
        assert_eq!(r.method, "DELETE");
        assert_eq!(r.header("mcp-session-id"), Some("s-1"));
        assert_eq!(r.header("authorization"), Some("Bearer test-token-123"));
    }
}
