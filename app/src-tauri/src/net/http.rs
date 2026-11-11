//! The one HTTP client every integration uses (D7), and `send`, which every
//! network command goes through.
//!
//! - Redirects are never followed: reqwest does not strip a custom
//!   `X-API-Key` on a cross-host redirect, so a 3xx is the error `redirect`
//!   carrying only the target origin.
//! - A key never goes to a non-loopback `http://` origin unless the vault
//!   allowed that origin (`insecure`, nothing sent).
//! - Bodies are capped (`tooLarge`), and the key in use is redacted from every
//!   text that comes back, 2xx included.
//! - A request with an id can be cancelled from the webview (`net_cancel`).
//! - `send_raw` follows the same rules but answers raw bytes and a few
//!   headers, and treats a 429 as an answer (Slack's rate limit carries
//!   `Retry-After`); `send` is `send_raw` plus UTF-8 text and redaction.
//! - `send_answer` (the GitHub client) follows the same rules but answers
//!   every status as `IncomingRaw`, a 3xx with its `location` (still never
//!   followed), so the caller can classify 401/403/404/422/451/301 itself.

use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, LOCATION};

use super::config::{is_loopback, origin, Url};
use super::error::{redact_text, NetError, NetErrorKind};
use super::NetState;

/// The most a response body may hold (32 MiB).
pub const MAX_BODY: usize = 32 * 1024 * 1024;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The shared client: no redirects, a 10 s connect timeout, rustls with ring
/// (the provider the updater already installs; installed here when missing).
pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            // Fails only when another thread installed one meanwhile, which is fine.
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent(concat!("labnoteO-Desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            // Only fails when no TLS backend can be set up, which the provider
            // install above rules out; there is nothing to fall back to.
            .expect("the HTTP client builds")
    })
}

/// One request. `secret` is the key the request carries (in a header the
/// caller set); it drives the TLS rule and the redaction of every answer.
pub struct Outgoing {
    pub method: reqwest::Method,
    pub url: Url,
    pub headers: Vec<(&'static str, String)>,
    pub json: Option<serde_json::Value>,
    pub timeout: Option<Duration>,
    pub max_body: usize,
    pub secret: Option<String>,
    /// Set by the caller when the vault's `allowHttpOrigins` holds the URL's origin.
    pub allow_http: bool,
}

/// Never prints the key: `secret` and every header value show as `***`, and
/// so does the key inside the URL (the NCBI key goes in the query string).
impl std::fmt::Debug for Outgoing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let headers: Vec<(&str, &str)> = self.headers.iter().map(|(k, _)| (*k, "***")).collect();
        f.debug_struct("Outgoing")
            .field("method", &self.method)
            .field("url", &redact_text(self.url.as_str(), self.secret.as_deref()))
            .field("headers", &headers)
            .field("json", &self.json.as_ref().map(|_| "..."))
            .field("timeout", &self.timeout)
            .field("max_body", &self.max_body)
            .field("secret", &self.secret.as_ref().map(|_| "***"))
            .field("allow_http", &self.allow_http)
            .finish()
    }
}

/// A 2xx answer; `text` already has the key redacted. Serializes as
/// `{status, text}` (what `llm_chat` returns to the webview).
#[derive(Debug, serde::Serialize)]
pub struct Incoming {
    pub status: u16,
    pub text: String,
}

/// An answer as raw bytes: a 2xx or 429 from `send_raw`, any status from
/// `send_answer`. `headers` holds only the `KEPT_HEADERS` (names lower-cased)
/// that are present, plus `location` on a 3xx from `send_answer` (redacted).
/// Never `authorization` or a cookie. The bytes are not redacted: callers
/// that turn them into text redact it.
#[derive(Debug, Clone)]
pub struct IncomingRaw {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub bytes: Vec<u8>,
}

