//! Streamed LLM chat (spec §6.2, ruling R1): `llm_chat_stream` sends the
//! same request as `llm_chat` (the guards are shared through
//! `llm::chat_target`) and relays the answer's raw frames to the webview as
//! `llm://frame {requestId, data}`; `app/src/ai/streamAssembler.ts` turns
//! them into a chat result.
//!
//! - OpenAI-compatible answers are SSE (`sse::SseParser`); each `data` is one
//!   frame and `[DONE]` ends the stream (not relayed). A 2xx that is plain
//!   JSON (a server that ignored `stream: true`) comes back whole as `text`.
//! - Ollama answers are NDJSON (`LineFramer`, 64 KiB per line); each line is
//!   one frame and the line with `"done": true` ends the stream. A 2xx
//!   `application/json` body that is one JSON value comes back whole as
//!   `text`; one that is not (NDJSON mislabelled) is still framed by line.
//! - Every chunk must arrive within `SSE_IDLE`, the whole stream within
//!   `LLM_TIMEOUT` (`timeout`); a frame over `SSE_MAX_FRAME`, a line over
//!   64 KiB or more than 8 MiB in all is `tooLarge`.
//! - A non-2xx answer resolves `{status, text}` with the body's first
//!   `BODY_EXCERPT` chars (the key redacted first), so the webview can fall
//!   back to one non-streamed call; nothing was relayed then. A 3xx is the
//!   `redirect` error, as for `llm_chat`.
//! - The key in use is redacted from every frame and every error.
//! - `net_cancel(requestId)` stops it (`cancelled`); no frame follows.

use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, State};

use super::config::{LlmKind, ServiceConfig};
use super::error::{redact_text, NetError, NetErrorKind};
use super::http::{
    cancelled, client, header_map, net_error, read_capped, redirect_error, refuse_insecure, take_utf8, too_large, Registration,
    MAX_BODY,
};
use super::llm::{auth_headers, chat_target, ChatTarget, LLM_TIMEOUT};
use super::secrets::{SecretStore, Secrets};
use super::sse::{SseParser, SSE_IDLE, SSE_MAX_FRAME};
use super::NetState;
use crate::vault::{SettingsFile, VaultState};

/// The event each frame goes out on (`tests/ipc-events.json`).
pub const FRAME_EVENT: &str = "llm://frame";
/// The most one streamed answer may hold, framing included.
pub const STREAM_MAX_TOTAL: usize = 8 * 1024 * 1024;
/// The longest NDJSON line.
pub const NDJSON_MAX_LINE: usize = 64 * 1024;
/// How much of a non-2xx body is read (only an excerpt is returned).
const ERROR_BODY_READ: usize = 64 * 1024;

/// One relayed frame: an SSE `data` value or an NDJSON line.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LlmFrame {
    pub request_id: String,
    pub data: String,
}

/// How a stream ended: `{status, done: true, frames}` after the frames, or
/// `{status, text}` for a non-2xx answer (an excerpt) or a 2xx JSON answer
/// that was not streamed (the whole text). `frames` lets the webview wait
/// for frames the command result overtook.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamEnd {
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames: Option<u64>,
}

impl StreamEnd {
    fn finished(frames: u64) -> StreamEnd {
        StreamEnd { status: 200, text: None, done: Some(true), frames: Some(frames) }
    }

    fn text(status: u16, text: String) -> StreamEnd {
        StreamEnd { status, text: Some(text), done: None, frames: None }
    }
}

/// The idle, total-time and total-size caps (tests shrink them).
#[derive(Clone, Copy, Debug)]
pub struct StreamLimits {
    pub idle: Duration,
    pub total: Duration,
    pub max_bytes: usize,
}

impl Default for StreamLimits {
    fn default() -> Self {
        StreamLimits { idle: SSE_IDLE, total: LLM_TIMEOUT, max_bytes: STREAM_MAX_TOTAL }
    }
}

