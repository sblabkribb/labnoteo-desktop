//! LLM calls (D7, D8): `llm_chat` for the saved provider and `llm_probe` for a
//! connection test of unsaved fields.
//!
//! - The webview names a provider and passes the request body; the endpoint
//!   comes from the open vault's stored settings, and the provider must be the
//!   saved one.
//! - The key (`Authorization: Bearer`) goes only to an OpenAI-compatible
//!   endpoint and comes from the keychain, except a key typed into the probe.
//!   Ollama never gets `Authorization`, even when its origin equals the saved
//!   OpenAI origin.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use super::config::{join_path, origin, parse_llm_endpoint, LlmKind, ServiceConfig, Url};
use super::error::{NetError, NetErrorKind};
use super::http::{parse_json, send, Incoming, Outgoing, MAX_BODY};
use super::secrets::{key_for, validate_secret, SecretStore, Secrets, Slot};
use super::NetState;
use crate::vault::{SettingsFile, VaultState};

pub const LLM_TIMEOUT: Duration = Duration::from_secs(300);
pub const LLM_MAX_REQUEST: usize = 4 * 1024 * 1024;
/// A connection test answers within this time or fails.
pub const LLM_PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// The model list a probe found, and whether the typed model is in it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LlmProbe {
    pub models: Vec<String>,
    pub model_found: bool,
}

fn endpoint_of(kind: LlmKind, cfg: &ServiceConfig) -> Option<&Url> {
    match kind {
        LlmKind::Ollama => cfg.llm_ollama.as_ref(),
        LlmKind::Openai => cfg.llm_openai.as_ref(),
        LlmKind::None => None,
    }
}

fn not_configured() -> NetError {
    NetError::new(NetErrorKind::NotConfigured, "no AI provider or endpoint is set")
}

/// The base of an OpenAI-compatible endpoint: one final path segment exactly
/// `v1` (case-sensitive, with or without a trailing `/`) is removed, so
/// `https://host/v1` and `https://gw/openai/v1/` work like `https://host` and
/// `https://gw/openai` (OpenAI SDK convention). Everything else is unchanged.
/// The origin never changes, so key binding by origin is unaffected.
pub fn openai_base(url: &Url) -> Url {
    let path = url.path();
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    match trimmed.strip_suffix("/v1") {
        Some(rest) => {
            let mut base = url.clone();
            base.set_path(rest);
            base
        }
        None => url.clone(),
    }
}

/// `<ollama>/api/chat` or `<openai>/v1/chat/completions`, appended as a
/// string so a gateway base path is kept (vendor `joinUrl`); a trailing `/v1`
/// on the OpenAI-compatible endpoint is its base (`openai_base`). No
/// provider, or no valid saved endpoint, is `notConfigured`.
pub fn chat_url(kind: LlmKind, cfg: &ServiceConfig) -> Result<Url, NetError> {
    let base = endpoint_of(kind, cfg).ok_or_else(not_configured)?;
    Ok(match kind {
        LlmKind::Ollama => join_path(base, "/api/chat"),
        _ => join_path(&openai_base(base), "/v1/chat/completions"),
    })
}

/// `Accept: <accept>` and `Authorization: Bearer <key>` when there is a key
/// (never for Ollama: the callers pass `None` there).
pub(crate) fn auth_headers(key: Option<&str>, accept: &str) -> Vec<(&'static str, String)> {
    let mut headers = vec![("Accept", accept.to_string())];
    if let Some(k) = key {
        headers.push(("Authorization", format!("Bearer {k}")));
    }
    headers
}

/// Where a chat request to the saved provider goes, and with which key.
pub(crate) struct ChatTarget {
    pub url: Url,
    pub key: Option<String>,
    /// The vault's `allowHttpOrigins` holds the URL's origin.
    pub allow_http: bool,
}

