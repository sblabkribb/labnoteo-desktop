//! bfworkflow calls (D7, D8): `bfw_request` for the saved connection,
//! `bfw_probe` for a connection test, `bfw_base` for opening pages in the
//! browser, and `bfw_generate_notes`, which drafts notes from a design over
//! SSE (`ai` scope) with progress events.
//!
//! - The webview names a path; the base URL comes from the open vault's stored
//!   settings (`server`) or from the desktop app's `runtime.json` (`desktop`),
//!   and the path must be on a fixed GET allow-list (`bfw_path_allowed`).
//! - The key (`X-API-Key`) comes from the keychain slot of the connection
//!   (`bfwServer` or `bfwDesktop`), never from the webview, except a key typed
//!   into the probe.
//! - Only `read`-scope GET endpoints and the `ai`-scope note generation are
//!   reachable here; no `write`-scope call exists. bfworkflow is a private
//!   repository: this module is written from the documented data shapes, with
//!   no bfworkflow source copied.

use std::path::Path;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, State};

use super::config::{bfw_desktop_base, bfw_runtime_path, join_path, origin, parse_origin_url, BfwConnection, ServiceConfig, Url};
use super::error::{redact_text, NetError, NetErrorKind};
use super::http::{
    cancelled, client, header_map, net_error, parse_json, read_capped, redirect_error, refuse_insecure, send, take_utf8, too_large, Outgoing,
    Registration, MAX_BODY,
};
use super::secrets::{key_for, validate_secret, SecretStore, Secrets, Slot};
use super::sse::{SseFrame, SseParser, SSE_IDLE, SSE_MAX_FRAME, SSE_TOTAL};
use super::NetState;
use crate::vault::{SettingsFile, VaultState};

/// The only query keys a request may carry.
pub const BFW_QUERY_KEYS: [&str; 1] = ["include_archived"];
pub const BFW_TIMEOUT: Duration = Duration::from_secs(30);

const NOT_RUNNING: &str = "bfworkflow desktop app is not running";

fn not_running() -> NetError {
    NetError::new(NetErrorKind::NotConfigured, NOT_RUNNING)
}

fn key_missing() -> NetError {
    NetError::new(NetErrorKind::KeyMissing, "no bfworkflow API key is set for this address")
}

fn forbidden() -> NetError {
    NetError::new(NetErrorKind::ForbiddenPath, "this bfworkflow address is not allowed")
}

/// `^[A-Za-z0-9_-]{1,64}$`
fn is_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `true` for exactly the GET paths the app reads (see the SP6 plan, Task 7).
/// The path must start with a single `/` and hold no `..`, `//`, `?`, `#`,
/// `%` or `\`.
pub fn bfw_path_allowed(path: &str) -> bool {
    if !path.starts_with('/') || path.contains("..") || path.contains("//") {
        return false;
    }
    if path.contains(['?', '#', '%', '\\']) {
        return false;
    }
    let parts: Vec<&str> = path[1..].split('/').collect();
    match parts.as_slice() {
        ["api", "auth", "me"]
        | ["api", "workflow-catalog"]
        | ["api", "uo-catalog-json"]
        | ["api", "services"]
        | ["api", "workflows-design"]
        | ["api", "design-usage", "catalog-workflows"]
        | ["api", "design-usage", "catalog-unit-operations"]
        | ["api", "ai", "llm-thinking-status"] => true,
        ["api", "services", id] => is_id(id),
        ["api", "services", id, "current-design"] => is_id(id),
        ["api", "service-workflows", id, "current-design"] => is_id(id),
        _ => false,
    }
}

/// The base URL and key slot of the saved connection. `Server` gives the
/// saved `bfwUrl` (`notConfigured` when invalid); `Desktop` gives the
/// loopback base from `runtime` (`notConfigured`, "bfworkflow desktop app is
/// not running", when the file is missing or unusable).
pub fn bfw_target(cfg: &ServiceConfig, runtime: Option<&Path>) -> Result<(Url, Slot), NetError> {
    match cfg.bfw_connection {
        BfwConnection::Server => {
            let url = cfg
                .bfw_url
                .clone()
                .ok_or_else(|| NetError::new(NetErrorKind::NotConfigured, "no valid bfworkflow address is set"))?;
            Ok((url, Slot::BfwServer))
        }
        BfwConnection::Desktop => desktop_target(runtime),
    }
}

fn desktop_target(runtime: Option<&Path>) -> Result<(Url, Slot), NetError> {
    let base = runtime.and_then(bfw_desktop_base).ok_or_else(not_running)?;
    Ok((base, Slot::BfwDesktop))
}

/// One keyed GET to `url`, parsed as JSON (an empty 2xx body reads as
/// `null`). For the desktop app a refused connection means the app is not
/// running (`runtime.json` survives a crash), so `offline` becomes
/// `notConfigured`.
async fn keyed_get(net: &NetState, allow_http: bool, slot: Slot, url: Url, key: String) -> Result<Value, NetError> {
    let out = Outgoing {
        method: reqwest::Method::GET,
        url,
        headers: vec![("X-API-Key", key.clone()), ("Accept", "application/json".to_string())],
        json: None,
        timeout: Some(BFW_TIMEOUT),
        max_body: MAX_BODY,
        secret: Some(key.clone()),
        allow_http,
    };
    let incoming = match send(net, None, out).await {
        Err(e) if slot == Slot::BfwDesktop && e.kind == NetErrorKind::Offline => return Err(not_running()),
        other => other?,
    };
    if incoming.text.trim().is_empty() {
        return Ok(Value::Null);
    }
    parse_json(&incoming.text).map_err(|e| e.redact(Some(&key)))
}

