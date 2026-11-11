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
//! - `partbank_read` is the assistant tools' door: the connection is the
//!   saved `partbankDefaultConnection`, and it has its own read-only allow-list
//!   (`read_route_allowed`, `read_query_ok`, `search_body`): GETs plus the
//!   read-only `POST /search/global`, never the usage-sync writes.

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
        return Err(forbidden());
    }
    let method = match method {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        _ => return Err(forbidden()),
    };
    if method == reqwest::Method::GET && body.is_some() {
        return Err(NetError::new(NetErrorKind::BadInput, "a GET request has no body"));
    }
    let query = query.unwrap_or_default();
    if let Some((k, _)) = query.iter().find(|(k, _)| !PB_QUERY_KEYS.contains(&k.as_str())) {
        return Err(NetError::new(NetErrorKind::BadInput, format!("query key {k:?} is not allowed")));
    }
    send_checked(net, cfg, store, connection, method, path, query, body).await
}

/// Sends a request whose route, query and body were already checked: the
/// saved URL of `connection` (`notConfigured` when invalid) and the key of
/// its slot (`keyMissing` when none).
#[allow(clippy::too_many_arguments)]
async fn send_checked(
    net: &NetState,
    cfg: &ServiceConfig,
    store: &dyn SecretStore,
    connection: PbConnection,
    method: reqwest::Method,
    path: &str,
    query: Vec<(String, String)>,
    body: Option<Value>,
) -> Result<PbResponse, NetError> {
    let base = saved_url(cfg, connection)
        .ok_or_else(|| NetError::new(NetErrorKind::NotConfigured, "no valid partbank address is set"))?;
    let key = key_for(store, slot_of(connection), cfg)?.ok_or_else(key_missing)?;
    let mut url = join_path(base, &format!("{API_BASE}{path}"));
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }
    keyed_call(net, cfg, connection, method, url, key, body).await
}

fn forbidden() -> NetError {
    NetError::new(NetErrorKind::ForbiddenPath, "this partbank address is not allowed")
}

// ---- partbank_read: the assistant tools' read-only door (design §5.1) ----

/// Segments of `GET /groups/{oid}/<list>`.
const GROUP_LISTS: [&str; 6] = ["parts", "constructs", "devices", "primers", "strains", "molecules"];
/// Segments of `GET /workspace/<list>` for a read.
const WORKSPACE_LISTS: [&str; 4] = ["parts", "primers", "strains", "molecules"];
/// Segments of `GET /registry/<type>[/{oid}]`.
const REGISTRY_TYPES: [&str; 5] = ["part", "device", "primer", "strain", "molecule"];
/// Segments of `GET /reverse-lookup/<segment>/{oid}/used-in`.
const REVERSE_LOOKUP: [&str; 3] = ["parts", "devices", "plasmids"];
/// The only query keys a read may carry.
pub const PB_READ_QUERY_KEYS: [&str; 10] = [
    "skip",
    "limit",
    "include_components",
    "scope",
    "search",
    "type",
    "tags",
    "exclude_library_members",
    "sort_by",
    "sort_order",
];
/// Most query pairs a read may carry.
pub const PB_READ_MAX_PAIRS: usize = 12;
/// Longest `search` or `tags` value (and `/search/global` `query`), in chars.
pub const PB_READ_MAX_TEXT: usize = 200;
/// Most rows `/search/global` may be asked for.
pub const PB_SEARCH_MAX_LIMIT: u64 = 25;
/// Rows `/search/global` is asked for when the body names no `limit`.
const PB_SEARCH_DEFAULT_LIMIT: u64 = 10;