/// The response headers `IncomingRaw` keeps: `mcp-session-id` and
/// `www-authenticate` for the MCP client; `link` (GitHub pagination),
/// `x-github-sso` (its SAML hint) and the rate-limit pair (its back-off) for
/// the GitHub upload. Never `authorization` (pinned by a test).
const KEPT_HEADERS: [&str; 9] = [
    "content-type",
    "retry-after",
    "x-oauth-scopes",
    "mcp-session-id",
    "www-authenticate",
    "link",
    "x-github-sso",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
];

/// Unregisters the request id when `send` ends, however it ends (the command
/// future may also be dropped).
pub(crate) struct Registration<'a> {
    pub(crate) net: &'a NetState,
    pub(crate) id: &'a str,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.net.finish(self.id);
    }
}

pub(crate) fn cancelled() -> NetError {
    NetError::new(NetErrorKind::Cancelled, "cancelled")
}

/// Sends one request (see the module doc for the rules). Every error is
/// redacted with the request's key before it is returned, and a 2xx text
/// too. Any non-2xx (429 included) is a `status` error.
pub async fn send(net: &NetState, request_id: Option<&str>, out: Outgoing) -> Result<Incoming, NetError> {
    let secret = out.secret.clone();
    let raw = send_raw(net, request_id, out).await?;
    let text = String::from_utf8_lossy(&raw.bytes);
    if (200..300).contains(&raw.status) {
        Ok(Incoming { status: raw.status, text: redact_text(&text, secret.as_deref()) })
    } else {
        Err(NetError::status(raw.status, &text, secret.as_deref()))
    }
}

/// Sends one request with `send`'s rules (insecure, redirect, the body cap,
/// cancellation, redaction of every error), but answers the raw bytes and the
/// kept headers, and answers a 429 too instead of failing with `status`.
pub async fn send_raw(net: &NetState, request_id: Option<&str>, out: Outgoing) -> Result<IncomingRaw, NetError> {
    let secret = out.secret.clone();
    send_inner(net, request_id, out, false).await.map_err(|e| e.redact(secret.as_deref()))
}

/// Sends one request with `send_raw`'s rules (insecure, the body cap,
/// cancellation, redaction of every error), but answers **every** HTTP status
/// as `IncomingRaw`. A 3xx is not followed and not an error: it comes back
/// with its `location` header (the key redacted from it).
pub async fn send_answer(net: &NetState, request_id: Option<&str>, out: Outgoing) -> Result<IncomingRaw, NetError> {
    let secret = out.secret.clone();
    send_inner(net, request_id, out, true).await.map_err(|e| e.redact(secret.as_deref()))
}

async fn send_inner(
    net: &NetState,
    request_id: Option<&str>,
    out: Outgoing,
    accept_any_status: bool,
) -> Result<IncomingRaw, NetError> {
    refuse_insecure(&out.url, out.secret.is_some(), out.allow_http)?;
    let Some(id) = request_id else { return perform(out, accept_any_status).await };
    let notify = net.register(id)?;
    let _registration = Registration { net, id };
    tokio::select! {
        result = perform(out, accept_any_status) => result,
        _ = notify.notified() => Err(cancelled()),
    }
}

/// `insecure` when a key would go to a non-loopback `http://` origin the
/// vault did not allow (D7); checked before anything is sent.
pub(crate) fn refuse_insecure(url: &Url, has_secret: bool, allow_http: bool) -> Result<(), NetError> {
    if has_secret && url.scheme() == "http" && !is_loopback(url) && !allow_http {
        return Err(NetError::new(
            NetErrorKind::Insecure,
            "a key is never sent without TLS to a server that is not this computer",
        ));
    }
    Ok(())
}

pub(crate) fn header_map(headers: &[(&'static str, String)]) -> Result<HeaderMap, NetError> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        // Never name the value: it may be the key.
        let bad = || NetError::new(NetErrorKind::BadInput, format!("invalid value for header {name}"));
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| bad())?;
        let mut value = HeaderValue::from_str(value).map_err(|_| bad())?;
        if name == AUTHORIZATION || name.as_str() == "x-api-key" {
            value.set_sensitive(true);
        }
        map.insert(name, value);
    }
    Ok(map)
}

