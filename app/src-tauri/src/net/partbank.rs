//! PartBank calls (D7, D8): `partbank_request` for the saved connection and
//! `partbank_probe` for a connection test of unsaved fields.
//!
//! - The webview names a connection (`desktop` or `web`) and a path; the URL
//!   comes from the open vault's stored settings, and the path must be on a
//!   fixed allow-list (`route_allowed`), so no request can reach another host.
//! - The key comes from the keychain (`X-API-Key`), never from the webview,
//!   except a key typed into the probe of unsaved fields.
//! - Web calls go through one shared 1000 ms gate (the plugin's pacing);
//!   desktop calls are not paced.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use super::config::{join_path, origin, parse_origin_url, PbConnection, ServiceConfig, Url};
use super::error::{NetError, NetErrorKind};
use super::http::{parse_json, send, Outgoing, MAX_BODY};
use super::secrets::{key_for, validate_secret, SecretStore, Secrets, Slot};
use super::NetState;
use crate::vault::{SettingsFile, VaultState};

/// Core `resourceSegment` values, in `PB_TYPES` order.
pub const PB_SEGMENTS: [&str; 6] = ["parts", "devices", "plasmids", "primers", "molecules", "strains"];
/// Core `PARTBANK_TYPES`.
pub const PB_TYPES: [&str; 6] = ["part", "device", "plasmid", "primer", "molecule", "strain"];
/// The only query keys a request may carry.
pub const PB_QUERY_KEYS: [&str; 3] = ["skip", "limit", "include_components"];
pub const PB_TIMEOUT: Duration = Duration::from_secs(15);
pub const PB_WEB_GAP: Duration = Duration::from_millis(1000);

/// Every PartBank path is under this prefix of the configured origin.
const API_BASE: &str = "/api/v1";

/// A 2xx answer, parsed.
#[derive(Serialize, Debug)]
pub struct PbResponse {
    pub status: u16,
    pub json: Value,
}