/// `true` for exactly the read routes of the assistant tools: GETs plus
/// `POST /search/global`. The usage-sync writes and every other POST, PUT,
/// PATCH or DELETE are refused. The path hygiene is `route_allowed`'s: a
/// single leading `/`, and no `..`, `//`, `?`, `#`, `%` or backslash.
pub fn read_route_allowed(method: &str, path: &str) -> bool {
    if !path.starts_with('/') || path.contains("..") || path.contains("//") {
        return false;
    }
    if path.contains(['?', '#', '%', '\\']) {
        return false;
    }
    let parts: Vec<&str> = path[1..].split('/').collect();
    match (method, parts.as_slice()) {
        ("POST", ["search", "global"]) => true,
        ("GET", ["auth", "me"]) => true,
        // `GET /groups/` is the form the web app uses; both are the same list.
        ("GET", ["groups"]) | ("GET", ["groups", ""]) => true,
        ("GET", ["groups", gid, list]) => is_oid(gid) && GROUP_LISTS.contains(list),
        ("GET", ["workspace", list]) => WORKSPACE_LISTS.contains(list),
        ("GET", ["devices", "constructs"]) => true,
        ("GET", ["registry", ty]) => REGISTRY_TYPES.contains(ty),
        ("GET", ["registry", ty, oid]) => REGISTRY_TYPES.contains(ty) && is_oid(oid),
        ("GET", [segment, oid]) => PB_SEGMENTS.contains(segment) && is_oid(oid),
        ("GET", ["stock-box", "by-resource", ty, oid]) => PB_TYPES.contains(ty) && is_oid(oid),
        ("GET", ["reverse-lookup", segment, oid, "used-in"]) => REVERSE_LOOKUP.contains(segment) && is_oid(oid),
        ("GET", ["labnoteo", "usages", ty, oid]) => PB_TYPES.contains(ty) && is_oid(oid),
        _ => false,
    }
}

/// Plain decimal digits (no sign, no blank) in `lo..=hi`.
fn int_in(v: &str, lo: u64, hi: u64) -> bool {
    (1..=6).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit()) && v.parse::<u64>().is_ok_and(|n| (lo..=hi).contains(&n))
}