/// One request. With `accept_any_status` every status is an answer (a 3xx
/// keeps its redacted `location`); without it a 3xx is `redirect` and any
/// non-2xx but 429 is a `status` error.
async fn perform(out: Outgoing, accept_any_status: bool) -> Result<IncomingRaw, NetError> {
    let secret = out.secret.as_deref();
    let mut req = client().request(out.method.clone(), out.url.clone()).headers(header_map(&out.headers)?);
    if let Some(json) = &out.json {
        req = req.json(json);
    }
    if let Some(timeout) = out.timeout {
        req = req.timeout(timeout);
    }
    let resp = req.send().await.map_err(net_error)?;
    let status = resp.status().as_u16();
    let redirect = (300..400).contains(&status);
    if redirect && !accept_any_status {
        return Err(redirect_error(&resp, &out.url));
    }
    let mut headers: Vec<(String, String)> = KEPT_HEADERS
        .iter()
        .filter_map(|name| {
            let value = resp.headers().get(*name)?.to_str().ok()?;
            Some((name.to_string(), value.to_string()))
        })
        .collect();
    if redirect {
        if let Some(loc) = resp.headers().get(LOCATION).and_then(|v| v.to_str().ok()) {
            headers.push(("location".to_string(), redact_text(loc, secret)));
        }
    }
    let bytes = read_capped(resp, out.max_body).await?;
    if accept_any_status || (200..300).contains(&status) || status == 429 {
        Ok(IncomingRaw { status, headers, bytes })
    } else {
        Err(NetError::status(status, &String::from_utf8_lossy(&bytes), secret))
    }
}

/// The `redirect` error of a 3xx answer to `url`, with only the origin of
/// its `Location`.
pub(crate) fn redirect_error(resp: &reqwest::Response, url: &Url) -> NetError {
    let location = resp
        .headers()
        .get(LOCATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|loc| url.join(loc).ok())
        .filter(|u| u.has_host())
        .map(|u| origin(&u));
    NetError::redirect(location)
}

pub(crate) fn too_large() -> NetError {
    NetError::new(NetErrorKind::TooLarge, "the response is too large")
}

/// Reads the body, failing with `tooLarge` past `max`: before reading when
/// `Content-Length` already says so, otherwise as soon as the chunks exceed it.
pub(crate) async fn read_capped(resp: reqwest::Response, max: usize) -> Result<Vec<u8>, NetError> {
    if resp.content_length().is_some_and(|n| n > max as u64) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(net_error)?;
        if body.len() + chunk.len() > max {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Takes the longest valid UTF-8 text from the front of `buf`, leaving an
/// unfinished multi-byte char for the next chunk. Invalid bytes read as U+FFFD.
pub(crate) fn take_utf8(buf: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(buf) {
            Ok(s) => {
                out.push_str(s);
                buf.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&buf[..valid]).unwrap_or_default());
                match e.error_len() {
                    None => {
                        buf.drain(..valid);
                        return out;
                    }
                    Some(n) => {
                        out.push('\u{FFFD}');
                        buf.drain(..valid + n);
                    }
                }
            }
        }
    }
}

/// The error kind of a failed request.
pub fn kind_of(err: &reqwest::Error) -> NetErrorKind {
    if err.is_timeout() {
        return NetErrorKind::Timeout;
    }
    if err.is_connect() {
        let mut chain = String::new();
        let mut source: Option<&dyn std::error::Error> = Some(err);
        while let Some(e) = source {
            chain.push_str(&e.to_string().to_lowercase());
            chain.push('\n');
            source = e.source();
        }
        return if chain.contains("certificate") || chain.contains("tls") {
            NetErrorKind::Tls
        } else {
            NetErrorKind::Offline
        };
    }
    if err.is_builder() {
        return NetErrorKind::InvalidUrl;
    }
    NetErrorKind::Offline
}