/// One bfworkflow GET over the saved connection, with the keychain key of
/// the connection's slot. The path and the query keys are checked first, so a
/// refused request sends nothing; a missing key is `keyMissing`.
pub async fn bfw_call(
    net: &NetState,
    cfg: &ServiceConfig,
    store: &dyn SecretStore,
    runtime: Option<&Path>,
    path: &str,
    query: Option<Vec<(String, String)>>,
) -> Result<Value, NetError> {
    if !bfw_path_allowed(path) {
        return Err(forbidden());
    }
    let query = query.unwrap_or_default();
    if let Some((k, _)) = query.iter().find(|(k, _)| !BFW_QUERY_KEYS.contains(&k.as_str())) {
        return Err(NetError::new(NetErrorKind::BadInput, format!("query key {k:?} is not allowed")));
    }
    let (base, slot) = bfw_target(cfg, runtime)?;
    let key = key_for(store, slot, cfg)?.ok_or_else(key_missing)?;
    let mut url = join_path(&base, path);
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }
    let allow_http = cfg.allow_http.contains(&origin(&url));
    keyed_get(net, allow_http, slot, url, key).await
}

/// What a connection test found: the user's name, whether the key has the
/// `read` scope, and the `ai` scope as `"ok"`, `"noScope"` or `"adminOnly"`.
/// It does not report whether the server has an LLM key (only generation
/// tells that, with a 503 `llm_key_missing`).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BfwProbe {
    pub user: String,
    pub read: bool,
    pub ai: &'static str,
}

fn non_empty_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty())
}

/// A connection test: `GET /api/auth/me`, then `GET /api/ai/llm-thinking-status`.
///
/// - `Server`: `url` (or the saved `bfwUrl` when `None`) must be an origin
///   (`invalidUrl` otherwise, nothing sent). A non-empty `api_key` is used as
///   typed; otherwise the keychain key only when the URL has the saved
///   origin, and `keyMissing` if not (D8).
/// - `Desktop`: `url` is ignored; the base comes from `runtime`, and the key
///   is the typed one or the `bfwDesktop|loopback` one.
///
/// `cfg` is `None` with no vault open (no saved key or URL applies then).
#[allow(clippy::too_many_arguments)]
pub async fn bfw_probe_call(
    net: &NetState,
    cfg: Option<&ServiceConfig>,
    store: &dyn SecretStore,
    runtime: Option<&Path>,
    connection: BfwConnection,
    url: Option<String>,
    api_key: Option<String>,
) -> Result<BfwProbe, NetError> {
    let typed = match api_key.filter(|k| !k.trim().is_empty()) {
        Some(k) => Some(validate_secret(&k)?),
        None => None,
    };
    let empty = ServiceConfig::from_settings_json("{}");
    let (base, slot, key) = match connection {
        BfwConnection::Desktop => {
            let (base, slot) = desktop_target(runtime)?;
            let key = match typed {
                Some(k) => k,
                None => key_for(store, slot, cfg.unwrap_or(&empty))?.ok_or_else(key_missing)?,
            };
            (base, slot, key)
        }
        BfwConnection::Server => {
            let target = match url {
                Some(u) => parse_origin_url(&u).ok_or_else(|| {
                    NetError::new(NetErrorKind::InvalidUrl, "enter an address such as https://workflow.example")
                })?,
                None => cfg.and_then(|c| c.bfw_url.clone()).ok_or_else(|| {
                    NetError::new(NetErrorKind::NotConfigured, "no valid bfworkflow address is set")
                })?,
            };
            let key = match typed {
                Some(k) => k,
                None => match cfg {
                    Some(c) if c.bfw_url.as_ref().is_some_and(|u| origin(u) == origin(&target)) => {
                        key_for(store, Slot::BfwServer, c)?.ok_or_else(key_missing)?
                    }
                    _ => return Err(key_missing()),
                },
            };
            (target, Slot::BfwServer, key)
        }
    };
    let allow_http = cfg.is_some_and(|c| c.allow_http.contains(&origin(&base)));

    let (user, read) = match keyed_get(net, allow_http, slot, join_path(&base, "/api/auth/me"), key.clone()).await {
        Ok(me) => {
            let user = non_empty_str(&me, "display_name").or_else(|| non_empty_str(&me, "username")).unwrap_or("");
            (user.to_string(), true)
        }
        Err(e) if e.kind == NetErrorKind::Status && e.status == Some(403) => (String::new(), false),
        Err(e) => return Err(e),
    };
    let ai = match keyed_get(net, allow_http, slot, join_path(&base, "/api/ai/llm-thinking-status"), key).await {
        Ok(_) => "ok",
        Err(e) if e.kind == NetErrorKind::Status && e.status == Some(403) => {
            let body = e.body.as_deref().unwrap_or("");
            if body.contains("스코프") || body.to_lowercase().contains("scope") {
                "noScope"
            } else {
                "adminOnly"
            }
        }
        Err(e) => return Err(e),
    };
    Ok(BfwProbe { user, read, ai })
}