/// `^[a-z_]{1,32}$`
fn is_token(v: &str) -> bool {
    (1..=32).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

/// Free text the server searches: at most 200 chars, no control character.
fn is_search_text(v: &str) -> bool {
    v.chars().count() <= PB_READ_MAX_TEXT && !v.chars().any(char::is_control)
}

/// `true` when every query pair of a read is allowed: at most 12 pairs, each
/// key at most once and on `PB_READ_QUERY_KEYS`, and each value in its range
/// (`scope` only `mine`, `skip` 0..=10000, `limit` 1..=100, the two flags
/// `true|false`, `type` and `sort_by` a `[a-z_]{1,32}` token, `sort_order`
/// `asc|desc`, `search` and `tags` free text).
pub fn read_query_ok(pairs: &[(String, String)]) -> bool {
    if pairs.len() > PB_READ_MAX_PAIRS {
        return false;
    }
    let mut seen: Vec<&str> = Vec::new();
    for (k, v) in pairs {
        if seen.contains(&k.as_str()) {
            return false;
        }
        seen.push(k);
        let ok = match k.as_str() {
            "scope" => v == "mine",
            "skip" => int_in(v, 0, 10_000),
            "limit" => int_in(v, 1, 100),
            "include_components" | "exclude_library_members" => v == "true" || v == "false",
            "type" | "sort_by" => is_token(v),
            "sort_order" => v == "asc" || v == "desc",
            "search" | "tags" => is_search_text(v),
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    true
}

fn bad_body(message: &str) -> NetError {
    NetError::new(NetErrorKind::BadInput, message)
}

/// The `POST /search/global` body, rebuilt from checked fields; the webview's
/// JSON is never forwarded. `query` is 1..=200 chars with no control
/// character, `limit` a whole number of at least 1 (more than 25 is cut to
/// 25; 10 when absent), `types` a list of the six PartBank types (each once),
/// and `exclude_public` a bool. Any other field, or a body that is not an
/// object, is `badInput`.
pub fn search_body(body: Option<&Value>) -> Result<Value, NetError> {
    let obj = body.and_then(Value::as_object).ok_or_else(|| bad_body("the search needs a JSON object body"))?;
    if let Some(k) = obj.keys().find(|k| !matches!(k.as_str(), "query" | "limit" | "types" | "exclude_public")) {
        return Err(bad_body(&format!("search field {k:?} is not allowed")));
    }
    let query = obj
        .get("query")
        .and_then(Value::as_str)
        .filter(|q| !q.trim().is_empty() && is_search_text(q))
        .ok_or_else(|| bad_body("the search query must be 1 to 200 characters"))?;
    let limit = match obj.get("limit") {
        None => PB_SEARCH_DEFAULT_LIMIT,
        Some(v) => v.as_u64().filter(|n| *n >= 1).ok_or_else(|| bad_body("the search limit must be a whole number from 1"))?,
    }
    .min(PB_SEARCH_MAX_LIMIT);
    let mut out = serde_json::Map::new();
    out.insert("query".into(), Value::from(query));
    out.insert("limit".into(), Value::from(limit));
    if let Some(types) = obj.get("types") {
        let list = types.as_array().ok_or_else(|| bad_body("the search types must be a list"))?;
        let mut kept: Vec<&str> = Vec::new();
        for t in list {
            let t = t.as_str().filter(|t| PB_TYPES.contains(t)).ok_or_else(|| bad_body("unknown partbank type"))?;
            if kept.contains(&t) {
                return Err(bad_body("a partbank type is named twice"));
            }
            kept.push(t);
        }
        out.insert("types".into(), Value::from(kept));
    }
    if let Some(v) = obj.get("exclude_public") {
        let b = v.as_bool().ok_or_else(|| bad_body("exclude_public must be true or false"))?;
        out.insert("exclude_public".into(), Value::Bool(b));
    }
    Ok(Value::Object(out))
}

/// One read over the saved default connection (`partbankDefaultConnection`;
/// the webview cannot pick it). The route, the query and the body are checked
/// before anything is sent: a refused route or query is `forbiddenPath`, a bad
/// search body `badInput`. Only `POST /search/global` carries a body, rebuilt
/// by `search_body`; a GET with a body is `badInput`.
pub async fn partbank_read_call(
    net: &NetState,
    cfg: &ServiceConfig,
    store: &dyn SecretStore,
    method: &str,
    path: &str,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
) -> Result<PbResponse, NetError> {
    if !read_route_allowed(method, path) {
        return Err(forbidden());
    }
    let query = query.unwrap_or_default();
    if !read_query_ok(&query) {
        return Err(NetError::new(NetErrorKind::ForbiddenPath, "this partbank query is not allowed"));
    }
    let (method, body) = match method {
        "GET" if body.is_some() => return Err(bad_body("a GET request has no body")),
        "GET" => (reqwest::Method::GET, None),
        "POST" => (reqwest::Method::POST, Some(search_body(body.as_ref())?)),
        _ => return Err(forbidden()),
    };
    send_checked(net, cfg, store, cfg.partbank_default, method, path, query, body).await
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

/// The assistant tools' read-only PartBank call (design §5.1).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn partbank_read(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    method: String,
    path: String,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
) -> Result<PbResponse, NetError> {
    let cfg = ServiceConfig::load(&settings.0, vault.root().ok().as_deref())?;
    partbank_read_call(&net, &cfg, secrets.0.as_ref(), &method, &path, query, body).await
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

    // ---- partbank_read (design §5.1, §8 Rust tests 1-4) ----

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn read(c: &ServiceConfig, store: &MemoryStore, method: &str, path: &str, query: Option<Vec<(String, String)>>, body: Option<Value>) -> Result<PbResponse, NetError> {
        block_on(partbank_read_call(&NetState::default(), c, store, method, path, query, body))
    }

    #[test]
    fn read_routes_allowed() {
        let o = OID;
        for (m, p) in [
            ("GET", "/auth/me".to_string()),
            ("GET", "/groups".to_string()),
            ("GET", "/groups/".to_string()),
            ("POST", "/search/global".to_string()),
            ("GET", "/devices/constructs".to_string()),
            ("GET", format!("/plasmids/{}", o.to_uppercase())),
        ] {
            assert!(read_route_allowed(m, &p), "{m} {p}");
        }
        for list in ["parts", "constructs", "devices", "primers", "strains", "molecules"] {
            assert!(read_route_allowed("GET", &format!("/groups/{o}/{list}")), "{list}");
        }
        for list in ["parts", "primers", "strains", "molecules"] {
            assert!(read_route_allowed("GET", &format!("/workspace/{list}")), "{list}");
        }
        for ty in ["part", "device", "primer", "strain", "molecule"] {
            assert!(read_route_allowed("GET", &format!("/registry/{ty}")), "{ty}");
            assert!(read_route_allowed("GET", &format!("/registry/{ty}/{o}")), "{ty}");
        }
        for seg in PB_SEGMENTS {
            assert!(read_route_allowed("GET", &format!("/{seg}/{o}")), "{seg}");
        }
        for ty in PB_TYPES {
            assert!(read_route_allowed("GET", &format!("/stock-box/by-resource/{ty}/{o}")), "{ty}");
            assert!(read_route_allowed("GET", &format!("/labnoteo/usages/{ty}/{o}")), "{ty}");
        }
        for seg in ["parts", "devices", "plasmids"] {
            assert!(read_route_allowed("GET", &format!("/reverse-lookup/{seg}/{o}/used-in")), "{seg}");
        }
    }

    #[test]
    fn every_write_route_is_refused_by_the_read_list() {
        let o = OID;
        // The write routes of the findings, under each method they could take.
        let writes = [
            "/labnoteo/usages/notes".to_string(),
            "/labnoteo/usages/prune".to_string(),
            "/parts/resolve".to_string(),
            "/parts/lookup".to_string(),
            "/bulk/delete".to_string(),
            "/devices/annotate".to_string(),
            "/desktop/sync/run".to_string(),
            "/search/advanced".to_string(),
            "/parts".to_string(),
            "/parts/".to_string(),
            format!("/parts/{o}"),
            format!("/devices/{o}"),
            format!("/groups/{o}/parts"),
        ];
        for p in &writes {
            for m in ["POST", "PUT", "PATCH", "DELETE"] {
                assert!(!read_route_allowed(m, p), "{m} {p}");
            }
        }
        for p in ["/labnoteo/usages/notes", "/labnoteo/usages/prune", "/parts/resolve", "/parts/lookup", "/bulk/delete", "/devices/annotate", "/desktop/sync/run"] {
            assert!(!read_route_allowed("GET", p), "GET {p}");
        }
        // The old allow-list does pass the usage writes; the read list never does.
        assert!(route_allowed("PUT", "/labnoteo/usages/notes"));
        // search/global is a POST only; lowercase methods and HEAD are refused.
        assert!(!read_route_allowed("GET", "/search/global"));
        assert!(!read_route_allowed("PUT", "/search/global"));
        assert!(!read_route_allowed("post", "/search/global"));
        assert!(!read_route_allowed("HEAD", "/auth/me"));
        assert!(!read_route_allowed("get", "/auth/me"));
    }

    #[test]
    fn read_routes_refuse_bad_paths() {
        let o = OID;
        for p in [
            "/parts/abc".to_string(),
            format!("/parts/{o}x"),
            format!("/parts/{}", &o[..23]),
            format!("/parts/{o}/x"),
            format!("/parts/{o}/"),
            format!("/parts/../{o}"),
            format!("/parts/%2e%2e/{o}"),
            format!("/parts/{o}?x=1"),
            format!("/parts/{o}#x"),
            format!("\\parts\\{o}"),
            format!("//evil.example/parts/{o}"),
            format!("parts/{o}"),
            "/auth/me/".to_string(),
            "/groups//parts".to_string(),
            format!("/groups/{o}/admin"),
            format!("/groups/{o}/parts/{o}"),
            "/groups/x/parts".to_string(),
            "/workspace/devices".to_string(),
            "/workspace/plasmids".to_string(),
            "/registry/plasmid".to_string(),
            format!("/registry/parts/{o}"),
            format!("/stock-box/by-resource/parts/{o}"),
            format!("/reverse-lookup/primers/{o}/used-in"),
            format!("/reverse-lookup/parts/{o}"),
            format!("/labnoteo/usages/parts/{o}"),
            format!("/widgets/{o}"),
            "/devices/constructs/x".to_string(),
            "".to_string(),
            "/".to_string(),
        ] {
            assert!(!read_route_allowed("GET", &p), "{p}");
        }
    }

    #[test]
    fn read_query_rules() {
        assert!(read_query_ok(&[]));
        assert!(read_query_ok(&pairs(&[
            ("scope", "mine"),
            ("search", "GFP 2"),
            ("limit", "25"),
            ("skip", "0"),
            ("exclude_library_members", "true"),
            ("include_components", "false"),
            ("type", "plasmid"),
            ("tags", "reporter"),
            ("sort_by", "updated_at"),
            ("sort_order", "desc"),
        ])));
        assert!(read_query_ok(&pairs(&[("limit", "100"), ("skip", "10000")])));
        assert!(read_query_ok(&pairs(&[("search", "")])));
        assert!(read_query_ok(&pairs(&[("search", &"가".repeat(200))])));
        for bad in [
            vec![("url", "x")],
            vec![("exclude_public", "true")],
            vec![("scope", "all")],
            vec![("scope", "group")],
            vec![("limit", "101")],
            vec![("limit", "0")],
            vec![("limit", "-1")],
            vec![("limit", "+5")],
            vec![("limit", " 5")],
            vec![("limit", "1e2")],
            vec![("skip", "10001")],
            vec![("skip", "")],
            vec![("include_components", "1")],
            vec![("exclude_library_members", "TRUE")],
            vec![("type", "Plasmid")],
            vec![("type", "plasmid&x=1")],
            vec![("sort_by", "a.b")],
            vec![("sort_order", "up")],
            vec![("search", "a\nb")],
            vec![("search", "a\u{0}b")],
            vec![("tags", "a\tb")],
            vec![("limit", "5"), ("limit", "6")],
        ] {
            assert!(!read_query_ok(&pairs(&bad)), "{bad:?}");
        }
        let long = "a".repeat(201);
        assert!(!read_query_ok(&pairs(&[("search", long.as_str())])));
        let many: Vec<(String, String)> = (0..13).map(|i| ("search".to_string(), i.to_string())).collect();
        assert!(!read_query_ok(&many));
    }

    #[test]
    fn search_body_is_rebuilt_from_checked_fields() {
        use serde_json::json;
        let b = search_body(Some(&json!({"query": "GFP", "limit": 99, "types": ["part", "plasmid"], "exclude_public": false}))).unwrap();
        assert_eq!(b, json!({"query": "GFP", "limit": 25, "types": ["part", "plasmid"], "exclude_public": false}));
        assert_eq!(search_body(Some(&json!({"query": "GFP"}))).unwrap(), json!({"query": "GFP", "limit": 10}));
        for bad in [
            json!({"query": "GFP", "owner": "x"}),
            json!({"query": "GFP", "types": ["widget"]}),
            json!({"query": "GFP", "types": ["part", "part"]}),
            json!({"query": "GFP", "types": "part"}),
            json!({"query": "GFP", "limit": 0}),
            json!({"query": "GFP", "limit": -3}),
            json!({"query": "GFP", "limit": 2.5}),
            json!({"query": "GFP", "limit": "5"}),
            json!({"query": "GFP", "exclude_public": "yes"}),
            json!({"query": ""}),
            json!({"query": "   "}),
            json!({"query": "a\u{7}b"}),
            json!({"query": "a".repeat(201)}),
            json!({"query": 5}),
            json!({"limit": 5}),
            json!(["GFP"]),
            json!("GFP"),
        ] {
            assert_eq!(search_body(Some(&bad)).unwrap_err().kind, NetErrorKind::BadInput, "{bad}");
        }
        assert_eq!(search_body(None).unwrap_err().kind, NetErrorKind::BadInput);
    }

    #[test]
    fn read_search_sends_only_the_rebuilt_body() {
        use serde_json::json;
        let s = serve(vec![Canned::ok(r#"{"items":[],"total":0}"#)]);
        let c = cfg_with_web(&s.url);
        let store = store_with_key(&c, "pbk_k");
        let body = json!({"query": "GFP", "limit": 40, "types": ["part"], "exclude_public": true});
        let r = read(&c, &store, "POST", "/search/global", None, Some(body)).unwrap();
        assert_eq!(r.json["total"], 0);
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "POST");
        assert_eq!(reqs[0].path, "/api/v1/search/global");
        assert_eq!(reqs[0].header("content-type"), Some("application/json"));
        let sent: Value = serde_json::from_str(&reqs[0].body).unwrap();
        let mut keys: Vec<&String> = sent.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["exclude_public", "limit", "query", "types"]);
        assert_eq!(sent["limit"], 25);
    }

    #[test]
    fn read_refusals_send_nothing() {
        use serde_json::json;
        let s = serve(vec![]);
        let c = cfg_with_web(&s.url);
        let store = store_with_key(&c, "pbk_k");
        let forbidden_cases: Vec<(&str, &str, Option<Vec<(String, String)>>, Option<Value>)> = vec![
            ("PUT", "/labnoteo/usages/notes", None, Some(json!({}))),
            ("POST", "/labnoteo/usages/prune", None, Some(json!({}))),
            ("POST", "/parts/resolve", None, Some(json!({}))),
            ("POST", "/parts/lookup", None, Some(json!({}))),
            ("DELETE", "/auth/me", None, None),
            ("GET", "/search/global", None, None),
            ("GET", "/workspace/parts", Some(pairs(&[("scope", "all")])), None),
            ("GET", "/workspace/parts", Some(pairs(&[("limit", "101")])), None),
            ("GET", "/workspace/parts", Some(pairs(&[("url", "https://evil.example")])), None),
        ];
        for (m, p, q, b) in forbidden_cases {
            assert_eq!(read(&c, &store, m, p, q, b).unwrap_err().kind, NetErrorKind::ForbiddenPath, "{m} {p}");
        }
        assert_eq!(read(&c, &store, "GET", "/auth/me", None, Some(json!({}))).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(read(&c, &store, "POST", "/search/global", None, None).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(
            read(&c, &store, "POST", "/search/global", None, Some(json!({"query": "x", "bulk": true}))).unwrap_err().kind,
            NetErrorKind::BadInput
        );
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(s.requests.lock().unwrap().len(), 0);
    }

    #[test]
    fn read_get_carries_the_query_and_the_default_connection_key() {
        let web = serve(vec![Canned::ok(r#"{"items":[]}"#)]);
        let desk = serve(vec![Canned::ok(r#"{"items":[]}"#)]);
        let both = |default: &str| {
            ServiceConfig::from_settings_json(
                &serde_json::json!({"partbankWebUrl": web.url, "partbankDesktopUrl": desk.url, "partbankDefaultConnection": default}).to_string(),
            )
        };
        let c = both("web");
        let store = MemoryStore::default();
        store.set(&account(Slot::PartbankWeb, &c).unwrap(), "pbk_web").unwrap();
        store.set(&account(Slot::PartbankDesktop, &c).unwrap(), "pbk_desk").unwrap();
        let q = pairs(&[("scope", "mine"), ("search", "GFP & co"), ("limit", "10"), ("skip", "0")]);
        read(&c, &store, "GET", "/workspace/parts", Some(q.clone()), None).unwrap();
        let reqs = web.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "GET");
        assert_eq!(reqs[0].path, "/api/v1/workspace/parts?scope=mine&search=GFP+%26+co&limit=10&skip=0");
        assert_eq!(reqs[0].header("x-api-key"), Some("pbk_web"));
        assert_eq!(reqs[0].header("content-type"), None);
        drop(reqs);
        // The saved default decides the slot; the desktop key never goes to the web.
        read(&both("desktop"), &store, "GET", "/workspace/parts", Some(q), None).unwrap();
        let reqs = desk.requests.lock().unwrap();
        assert_eq!(reqs[0].header("x-api-key"), Some("pbk_desk"));
        assert_eq!(web.requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn read_with_no_key_for_the_default_is_key_missing() {
        let s = serve(vec![Canned::ok("{}")]);
        let c = ServiceConfig::from_settings_json(&serde_json::json!({"partbankWebUrl": s.url, "partbankDefaultConnection": "desktop"}).to_string());
        // A web key is saved, but the default is the desktop connection.
        let store = store_with_key(&c, "pbk_web");
        assert_eq!(read(&c, &store, "GET", "/auth/me", None, None).unwrap_err().kind, NetErrorKind::KeyMissing);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(s.requests.lock().unwrap().len(), 0);
    }

    #[test]
    fn read_errors_never_carry_the_key() {
        let s = serve(vec![
            Canned::status(403).body("forbidden for pbk_secret_k"),
            Canned::status(200).header("Content-Type", "text/html").body("<p>pbk_secret_k</p>"),
        ]);
        let c = cfg_with_web(&s.url);
        let store = store_with_key(&c, "pbk_secret_k");
        let path = format!("/parts/{OID}");
        let e = read(&c, &store, "GET", &path, None, None).unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(403)));
        assert!(!serde_json::to_string(&e).unwrap().contains("pbk_secret_k"));
        let e = read(&c, &store, "GET", &path, None, None).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::NotJson);
        assert!(!serde_json::to_string(&e).unwrap().contains("pbk_secret_k"));
    }

    #[test]
    fn read_redirect_is_an_error_and_the_key_is_not_sent_again() {
        let other = serve(vec![Canned::ok("{}")]);
        let s = serve(vec![Canned::status(302).header("Location", format!("{}/api/v1/auth/me", other.url))]);
        let c = cfg_with_web(&s.url);
        let store = store_with_key(&c, "pbk_k");
        let e = read(&c, &store, "GET", "/auth/me", None, None).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Redirect);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(other.requests.lock().unwrap().len(), 0);
        assert_eq!(s.requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn reads_are_paced_on_web_not_on_desktop() {
        let web = serve(vec![Canned::ok("{}"), Canned::ok("{}")]);
        let c = cfg_with_web(&web.url);
        let store = store_with_key(&c, "pbk_k");
        let net = NetState::default();
        let t = Instant::now();
        for _ in 0..2 {
            block_on(partbank_read_call(&net, &c, &store, "GET", "/auth/me", None, None)).unwrap();
        }
        assert!(t.elapsed() >= Duration::from_millis(1000), "{:?}", t.elapsed());

        let desk = serve(vec![Canned::ok("{}"), Canned::ok("{}"), Canned::ok("{}")]);
        let c = ServiceConfig::from_settings_json(
            &serde_json::json!({"partbankDesktopUrl": desk.url, "partbankDefaultConnection": "desktop"}).to_string(),
        );
        store.set(&account(Slot::PartbankDesktop, &c).unwrap(), "pbk_d").unwrap();
        let t = Instant::now();
        for _ in 0..3 {
            block_on(partbank_read_call(&net, &c, &store, "GET", "/auth/me", None, None)).unwrap();
        }
        assert!(t.elapsed() < Duration::from_millis(1000), "{:?}", t.elapsed());
    }
}