/// A Mongo object id: 24 hex digits (either case).
fn is_oid(s: &str) -> bool {
    s.len() == 24 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `true` for exactly the routes the plugin uses (see the table in the SP6
/// plan, Task 5). The path must start with a single `/` and hold no `..`,
/// `//`, `?`, `#`, `%` or `\`.
pub fn route_allowed(method: &str, path: &str) -> bool {
    if !path.starts_with('/') || path.contains("..") || path.contains("//") {
        return false;
    }
    if path.contains(['?', '#', '%', '\\']) {
        return false;
    }
    let parts: Vec<&str> = path[1..].split('/').collect();
    match (method, parts.as_slice()) {
        ("GET", ["auth", "me"]) => true,
        ("POST", ["search", "global"]) => true,
        ("GET", ["workspace", segment]) => PB_SEGMENTS.contains(segment),
        ("GET", [segment, oid]) => PB_SEGMENTS.contains(segment) && is_oid(oid),
        ("GET", ["stock-box", "by-resource", ty, oid]) => PB_TYPES.contains(ty) && is_oid(oid),
        ("PUT", ["labnoteo", "usages", "notes"]) => true,
        ("POST", ["labnoteo", "usages", "prune"]) => true,
        _ => false,
    }
}

fn slot_of(connection: PbConnection) -> Slot {
    match connection {
        PbConnection::Desktop => Slot::PartbankDesktop,
        PbConnection::Web => Slot::PartbankWeb,
    }
}

fn saved_url(cfg: &ServiceConfig, connection: PbConnection) -> Option<&Url> {
    match connection {
        PbConnection::Desktop => cfg.partbank_desktop.as_ref(),
        PbConnection::Web => cfg.partbank_web.as_ref(),
    }
}

fn key_missing() -> NetError {
    NetError::new(NetErrorKind::KeyMissing, "no partbank API key is set for this address")
}

/// Sends one keyed request to `url` (already built and checked) and parses
/// the 2xx answer as JSON. An empty 2xx body (a `204`, say) reads as `null`.
async fn keyed_call(
    net: &NetState,
    cfg: &ServiceConfig,
    connection: PbConnection,
    method: reqwest::Method,
    url: Url,
    key: String,
    body: Option<Value>,
) -> Result<PbResponse, NetError> {
    let mut headers: Vec<(&'static str, String)> =
        vec![("X-API-Key", key.clone()), ("Accept", "application/json".to_string())];
    if body.is_some() {
        headers.push(("Content-Type", "application/json".to_string()));
    }
    let allow_http = cfg.allow_http.contains(&origin(&url));
    let out = Outgoing {
        method,
        url,
        headers,
        json: body,
        timeout: Some(PB_TIMEOUT),
        max_body: MAX_BODY,
        secret: Some(key.clone()),
        allow_http,
    };
    if connection == PbConnection::Web {
        net.web_slot(PB_WEB_GAP).await;
    }
    let incoming = send(net, None, out).await?;
    let json = if incoming.text.trim().is_empty() {
        Value::Null
    } else {
        parse_json(&incoming.text).map_err(|e| e.redact(Some(&key)))?
    };
    Ok(PbResponse { status: incoming.status, json })
}

/// One PartBank call over the saved connection: `<url>/api/v1<path>?<query>`
/// with the keychain key. The route and the query keys are checked first, so
/// a refused request sends nothing; a missing key is `keyMissing`.
#[allow(clippy::too_many_arguments)]
pub async fn partbank_call(
    net: &NetState,
    cfg: &ServiceConfig,
    store: &dyn SecretStore,
    connection: PbConnection,
    method: &str,
    path: &str,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
) -> Result<PbResponse, NetError> {
    if !route_allowed(method, path) {
        return Err(NetError::new(NetErrorKind::ForbiddenPath, "this partbank address is not allowed"));
    }
    let method = match method {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        _ => return Err(NetError::new(NetErrorKind::ForbiddenPath, "this partbank address is not allowed")),
    };
    if method == reqwest::Method::GET && body.is_some() {
        return Err(NetError::new(NetErrorKind::BadInput, "a GET request has no body"));
    }
    let query = query.unwrap_or_default();
    if let Some((k, _)) = query.iter().find(|(k, _)| !PB_QUERY_KEYS.contains(&k.as_str())) {
        return Err(NetError::new(NetErrorKind::BadInput, format!("query key {k:?} is not allowed")));
    }
    let base = saved_url(cfg, connection)
        .ok_or_else(|| NetError::new(NetErrorKind::NotConfigured, "no valid partbank address is set"))?;
    let key = key_for(store, slot_of(connection), cfg)?.ok_or_else(key_missing)?;
    let mut url = join_path(base, &format!("{API_BASE}{path}"));
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }
    keyed_call(net, cfg, connection, method, url, key, body).await
}

/// A connection test of unsaved fields: `GET <url>/api/v1/auth/me`. `url`
/// must be an origin (`invalidUrl` otherwise, nothing sent). A non-empty
/// `api_key` is used as typed; otherwise the keychain key is used only when
/// `url` has the saved URL's origin, and the probe is `keyMissing` if not.
/// `cfg` is `None` with no vault open (no saved key can apply then).
pub async fn partbank_probe_at(
    net: &NetState,
    cfg: Option<&ServiceConfig>,
    store: &dyn SecretStore,
    connection: PbConnection,
    url: &str,
    api_key: Option<String>,
) -> Result<Value, NetError> {
    let target = parse_origin_url(url)
        .ok_or_else(|| NetError::new(NetErrorKind::InvalidUrl, "enter an address such as https://partbank.example"))?;
    let typed = api_key.filter(|k| !k.trim().is_empty());
    let key = match typed {
        Some(k) => validate_secret(&k)?,
        None => {
            let saved = cfg.and_then(|c| saved_url(c, connection).map(|u| (c, u)));
            match saved {
                Some((c, u)) if origin(u) == origin(&target) => {
                    key_for(store, slot_of(connection), c)?.ok_or_else(key_missing)?
                }
                _ => return Err(key_missing()),
            }
        }
    };
    let empty = ServiceConfig::from_settings_json("{}");
    let cfg = cfg.unwrap_or(&empty);
    let url = join_path(&target, &format!("{API_BASE}/auth/me"));
    Ok(keyed_call(net, cfg, connection, reqwest::Method::GET, url, key, None).await?.json)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn partbank_request(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    connection: PbConnection,
    method: String,
    path: String,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
) -> Result<PbResponse, NetError> {
    let cfg = ServiceConfig::load(&settings.0, vault.root().ok().as_deref())?;
    partbank_call(&net, &cfg, secrets.0.as_ref(), connection, &method, &path, query, body).await
}

#[tauri::command]
pub async fn partbank_probe(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    connection: PbConnection,
    url: String,
    api_key: Option<String>,
) -> Result<Value, NetError> {
    let cfg = ServiceConfig::load(&settings.0, vault.root().ok().as_deref()).ok();
    partbank_probe_at(&net, cfg.as_ref(), secrets.0.as_ref(), connection, &url, api_key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::secrets::{account, MemoryStore};
    use crate::net::testserver::{serve, Canned};
    use std::time::Instant;
    use tauri::async_runtime::block_on;

    const OID: &str = "0123456789abcdef01234567";

    fn cfg_with_web(url: &str) -> ServiceConfig {
        ServiceConfig::from_settings_json(&serde_json::json!({ "partbankWebUrl": url }).to_string())
    }

    fn store_with_key(c: &ServiceConfig, key: &str) -> MemoryStore {
        let store = MemoryStore::default();
        store.set(&account(Slot::PartbankWeb, c).unwrap(), key).unwrap();
        store
    }

    fn call(c: &ServiceConfig, store: &MemoryStore, method: &str, path: &str, query: Option<Vec<(String, String)>>, body: Option<Value>) -> Result<PbResponse, NetError> {
        block_on(partbank_call(&NetState::default(), c, store, PbConnection::Web, method, path, query, body))
    }

    #[test]
    fn allowed_routes() {
        let oid = OID;
        assert!(route_allowed("GET", "/auth/me"));
        assert!(route_allowed("POST", "/search/global"));
        assert!(route_allowed("GET", &format!("/plasmids/{oid}")));
        assert!(route_allowed("GET", &format!("/plasmids/{}", oid.to_uppercase())));
        assert!(route_allowed("GET", &format!("/stock-box/by-resource/plasmid/{oid}")));
        assert!(route_allowed("GET", "/workspace/primers"));
        assert!(route_allowed("PUT", "/labnoteo/usages/notes"));
        assert!(route_allowed("POST", "/labnoteo/usages/prune"));
        assert!(!route_allowed("DELETE", "/auth/me"));
        assert!(!route_allowed("GET", "/search/global"));
        assert!(!route_allowed("get", "/auth/me"));
        assert!(!route_allowed("GET", &format!("/widgets/{oid}")));
        assert!(!route_allowed("GET", &format!("/stock-box/by-resource/parts/{oid}")));
        assert!(!route_allowed("GET", "/workspace/plasmid"));
        assert!(!route_allowed("GET", "/auth/me/"));
    }

    #[test]
    fn paths_outside_the_allow_list_are_refused() {
        let s = serve(vec![]);
        let c = cfg_with_web(&s.url);
        let store = store_with_key(&c, "pbk_k");
        for p in ["//evil.example/x", "/auth/me/../x", "/search/global?q=1", "http://a/b", "/parts/abc",
                  "/parts/0123456789abcdef01234567/x", "/auth/me%2F..", "\\auth\\me"] {
            let e = block_on(partbank_call(&NetState::default(), &c, &store, PbConnection::Web, "GET", p, None, None)).unwrap_err();
            assert_eq!(e.kind, NetErrorKind::ForbiddenPath, "{p}");
        }
        assert_eq!(s.requests.lock().unwrap().len(), 0);
    }

    #[test]
    fn sends_key_and_accept_to_the_configured_url() {
        let s = serve(vec![Canned::ok(r#"{"username":"kim"}"#)]);
        let c = cfg_with_web(&s.url);
        let store = store_with_key(&c, "pbk_k");
        let r = call(&c, &store, "GET", "/auth/me", None, None).unwrap();
        assert_eq!((r.status, r.json["username"].as_str()), (200, Some("kim")));
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "GET");
        assert_eq!(reqs[0].path, "/api/v1/auth/me");
        assert_eq!(reqs[0].header("x-api-key"), Some("pbk_k"));
        assert_eq!(reqs[0].header("accept"), Some("application/json"));
        assert_eq!(reqs[0].header("content-type"), None);
    }

    #[test]
    fn put_body_sets_content_type_json() {
        let s = serve(vec![Canned::ok("{}")]);
        let c = cfg_with_web(&s.url);
        let store = store_with_key(&c, "pbk_k");
        call(&c, &store, "PUT", "/labnoteo/usages/notes", None, Some(serde_json::json!({"a": 1}))).unwrap();
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "PUT");
        assert_eq!(reqs[0].header("content-type"), Some("application/json"));
        assert_eq!(reqs[0].body, r#"{"a":1}"#);
    }

    #[test]
    fn query_pairs_are_encoded_and_unknown_keys_refused() {
        let s = serve(vec![Canned::ok("[]"), Canned::ok("[]")]);
        let c = cfg_with_web(&s.url);
        let store = store_with_key(&c, "pbk_k");
        let q = |pairs: &[(&str, &str)]| Some(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
        call(&c, &store, "GET", "/workspace/parts", q(&[("skip", "0"), ("limit", "200"), ("include_components", "false")]), None).unwrap();
        assert_eq!(s.requests.lock().unwrap()[0].path, "/api/v1/workspace/parts?skip=0&limit=200&include_components=false");
        let e = call(&c, &store, "GET", "/workspace/parts", q(&[("url", "x")]), None).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::BadInput);
        // A value is encoded, never spliced into the query string.
        call(&c, &store, "GET", "/workspace/parts", q(&[("limit", "1&url=x")]), None).unwrap();
        assert_eq!(s.requests.lock().unwrap()[1].path, "/api/v1/workspace/parts?limit=1%26url%3Dx");
    }

    #[test]
    fn no_key_is_key_missing_and_sends_nothing() {
        let s = serve(vec![Canned::ok("{}")]);
        let c = cfg_with_web(&s.url);
        let e = call(&c, &MemoryStore::default(), "GET", "/auth/me", None, None).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::KeyMissing);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(s.requests.lock().unwrap().len(), 0);
    }

    #[test]
    fn invalid_saved_url_is_not_configured() {
        let c = ServiceConfig::from_settings_json(r#"{"partbankWebUrl":"nope"}"#);
        let e = call(&c, &MemoryStore::default(), "GET", "/auth/me", None, None).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::NotConfigured);
    }

    #[test]
    fn web_calls_are_paced_desktop_calls_are_not() {
        let web = serve(vec![Canned::ok("{}"), Canned::ok("{}"), Canned::ok("{}")]);
        let c = cfg_with_web(&web.url);
        let store = store_with_key(&c, "pbk_k");
        let net = NetState::default();
        let t = Instant::now();
        for _ in 0..3 {
            block_on(partbank_call(&net, &c, &store, PbConnection::Web, "GET", "/auth/me", None, None)).unwrap();
        }
        assert!(t.elapsed() >= Duration::from_millis(2000), "{:?}", t.elapsed());

        let desk = serve(vec![Canned::ok("{}"), Canned::ok("{}"), Canned::ok("{}")]);
        let c = ServiceConfig::from_settings_json(&serde_json::json!({ "partbankDesktopUrl": desk.url }).to_string());
        store.set(&account(Slot::PartbankDesktop, &c).unwrap(), "pbk_d").unwrap();
        let t = Instant::now();
        for _ in 0..3 {
            block_on(partbank_call(&net, &c, &store, PbConnection::Desktop, "GET", "/auth/me", None, None)).unwrap();
        }
        assert!(t.elapsed() < Duration::from_millis(1000), "{:?}", t.elapsed());
        assert_eq!(desk.requests.lock().unwrap()[0].header("x-api-key"), Some("pbk_d"));
    }

    #[test]
    fn two_xx_html_is_not_json() {
        let s = serve(vec![Canned::status(200).header("Content-Type", "text/html").body("<html>")]);
        let c = cfg_with_web(&s.url);
        let store = store_with_key(&c, "pbk_k");
        assert_eq!(call(&c, &store, "GET", "/auth/me", None, None).unwrap_err().kind, NetErrorKind::NotJson);
    }

    #[test]
    fn non_2xx_is_status_with_the_key_redacted() {
        let s = serve(vec![Canned::status(401).body("bad key pbk_k")]);
        let c = cfg_with_web(&s.url);
        let store = store_with_key(&c, "pbk_k");
        let e = call(&c, &store, "GET", "/auth/me", None, None).unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(401)));
        assert!(!serde_json::to_string(&e).unwrap().contains("pbk_k"));
    }

    #[test]
    fn probe_with_other_origin_never_uses_stored_key() {
        let a = serve(vec![Canned::ok(r#"{"username":"a"}"#)]);
        let b = serve(vec![Canned::ok(r#"{"username":"b"}"#)]);
        let c = cfg_with_web(&a.url);
        let store = store_with_key(&c, "pbk_stored");
        let net = NetState::default();
        let probe = |url: &str, key: Option<&str>| {
            block_on(partbank_probe_at(&net, Some(&c), &store, PbConnection::Web, url, key.map(str::to_string)))
        };
        assert_eq!(probe(&b.url, None).unwrap_err().kind, NetErrorKind::KeyMissing);
        assert_eq!(probe(&b.url, Some("  ")).unwrap_err().kind, NetErrorKind::KeyMissing);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(b.requests.lock().unwrap().len(), 0);
        assert_eq!(probe(&b.url, Some("typed")).unwrap()["username"], "b");
        assert_eq!(b.requests.lock().unwrap()[0].header("x-api-key"), Some("typed"));
        assert_eq!(b.requests.lock().unwrap()[0].path, "/api/v1/auth/me");
        assert_eq!(probe(&format!("{}/", a.url), None).unwrap()["username"], "a");
        assert_eq!(a.requests.lock().unwrap()[0].header("x-api-key"), Some("pbk_stored"));
    }

    #[test]
    fn probe_without_a_vault_needs_a_typed_key() {
        let e = block_on(partbank_probe_at(&NetState::default(), None, &MemoryStore::default(), PbConnection::Web, "https://x.example", None)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::KeyMissing);
    }

    #[test]
    fn probe_refuses_a_path() {
        let s = serve(vec![Canned::ok("{}")]);
        let c = cfg_with_web(&s.url);
        let store = store_with_key(&c, "pbk_k");
        let e = block_on(partbank_probe_at(&NetState::default(), Some(&c), &store, PbConnection::Web, &format!("{}/x", s.url), Some("typed".into()))).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::InvalidUrl);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(s.requests.lock().unwrap().len(), 0);
    }
}