#[tauri::command]
pub async fn bfw_request(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    path: String,
    query: Option<Vec<(String, String)>>,
) -> Result<Value, NetError> {
    let cfg = ServiceConfig::load(&settings.0, vault.root().ok().as_deref())?;
    let runtime = bfw_runtime_path();
    bfw_call(&net, &cfg, secrets.0.as_ref(), runtime.as_deref(), &path, query).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bfw_probe(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    connection: BfwConnection,
    url: Option<String>,
    api_key: Option<String>,
) -> Result<BfwProbe, NetError> {
    let cfg = ServiceConfig::load(&settings.0, vault.root().ok().as_deref()).ok();
    let runtime = bfw_runtime_path();
    bfw_probe_call(&net, cfg.as_ref(), secrets.0.as_ref(), runtime.as_deref(), connection, url, api_key).await
}

/// The resolved base URL of the saved connection, for opening bfworkflow
/// pages in the default browser. It holds no secret.
#[tauri::command]
pub fn bfw_base(vault: State<'_, VaultState>, settings: State<'_, SettingsFile>) -> Result<String, NetError> {
    let cfg = ServiceConfig::load(&settings.0, vault.root().ok().as_deref())?;
    let runtime = bfw_runtime_path();
    Ok(bfw_target(&cfg, runtime.as_deref())?.0.to_string())
}

/// The event that carries note-generation progress to the webview.
pub const NOTES_EVENT: &str = "bfworkflow://notes";

/// The one `ai`-scope endpoint the app calls (a POST, but it writes nothing
/// on the server: it only drafts notes from the design it is given).
const NOTES_PATH: &str = "/api/ai/workflow-assistant/json-to-notes-stream";

/// How many chars of a server `error` frame's message are kept.
const REMOTE_MESSAGE_MAX: usize = 500;

/// One `progress` frame of note generation, sent to the webview.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotesProgress {
    pub request_id: String,
    pub step: String,
    pub message: String,
}

fn bad_input(message: &str) -> NetError {
    NetError::new(NetErrorKind::BadInput, message)
}

/// The generation request body, `{design, context_mode:"graph_single",
/// per_workflow, language}`. `language` must be `ko` or `en`, and `design` an
/// object with a string `designType` and array `nodes` and `edges`
/// (`badInput` otherwise).
pub fn notes_payload(design: Value, language: &str, per_workflow: bool) -> Result<Value, NetError> {
    if language != "ko" && language != "en" {
        return Err(bad_input("the note language must be ko or en"));
    }
    let shaped = design.as_object().is_some_and(|o| {
        o.get("designType").is_some_and(Value::is_string)
            && o.get("nodes").is_some_and(Value::is_array)
            && o.get("edges").is_some_and(Value::is_array)
    });
    if !shaped {
        return Err(bad_input("the design needs designType, nodes and edges"));
    }
    Ok(serde_json::json!({
        "design": design,
        "context_mode": "graph_single",
        "per_workflow": per_workflow,
        "language": language,
    }))
}

fn timed_out() -> NetError {
    NetError::new(NetErrorKind::Timeout, "the server did not answer in time")
}

/// `fut`, or `timeout` when it takes longer than `limit`.
async fn within<T>(limit: Duration, fut: impl std::future::Future<Output = T>) -> Result<T, NetError> {
    tokio::time::timeout(limit, fut).await.map_err(|_| timed_out())
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// One frame. The key is redacted from its data before anything reads or
/// cuts it. `Ok(Some)` is the result; progress goes to `on_progress`; other
/// events are ignored.
fn handle_frame(frame: SseFrame, key: &str, request_id: &str, on_progress: &impl Fn(NotesProgress)) -> Result<Option<Value>, NetError> {
    let data = redact_text(&frame.data, Some(key));
    match frame.event.as_str() {
        "progress" => {
            // A progress line the app cannot read is only a lost status line.
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                on_progress(NotesProgress {
                    request_id: request_id.to_string(),
                    step: str_field(&v, "step"),
                    message: str_field(&v, "message"),
                });
            }
            Ok(None)
        }
        "result" => parse_json(&data).map(Some),
        "error" => {
            let message = serde_json::from_str::<Value>(&data)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string))
                .unwrap_or(data);
            let cut: String = message.chars().take(REMOTE_MESSAGE_MAX).collect();
            let cut = if cut.trim().is_empty() { "bfworkflow could not write the notes".to_string() } else { cut };
            Err(NetError::new(NetErrorKind::Remote, cut))
        }
        _ => Ok(None),
    }
}

/// Sends the request and reads the stream to its `result`. Every wait (the
/// answer's head, then each chunk) must end within `idle`.
async fn stream_notes(
    url: Url,
    key: &str,
    request_id: &str,
    payload: Value,
    idle: Duration,
    on_progress: &impl Fn(NotesProgress),
) -> Result<Value, NetError> {
    let headers = header_map(&[("X-API-Key", key.to_string()), ("Accept", "text/event-stream".to_string())])?;
    // No reqwest timeout: the stream may legitimately run for many minutes.
    let req = client().post(url.clone()).headers(headers).json(&payload);
    let resp = within(idle, req.send()).await?.map_err(net_error)?;
    let status = resp.status().as_u16();
    if (300..400).contains(&status) {
        return Err(redirect_error(&resp, &url));
    }
    if !(200..300).contains(&status) {
        let bytes = within(idle, read_capped(resp, MAX_BODY)).await??;
        return Err(NetError::status(status, &String::from_utf8_lossy(&bytes), Some(key)));
    }
    let mut stream = resp.bytes_stream();
    let mut parser = SseParser::default();
    let mut tail = Vec::new();
    let mut received = 0usize;
    loop {
        let Some(chunk) = within(idle, stream.next()).await? else {
            return Err(NetError::new(NetErrorKind::NoResult, "the notes stream ended without a result"));
        };
        let chunk = chunk.map_err(net_error)?;
        received += chunk.len();
        if received > MAX_BODY {
            return Err(too_large());
        }
        tail.extend_from_slice(&chunk);
        let text = take_utf8(&mut tail);
        for frame in parser.push(&text) {
            if let Some(result) = handle_frame(frame, key, request_id, on_progress)? {
                return Ok(result);
            }
        }
        if parser.pending_len() + tail.len() > SSE_MAX_FRAME {
            return Err(too_large());
        }
    }
}