/// The guards `llm_chat` and `llm_chat_stream` share, checked before anything
/// is sent: the provider must be the saved one and the body a JSON object of
/// at most `LLM_MAX_REQUEST` bytes (`badInput`); no saved endpoint is
/// `notConfigured`. The keychain key is looked up only for an
/// OpenAI-compatible endpoint (never for Ollama).
pub(crate) fn chat_target(
    cfg: &ServiceConfig,
    store: &dyn SecretStore,
    provider: LlmKind,
    body: &Value,
) -> Result<ChatTarget, NetError> {
    if provider != cfg.llm_provider {
        return Err(NetError::new(NetErrorKind::BadInput, "the AI provider is not the one saved in settings"));
    }
    if !body.is_object() {
        return Err(NetError::new(NetErrorKind::BadInput, "the request body must be a JSON object"));
    }
    let size = serde_json::to_vec(body).map(|v| v.len()).unwrap_or(usize::MAX);
    if size > LLM_MAX_REQUEST {
        return Err(NetError::new(NetErrorKind::BadInput, "the request is too large"));
    }
    let url = chat_url(provider, cfg)?;
    let key = match provider {
        LlmKind::Openai => key_for(store, Slot::LlmOpenai, cfg)?,
        _ => None,
    };
    let allow_http = cfg.allow_http.contains(&origin(&url));
    Ok(ChatTarget { url, key, allow_http })
}

/// One chat request to the saved provider (`chat_target` holds the guards).
/// The keychain key goes only to an OpenAI-compatible endpoint. Cancellable
/// through `request_id`.
pub async fn llm_call(
    net: &NetState,
    cfg: &ServiceConfig,
    store: &dyn SecretStore,
    request_id: &str,
    provider: LlmKind,
    body: Value,
) -> Result<Incoming, NetError> {
    let ChatTarget { url, key, allow_http } = chat_target(cfg, store, provider, &body)?;
    let out = Outgoing {
        method: reqwest::Method::POST,
        headers: auth_headers(key.as_deref(), "application/json"),
        allow_http,
        url,
        json: Some(body),
        timeout: Some(LLM_TIMEOUT),
        max_body: MAX_BODY,
        secret: key,
    };
    send(net, Some(request_id), out).await
}

/// `true` when `name` is `model` or a tag of it (`model:<tag>`).
fn matches_model(name: &str, model: &str) -> bool {
    name == model || name.strip_prefix(model).is_some_and(|rest| rest.starts_with(':'))
}

/// A connection test of unsaved fields: `GET <endpoint>/api/tags` (Ollama) or
/// `GET <openai_base(endpoint)>/v1/models` (OpenAI-compatible). The key follows the D8
/// probe rule: a non-empty `api_key` as typed, otherwise the keychain key only
/// when `endpoint` has the saved OpenAI endpoint's origin, otherwise none (a
/// local OpenAI-compatible server often needs none). Ollama never gets
/// `Authorization`. `cfg` is `None` with no vault open.
#[allow(clippy::too_many_arguments)]
pub async fn llm_probe_call(
    net: &NetState,
    cfg: Option<&ServiceConfig>,
    store: &dyn SecretStore,
    provider: LlmKind,
    endpoint: &str,
    model: &str,
    api_key: Option<String>,
) -> Result<LlmProbe, NetError> {
    if provider == LlmKind::None {
        return Err(NetError::new(NetErrorKind::BadInput, "choose an AI provider to test"));
    }
    let target = parse_llm_endpoint(endpoint)
        .ok_or_else(|| NetError::new(NetErrorKind::InvalidUrl, "enter an address such as http://localhost:11434"))?;
    let key = match provider {
        LlmKind::Openai => match api_key.filter(|k| !k.trim().is_empty()) {
            Some(k) => Some(validate_secret(&k)?),
            None => match cfg {
                Some(c) if c.llm_openai.as_ref().is_some_and(|u| origin(u) == origin(&target)) => {
                    key_for(store, Slot::LlmOpenai, c)?
                }
                _ => None,
            },
        },
        _ => None,
    };
    let url = match provider {
        LlmKind::Ollama => join_path(&target, "/api/tags"),
        _ => join_path(&openai_base(&target), "/v1/models"),
    };
    let out = Outgoing {
        method: reqwest::Method::GET,
        headers: auth_headers(key.as_deref(), "application/json"),
        allow_http: cfg.is_some_and(|c| c.allow_http.contains(&origin(&url))),
        url,
        json: None,
        timeout: Some(LLM_PROBE_TIMEOUT),
        max_body: MAX_BODY,
        secret: key.clone(),
    };
    let incoming = send(net, None, out).await?;
    let json = parse_json(&incoming.text).map_err(|e| e.redact(key.as_deref()))?;
    let (list, field) = match provider {
        LlmKind::Ollama => ("models", "name"),
        _ => ("data", "id"),
    };
    let models: Vec<String> = json
        .get(list)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|m| m.get(field)?.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let model = model.trim();
    let model_found = !model.is_empty() && models.iter().any(|m| matches_model(m, model));
    Ok(LlmProbe { models, model_found })
}

