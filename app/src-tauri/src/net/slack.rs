//! Slack calls for the scan inbox (SP7 B6). The bot token stays in Rust.
//!
//! - `slack_call` takes a method from the allow-list `SlackMethod` and builds
//!   `https://slack.com/api/<method>` itself; the webview never names a host.
//!   A 429 is an answer (`retryAfter`), so the inbox can pause.
//! - `slack_download` re-validates the file URL (`https`, host exactly
//!   `files.slack.com`, no userinfo, no port but 443, path under
//!   `/files-pri/`) before the token is attached or anything is sent, and
//!   never follows a redirect (the token never follows one either).
//! - The token is redacted from every reply text and error.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use super::config::{ServiceConfig, Url};
use super::error::{redact_text, NetError, NetErrorKind};
use super::http::{parse_json, send_raw, IncomingRaw, Outgoing};
use super::secrets::{key_for, SecretStore, Secrets, Slot};
use super::NetState;

/// The production base every Slack Web API call is built on.
pub const SLACK_API: &str = "https://slack.com/api/";

/// The largest file a download may hold (plugin `MAX_FILE_BYTES`).
pub const MAX_SLACK_FILE_BYTES: usize = 100 * 1024 * 1024;

/// The body cap of a Web API answer (the shared `MAX_BODY`).
const SLACK_CALL_MAX_BODY: usize = super::http::MAX_BODY;

pub const SLACK_CALL_TIMEOUT: Duration = Duration::from_secs(30);
pub const SLACK_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// The only Web API methods the app calls.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SlackMethod {
    AuthTest,
    ConversationsHistory,
    ConversationsList,
    ChatPostMessage,
    ReactionsAdd,
}

impl SlackMethod {
    /// The Web API method name, appended to the base.
    pub fn path(self) -> &'static str {
        match self {
            SlackMethod::AuthTest => "auth.test",
            SlackMethod::ConversationsHistory => "conversations.history",
            SlackMethod::ConversationsList => "conversations.list",
            SlackMethod::ChatPostMessage => "chat.postMessage",
            SlackMethod::ReactionsAdd => "reactions.add",
        }
    }

    /// The reads are GET with a query; the others POST a JSON body.
    pub fn http(self) -> reqwest::Method {
        match self {
            SlackMethod::ConversationsHistory | SlackMethod::ConversationsList => reqwest::Method::GET,
            _ => reqwest::Method::POST,
        }
    }
}

/// A Web API answer: a 2xx or a 429, parsed. `scopes` is `X-OAuth-Scopes`
/// and `retry_after` is `Retry-After` in seconds, when present.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SlackReply {
    pub status: u16,
    pub json: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u32>,
}

/// `true` only for a Slack private file URL: `https`, host exactly
/// `files.slack.com`, port `None` or 443, no userinfo, path under `/files-pri/`.
pub fn download_url_ok(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("files.slack.com")
        && matches!(url.port(), None | Some(443))
        && url.username().is_empty()
        && url.password().is_none()
        && url.path().starts_with("/files-pri/")
}

fn key_missing() -> NetError {
    NetError::new(NetErrorKind::KeyMissing, "no Slack bot token is set")
}

fn forbidden() -> NetError {
    NetError::new(NetErrorKind::ForbiddenPath, "this Slack file address is not allowed")
}

/// The stored bot token. The Slack slot's account does not depend on the
/// vault's settings, so an empty config names it.
fn token(store: &dyn SecretStore) -> Result<String, NetError> {
    key_for(store, Slot::SlackBot, &ServiceConfig::from_settings_json("{}"))?.ok_or_else(key_missing)
}

/// The query of a GET method: `params` must be `null` or an object whose
/// values are strings or numbers (`badInput` otherwise, nothing sent).
fn query_of(params: &Value) -> Result<Vec<(String, String)>, NetError> {
    let bad = || NetError::new(NetErrorKind::BadInput, "Slack query values must be strings or numbers");
    match params {
        Value::Null => Ok(Vec::new()),
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| match v {
                Value::String(s) => Ok((k.clone(), s.clone())),
                Value::Number(n) => Ok((k.clone(), n.to_string())),
                _ => Err(bad()),
            })
            .collect(),
        _ => Err(bad()),
    }
}