/// Generates notes from a design: `POST <base>/api/ai/workflow-assistant/
/// json-to-notes-stream` with `X-API-Key` and `Accept: text/event-stream`,
/// reading the SSE answer (see the SP6 plan, Task 8):
///
/// - each chunk must arrive within `idle` (keepalive comments count), and the
///   whole call must end within `total`, or it is `timeout`;
/// - an unfinished frame over `SSE_MAX_FRAME`, or more than `MAX_BODY` bytes
///   in all, is `tooLarge`;
/// - every frame's data has the key redacted before it is parsed or cut;
/// - `progress` frames call `on_progress`, `result` returns its data, `error`
///   is `remote` with its message cut to 500 chars, and an end without a
///   result is `noResult`; a non-2xx answer is `status`;
/// - `net.cancel(request_id)` stops it with `cancelled`.
///
/// A key never goes to a non-loopback `http://` origin (`insecure`).
#[allow(clippy::too_many_arguments)]
pub async fn generate_notes(
    net: &NetState,
    base: &Url,
    key: &str,
    request_id: &str,
    payload: Value,
    idle: Duration,
    total: Duration,
    on_progress: impl Fn(NotesProgress),
) -> Result<Value, NetError> {
    generate_notes_with(net, base, key, request_id, payload, false, idle, total, on_progress).await
}

/// `generate_notes`, with `allow_http` set when the vault's `allowHttpOrigins`
/// holds the base's origin (D7).
#[allow(clippy::too_many_arguments)]
pub async fn generate_notes_with(
    net: &NetState,
    base: &Url,
    key: &str,
    request_id: &str,
    payload: Value,
    allow_http: bool,
    idle: Duration,
    total: Duration,
    on_progress: impl Fn(NotesProgress),
) -> Result<Value, NetError> {
    let url = join_path(base, NOTES_PATH);
    let result = async {
        refuse_insecure(&url, true, allow_http)?;
        let notify = net.register(request_id)?;
        let _registration = Registration { net, id: request_id };
        tokio::select! {
            r = tokio::time::timeout(total, stream_notes(url, key, request_id, payload, idle, &on_progress)) => {
                r.unwrap_or_else(|_| Err(timed_out()))
            }
            _ = notify.notified() => Err(cancelled()),
        }
    }
    .await;
    result.map_err(|e| e.redact(Some(key)))
}