/// A fixed message per kind, so no URL or library text reaches the webview.
pub(crate) fn net_error(err: reqwest::Error) -> NetError {
    let kind = kind_of(&err);
    let message = match kind {
        NetErrorKind::Timeout => "the server did not answer in time",
        NetErrorKind::Tls => "the secure connection could not be established",
        NetErrorKind::InvalidUrl => "the address is not valid",
        _ => "the server could not be reached",
    };
    NetError::new(kind, message)
}

/// Parses a response text as JSON; anything else (a captive portal's HTML,
/// say) is `notJson`.
pub fn parse_json(text: &str) -> Result<serde_json::Value, NetError> {
    serde_json::from_str(text).map_err(|_| NetError::new(NetErrorKind::NotJson, "the response is not JSON"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::testserver::{echo_header, refused_port, serve, silent, Canned};
    use crate::net::{NetErrorKind, NetState};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tauri::async_runtime::block_on;

    fn get(url: &str, secret: Option<&str>) -> Outgoing {
        Outgoing {
            method: reqwest::Method::GET,
            url: Url::parse(url).unwrap(),
            headers: Vec::new(),
            json: None,
            timeout: Some(Duration::from_secs(5)),
            max_body: MAX_BODY,
            secret: secret.map(str::to_string),
            allow_http: false,
        }
    }

    #[test]
    fn get_returns_status_and_text() {
        let s = serve(vec![Canned::ok("{\"ok\":1}")]);
        let inc = block_on(send(&NetState::default(), None, get(&s.url, None))).unwrap();
        assert_eq!(inc.status, 200);
        assert_eq!(inc.text, "{\"ok\":1}");
        assert_eq!(parse_json(&inc.text).unwrap()["ok"], 1);
    }

    #[test]
    fn json_body_and_headers_are_sent() {
        let s = serve(vec![Canned::ok("{}")]);
        let mut out = get(&s.url, Some("pbk_secret"));
        out.method = reqwest::Method::POST;
        out.url = Url::parse(&format!("{}/api/x", s.url)).unwrap();
        out.json = Some(serde_json::json!({"a": 1}));
        out.headers.push(("X-API-Key", "pbk_secret".into()));
        block_on(send(&NetState::default(), None, out)).unwrap();
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "POST");
        assert_eq!(reqs[0].path, "/api/x");
        assert_eq!(reqs[0].header("x-api-key"), Some("pbk_secret"));
        assert_eq!(reqs[0].body, "{\"a\":1}");
        assert!(reqs[0].header("user-agent").unwrap().starts_with("labnoteO-Desktop/"));
    }

    #[test]
    fn non_2xx_is_status_kind_with_cut_body() {
        let s = serve(vec![Canned::status(500).body("x".repeat(5000))]);
        let e = block_on(send(&NetState::default(), None, get(&s.url, None))).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Status);
        assert_eq!(e.status, Some(500));
        assert_eq!(e.body.unwrap().chars().count(), 2000);
    }

    #[test]
    fn redirect_is_an_error_and_key_never_reaches_second_host() {
        let second = serve(vec![Canned::ok("{}")]);
        let first = serve(vec![Canned::status(302).header("Location", format!("{}/steal", second.url))]);
        let mut out = get(&first.url, Some("pbk_secret"));
        out.headers.push(("X-API-Key", "pbk_secret".into()));
        let e = block_on(send(&NetState::default(), None, out)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Redirect);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(second.requests.lock().unwrap().len(), 0);
    }

    #[test]
    fn key_is_redacted_from_body_and_message() {
        let s = echo_header("x-api-key", 500);
        let mut out = get(&s.url, Some("pbk_secret"));
        out.headers.push(("X-API-Key", "pbk_secret".into()));
        let e = block_on(send(&NetState::default(), None, out)).unwrap_err();
        let text = serde_json::to_string(&e).unwrap();
        assert!(!text.contains("pbk_secret"));
        assert!(text.contains("***"));
    }

    #[test]
    fn redirect_reports_the_target_origin_only() {
        let s = serve(vec![Canned::status(302).header("Location", "https://pb.example/api/v1/x?token=1")]);
        let e = block_on(send(&NetState::default(), None, get(&s.url, None))).unwrap_err();
        assert_eq!(e.location.as_deref(), Some("https://pb.example"));
        assert!(!serde_json::to_string(&e).unwrap().contains("token"));
    }

    #[test]
    fn redirect_without_a_usable_location_has_none() {
        let s = serve(vec![Canned::status(301)]);
        let e = block_on(send(&NetState::default(), None, get(&s.url, None))).unwrap_err();
        assert_eq!((e.kind, e.location), (NetErrorKind::Redirect, None));
    }

    #[test]
    fn two_xx_echo_is_redacted() {
        let s = echo_header("x-api-key", 200);
        let mut out = get(&s.url, Some("pbk_secret"));
        out.headers.push(("X-API-Key", "pbk_secret".into()));
        let inc = block_on(send(&NetState::default(), None, out)).unwrap();
        assert!(!inc.text.contains("pbk_secret"));
        assert!(inc.text.contains("***"));
    }

    #[test]
    fn key_to_plain_http_non_loopback_is_insecure_and_sends_nothing() {
        let t = Instant::now();
        let e = block_on(send(&NetState::default(), None, get("http://10.255.255.1:9/x", Some("pbk_secret")))).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Insecure);
        assert!(t.elapsed() < Duration::from_millis(100)); // refused before any connect
        let mut allowed = get("http://10.255.255.1:9/x", Some("pbk_secret"));
        allowed.allow_http = true;
        allowed.timeout = Some(Duration::from_millis(200));
        assert_ne!(block_on(send(&NetState::default(), None, allowed)).unwrap_err().kind, NetErrorKind::Insecure);
        let s = serve(vec![Canned::ok("{}")]); // loopback http is fine
        assert!(block_on(send(&NetState::default(), None, get(&s.url, Some("pbk_secret")))).is_ok());
    }

    #[test]
    fn plain_http_without_a_key_is_not_insecure() {
        let mut out = get("http://10.255.255.1:9/x", None);
        out.timeout = Some(Duration::from_millis(200));
        assert_ne!(block_on(send(&NetState::default(), None, out)).unwrap_err().kind, NetErrorKind::Insecure);
    }

    #[test]
    fn outgoing_debug_never_prints_the_key() {
        let mut out = get("https://pb.example/x", Some("pbk_secret"));
        out.headers.push(("X-API-Key", "pbk_secret".into()));
        out.headers.push(("Authorization", "Bearer pbk_secret".into()));
        let text = format!("{out:?}");
        assert!(!text.contains("pbk_secret"));
        assert!(text.contains("X-API-Key"));
    }

    #[test]
    fn body_over_cap_is_too_large() {
        // Announced by Content-Length.
        let s = serve(vec![Canned::ok(&"x".repeat(2048))]);
        let mut out = get(&s.url, None);
        out.max_body = 1024;
        assert_eq!(block_on(send(&NetState::default(), None, out)).unwrap_err().kind, NetErrorKind::TooLarge);
        // Streamed with no Content-Length.
        let s = serve(vec![Canned::ok("").chunk(Duration::ZERO, &[b'x'; 700]).chunk(Duration::from_millis(10), &[b'x'; 700])]);
        let mut out = get(&s.url, None);
        out.max_body = 1024;
        assert_eq!(block_on(send(&NetState::default(), None, out)).unwrap_err().kind, NetErrorKind::TooLarge);
        // Exactly at the cap is fine.
        let s = serve(vec![Canned::ok(&"x".repeat(1024))]);
        let mut out = get(&s.url, None);
        out.max_body = 1024;
        assert_eq!(block_on(send(&NetState::default(), None, out)).unwrap().text.len(), 1024);
    }

    #[test]
    fn timeout_is_timeout_kind() {
        let s = silent();
        let mut out = get(&s.url, None);
        out.timeout = Some(Duration::from_millis(200));
        assert_eq!(block_on(send(&NetState::default(), None, out)).unwrap_err().kind, NetErrorKind::Timeout);
    }

    #[test]
    fn offline_when_nothing_listens() {
        let e = block_on(send(&NetState::default(), None, get(&refused_port(), None))).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Offline);
    }

    #[test]
    fn cancel_ends_a_pending_request_with_cancelled() {
        let s = silent();
        let net = Arc::new(NetState::default());
        let n2 = net.clone();
        let url = s.url.clone();
        let h = std::thread::spawn(move || block_on(send(&n2, Some("r1"), get(&url, None))));
        std::thread::sleep(Duration::from_millis(150));
        assert!(net.cancel("r1"));
        assert_eq!(h.join().unwrap().unwrap_err().kind, NetErrorKind::Cancelled);
        assert!(!net.cancel("r1")); // finished requests are forgotten
    }

    #[test]
    fn cancel_before_register_prevents_the_request() {
        let s = serve(vec![Canned::ok("{}")]);
        let net = NetState::default();
        assert!(!net.cancel("r9"));
        assert_eq!(block_on(send(&net, Some("r9"), get(&s.url, None))).unwrap_err().kind, NetErrorKind::Cancelled);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(s.requests.lock().unwrap().len(), 0);
        // The early cancel is used up: the same id may run afterwards.
        assert!(block_on(send(&net, Some("r9"), get(&s.url, None))).is_ok());
    }

    #[test]
    fn a_finished_request_id_is_forgotten_after_an_error_too() {
        let net = NetState::default();
        let _ = block_on(send(&net, Some("r2"), get(&refused_port(), None)));
        assert!(!net.cancel("r2"));
    }

    #[test]
    fn web_slot_spaces_calls_by_gap() {
        let net = NetState::default();
        let t = Instant::now();
        for _ in 0..3 {
            block_on(net.web_slot(Duration::from_millis(150)));
        }
        assert!(t.elapsed() >= Duration::from_millis(300));
    }

    #[test]
    fn send_raw_keeps_selected_headers_and_bytes() {
        let body: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x00, 0xff];
        let s = serve(vec![Canned::ok("")
            .header("Content-Type", "image/png")
            .header("Retry-After", "7")
            .header("X-OAuth-Scopes", "a,b")
            .header("X-Other", "z")
            .body(body.clone())]);
        let raw = block_on(send_raw(&NetState::default(), None, get(&s.url, None))).unwrap();
        assert_eq!(raw.status, 200);
        assert_eq!(raw.bytes, body);
        let mut headers = raw.headers.clone();
        headers.sort();
        assert_eq!(
            headers,
            vec![
                ("content-type".to_string(), "image/png".to_string()),
                ("retry-after".to_string(), "7".to_string()),
                ("x-oauth-scopes".to_string(), "a,b".to_string()),
            ]
        );
    }

    #[test]
    fn send_raw_429_is_ok_with_retry_after() {
        let s = serve(vec![Canned::status(429).header("Retry-After", "30").body("{\"ok\":false}")]);
        let raw = block_on(send_raw(&NetState::default(), None, get(&s.url, None))).unwrap();
        assert_eq!(raw.status, 429);
        assert!(raw.headers.contains(&("retry-after".to_string(), "30".to_string())));
        assert_eq!(raw.bytes, b"{\"ok\":false}");
    }

    #[test]
    fn send_still_treats_429_as_a_status_error() {
        let s = serve(vec![Canned::status(429).header("Retry-After", "30").body("slow down")]);
        let e = block_on(send(&NetState::default(), None, get(&s.url, None))).unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(429)));
        assert_eq!(e.body.as_deref(), Some("slow down"));
    }

    #[test]
    fn send_raw_keeps_the_other_rules() {
        // Other non-2xx statuses are redacted status errors.
        let s = echo_header("x-api-key", 500);
        let mut out = get(&s.url, Some("pbk_secret"));
        out.headers.push(("X-API-Key", "pbk_secret".into()));
        let e = block_on(send_raw(&NetState::default(), None, out)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Status);
        assert!(!serde_json::to_string(&e).unwrap().contains("pbk_secret"));
        // Redirects are refused.
        let s = serve(vec![Canned::status(302).header("Location", "https://files.example/x")]);
        let e = block_on(send_raw(&NetState::default(), None, get(&s.url, None))).unwrap_err();
        assert_eq!((e.kind, e.location.as_deref()), (NetErrorKind::Redirect, Some("https://files.example")));
        // A key never goes to plain http off this computer.
        let e = block_on(send_raw(&NetState::default(), None, get("http://10.255.255.1:9/x", Some("k")))).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Insecure);
        // The body cap holds.
        let s = serve(vec![Canned::ok(&"x".repeat(2048))]);
        let mut out = get(&s.url, None);
        out.max_body = 1024;
        assert_eq!(block_on(send_raw(&NetState::default(), None, out)).unwrap_err().kind, NetErrorKind::TooLarge);
        // A request id can be cancelled.
        let net = NetState::default();
        assert!(!net.cancel("r7"));
        let s = serve(vec![Canned::ok("{}")]);
        assert_eq!(block_on(send_raw(&net, Some("r7"), get(&s.url, None))).unwrap_err().kind, NetErrorKind::Cancelled);
    }

    #[test]
    fn kept_headers_hold_link_and_github_headers_but_never_authorization() {
        assert!(KEPT_HEADERS.contains(&"link"));
        assert!(!KEPT_HEADERS.iter().any(|h| *h == "authorization" || *h == "set-cookie"));
        let s = serve(vec![Canned::ok("[]")
            .header("Link", "<https://api.example/x?page=2>; rel=\"next\"")
            .header("X-GitHub-SSO", "required; url=https://github.com/orgs/x/sso")
            .header("X-RateLimit-Remaining", "59")
            .header("X-RateLimit-Reset", "1700000000")
            .header("Authorization", "Bearer ghp_FAKEFAKE")
            .header("Set-Cookie", "a=b")]);
        let raw = block_on(send_raw(&NetState::default(), None, get(&s.url, None))).unwrap();
        let names: Vec<&str> = raw.headers.iter().map(|(k, _)| k.as_str()).collect();
        for kept in ["link", "x-github-sso", "x-ratelimit-remaining", "x-ratelimit-reset"] {
            assert!(names.contains(&kept), "{kept} missing from {names:?}");
        }
        assert!(!names.contains(&"authorization") && !names.contains(&"set-cookie"), "{names:?}");
        assert!(!format!("{raw:?}").contains("ghp_FAKEFAKE"));
        // The request's own Authorization header is never echoed into the kept headers.
        let s = echo_header("authorization", 200);
        let mut out = get(&s.url, Some("ghp_FAKEFAKE"));
        out.headers.push(("Authorization", "Bearer ghp_FAKEFAKE".into()));
        let raw = block_on(send_answer(&NetState::default(), None, out)).unwrap();
        assert!(!raw.headers.iter().any(|(k, v)| k == "authorization" || v.contains("ghp_FAKEFAKE")));
    }

    #[test]
    fn send_answer_returns_a_403_with_its_body_and_sso_header() {
        let s = serve(vec![Canned::status(403)
            .header("X-GitHub-SSO", "required; url=https://github.com/orgs/lab/sso?authorization_request=1")
            .header("Content-Type", "application/json")
            .body("{\"message\":\"Resource protected by organization SAML enforcement.\"}")]);
        let raw = block_on(send_answer(&NetState::default(), None, get(&s.url, None))).unwrap();
        assert_eq!(raw.status, 403);
        assert!(String::from_utf8_lossy(&raw.bytes).contains("SAML"));
        assert!(raw.headers.iter().any(|(k, v)| k == "x-github-sso" && v.starts_with("required")));
        // Every other status too: 401, 404, 422, 451, 500.
        for code in [401u16, 404, 422, 451, 500] {
            let s = serve(vec![Canned::status(code).body("{}")]);
            assert_eq!(block_on(send_answer(&NetState::default(), None, get(&s.url, None))).unwrap().status, code);
        }
    }

    #[test]
    fn send_answer_returns_a_redirect_with_its_location_and_never_follows_it() {
        let second = serve(vec![Canned::ok("{}")]);
        let first = serve(vec![Canned::status(301).header("Location", format!("{}/repos/a/b", second.url))]);
        let mut out = get(&first.url, Some("ghp_FAKEFAKE"));
        out.headers.push(("Authorization", "Bearer ghp_FAKEFAKE".into()));
        let raw = block_on(send_answer(&NetState::default(), None, out)).unwrap();
        assert_eq!(raw.status, 301);
        let location = raw.headers.iter().find(|(k, _)| k == "location").map(|(_, v)| v.clone());
        assert_eq!(location, Some(format!("{}/repos/a/b", second.url)));
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(second.requests.lock().unwrap().len(), 0);
        // A key the server reflects into the location is redacted.
        let s = serve(vec![Canned::status(302).header("Location", "https://evil.example/?t=ghp_FAKEFAKE")]);
        let raw = block_on(send_answer(&NetState::default(), None, get(&s.url, Some("ghp_FAKEFAKE")))).unwrap();
        assert!(!format!("{raw:?}").contains("ghp_FAKEFAKE"));
        // A non-3xx answer never keeps a location.
        let s = serve(vec![Canned::ok("{}").header("Location", "https://x.example/")]);
        let raw = block_on(send_answer(&NetState::default(), None, get(&s.url, None))).unwrap();
        assert!(!raw.headers.iter().any(|(k, _)| k == "location"));
    }

    #[test]
    fn send_answer_keeps_the_other_rules() {
        // A key never goes to plain http off this computer.
        let t = Instant::now();
        let e = block_on(send_answer(&NetState::default(), None, get("http://10.255.255.1:9/x", Some("ghp_FAKEFAKE")))).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Insecure);
        assert!(t.elapsed() < Duration::from_millis(100));
        // Errors are redacted: a bad header value never names the key.
        let s = serve(vec![Canned::ok("{}")]);
        let mut out = get(&s.url, Some("ghp_FAKE
FAKE"));
        out.headers.push(("Authorization", "Bearer ghp_FAKE
FAKE".into()));
        let e = block_on(send_answer(&NetState::default(), None, out)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::BadInput);
        assert!(!serde_json::to_string(&e).unwrap().contains("ghp_FAKE"));
        // The body cap holds on a non-2xx answer too.
        let s = serve(vec![Canned::status(500).body("x".repeat(2048))]);
        let mut out = get(&s.url, None);
        out.max_body = 1024;
        assert_eq!(block_on(send_answer(&NetState::default(), None, out)).unwrap_err().kind, NetErrorKind::TooLarge);
        // Cancel works, before and during the request.
        let net = NetState::default();
        assert!(!net.cancel("g1"));
        let s = serve(vec![Canned::ok("{}")]);
        assert_eq!(block_on(send_answer(&net, Some("g1"), get(&s.url, None))).unwrap_err().kind, NetErrorKind::Cancelled);
        let s = silent();
        let net = Arc::new(NetState::default());
        let n2 = net.clone();
        let url = s.url.clone();
        let h = std::thread::spawn(move || block_on(send_answer(&n2, Some("g2"), get(&url, None))));
        std::thread::sleep(Duration::from_millis(150));
        assert!(net.cancel("g2"));
        assert_eq!(h.join().unwrap().unwrap_err().kind, NetErrorKind::Cancelled);
    }

    #[test]
    fn parse_json_refuses_html() {
        assert_eq!(parse_json("<html>portal</html>").unwrap_err().kind, NetErrorKind::NotJson);
    }
}