/// Splits text chunks into lines (NDJSON). `\r\n` is read as `\n`, blank
/// lines are skipped, and a line (finished or not) longer than `max` bytes is
/// `tooLarge`.
pub struct LineFramer {
    buf: String,
    max: usize,
}

impl LineFramer {
    pub fn new(max: usize) -> Self {
        LineFramer { buf: String::new(), max }
    }

    /// Adds a chunk and returns the lines it completed.
    pub fn push(&mut self, chunk: &str) -> Result<Vec<String>, NetError> {
        self.buf.push_str(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.buf.find('\n') {
            let raw: String = self.buf.drain(..=pos).collect();
            let line = raw.trim_end_matches(['\n', '\r']);
            if line.len() > self.max {
                return Err(too_large());
            }
            if !line.trim().is_empty() {
                lines.push(line.to_string());
            }
        }
        if self.buf.len() > self.max {
            return Err(too_large());
        }
        Ok(lines)
    }

    /// The last line, when the stream ended without a newline after it.
    pub fn finish(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.buf);
        let rest = rest.trim_end_matches('\r');
        (!rest.trim().is_empty()).then(|| rest.to_string())
    }
}

fn timed_out() -> NetError {
    NetError::new(NetErrorKind::Timeout, "the server did not answer in time")
}

/// `fut`, or `timeout` when it takes longer than `limit`.
async fn within<T>(limit: Duration, fut: impl std::future::Future<Output = T>) -> Result<T, NetError> {
    tokio::time::timeout(limit, fut).await.map_err(|_| timed_out())
}

/// True for an Ollama line that says the answer is complete.
fn ndjson_done(line: &str) -> bool {
    serde_json::from_str::<Value>(line).ok().and_then(|v| v.get("done").and_then(Value::as_bool)) == Some(true)
}

/// The first bytes of a non-2xx body, at most `ERROR_BODY_READ`.
async fn read_prefix(resp: reqwest::Response, idle: Duration) -> Result<Vec<u8>, NetError> {
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while body.len() < ERROR_BODY_READ {
        let Some(chunk) = within(idle, stream.next()).await? else { break };
        body.extend_from_slice(&chunk.map_err(net_error)?);
    }
    body.truncate(ERROR_BODY_READ);
    Ok(body)
}

/// Counts and relays frames, redacting the key from each.
struct Relay<'a, F: Fn(String)> {
    key: Option<&'a str>,
    on_frame: &'a F,
    count: u64,
}

impl<F: Fn(String)> Relay<'_, F> {
    fn send(&mut self, data: &str) {
        self.count += 1;
        (self.on_frame)(redact_text(data, self.key));
    }
}