/// Generates notes from `design` over the saved connection, sending each
/// progress frame to the webview as `bfworkflow://notes`. The input is checked
/// before anything else (`badInput`); the key is the connection slot's.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bfw_generate_notes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    request_id: String,
    design: Value,
    language: String,
    per_workflow: bool,
) -> Result<Value, NetError> {
    let payload = notes_payload(design, &language, per_workflow)?;
    let cfg = ServiceConfig::load(&settings.0, vault.root().ok().as_deref())?;
    let runtime = bfw_runtime_path();
    let (base, slot) = bfw_target(&cfg, runtime.as_deref())?;
    let key = key_for(secrets.0.as_ref(), slot, &cfg)?.ok_or_else(key_missing)?;
    let allow_http = cfg.allow_http.contains(&origin(&base));
    let emit = move |p: NotesProgress| {
        // A lost progress line is not worth failing the generation for.
        let _ = app.emit(NOTES_EVENT, p);
    };
    match generate_notes_with(&net, &base, &key, &request_id, payload, allow_http, SSE_IDLE, SSE_TOTAL, emit).await {
        Err(e) if slot == Slot::BfwDesktop && e.kind == NetErrorKind::Offline => Err(not_running()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::config::tests::scratch_dir;
    use crate::net::secrets::{account, MemoryStore};
    use crate::net::testserver::{refused_port, serve, Canned};
    use serde_json::json;
    use std::path::PathBuf;
    use tauri::async_runtime::block_on;

    fn cfg(settings: Value) -> ServiceConfig {
        ServiceConfig::from_settings_json(&settings.to_string())
    }

    fn store_with(slot: Slot, c: &ServiceConfig, key: &str) -> MemoryStore {
        let store = MemoryStore::default();
        store.set(&account(slot, c).unwrap(), key).unwrap();
        store
    }

    /// A runtime.json in a fresh scratch dir; returns (dir, file).
    fn runtime_file(base_url: &str) -> (PathBuf, PathBuf) {
        let dir = scratch_dir("bfw-runtime");
        let file = dir.join("runtime.json");
        std::fs::write(&file, json!({"schemaVersion": 1, "baseUrl": base_url, "desktop": true}).to_string()).unwrap();
        (dir, file)
    }

    fn settle() {
        std::thread::sleep(Duration::from_millis(100));
    }

    #[test]
    fn bfw_paths() {
        assert!(bfw_path_allowed("/api/services/svc_01/current-design"));
        assert!(bfw_path_allowed("/api/design-usage/catalog-workflows"));
        for p in ["/api/api-keys", "/api/services/../api-keys", "/api/services/a b", "/api/ai/workflow-assistant/json-to-notes", "//x", "/api/services?x=1"] {
            assert!(!bfw_path_allowed(p), "{p}");
        }
    }

    #[test]
    fn bfw_paths_full_list() {
        for p in [
            "/api/auth/me",
            "/api/workflow-catalog",
            "/api/uo-catalog-json",
            "/api/services",
            "/api/services/svc-1",
            "/api/services/svc-1/current-design",
            "/api/workflows-design",
            "/api/service-workflows/wf_9/current-design",
            "/api/design-usage/catalog-workflows",
            "/api/design-usage/catalog-unit-operations",
            "/api/ai/llm-thinking-status",
        ] {
            assert!(bfw_path_allowed(p), "{p}");
        }
        assert!(bfw_path_allowed(&format!("/api/services/{}", "a".repeat(64))));
        let long = format!("/api/services/{}", "a".repeat(65));
        for p in [
            "/api/services/",
            long.as_str(),
            "/api/services/a%2F",
            "/api/services/a#b",
            "/api/services\\x",
            "/api/auth/me/",
            "api/auth/me",
            "/api/service-workflows/x",
            "/api/ai/workflow-assistant/json-to-notes-stream",
            "/api/services/x/current-design/x",
        ] {
            assert!(!bfw_path_allowed(p), "{p}");
        }
    }

    #[test]
    fn get_sends_x_api_key_of_the_connection_slot() {
        let s = serve(vec![Canned::ok(r#"[{"workflow_id":"WB001"}]"#)]);
        let c = cfg(json!({"bfwUrl": s.url}));
        let store = store_with(Slot::BfwServer, &c, "bf_live_k");
        let v = block_on(bfw_call(&NetState::default(), &c, &store, None, "/api/workflow-catalog", None)).unwrap();
        assert_eq!(v[0]["workflow_id"], "WB001");
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "GET");
        assert_eq!(reqs[0].path, "/api/workflow-catalog");
        assert_eq!(reqs[0].header("x-api-key"), Some("bf_live_k"));
        assert_eq!(reqs[0].header("accept"), Some("application/json"));
    }

    #[test]
    fn query_keys_are_limited_and_encoded() {
        let s = serve(vec![Canned::ok("[]")]);
        let c = cfg(json!({"bfwUrl": s.url}));
        let store = store_with(Slot::BfwServer, &c, "bf_live_k");
        let net = NetState::default();
        let q = |k: &str, v: &str| Some(vec![(k.to_string(), v.to_string())]);
        block_on(bfw_call(&net, &c, &store, None, "/api/services", q("include_archived", "true"))).unwrap();
        assert_eq!(s.requests.lock().unwrap()[0].path, "/api/services?include_archived=true");
        let e = block_on(bfw_call(&net, &c, &store, None, "/api/services", q("url", "x"))).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::BadInput);
    }

    #[test]
    fn refused_path_and_missing_key_send_nothing() {
        let s = serve(vec![Canned::ok("{}")]);
        let c = cfg(json!({"bfwUrl": s.url}));
        let store = store_with(Slot::BfwServer, &c, "bf_live_k");
        let net = NetState::default();
        let e = block_on(bfw_call(&net, &c, &store, None, "/api/api-keys", None)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::ForbiddenPath);
        let e = block_on(bfw_call(&net, &c, &MemoryStore::default(), None, "/api/auth/me", None)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::KeyMissing);
        settle();
        assert_eq!(s.requests.lock().unwrap().len(), 0);
    }

    #[test]
    fn desktop_connection_uses_runtime_json_base() {
        let s = serve(vec![Canned::ok(r#"{"username":"kim"}"#)]);
        let (dir, runtime) = runtime_file(&s.url);
        let c = cfg(json!({"bfwConnection": "desktop"}));
        let store = store_with(Slot::BfwDesktop, &c, "bf_desk");
        // A server key must never go to the desktop app.
        store.set(&account(Slot::BfwServer, &c).unwrap(), "bf_server").unwrap();
        let (url, slot) = bfw_target(&c, Some(&runtime)).unwrap();
        assert_eq!((origin(&url), slot), (origin(&Url::parse(&s.url).unwrap()), Slot::BfwDesktop));
        let v = block_on(bfw_call(&NetState::default(), &c, &store, Some(&runtime), "/api/auth/me", None)).unwrap();
        assert_eq!(v["username"], "kim");
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].path, "/api/auth/me");
        assert_eq!(reqs[0].header("x-api-key"), Some("bf_desk"));
        drop(reqs);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn desktop_without_runtime_is_not_configured() {
        let dir = scratch_dir("bfw-noruntime");
        let c = cfg(json!({"bfwConnection": "desktop"}));
        let store = store_with(Slot::BfwDesktop, &c, "bf_desk");
        let missing = dir.join("runtime.json");
        for runtime in [None, Some(missing.as_path())] {
            let e = bfw_target(&c, runtime).unwrap_err();
            assert_eq!((e.kind, e.message.as_str()), (NetErrorKind::NotConfigured, "bfworkflow desktop app is not running"));
            let e = block_on(bfw_call(&NetState::default(), &c, &store, runtime, "/api/auth/me", None)).unwrap_err();
            assert_eq!((e.kind, e.message.as_str()), (NetErrorKind::NotConfigured, "bfworkflow desktop app is not running"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn desktop_runtime_pointing_at_a_closed_port_is_not_configured() {
        let (dir, runtime) = runtime_file(&refused_port());
        let c = cfg(json!({"bfwConnection": "desktop"}));
        let store = store_with(Slot::BfwDesktop, &c, "bf_desk");
        let e = block_on(bfw_call(&NetState::default(), &c, &store, Some(&runtime), "/api/auth/me", None)).unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (NetErrorKind::NotConfigured, "bfworkflow desktop app is not running"));
        let e = block_on(bfw_probe_call(&NetState::default(), Some(&c), &store, Some(&runtime), BfwConnection::Desktop, None, None)).unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (NetErrorKind::NotConfigured, "bfworkflow desktop app is not running"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn server_target_is_the_saved_url() {
        let (url, slot) = bfw_target(&cfg(json!({})), None).unwrap();
        assert_eq!((url.as_str(), slot), ("https://workflow.kbiofoundry.kr/", Slot::BfwServer));
        let bad = cfg(json!({"bfwUrl": "https://wf.example/api"}));
        assert_eq!(bfw_target(&bad, None).unwrap_err().kind, NetErrorKind::NotConfigured);
    }

    fn probe_server(c: &ServiceConfig, store: &MemoryStore, url: Option<&str>, key: Option<&str>) -> Result<BfwProbe, NetError> {
        block_on(bfw_probe_call(&NetState::default(), Some(c), store, None, BfwConnection::Server, url.map(str::to_string), key.map(str::to_string)))
    }

    #[test]
    fn probe_reports_scopes() {
        // case 1: me 200, thinking 200.
        let s = serve(vec![Canned::ok(r#"{"username":"kim"}"#), Canned::ok(r#"{"enabled":true}"#)]);
        let c = cfg(json!({"bfwUrl": s.url}));
        let store = store_with(Slot::BfwServer, &c, "bf_live_k");
        let p = probe_server(&c, &store, Some(&s.url), None).unwrap();
        assert_eq!((p.user.as_str(), p.read, p.ai), ("kim", true, "ok"));
        let v = serde_json::to_value(&p).unwrap();
        let mut keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["ai", "read", "user"]);
        let reqs = s.requests.lock().unwrap();
        let paths: Vec<&str> = reqs.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["/api/auth/me", "/api/ai/llm-thinking-status"]);
        assert!(reqs.iter().all(|r| r.header("x-api-key") == Some("bf_live_k")));
        drop(reqs);

        // case 2: thinking 403 for a missing `ai` scope.
        let s = serve(vec![
            Canned::ok(r#"{"username":"kim","display_name":"김연구"}"#),
            Canned::status(403).body(r#"{"detail":"API 키에 'ai' 스코프가 없습니다."}"#),
        ]);
        let c = cfg(json!({"bfwUrl": s.url}));
        let store = store_with(Slot::BfwServer, &c, "bf_live_k");
        let p = probe_server(&c, &store, None, None).unwrap();
        assert_eq!((p.user.as_str(), p.read, p.ai), ("김연구", true, "noScope"));
        assert!(s.requests.lock().unwrap().iter().all(|r| r.path != "/api/health"));

        // case 3: thinking 403 for a non-admin (auth/__init__.py:255).
        let s = serve(vec![
            Canned::ok(r#"{"username":"kim","display_name":""}"#),
            Canned::status(403).body(r#"{"detail":"LLM 어시스턴트 사용 권한이 없습니다."}"#),
        ]);
        let c = cfg(json!({"bfwUrl": s.url}));
        let store = store_with(Slot::BfwServer, &c, "bf_live_k");
        let p = probe_server(&c, &store, None, None).unwrap();
        assert_eq!((p.user.as_str(), p.read, p.ai), ("kim", true, "adminOnly"));
        assert!(s.requests.lock().unwrap().iter().all(|r| r.path != "/api/health"));

        // case 4: me 401 is an error, with the key redacted.
        let s = serve(vec![Canned::status(401).body(r#"{"detail":"bad bf_live_k"}"#)]);
        let c = cfg(json!({"bfwUrl": s.url}));
        let store = store_with(Slot::BfwServer, &c, "bf_live_k");
        let e = probe_server(&c, &store, None, None).unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(401)));
        assert!(!serde_json::to_string(&e).unwrap().contains("bf_live_k"));
        settle();
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        assert!(reqs.iter().all(|r| r.path != "/api/health"));
    }

    #[test]
    fn probe_me_403_is_read_false() {
        let s = serve(vec![Canned::status(403).body(r#"{"detail":"no read"}"#), Canned::ok("{}")]);
        let c = cfg(json!({"bfwUrl": s.url}));
        let store = store_with(Slot::BfwServer, &c, "bf_live_k");
        let p = probe_server(&c, &store, None, None).unwrap();
        assert_eq!((p.user.as_str(), p.read, p.ai), ("", false, "ok"));
    }

    #[test]
    fn probe_of_another_origin_never_uses_the_stored_key() {
        let a = serve(vec![]);
        let b = serve(vec![Canned::ok(r#"{"username":"b"}"#), Canned::ok("{}")]);
        let c = cfg(json!({"bfwUrl": a.url}));
        let store = store_with(Slot::BfwServer, &c, "bf_stored");
        assert_eq!(probe_server(&c, &store, Some(&b.url), None).unwrap_err().kind, NetErrorKind::KeyMissing);
        assert_eq!(probe_server(&c, &store, Some(&b.url), Some(" ")).unwrap_err().kind, NetErrorKind::KeyMissing);
        settle();
        assert_eq!(b.requests.lock().unwrap().len(), 0);
        assert_eq!(probe_server(&c, &store, Some(&b.url), Some("typed")).unwrap().user, "b");
        assert_eq!(b.requests.lock().unwrap()[0].header("x-api-key"), Some("typed"));
        let e = probe_server(&c, &store, Some(&format!("{}/x", b.url)), Some("typed")).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::InvalidUrl);
    }

    #[test]
    fn probe_without_a_vault_needs_a_typed_key_and_a_url() {
        let net = NetState::default();
        let store = MemoryStore::default();
        let e = block_on(bfw_probe_call(&net, None, &store, None, BfwConnection::Server, Some("https://x.example".into()), None)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::KeyMissing);
        let e = block_on(bfw_probe_call(&net, None, &store, None, BfwConnection::Server, None, Some("typed".into()))).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::NotConfigured);
    }

    #[test]
    fn desktop_probe_ignores_url_and_uses_the_loopback_key() {
        let s = serve(vec![Canned::ok(r#"{"username":"desk"}"#), Canned::ok("{}")]);
        let (dir, runtime) = runtime_file(&s.url);
        let c = cfg(json!({}));
        let store = store_with(Slot::BfwDesktop, &c, "bf_desk");
        let p = block_on(bfw_probe_call(&NetState::default(), Some(&c), &store, Some(&runtime), BfwConnection::Desktop, Some("https://elsewhere.example".into()), None)).unwrap();
        assert_eq!(p.user, "desk");
        assert_eq!(s.requests.lock().unwrap()[0].header("x-api-key"), Some("bf_desk"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- note generation over SSE (Task 8) ----

    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    fn sse(body_chunks: Vec<(u64, &[u8])>) -> Canned {
        body_chunks.into_iter().fold(Canned::ok("").header("Content-Type", "text/event-stream"), |c, (ms, b)| {
            c.chunk(Duration::from_millis(ms), b)
        })
    }

    fn base(s: &crate::net::testserver::TestServer) -> Url {
        Url::parse(&s.url).unwrap()
    }

    fn run(s: &crate::net::testserver::TestServer, key: &str, idle: Duration, total: Duration) -> (Result<Value, NetError>, Vec<NotesProgress>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let r = block_on(generate_notes(&NetState::default(), &base(s), key, "r1", json!({}), idle, total, move |p| {
            log.lock().unwrap().push(p)
        }));
        let seen = seen.lock().unwrap().clone();
        (r, seen)
    }

    #[test]
    fn progress_frames_are_reported_then_result_returned() {
        let s = serve(vec![sse(vec![
            (0, b"event: progress\ndata: {\"step\":\"init\",\"message\":\"Starting\"}\n\n"),
            (20, b": keepalive\n\n"),
            (20, b"event: progress\ndata: {\"step\":\"generate\",\"message\":\"Writing notes\"}\n\n"),
            (20, b"event: result\ndata: {\"workflows\":[{\"workflow_id\":\"WB030\",\"markdown\":\"# x\"}]}\n\n"),
        ])]);
        let (r, seen) = run(&s, "bf_test_key", Duration::from_secs(5), SSE_TOTAL);
        let v = r.unwrap();
        assert_eq!(v["workflows"][0]["workflow_id"], "WB030");
        let steps: Vec<&str> = seen.iter().map(|p| p.step.as_str()).collect();
        assert_eq!(steps, ["init", "generate"]);
        assert_eq!(seen[1], NotesProgress { request_id: "r1".into(), step: "generate".into(), message: "Writing notes".into() });
    }

    #[test]
    fn stream_ending_without_result_emits_error_no_result() {
        let s = serve(vec![sse(vec![(0, b"event: progress\ndata: {\"step\":\"init\",\"message\":\"a\"}\n\n")])]);
        let (r, seen) = run(&s, "bf_test_key", Duration::from_secs(5), SSE_TOTAL);
        assert_eq!(r.unwrap_err().kind, NetErrorKind::NoResult);
        assert_eq!(seen.len(), 1);
    }

    #[test]
    fn server_error_event_is_remote() {
        let s = serve(vec![sse(vec![(0, b"event: error\ndata: {\"message\":\"LLM failed\"}\n\n")])]);
        let e = run(&s, "bf_test_key", Duration::from_secs(5), SSE_TOTAL).0.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (NetErrorKind::Remote, "LLM failed"));
    }

    #[test]
    fn idle_stream_times_out() {
        let s = serve(vec![Canned::ok("").header("Content-Type", "text/event-stream").chunk(Duration::from_millis(2000), b": late\n\n")]);
        let t = Instant::now();
        let e = block_on(generate_notes(&NetState::default(), &base(&s), "k", "r1", json!({}), Duration::from_millis(200), SSE_TOTAL, |_| {})).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Timeout);
        assert!(t.elapsed() < Duration::from_millis(1500));
    }

    #[test]
    fn a_server_that_never_answers_times_out_on_idle() {
        let s = crate::net::testserver::silent();
        let t = Instant::now();
        let e = block_on(generate_notes(&NetState::default(), &base(&s), "k", "r1", json!({}), Duration::from_millis(200), SSE_TOTAL, |_| {})).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Timeout);
        assert!(t.elapsed() < Duration::from_millis(1500));
    }

    #[test]
    fn total_cap_stops_an_endless_keepalive_stream() {
        let chunks: Vec<(u64, &[u8])> = (0..40).map(|_| (50u64, &b": keepalive\n\n"[..])).collect();
        let s = serve(vec![sse(chunks)]);
        let t = Instant::now();
        let e = run(&s, "bf_test_key", Duration::from_millis(200), Duration::from_millis(500)).0.unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Timeout);
        let took = t.elapsed();
        assert!(took >= Duration::from_millis(450) && took < Duration::from_millis(1500), "{took:?}");
    }

    #[test]
    fn frame_without_terminator_over_cap_is_too_large() {
        let mut big = b"data: ".to_vec();
        big.extend(std::iter::repeat(b'x').take(SSE_MAX_FRAME + 10));
        let s = serve(vec![sse(vec![(0, &big)])]);
        assert_eq!(run(&s, "bf_test_key", Duration::from_secs(5), SSE_TOTAL).0.unwrap_err().kind, NetErrorKind::TooLarge);
    }

    #[test]
    fn remote_message_is_redacted_before_the_cut() {
        let msg = format!("{}k_secret{}", "x".repeat(495), "y".repeat(20));
        let frame = format!("event: error\ndata: {}\n\n", json!({ "message": msg }));
        let s = serve(vec![sse(vec![(0, frame.as_bytes())])]);
        let e = run(&s, "k_secret", Duration::from_secs(5), SSE_TOTAL).0.unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Remote);
        assert!(!e.message.contains("k_sec"), "{}", e.message);
        assert_eq!(e.message.chars().count(), 500);
    }

    #[test]
    fn progress_and_result_are_redacted() {
        let s = serve(vec![sse(vec![
            (0, b"event: progress\ndata: {\"step\":\"init\",\"message\":\"key k_secret\"}\n\n"),
            (0, b"event: result\ndata: {\"echo\":\"k_secret\"}\n\n"),
        ])]);
        let (r, seen) = run(&s, "k_secret", Duration::from_secs(5), SSE_TOTAL);
        assert_eq!(r.unwrap()["echo"], "***");
        assert_eq!(seen[0].message, "key ***");
    }

    #[test]
    fn keepalives_reset_the_idle_timer() {
        let mut chunks: Vec<(u64, &[u8])> = (0..5).map(|_| (100u64, &b": keepalive\n\n"[..])).collect();
        chunks.push((100, b"event: result\ndata: {\"ok\":true}\n\n"));
        let s = serve(vec![sse(chunks)]);
        assert_eq!(run(&s, "bf_test_key", Duration::from_millis(200), SSE_TOTAL).0.unwrap()["ok"], true);
    }

    #[test]
    fn http_503_before_stream_is_status_with_body() {
        let s = serve(vec![Canned::status(503).header("Content-Type", "application/json").body(r#"{"detail":{"code":"llm_key_missing"}}"#)]);
        let e = run(&s, "bf_test_key", Duration::from_secs(5), SSE_TOTAL).0.unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(503)));
        assert!(e.body.unwrap().contains("llm_key_missing"));
    }

    #[test]
    fn a_redirect_before_the_stream_is_redirect() {
        let s = serve(vec![Canned::status(302).header("Location", "https://other.example/x")]);
        let e = run(&s, "bf_test_key", Duration::from_secs(5), SSE_TOTAL).0.unwrap_err();
        assert_eq!((e.kind, e.location.as_deref()), (NetErrorKind::Redirect, Some("https://other.example")));
    }

    #[test]
    fn a_key_never_goes_to_plain_http_off_this_computer() {
        let e = block_on(generate_notes(
            &NetState::default(),
            &Url::parse("http://10.255.255.1:9").unwrap(),
            "k",
            "r1",
            json!({}),
            Duration::from_secs(5),
            SSE_TOTAL,
            |_| {},
        ))
        .unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Insecure);
    }

    #[test]
    fn cancel_stops_the_stream() {
        let s = serve(vec![Canned::ok("")
            .header("Content-Type", "text/event-stream")
            .chunk(Duration::from_millis(100), b"event: progress\ndata: {\"step\":\"init\",\"message\":\"a\"}\n\n")
            .chunk(Duration::from_millis(3000), b"event: result\ndata: {}\n\n")]);
        let net = Arc::new(NetState::default());
        let n2 = net.clone();
        let b = base(&s);
        let h = std::thread::spawn(move || {
            block_on(generate_notes(&n2, &b, "k", "r2", json!({}), Duration::from_secs(5), SSE_TOTAL, |_| {}))
        });
        std::thread::sleep(Duration::from_millis(300));
        assert!(net.cancel("r2"));
        assert_eq!(h.join().unwrap().unwrap_err().kind, NetErrorKind::Cancelled);
        assert!(!net.cancel("r2")); // forgotten once it ended
    }

    #[test]
    fn payload_is_graph_single_with_language() {
        let design = json!({"designType": "service", "nodes": [], "edges": []});
        let payload = notes_payload(design.clone(), "ko", true).unwrap();
        let s = serve(vec![sse(vec![(0, b"event: result\ndata: {}\n\n")])]);
        block_on(generate_notes(&NetState::default(), &base(&s), "bf_k", "r1", payload, Duration::from_secs(5), SSE_TOTAL, |_| {})).unwrap();
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "POST");
        assert_eq!(reqs[0].path, "/api/ai/workflow-assistant/json-to-notes-stream");
        assert_eq!(reqs[0].header("x-api-key"), Some("bf_k"));
        assert_eq!(reqs[0].header("accept"), Some("text/event-stream"));
        let body: Value = serde_json::from_str(&reqs[0].body).unwrap();
        assert_eq!(body, json!({"design": design, "context_mode": "graph_single", "per_workflow": true, "language": "ko"}));
    }

    #[test]
    fn payload_input_is_checked() {
        let good = json!({"designType": "service", "nodes": [], "edges": []});
        assert!(notes_payload(good.clone(), "en", false).is_ok());
        assert_eq!(notes_payload(good.clone(), "fr", false).unwrap_err().kind, NetErrorKind::BadInput);
        for bad in [
            json!([]),
            json!({"nodes": [], "edges": []}),
            json!({"designType": "service", "nodes": {}, "edges": []}),
            json!({"designType": "service", "nodes": []}),
        ] {
            assert_eq!(notes_payload(bad.clone(), "ko", false).unwrap_err().kind, NetErrorKind::BadInput, "{bad}");
        }
    }
}