/// A kept response header's value.
fn header<'a>(raw: &'a IncomingRaw, name: &str) -> Option<&'a str> {
    raw.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// One Web API call to `base` + the method name, with the stored bot token
/// (`keyMissing` without one, nothing sent). The production base is
/// `SLACK_API`; only tests pass another. A 2xx or a 429 is a reply whose JSON
/// has the token redacted; a 2xx that is not JSON is `notJson`, and a 429 that
/// is not JSON has `json: null`.
pub async fn slack_call_with(
    net: &NetState,
    store: &dyn SecretStore,
    base: &Url,
    request_id: Option<&str>,
    method: SlackMethod,
    params: Value,
) -> Result<SlackReply, NetError> {
    let http = method.http();
    let mut url = base
        .join(method.path())
        .map_err(|_| NetError::new(NetErrorKind::InvalidUrl, "the address is not valid"))?;
    let json = if http == reqwest::Method::GET {
        let query = query_of(&params)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        }
        None
    } else {
        match params {
            Value::Null => Some(Value::Object(Default::default())),
            Value::Object(_) => Some(params),
            _ => return Err(NetError::new(NetErrorKind::BadInput, "Slack parameters must be an object")),
        }
    };
    let token = token(store)?;
    let mut headers: Vec<(&'static str, String)> = vec![("Authorization", format!("Bearer {token}"))];
    if json.is_some() {
        headers.push(("Content-Type", "application/json; charset=utf-8".to_string()));
    }
    let out = Outgoing {
        method: http,
        url,
        headers,
        json,
        timeout: Some(SLACK_CALL_TIMEOUT),
        max_body: SLACK_CALL_MAX_BODY,
        secret: Some(token.clone()),
        allow_http: false,
    };
    let raw = send_raw(net, request_id, out).await?;
    let secret = Some(token.as_str());
    let text = redact_text(&String::from_utf8_lossy(&raw.bytes), secret);
    let json = match parse_json(&text) {
        Ok(v) => v,
        Err(_) if raw.status == 429 => Value::Null,
        Err(e) => return Err(e),
    };
    Ok(SlackReply {
        status: raw.status,
        json,
        scopes: header(&raw, "x-oauth-scopes").map(|v| redact_text(v, secret)),
        retry_after: header(&raw, "retry-after").and_then(|v| v.trim().parse().ok()),
    })
}

/// Downloads `url` with the stored bot token. A URL that is not a Slack
/// private file URL (`download_url_ok`) is `forbiddenPath` before the token is
/// read or anything is sent; so is a string that is not a URL.
pub async fn slack_download_checked(
    net: &NetState,
    store: &dyn SecretStore,
    request_id: Option<&str>,
    url: &str,
) -> Result<Vec<u8>, NetError> {
    let url = Url::parse(url).map_err(|_| forbidden())?;
    if !download_url_ok(&url) {
        return Err(forbidden());
    }
    slack_download_from(net, store, request_id, url).await
}

/// Downloads `url` with the stored bot token, without the URL check (only
/// `slack_download_checked` and the tests call it). A 3xx is `redirect` (never
/// followed), every non-2xx (429 included) is `status`, and an HTML page (a
/// sign-in page, say) is `notJson`. The bytes are the file and are not
/// redacted; every error is.
pub(crate) async fn slack_download_from(
    net: &NetState,
    store: &dyn SecretStore,
    request_id: Option<&str>,
    url: Url,
) -> Result<Vec<u8>, NetError> {
    let token = token(store)?;
    let out = Outgoing {
        method: reqwest::Method::GET,
        url,
        headers: vec![("Authorization", format!("Bearer {token}"))],
        json: None,
        timeout: Some(SLACK_DOWNLOAD_TIMEOUT),
        max_body: MAX_SLACK_FILE_BYTES,
        secret: Some(token.clone()),
        allow_http: false,
    };
    let raw = send_raw(net, request_id, out).await?;
    if !(200..300).contains(&raw.status) {
        return Err(NetError::status(raw.status, &String::from_utf8_lossy(&raw.bytes), Some(&token)));
    }
    let html = header(&raw, "content-type").is_some_and(|v| v.trim().to_ascii_lowercase().starts_with("text/html"));
    if html {
        return Err(NetError::new(NetErrorKind::NotJson, "Slack answered with a web page instead of the file"));
    }
    Ok(raw.bytes)
}