/// Sends the request and relays the frames (see the module doc).
async fn read_stream(
    target: &ChatTarget,
    provider: LlmKind,
    body: Value,
    limits: StreamLimits,
    on_frame: &impl Fn(String),
) -> Result<StreamEnd, NetError> {
    let key = target.key.as_deref();
    let accept = match provider {
        LlmKind::Ollama => "application/x-ndjson",
        _ => "text/event-stream",
    };
    let headers = header_map(&auth_headers(key, accept))?;
    // No reqwest timeout: the idle and total caps bound the stream instead.
    let req = client().post(target.url.clone()).headers(headers).json(&body);
    let resp = within(limits.idle, req.send()).await?.map_err(net_error)?;
    let status = resp.status().as_u16();
    if (300..400).contains(&status) {
        return Err(redirect_error(&resp, &target.url));
    }
    if !(200..300).contains(&status) {
        let bytes = read_prefix(resp, limits.idle).await?;
        // `NetError::status` redacts the whole text before it cuts the excerpt.
        let excerpt = NetError::status(status, &String::from_utf8_lossy(&bytes), key).body.unwrap_or_default();
        return Ok(StreamEnd::text(status, excerpt));
    }
    let json_answer = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim_start().to_ascii_lowercase().starts_with("application/json"));
    let mut relay = Relay { key, on_frame, count: 0 };
    if json_answer {
        let bytes = within(limits.idle, read_capped(resp, MAX_BODY)).await??;
        let text = String::from_utf8_lossy(&bytes);
        // One JSON value (even pretty-printed) is a whole answer. Ollama NDJSON
        // mislabelled `application/json` is still framed line by line.
        if provider != LlmKind::Ollama || serde_json::from_str::<Value>(&text).is_ok() {
            return Ok(StreamEnd::text(status, redact_text(&text, key)));
        }
        let mut lines = LineFramer::new(NDJSON_MAX_LINE);
        for line in lines.push(&text)?.into_iter().chain(lines.finish()) {
            relay.send(&line);
            if ndjson_done(&line) {
                break;
            }
        }
        return Ok(StreamEnd::finished(relay.count));
    }
    let mut sse = SseParser::default();
    let mut lines = LineFramer::new(NDJSON_MAX_LINE);
    let mut stream = resp.bytes_stream();
    let mut tail = Vec::new();
    let mut received = 0usize;
    while let Some(chunk) = within(limits.idle, stream.next()).await? {
        let chunk = chunk.map_err(net_error)?;
        received += chunk.len();
        if received > limits.max_bytes {
            return Err(too_large());
        }
        tail.extend_from_slice(&chunk);
        let text = take_utf8(&mut tail);
        if provider == LlmKind::Ollama {
            for line in lines.push(&text)? {
                relay.send(&line);
                if ndjson_done(&line) {
                    return Ok(StreamEnd::finished(relay.count));
                }
            }
        } else {
            for frame in sse.push(&text) {
                if frame.data.len() > SSE_MAX_FRAME {
                    return Err(too_large());
                }
                if frame.data.trim() == "[DONE]" {
                    return Ok(StreamEnd::finished(relay.count));
                }
                relay.send(&frame.data);
            }
            if sse.pending_len() + tail.len() > SSE_MAX_FRAME {
                return Err(too_large());
            }
        }
    }
    if let Some(line) = lines.finish() {
        relay.send(&line);
    }
    Ok(StreamEnd::finished(relay.count))
}

/// One streamed chat request to the saved provider. The guards are
/// `llm_call`'s (`chat_target`: saved provider, JSON object body within
/// `LLM_MAX_REQUEST`, the keychain key only for OpenAI-compatible, the
/// `allow_http` rule), all checked before anything is sent. `on_frame` gets
/// each frame's data with the key redacted. Cancellable through `request_id`.
#[allow(clippy::too_many_arguments)]
pub async fn llm_stream_call(
    net: &NetState,
    cfg: &ServiceConfig,
    store: &dyn SecretStore,
    request_id: &str,
    provider: LlmKind,
    body: Value,
    limits: StreamLimits,
    on_frame: impl Fn(String),
) -> Result<StreamEnd, NetError> {
    let target = chat_target(cfg, store, provider, &body)?;
    let key = target.key.clone();
    let result = async {
        refuse_insecure(&target.url, key.is_some(), target.allow_http)?;
        let notify = net.register(request_id)?;
        let _registration = Registration { net, id: request_id };
        tokio::select! {
            r = tokio::time::timeout(limits.total, read_stream(&target, provider, body, limits, &on_frame)) => {
                r.unwrap_or_else(|_| Err(timed_out()))
            }
            _ = notify.notified() => Err(cancelled()),
        }
    }
    .await;
    result.map_err(|e| e.redact(key.as_deref()))
}