#[tauri::command]
pub async fn llm_chat(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    request_id: String,
    provider: LlmKind,
    body: Value,
) -> Result<Incoming, NetError> {
    let cfg = ServiceConfig::load(&settings.0, vault.root().ok().as_deref())?;
    llm_call(&net, &cfg, secrets.0.as_ref(), &request_id, provider, body).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn llm_probe(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    provider: LlmKind,
    endpoint: String,
    model: String,
    api_key: Option<String>,
) -> Result<LlmProbe, NetError> {
    let cfg = ServiceConfig::load(&settings.0, vault.root().ok().as_deref()).ok();
    llm_probe_call(&net, cfg.as_ref(), secrets.0.as_ref(), provider, &endpoint, &model, api_key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::secrets::{account, MemoryStore};
    use crate::net::testserver::{echo_header, serve, Canned};
    use serde_json::json;
    use tauri::async_runtime::block_on;

    fn cfg(settings: Value) -> ServiceConfig {
        ServiceConfig::from_settings_json(&settings.to_string())
    }

    fn store_with_openai_key(c: &ServiceConfig, key: &str) -> MemoryStore {
        let store = MemoryStore::default();
        store.set(&account(Slot::LlmOpenai, c).unwrap(), key).unwrap();
        store
    }

    fn chat(c: &ServiceConfig, store: &MemoryStore, provider: LlmKind, body: Value) -> Result<Incoming, NetError> {
        block_on(llm_call(&NetState::default(), c, store, "r1", provider, body))
    }

    fn probe(c: Option<&ServiceConfig>, store: &MemoryStore, provider: LlmKind, endpoint: &str, model: &str, key: Option<&str>) -> Result<LlmProbe, NetError> {
        block_on(llm_probe_call(&NetState::default(), c, store, provider, endpoint, model, key.map(str::to_string)))
    }

    fn settle() {
        std::thread::sleep(Duration::from_millis(100));
    }

    #[test]
    fn ollama_chat_posts_to_api_chat_without_authorization() {
        let s = serve(vec![Canned::ok(r#"{"message":{"content":"hi"}}"#)]);
        let c = cfg(json!({"llmProvider": "ollama", "llmEndpointOllama": s.url}));
        // A key is stored for the saved OpenAI origin; it must never go to Ollama.
        let store = store_with_openai_key(&c, "sk-k");
        let body = json!({"model": "llama3.1", "messages": [{"role": "user", "content": "안녕"}], "stream": false});
        let r = chat(&c, &store, LlmKind::Ollama, body.clone()).unwrap();
        assert_eq!((r.status, r.text.as_str()), (200, r#"{"message":{"content":"hi"}}"#));
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "POST");
        assert_eq!(reqs[0].path, "/api/chat");
        assert_eq!(reqs[0].header("authorization"), None);
        assert_eq!(serde_json::from_str::<Value>(&reqs[0].body).unwrap(), body);
    }

    #[test]
    fn ollama_chat_never_sends_authorization_even_at_the_openai_origin() {
        let s = serve(vec![Canned::ok("{}")]);
        let c = cfg(json!({"llmProvider": "ollama", "llmEndpointOllama": s.url, "llmEndpointOpenai": s.url}));
        let store = store_with_openai_key(&c, "sk-k");
        chat(&c, &store, LlmKind::Ollama, json!({})).unwrap();
        assert_eq!(s.requests.lock().unwrap()[0].header("authorization"), None);
    }

    #[test]
    fn openai_chat_sends_bearer_from_keychain() {
        let s = serve(vec![Canned::ok(r#"{"choices":[]}"#)]);
        let c = cfg(json!({"llmProvider": "openai", "llmEndpointOpenai": s.url}));
        let store = store_with_openai_key(&c, "sk-k");
        chat(&c, &store, LlmKind::Openai, json!({"model": "m"})).unwrap();
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "POST");
        assert_eq!(reqs[0].path, "/v1/chat/completions");
        assert_eq!(reqs[0].header("authorization"), Some("Bearer sk-k"));
        assert_eq!(reqs[0].header("content-type"), Some("application/json"));
    }

    #[test]
    fn openai_gateway_path_is_kept() {
        let s = serve(vec![Canned::ok("{}")]);
        let c = cfg(json!({"llmProvider": "openai", "llmEndpointOpenai": format!("{}/openai", s.url)}));
        chat(&c, &MemoryStore::default(), LlmKind::Openai, json!({})).unwrap();
        assert_eq!(s.requests.lock().unwrap()[0].path, "/openai/v1/chat/completions");
    }

    #[test]
    fn openai_without_key_sends_no_authorization() {
        let s = serve(vec![Canned::ok("{}")]);
        let c = cfg(json!({"llmProvider": "openai", "llmEndpointOpenai": s.url}));
        chat(&c, &MemoryStore::default(), LlmKind::Openai, json!({})).unwrap();
        assert_eq!(s.requests.lock().unwrap()[0].header("authorization"), None);
    }

    #[test]
    fn provider_mismatch_is_bad_input() {
        let s = serve(vec![Canned::ok("{}")]);
        let c = cfg(json!({"llmProvider": "ollama", "llmEndpointOllama": s.url, "llmEndpointOpenai": s.url}));
        let store = store_with_openai_key(&c, "sk-k");
        assert_eq!(chat(&c, &store, LlmKind::Openai, json!({})).unwrap_err().kind, NetErrorKind::BadInput);
        settle();
        assert_eq!(s.requests.lock().unwrap().len(), 0);
    }

    #[test]
    fn provider_none_is_not_configured() {
        let c = cfg(json!({}));
        assert_eq!(c.llm_provider, LlmKind::None);
        assert_eq!(chat(&c, &MemoryStore::default(), LlmKind::None, json!({})).unwrap_err().kind, NetErrorKind::NotConfigured);
    }

    #[test]
    fn invalid_saved_endpoint_is_not_configured() {
        let c = cfg(json!({"llmProvider": "openai", "llmEndpointOpenai": "ftp://x"}));
        assert_eq!(chat(&c, &MemoryStore::default(), LlmKind::Openai, json!({})).unwrap_err().kind, NetErrorKind::NotConfigured);
    }

    #[test]
    fn body_must_be_an_object_within_the_cap() {
        let s = serve(vec![Canned::ok("{}")]);
        let c = cfg(json!({"llmProvider": "ollama", "llmEndpointOllama": s.url}));
        let store = MemoryStore::default();
        for body in [json!([1]), json!("x"), Value::Null, json!({"x": "a".repeat(LLM_MAX_REQUEST)})] {
            assert_eq!(chat(&c, &store, LlmKind::Ollama, body).unwrap_err().kind, NetErrorKind::BadInput);
        }
        settle();
        assert_eq!(s.requests.lock().unwrap().len(), 0);
    }

    #[test]
    fn chat_is_cancellable_by_request_id() {
        let s = crate::net::testserver::silent();
        let c = cfg(json!({"llmProvider": "ollama", "llmEndpointOllama": s.url}));
        let net = std::sync::Arc::new(NetState::default());
        let n2 = net.clone();
        let h = std::thread::spawn(move || {
            block_on(llm_call(&n2, &c, &MemoryStore::default(), "chat-1", LlmKind::Ollama, json!({})))
        });
        std::thread::sleep(Duration::from_millis(150));
        assert!(net.cancel("chat-1"));
        assert_eq!(h.join().unwrap().unwrap_err().kind, NetErrorKind::Cancelled);
    }

    #[test]
    fn probe_lists_models_and_finds_model() {
        let tags = r#"{"models":[{"name":"llama3.1:latest"},{"name":"qwen3"}]}"#;
        let s = serve(vec![Canned::ok(tags), Canned::ok(tags), Canned::ok(tags)]);
        let store = MemoryStore::default();
        let p = probe(None, &store, LlmKind::Ollama, &s.url, "llama3.1", None).unwrap();
        assert_eq!(p, LlmProbe { models: vec!["llama3.1:latest".into(), "qwen3".into()], model_found: true });
        assert_eq!(s.requests.lock().unwrap()[0].path, "/api/tags");
        assert_eq!(s.requests.lock().unwrap()[0].method, "GET");
        assert!(!probe(None, &store, LlmKind::Ollama, &s.url, "mistral", None).unwrap().model_found);
        assert!(probe(None, &store, LlmKind::Ollama, &s.url, "qwen3", None).unwrap().model_found);
    }

    #[test]
    fn openai_probe_reads_data_ids() {
        let s = serve(vec![Canned::ok(r#"{"data":[{"id":"gpt-4o"},{"id":"gpt-4o-mini"}]}"#)]);
        let p = probe(None, &MemoryStore::default(), LlmKind::Openai, &format!("{}/openai", s.url), "gpt-4o-mini", None).unwrap();
        assert_eq!(p, LlmProbe { models: vec!["gpt-4o".into(), "gpt-4o-mini".into()], model_found: true });
        assert_eq!(s.requests.lock().unwrap()[0].path, "/openai/v1/models");
    }

    #[test]
    fn probe_other_origin_ignores_stored_key() {
        let saved = serve(vec![Canned::ok(r#"{"data":[]}"#)]);
        let other = serve(vec![Canned::ok(r#"{"data":[]}"#), Canned::ok(r#"{"data":[]}"#)]);
        let c = cfg(json!({"llmProvider": "openai", "llmEndpointOpenai": saved.url}));
        let store = store_with_openai_key(&c, "sk-stored");
        probe(Some(&c), &store, LlmKind::Openai, &other.url, "m", None).unwrap();
        assert_eq!(other.requests.lock().unwrap()[0].header("authorization"), None);
        probe(Some(&c), &store, LlmKind::Openai, &other.url, "m", Some("typed")).unwrap();
        assert_eq!(other.requests.lock().unwrap()[1].header("authorization"), Some("Bearer typed"));
        // The saved origin (a path is allowed) gets the stored key.
        probe(Some(&c), &store, LlmKind::Openai, &format!("{}/", saved.url), "m", None).unwrap();
        assert_eq!(saved.requests.lock().unwrap()[0].header("authorization"), Some("Bearer sk-stored"));
    }

    #[test]
    fn ollama_probe_never_sends_authorization() {
        let tags = r#"{"models":[]}"#;
        let s = serve(vec![Canned::ok(tags), Canned::ok(tags)]);
        let c = cfg(json!({"llmProvider": "openai", "llmEndpointOpenai": s.url}));
        let store = store_with_openai_key(&c, "sk-k");
        probe(Some(&c), &store, LlmKind::Ollama, &s.url, "m", None).unwrap();
        probe(Some(&c), &store, LlmKind::Ollama, &s.url, "m", Some("typed")).unwrap();
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs.len(), 2);
        assert!(reqs.iter().all(|r| r.header("authorization").is_none()));
    }

    #[test]
    fn probe_refuses_an_invalid_endpoint_and_provider_none() {
        let store = MemoryStore::default();
        for endpoint in ["ftp://x", "http://h/a?b=1", "", "http://h/a b"] {
            assert_eq!(probe(None, &store, LlmKind::Ollama, endpoint, "m", None).unwrap_err().kind, NetErrorKind::InvalidUrl, "{endpoint}");
        }
        assert_eq!(probe(None, &store, LlmKind::None, "http://127.0.0.1:1", "m", None).unwrap_err().kind, NetErrorKind::BadInput);
    }

    #[test]
    fn probe_html_is_not_json() {
        let s = serve(vec![Canned::status(200).header("Content-Type", "text/html").body("<html>")]);
        assert_eq!(probe(None, &MemoryStore::default(), LlmKind::Ollama, &s.url, "m", None).unwrap_err().kind, NetErrorKind::NotJson);
    }

    #[test]
    fn error_body_never_contains_the_key() {
        let s = echo_header("authorization", 401);
        let c = cfg(json!({"llmProvider": "openai", "llmEndpointOpenai": s.url}));
        let store = store_with_openai_key(&c, "sk-k");
        let e = chat(&c, &store, LlmKind::Openai, json!({})).unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(401)));
        let text = serde_json::to_string(&e).unwrap();
        assert!(!text.contains("sk-k"), "{text}");
        let e = probe(Some(&c), &store, LlmKind::Openai, &s.url, "m", Some("sk-typed")).unwrap_err();
        assert!(!serde_json::to_string(&e).unwrap().contains("sk-typed"));
    }

    #[test]
    fn chat_url_matches_vendor_join_url() {
        let c = |o: &str| chat_url(LlmKind::Openai, &ServiceConfig::from_settings_json(&format!(r#"{{"llmProvider":"openai","llmEndpointOpenai":"{o}"}}"#))).unwrap().to_string();
        assert_eq!(c("http://h:1/"), "http://h:1/v1/chat/completions");
        assert_eq!(c(" 127.0.0.1:11434/ "), "http://127.0.0.1:11434/v1/chat/completions");
        assert_eq!(c("localhost:11434"), "http://localhost:11434/v1/chat/completions");
        assert_eq!(c("https://gw.lab.kr/openai"), "https://gw.lab.kr/openai/v1/chat/completions");
        let o = chat_url(LlmKind::Ollama, &cfg(json!({"llmEndpointOllama": "http://h:2/x/"}))).unwrap().to_string();
        assert_eq!(o, "http://h:2/x/api/chat");
        assert_eq!(chat_url(LlmKind::None, &cfg(json!({}))).unwrap_err().kind, NetErrorKind::NotConfigured);
    }

    #[test]
    fn llm_chat_to_plain_http_non_loopback_is_insecure() {
        let c = cfg(json!({"llmProvider": "openai", "llmEndpointOpenai": "http://10.255.255.1:9"}));
        let store = store_with_openai_key(&c, "sk-k");
        let t = std::time::Instant::now();
        assert_eq!(chat(&c, &store, LlmKind::Openai, json!({})).unwrap_err().kind, NetErrorKind::Insecure);
        assert!(t.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn probe_serializes_camel_case() {
        let p = LlmProbe { models: vec!["a".into()], model_found: true };
        assert_eq!(serde_json::to_value(&p).unwrap(), json!({"models": ["a"], "modelFound": true}));
        let i = Incoming { status: 200, text: "x".into() };
        assert_eq!(serde_json::to_value(&i).unwrap(), json!({"status": 200, "text": "x"}));
    }

    #[test]
    fn openai_base_strips_only_a_final_v1_segment() {
        let b = |u: &str| openai_base(&parse_llm_endpoint(u).unwrap()).to_string();
        assert_eq!(b("https://host/v1"), "https://host/");
        assert_eq!(b("https://host/v1/"), "https://host/");
        assert_eq!(b("https://gw.lab.kr/openai/v1"), "https://gw.lab.kr/openai");
        assert_eq!(b("https://gw.lab.kr/openai/v1/"), "https://gw.lab.kr/openai");
        for u in ["https://host/v1x", "https://host/api/v10", "https://host/V1", "https://host/v1/chat/completions", "https://host/openai"] {
            assert_eq!(b(u), parse_llm_endpoint(u).unwrap().to_string(), "{u}");
        }
        // Only one segment is removed.
        assert_eq!(b("https://host/v1/v1"), "https://host/v1");
    }

    #[test]
    fn openai_chat_url_treats_a_trailing_v1_as_the_base() {
        let c = |o: &str| chat_url(LlmKind::Openai, &cfg(json!({"llmProvider": "openai", "llmEndpointOpenai": o}))).unwrap().to_string();
        assert_eq!(c("https://host/v1"), "https://host/v1/chat/completions");
        assert_eq!(c("https://host/v1/"), "https://host/v1/chat/completions");
        assert_eq!(c("https://gw.lab.kr/openai/v1"), "https://gw.lab.kr/openai/v1/chat/completions");
        assert_eq!(c("https://host/v1x"), "https://host/v1x/v1/chat/completions");
        assert_eq!(c("https://host/api/v10"), "https://host/api/v10/v1/chat/completions");
        assert_eq!(c("https://host/V1"), "https://host/V1/v1/chat/completions");
        let o = chat_url(LlmKind::Ollama, &cfg(json!({"llmEndpointOllama": "http://localhost:11434/v1"}))).unwrap().to_string();
        assert_eq!(o, "http://localhost:11434/v1/api/chat");
    }

    #[test]
    fn openai_chat_with_v1_endpoint_posts_once_to_v1_chat_completions() {
        let s = serve(vec![Canned::ok("{}")]);
        let c = cfg(json!({"llmProvider": "openai", "llmEndpointOpenai": format!("{}/v1", s.url)}));
        chat(&c, &MemoryStore::default(), LlmKind::Openai, json!({})).unwrap();
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].path, "/v1/chat/completions");
    }

    #[test]
    fn openai_probe_with_v1_endpoint_hits_v1_models_with_the_stored_key() {
        let s = serve(vec![Canned::ok(r#"{"data":[{"id":"m"}]}"#)]);
        let c = cfg(json!({"llmProvider": "openai", "llmEndpointOpenai": s.url}));
        let store = store_with_openai_key(&c, "sk-stored");
        let p = probe(Some(&c), &store, LlmKind::Openai, &format!("{}/v1", s.url), "m", None).unwrap();
        assert!(p.model_found);
        settle();
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].path, "/v1/models");
        assert_eq!(reqs[0].header("authorization"), Some("Bearer sk-stored"));
    }

    #[test]
    fn ollama_probe_keeps_a_trailing_v1() {
        let s = serve(vec![Canned::ok(r#"{"models":[]}"#)]);
        probe(None, &MemoryStore::default(), LlmKind::Ollama, &format!("{}/v1", s.url), "m", None).unwrap();
        assert_eq!(s.requests.lock().unwrap()[0].path, "/v1/api/tags");
    }
}