#[tauri::command]
pub async fn slack_call(
    net: State<'_, NetState>,
    secrets: State<'_, Secrets>,
    request_id: String,
    method: SlackMethod,
    params: Value,
) -> Result<SlackReply, NetError> {
    let base = Url::parse(SLACK_API).map_err(|_| NetError::new(NetErrorKind::InvalidUrl, "the address is not valid"))?;
    slack_call_with(&net, secrets.0.as_ref(), &base, Some(&request_id), method, params).await
}

#[tauri::command]
pub async fn slack_download(
    net: State<'_, NetState>,
    secrets: State<'_, Secrets>,
    request_id: String,
    url: String,
) -> Result<tauri::ipc::Response, NetError> {
    let bytes = slack_download_checked(&net, secrets.0.as_ref(), Some(&request_id), &url).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::secrets::{account, MemoryStore};
    use crate::net::testserver::{echo_header, serve, Canned};
    use tauri::async_runtime::block_on;

    const TOKEN: &str = "xoxb-t";

    fn store_with_token() -> MemoryStore {
        let store = MemoryStore::default();
        store.set(&account(Slot::SlackBot, &ServiceConfig::from_settings_json("{}")).unwrap(), TOKEN).unwrap();
        store
    }

    fn base(url: &str) -> Url {
        Url::parse(&format!("{url}/")).unwrap()
    }

    fn call(url: &str, store: &MemoryStore, method: SlackMethod, params: Value) -> Result<SlackReply, NetError> {
        block_on(slack_call_with(&NetState::default(), store, &base(url), None, method, params))
    }

    fn download(url: &str, store: &MemoryStore) -> Result<Vec<u8>, NetError> {
        block_on(slack_download_from(&NetState::default(), store, None, Url::parse(url).unwrap()))
    }

    #[test]
    fn methods_map_to_paths_and_verbs() {
        assert_eq!(SlackMethod::AuthTest.path(), "auth.test");
        assert_eq!(SlackMethod::ConversationsHistory.path(), "conversations.history");
        assert_eq!(SlackMethod::ConversationsList.path(), "conversations.list");
        assert_eq!(SlackMethod::ChatPostMessage.path(), "chat.postMessage");
        assert_eq!(SlackMethod::ReactionsAdd.path(), "reactions.add");
        assert_eq!(SlackMethod::ConversationsHistory.http(), reqwest::Method::GET);
        assert_eq!(SlackMethod::ConversationsList.http(), reqwest::Method::GET);
        assert_eq!(SlackMethod::AuthTest.http(), reqwest::Method::POST);
        assert_eq!(SlackMethod::ChatPostMessage.http(), reqwest::Method::POST);
        assert_eq!(SlackMethod::ReactionsAdd.http(), reqwest::Method::POST);
        let m: SlackMethod = serde_json::from_value(serde_json::json!("conversationsHistory")).unwrap();
        assert_eq!(m, SlackMethod::ConversationsHistory);
        assert!(serde_json::from_value::<SlackMethod>(serde_json::json!("filesDelete")).is_err());
        assert!(SLACK_API.starts_with("https://slack.com/api/"));
    }

    #[test]
    fn auth_test_sends_bearer_and_reports_scopes() {
        let s = serve(vec![Canned::ok(r#"{"ok":true}"#).header("X-OAuth-Scopes", "im:history,files:read")]);
        let r = call(&s.url, &store_with_token(), SlackMethod::AuthTest, serde_json::json!({})).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.json["ok"], true);
        assert_eq!(r.scopes.as_deref(), Some("im:history,files:read"));
        assert_eq!(r.retry_after, None);
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "POST");
        assert_eq!(reqs[0].path, "/auth.test");
        assert_eq!(reqs[0].header("authorization"), Some("Bearer xoxb-t"));
    }

    #[test]
    fn post_methods_send_params_as_json() {
        let s = serve(vec![Canned::ok(r#"{"ok":true}"#)]);
        let params = serde_json::json!({"channel": "D1", "text": "안녕"});
        call(&s.url, &store_with_token(), SlackMethod::ChatPostMessage, params.clone()).unwrap();
        let reqs = s.requests.lock().unwrap();
        assert_eq!((reqs[0].method.as_str(), reqs[0].path.as_str()), ("POST", "/chat.postMessage"));
        assert!(reqs[0].header("content-type").unwrap().starts_with("application/json"));
        assert_eq!(serde_json::from_str::<Value>(&reqs[0].body).unwrap(), params);
    }

    #[test]
    fn history_is_get_with_query_from_params() {
        let s = serve(vec![Canned::ok(r#"{"ok":true,"messages":[]}"#)]);
        let params = serde_json::json!({"channel": "D1", "limit": 200, "oldest": "1.2"});
        call(&s.url, &store_with_token(), SlackMethod::ConversationsHistory, params).unwrap();
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "GET");
        assert_eq!(reqs[0].path, "/conversations.history?channel=D1&limit=200&oldest=1.2");
        assert_eq!(reqs[0].body, "");
    }

    #[test]
    fn a_get_param_that_is_not_a_string_or_number_is_bad_input_and_nothing_sent() {
        let s = serve(vec![Canned::ok("{}")]);
        for params in [serde_json::json!({"channel": ["D1"]}), serde_json::json!({"x": {"y": 1}}), serde_json::json!([1])] {
            let e = call(&s.url, &store_with_token(), SlackMethod::ConversationsList, params.clone()).unwrap_err();
            assert_eq!(e.kind, NetErrorKind::BadInput, "{params}");
        }
        // No params at all is an empty query.
        call(&s.url, &store_with_token(), SlackMethod::ConversationsList, Value::Null).unwrap();
        assert_eq!(s.requests.lock().unwrap()[0].path, "/conversations.list");
    }

    #[test]
    fn rate_limited_reply_carries_retry_after() {
        let s = serve(vec![Canned::status(429)
            .header("Content-Type", "application/json")
            .header("Retry-After", "30")
            .body(r#"{"ok":false,"error":"ratelimited"}"#)]);
        let r = call(&s.url, &store_with_token(), SlackMethod::ConversationsHistory, serde_json::json!({"channel": "D1"}))
            .unwrap();
        assert_eq!(r.status, 429);
        assert_eq!(r.retry_after, Some(30));
        assert_eq!(r.json["error"], "ratelimited");
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["retryAfter"], 30);
        assert!(v.get("scopes").is_none());
    }

    #[test]
    fn a_non_json_answer_is_not_json() {
        let s = serve(vec![Canned::ok("<html>portal</html>").header("Content-Type", "text/html")]);
        let e = call(&s.url, &store_with_token(), SlackMethod::AuthTest, serde_json::json!({})).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::NotJson);
    }

    #[test]
    fn slack_download_refuses_non_files_slack_host_and_sends_no_token() {
        for u in ["http://files.slack.com/files-pri/x", "https://files.slack.com.evil.example/files-pri/x", "https://evil.example/files-pri/x",
                  "https://u:p@files.slack.com/files-pri/x", "https://files.slack.com:8443/files-pri/x", "https://files.slack.com/api/x",
                  "https://u@files.slack.com/files-pri/x", "https://files.slack.com/files-prix", "https://files.slack.com./files-pri/x"] {
            assert!(!download_url_ok(&Url::parse(u).unwrap()), "{u}");
        }
        for u in ["https://files.slack.com/files-pri/T1-F1/scan.png", "https://files.slack.com:443/files-pri/T1-F1/a.pdf",
                  "https://FILES.SLACK.COM/files-pri/T1-F1/a.jpg"] {
            assert!(download_url_ok(&Url::parse(u).unwrap()), "{u}");
        }
        // The checked download refuses before anything else, token or not,
        // and a string that is not a URL is refused the same way.
        let store = store_with_token();
        for u in ["https://evil.example/files-pri/x", "http://127.0.0.1:9/files-pri/x", "not a url", ""] {
            let e = block_on(slack_download_checked(&NetState::default(), &store, None, u)).unwrap_err();
            assert_eq!(e.kind, NetErrorKind::ForbiddenPath, "{u}");
        }
        let e = block_on(slack_download_checked(&NetState::default(), &MemoryStore::default(), None, "https://evil.example/x"))
            .unwrap_err();
        assert_eq!(e.kind, NetErrorKind::ForbiddenPath);
    }

    #[test]
    fn download_returns_the_bytes_with_the_bearer_token() {
        let body: Vec<u8> = vec![0xff, 0xd8, 0xff, 0x00, 0x01];
        let s = serve(vec![Canned::ok("").header("Content-Type", "image/jpeg").body(body.clone())]);
        assert_eq!(download(&format!("{}/files-pri/T1-F1/a.jpg", s.url), &store_with_token()).unwrap(), body);
        let reqs = s.requests.lock().unwrap();
        assert_eq!((reqs[0].method.as_str(), reqs[0].path.as_str()), ("GET", "/files-pri/T1-F1/a.jpg"));
        assert_eq!(reqs[0].header("authorization"), Some("Bearer xoxb-t"));
    }

    #[test]
    fn download_of_an_html_page_is_not_json() {
        let s = serve(vec![Canned::ok("<html>sign in</html>").header("Content-Type", "text/html; charset=utf-8")]);
        assert_eq!(download(&s.url, &store_with_token()).unwrap_err().kind, NetErrorKind::NotJson);
    }

    #[test]
    fn download_non_2xx_is_status_even_429() {
        let s = serve(vec![Canned::status(404), Canned::status(429).header("Retry-After", "5")]);
        let e = download(&s.url, &store_with_token()).unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(404)));
        let e = download(&s.url, &store_with_token()).unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(429)));
    }

    #[test]
    fn download_redirect_is_an_error_and_token_does_not_follow() {
        let second = serve(vec![Canned::ok("stolen")]);
        let first = serve(vec![Canned::status(302).header("Location", format!("{}/steal", second.url))]);
        let e = download(&format!("{}/files-pri/x", first.url), &store_with_token()).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Redirect);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(second.requests.lock().unwrap().len(), 0);
    }

    #[test]
    fn token_never_appears_in_a_reply_or_error() {
        let store = store_with_token();
        // Errors: a non-2xx echo of the Authorization header, for calls and downloads.
        let s = echo_header("authorization", 500);
        let e = call(&s.url, &store, SlackMethod::AuthTest, serde_json::json!({})).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Status);
        let text = serde_json::to_string(&e).unwrap();
        assert!(!text.contains(TOKEN) && text.contains("***"), "{text}");
        let e = download(&s.url, &store).unwrap_err();
        let text = serde_json::to_string(&e).unwrap();
        assert!(!text.contains(TOKEN) && text.contains("***"), "{text}");
        // A 2xx echo is not JSON, and the error carries no body.
        let s = echo_header("authorization", 200);
        let e = call(&s.url, &store, SlackMethod::AuthTest, serde_json::json!({})).unwrap_err();
        assert!(!serde_json::to_string(&e).unwrap().contains(TOKEN));
        // A JSON reply that quotes the token, in the body or in a header, is redacted.
        let s = serve(vec![
            Canned::ok(r#"{"ok":true,"echo":"Bearer xoxb-t"}"#).header("X-OAuth-Scopes", "xoxb-t"),
            Canned::status(429).header("Retry-After", "1").body(r#"{"ok":false,"echo":"xoxb-t"}"#),
        ]);
        for _ in 0..2 {
            let r = call(&s.url, &store, SlackMethod::AuthTest, serde_json::json!({})).unwrap();
            let text = serde_json::to_string(&r).unwrap();
            assert!(!text.contains(TOKEN) && text.contains("***"), "{text}");
        }
    }

    #[test]
    fn no_token_is_key_missing_and_nothing_sent() {
        let s = serve(vec![Canned::ok("{}"), Canned::ok("{}")]);
        let empty = MemoryStore::default();
        assert_eq!(call(&s.url, &empty, SlackMethod::AuthTest, serde_json::json!({})).unwrap_err().kind, NetErrorKind::KeyMissing);
        assert_eq!(download(&format!("{}/files-pri/x", s.url), &empty).unwrap_err().kind, NetErrorKind::KeyMissing);
        let e = block_on(slack_download_checked(&NetState::default(), &empty, None, "https://files.slack.com/files-pri/x"))
            .unwrap_err();
        assert_eq!(e.kind, NetErrorKind::KeyMissing);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(s.requests.lock().unwrap().len(), 0);
    }

    #[test]
    fn a_cancelled_request_id_sends_nothing() {
        let s = serve(vec![Canned::ok("{}")]);
        let net = NetState::default();
        assert!(!net.cancel("s1"));
        let e = block_on(slack_call_with(&net, &store_with_token(), &base(&s.url), Some("s1"), SlackMethod::AuthTest, Value::Null))
            .unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Cancelled);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(s.requests.lock().unwrap().len(), 0);
    }
}