/// Streams a chat answer from the saved provider, sending each frame to the
/// webview as `llm://frame {requestId, data}` (see the module doc).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn llm_chat_stream<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    request_id: String,
    provider: LlmKind,
    body: Value,
) -> Result<StreamEnd, NetError> {
    let cfg = ServiceConfig::load(&settings.0, vault.root().ok().as_deref())?;
    let id = request_id.clone();
    let emit = move |data: String| {
        // A frame the webview cannot get is caught there by the frame count.
        let _ = app.emit(FRAME_EVENT, LlmFrame { request_id: id.clone(), data });
    };
    llm_stream_call(&net, &cfg, secrets.0.as_ref(), &request_id, provider, body, StreamLimits::default(), emit).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::error::BODY_EXCERPT;
    use crate::net::llm::LLM_MAX_REQUEST;
    use crate::net::secrets::{account, MemoryStore, Slot};
    use crate::net::testserver::{serve, Canned};
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    use tauri::async_runtime::block_on;

    fn cfg(settings: Value) -> ServiceConfig {
        ServiceConfig::from_settings_json(&settings.to_string())
    }

    fn openai(url: &str) -> ServiceConfig {
        cfg(json!({"llmProvider": "openai", "llmEndpointOpenai": url}))
    }

    fn ollama(url: &str) -> ServiceConfig {
        cfg(json!({"llmProvider": "ollama", "llmEndpointOllama": url}))
    }

    fn store_with_key(c: &ServiceConfig, key: &str) -> MemoryStore {
        let store = MemoryStore::default();
        store.set(&account(Slot::LlmOpenai, c).unwrap(), key).unwrap();
        store
    }

    fn limits() -> StreamLimits {
        StreamLimits { idle: Duration::from_secs(5), ..StreamLimits::default() }
    }

    /// A 2xx with the given content type whose body arrives in `chunks`.
    fn streamed(content_type: &str, chunks: Vec<&[u8]>) -> Canned {
        chunks
            .into_iter()
            .fold(Canned::ok("").header("Content-Type", content_type.to_string()), |c, b| c.chunk(Duration::from_millis(15), b))
    }

    fn run(
        c: &ServiceConfig,
        store: &MemoryStore,
        provider: LlmKind,
        body: Value,
        limits: StreamLimits,
    ) -> (Result<StreamEnd, NetError>, Vec<String>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        let r = block_on(llm_stream_call(&NetState::default(), c, store, "s1", provider, body, limits, move |d| {
            s2.lock().unwrap().push(d)
        }));
        let frames = seen.lock().unwrap().clone();
        (r, frames)
    }

    fn done(frames: u64) -> StreamEnd {
        StreamEnd { status: 200, text: None, done: Some(true), frames: Some(frames) }
    }

    #[test]
    fn line_framer_splits_lines_across_chunks() {
        let mut f = LineFramer::new(64);
        assert_eq!(f.push("{\"a\":").unwrap(), Vec::<String>::new());
        assert_eq!(f.push("1}\r\n\n{\"b\"").unwrap(), vec!["{\"a\":1}".to_string()]);
        assert_eq!(f.push(":2}\n{\"c\":3}").unwrap(), vec!["{\"b\":2}".to_string()]);
        assert_eq!(f.finish(), Some("{\"c\":3}".to_string()));
        assert_eq!(f.finish(), None);
    }

    #[test]
    fn line_framer_refuses_an_over_long_line() {
        let mut f = LineFramer::new(8);
        assert_eq!(f.push("123456789\n").unwrap_err().kind, NetErrorKind::TooLarge);
        let mut f = LineFramer::new(8);
        assert!(f.push("12345").is_ok());
        assert_eq!(f.push("6789").unwrap_err().kind, NetErrorKind::TooLarge);
    }

    #[test]
    fn openai_sse_frames_keep_split_korean_and_stop_at_done() {
        let first = "data: {\"choices\":[{\"delta\":{\"content\":\"안녕\"}}]}\n\n".as_bytes();
        // Split after the first byte of the three-byte '녕'.
        let cut = first.len() - 9;
        let s = serve(vec![streamed(
            "text/event-stream",
            vec![
                &first[..cut],
                &first[cut..],
                b": keepalive\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"a\"}}]}}]}\n",
                b"\ndata: [DONE]\n\n",
                b"data: {\"after\":\"done\"}\n\n",
            ],
        )]);
        let c = openai(&s.url);
        let store = store_with_key(&c, "sk-k");
        let (r, frames) = run(&c, &store, LlmKind::Openai, json!({"model": "m", "stream": true}), limits());
        assert_eq!(r.unwrap(), done(2));
        assert_eq!(
            frames,
            vec![
                r#"{"choices":[{"delta":{"content":"안녕"}}]}"#.to_string(),
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"a"}}]}}]}"#.to_string(),
            ]
        );
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].path, "/v1/chat/completions");
        assert_eq!(reqs[0].header("accept"), Some("text/event-stream"));
        assert_eq!(reqs[0].header("authorization"), Some("Bearer sk-k"));
        assert_eq!(serde_json::from_str::<Value>(&reqs[0].body).unwrap()["stream"], true);
    }

    #[test]
    fn ollama_ndjson_lines_are_frames_and_the_done_line_ends_it() {
        let s = serve(vec![streamed(
            "application/x-ndjson",
            vec![
                "{\"message\":{\"content\":\"실".as_bytes(),
                "험\"},\"done\":false}\n{\"message\":{\"content\":\"\",\"tool_calls\":[{\"function\":{\"name\":\"t\",\"arguments\":{}}}]},\"done\":true}\n".as_bytes(),
                b"{\"late\":1}\n",
            ],
        )]);
        let c = ollama(&s.url);
        let store = store_with_key(&openai("http://127.0.0.1:1"), "sk-k");
        let (r, frames) = run(&c, &store, LlmKind::Ollama, json!({"model": "m", "stream": true}), limits());
        assert_eq!(r.unwrap(), done(2));
        assert_eq!(frames[0], r#"{"message":{"content":"실험"},"done":false}"#);
        assert!(frames[1].contains("tool_calls"));
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].path, "/api/chat");
        assert_eq!(reqs[0].header("authorization"), None);
    }

    #[test]
    fn a_last_ndjson_line_without_newline_still_counts() {
        let s = serve(vec![streamed("application/x-ndjson", vec![b"{\"message\":{\"content\":\"a\"}}"])]);
        let (r, frames) = run(&ollama(&s.url), &MemoryStore::default(), LlmKind::Ollama, json!({}), limits());
        assert_eq!(r.unwrap(), done(1));
        assert_eq!(frames, vec![r#"{"message":{"content":"a"}}"#.to_string()]);
    }

    #[test]
    fn an_over_long_frame_or_line_is_too_large() {
        let mut big = b"data: ".to_vec();
        big.extend(std::iter::repeat(b'x').take(SSE_MAX_FRAME + 10));
        let s = serve(vec![streamed("text/event-stream", vec![&big])]);
        let (r, frames) = run(&openai(&s.url), &MemoryStore::default(), LlmKind::Openai, json!({}), limits());
        assert_eq!(r.unwrap_err().kind, NetErrorKind::TooLarge);
        assert!(frames.is_empty());

        let line = vec![b'x'; NDJSON_MAX_LINE + 1];
        let s = serve(vec![streamed("application/x-ndjson", vec![&line])]);
        let (r, _) = run(&ollama(&s.url), &MemoryStore::default(), LlmKind::Ollama, json!({}), limits());
        assert_eq!(r.unwrap_err().kind, NetErrorKind::TooLarge);
    }

    #[test]
    fn a_stream_over_the_total_cap_is_too_large() {
        let frame = format!("data: {}\n\n", "y".repeat(200));
        let chunks: Vec<&[u8]> = (0..10).map(|_| frame.as_bytes()).collect();
        let s = serve(vec![streamed("text/event-stream", chunks)]);
        let small = StreamLimits { max_bytes: 1000, ..limits() };
        let (r, frames) = run(&openai(&s.url), &MemoryStore::default(), LlmKind::Openai, json!({}), small);
        assert_eq!(r.unwrap_err().kind, NetErrorKind::TooLarge);
        assert!(frames.len() < 5, "{}", frames.len());
    }

    #[test]
    fn an_idle_stream_times_out() {
        let s = serve(vec![Canned::ok("")
            .header("Content-Type", "text/event-stream")
            .chunk(Duration::from_millis(10), b"data: {}\n\n")
            .chunk(Duration::from_millis(2000), b"data: {}\n\n")]);
        let t = Instant::now();
        let quick = StreamLimits { idle: Duration::from_millis(200), ..limits() };
        let (r, frames) = run(&openai(&s.url), &MemoryStore::default(), LlmKind::Openai, json!({}), quick);
        assert_eq!(r.unwrap_err().kind, NetErrorKind::Timeout);
        assert_eq!(frames.len(), 1);
        assert!(t.elapsed() < Duration::from_millis(1500));
    }

    #[test]
    fn the_total_time_is_capped() {
        let chunks: Vec<&[u8]> = (0..40).map(|_| &b": keepalive\n\n"[..]).collect();
        let s = serve(vec![streamed("text/event-stream", chunks)]);
        let short = StreamLimits { idle: Duration::from_millis(200), total: Duration::from_millis(250), ..limits() };
        let t = Instant::now();
        let (r, _) = run(&openai(&s.url), &MemoryStore::default(), LlmKind::Openai, json!({}), short);
        assert_eq!(r.unwrap_err().kind, NetErrorKind::Timeout);
        assert!(t.elapsed() < Duration::from_millis(1500));
    }

    #[test]
    fn a_non_2xx_answer_is_its_status_and_a_capped_redacted_body() {
        let body = format!("{{\"error\":\"bad key sk-k\"}}{}", "z".repeat(5000));
        let s = serve(vec![Canned::status(400).header("Content-Type", "application/json").body(body)]);
        let c = openai(&s.url);
        let store = store_with_key(&c, "sk-k");
        let (r, frames) = run(&c, &store, LlmKind::Openai, json!({"stream": true}), limits());
        let end = r.unwrap();
        assert_eq!(end.status, 400);
        let text = end.text.unwrap();
        assert!(text.starts_with("{\"error\":\"bad key ***\"}"), "{text}");
        assert_eq!(text.chars().count(), BODY_EXCERPT);
        assert_eq!((end.done, end.frames), (None, None));
        assert!(frames.is_empty());
    }

    #[test]
    fn a_json_answer_to_a_stream_request_is_returned_as_text() {
        let s = serve(vec![Canned::ok(r#"{"choices":[{"message":{"content":"sk-k 한 번에"}}]}"#)]);
        let c = openai(&s.url);
        let store = store_with_key(&c, "sk-k");
        let (r, frames) = run(&c, &store, LlmKind::Openai, json!({"stream": true}), limits());
        let end = r.unwrap();
        assert_eq!(end.status, 200);
        assert_eq!(end.text.as_deref(), Some(r#"{"choices":[{"message":{"content":"*** 한 번에"}}]}"#));
        assert_eq!(end.done, None);
        assert!(frames.is_empty());
    }

    #[test]
    fn an_ollama_json_answer_is_text_even_pretty_printed() {
        let body = "{
  \"message\": {
    \"content\": \"한 번에\"
  },
  \"done\": true
}
";
        let s = serve(vec![Canned::ok(body)]);
        let (r, frames) = run(&ollama(&s.url), &MemoryStore::default(), LlmKind::Ollama, json!({}), limits());
        let end = r.unwrap();
        assert_eq!(end.status, 200);
        assert_eq!(end.text.as_deref(), Some(body));
        assert!(frames.is_empty());
    }

    #[test]
    fn ollama_ndjson_labelled_json_is_still_framed() {
        let s = serve(vec![streamed(
            "application/json",
            vec![b"{\"message\":{\"content\":\"a\"},\"done\":false}
{\"message\":{\"content\":\"b\"},\"done\":true}
{\"late\":1}
"],
        )]);
        let (r, frames) = run(&ollama(&s.url), &MemoryStore::default(), LlmKind::Ollama, json!({}), limits());
        assert_eq!(r.unwrap(), done(2));
        assert_eq!(frames.len(), 2);
    }

    #[test]
    fn frames_have_the_key_redacted() {
        let s = serve(vec![streamed("text/event-stream", vec![b"data: {\"echo\":\"sk-k\"}\n\n"])]);
        let c = openai(&s.url);
        let store = store_with_key(&c, "sk-k");
        let (_, frames) = run(&c, &store, LlmKind::Openai, json!({}), limits());
        assert_eq!(frames, vec![r#"{"echo":"***"}"#.to_string()]);
    }

    #[test]
    fn the_shared_guards_refuse_before_sending() {
        let s = serve(vec![Canned::ok("{}")]);
        let c = cfg(json!({"llmProvider": "ollama", "llmEndpointOllama": s.url, "llmEndpointOpenai": s.url}));
        let store = MemoryStore::default();
        for (provider, body) in [
            (LlmKind::Openai, json!({})),
            (LlmKind::Ollama, json!([1])),
            (LlmKind::Ollama, json!({"x": "a".repeat(LLM_MAX_REQUEST)})),
        ] {
            assert_eq!(run(&c, &store, provider, body, limits()).0.unwrap_err().kind, NetErrorKind::BadInput);
        }
        assert_eq!(run(&cfg(json!({})), &store, LlmKind::None, json!({}), limits()).0.unwrap_err().kind, NetErrorKind::NotConfigured);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(s.request_count(), 0);
    }

    #[test]
    fn a_key_never_goes_to_plain_http_off_this_computer() {
        let c = openai("http://10.255.255.1:9");
        let store = store_with_key(&c, "sk-k");
        let t = Instant::now();
        assert_eq!(run(&c, &store, LlmKind::Openai, json!({}), limits()).0.unwrap_err().kind, NetErrorKind::Insecure);
        assert!(t.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn cancel_stops_the_frames() {
        let s = serve(vec![Canned::ok("")
            .header("Content-Type", "text/event-stream")
            .chunk(Duration::from_millis(50), b"data: {\"n\":1}\n\n")
            .chunk(Duration::from_millis(3000), b"data: {\"n\":2}\n\n")]);
        let c = openai(&s.url);
        let net = Arc::new(NetState::default());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (n2, s2) = (net.clone(), seen.clone());
        let h = std::thread::spawn(move || {
            block_on(llm_stream_call(&n2, &c, &MemoryStore::default(), "st-1", LlmKind::Openai, json!({}), limits(), move |d| {
                s2.lock().unwrap().push(d)
            }))
        });
        std::thread::sleep(Duration::from_millis(300));
        assert!(net.cancel("st-1"));
        assert_eq!(h.join().unwrap().unwrap_err().kind, NetErrorKind::Cancelled);
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(!net.cancel("st-1")); // forgotten once it ended
    }

    #[test]
    fn frame_and_end_serialize_camel_case() {
        let f = LlmFrame { request_id: "r".into(), data: "d".into() };
        assert_eq!(serde_json::to_value(&f).unwrap(), json!({"requestId": "r", "data": "d"}));
        assert_eq!(serde_json::to_value(done(3)).unwrap(), json!({"status": 200, "done": true, "frames": 3}));
        let e = StreamEnd { status: 400, text: Some("x".into()), done: None, frames: None };
        assert_eq!(serde_json::to_value(&e).unwrap(), json!({"status": 400, "text": "x"}));
    }
}
