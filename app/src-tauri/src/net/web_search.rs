//! `web_search` through a SearXNG instance's JSON API (assistant spec §7.1,
//! plan Task 12).
//!
//! - The base URL is read by Rust from the per-PC `assistant.json` on every
//!   call (`notConfigured` when unset); the webview never names the host (D8).
//!   `web_search_probe` tests an **unsaved** URL for the settings pane.
//! - Base URL rule: http/https, no credentials, no query or fragment, a path
//!   prefix allowed, trailing `/` stripped; `http://` only for loopback or an
//!   origin in the open vault's `allowHttpOrigins`. Private addresses are
//!   allowed for the base (self-hosted SearXNG, ruling R5).
//! - `GET {base}/search?q=…&format=json&language=…&safesearch=1&pageno=1`
//!   with `User-Agent: labnoteO/<ver>`, `Accept: application/json,
//!   text/html;q=0.5`, `Accept-Language: ko,en`. No redirects (a 3xx is
//!   `redirect`), 1 MiB cap, 15 s timeout, no key ever sent.
//! - Query: trimmed, 1..=200 chars (longer is `badInput`, nothing is sent).
//! - Errors: 403 → `jsonDisabled` (the instance does not allow `format=json`),
//!   429 → `rateLimited`, no results with `unresponsive_engines` →
//!   `enginesDown`; others are the usual `NetError` kinds.
//! - Result: at most 8 hits, http/https URLs only (fragment dropped), deduped
//!   by normalised URL, title ≤ 200 chars, snippet ≤ 300 chars, control and
//!   bidi characters removed. The text is the web's: the webview fences it
//!   as untrusted before any model sees it.

use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use super::config::{is_loopback, join_path, origin, parse_service_url, Url};
use super::error::{NetError, NetErrorKind};
use super::http::{parse_json, send, Outgoing};
use super::NetState;
use crate::assistant::config::{allow_http_of, read_at, MAX_URL};
use crate::vault::{SettingsFile, VaultState};

/// Longest query sent, in chars.
pub const MAX_QUERY: usize = 200;
/// Most hits answered.
pub const MAX_HITS: usize = 8;
pub const MAX_TITLE: usize = 200;
pub const MAX_SNIPPET: usize = 300;
pub const MAX_ENGINE: usize = 40;
/// Largest SearXNG answer read (1 MiB).
pub const MAX_BODY: usize = 1024 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(15);
/// The query `web_search_probe` sends.
pub const PROBE_QUERY: &str = "labnoteO";

/// The SearXNG categories the assistant may ask for.
const CATEGORIES: [&str; 4] = ["general", "science", "it", "news"];
const TIME_RANGES: [&str; 4] = ["day", "week", "month", "year"];

/// `{language?, timeRange?, categories?}` from the webview.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchOpts {
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub time_range: Option<String>,
    #[serde(default)]
    pub categories: Option<Vec<String>>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub engine: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    /// Some engines did not answer (the hits may be incomplete).
    pub engines_down: bool,
}

/// A SearXNG base URL as typed: `parse_service_url` (path prefix allowed,
/// trailing `/` trimmed), at most `MAX_URL` chars, and clear text only to
/// loopback or an allowed origin.
pub fn parse_searxng_url(raw: &str, allow_http: &[String]) -> Option<Url> {
    let url = parse_base(raw)?;
    clear_text_ok(&url, allow_http).then_some(url)
}

/// `parse_service_url` within `MAX_URL` chars (no http rule).
fn parse_base(raw: &str) -> Option<Url> {
    let raw = raw.trim();
    if raw.chars().count() > MAX_URL {
        return None;
    }
    parse_service_url(raw)
}

fn clear_text_ok(url: &Url, allow_http: &[String]) -> bool {
    url.scheme() == "https" || is_loopback(url) || allow_http.contains(&origin(url))
}

fn bad_input(message: &str) -> NetError {
    NetError::new(NetErrorKind::BadInput, message)
}

fn insecure() -> NetError {
    NetError::new(
        NetErrorKind::Insecure,
        "a plain http search address is allowed only for this computer or an allowed origin",
    )
}

/// A language tag such as `ko`, `en-US`, `all` or `auto`.
fn language_ok(lang: &str) -> bool {
    if lang == "all" || lang == "auto" {
        return true;
    }
    let mut parts = lang.split('-');
    let primary = parts.next().unwrap_or("");
    let region = parts.next();
    parts.next().is_none()
        && (2..=3).contains(&primary.len())
        && primary.bytes().all(|b| b.is_ascii_alphabetic())
        && region.map_or(true, |r| (2..=8).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// Removes control and bidi-override characters and collapses whitespace,
/// then keeps at most `max` chars.
fn clean(text: &str, max: usize) -> String {
    let bidi = |c: char| matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}');
    let mut out = String::new();
    let mut gap = false;
    for c in text.chars() {
        if c.is_whitespace() {
            gap = !out.is_empty();
            continue;
        }
        if c.is_control() || bidi(c) {
            continue;
        }
        if gap {
            out.push(' ');
            gap = false;
        }
        out.push(c);
    }
    out.chars().take(max).collect()
}

/// An http/https hit URL with a host, no userinfo, without its fragment.
fn hit_url(raw: &str) -> Option<Url> {
    let mut url = Url::parse(raw.trim()).ok()?;
    if (url.scheme() != "http" && url.scheme() != "https") || !url.has_host() {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.set_fragment(None);
    Some(url)
}

/// The dedupe key: origin, path without a trailing `/`, query.
fn dedupe_key(url: &Url) -> String {
    format!("{}{}?{}", origin(url), url.path().trim_end_matches('/'), url.query().unwrap_or(""))
}

/// `{base}/search` with the query string, or `badInput` for a bad query or option.
pub fn search_url(base: &Url, query: &str, opts: &SearchOpts) -> Result<Url, NetError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(bad_input("the search query is empty"));
    }
    if query.chars().count() > MAX_QUERY {
        return Err(bad_input("the search query is longer than 200 characters"));
    }
    let language = opts.language.as_deref().map(str::trim).filter(|l| !l.is_empty()).unwrap_or("all");
    if !language_ok(language) {
        return Err(bad_input("unknown search language"));
    }
    if let Some(range) = &opts.time_range {
        if !TIME_RANGES.contains(&range.as_str()) {
            return Err(bad_input("unknown time range"));
        }
    }
    let categories = match &opts.categories {
        None => None,
        Some(list) => {
            if list.is_empty() || list.len() > CATEGORIES.len() || list.iter().any(|c| !CATEGORIES.contains(&c.as_str())) {
                return Err(bad_input("unknown search category"));
            }
            Some(list.join(","))
        }
    };
    let mut url = join_path(base, "/search");
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("q", query)
            .append_pair("format", "json")
            .append_pair("language", language)
            .append_pair("safesearch", "1")
            .append_pair("pageno", "1");
        if let Some(range) = &opts.time_range {
            q.append_pair("time_range", range);
        }
        if let Some(c) = &categories {
            q.append_pair("categories", c);
        }
    }
    Ok(url)
}

/// Parses a SearXNG JSON answer, tolerating missing or odd fields.
pub fn parse_results(text: &str) -> Result<SearchResult, NetError> {
    let json = parse_json(text)?;
    if !json.is_object() {
        return Err(NetError::new(NetErrorKind::NotJson, "the response is not a SearXNG answer"));
    }
    let engines_down = json.get("unresponsive_engines").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    let mut seen = HashSet::new();
    let mut hits = Vec::new();
    for item in json.get("results").and_then(Value::as_array).into_iter().flatten() {
        if hits.len() >= MAX_HITS {
            break;
        }
        let Some(url) = item.get("url").and_then(Value::as_str).and_then(hit_url) else { continue };
        if !seen.insert(dedupe_key(&url)) {
            continue;
        }
        let text_of = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or("");
        let mut title = clean(text_of("title"), MAX_TITLE);
        if title.is_empty() {
            title = clean(url.as_str(), MAX_TITLE);
        }
        let engine = match item.get("engine").and_then(Value::as_str) {
            Some(e) => e,
            None => item.get("engines").and_then(Value::as_array).and_then(|a| a.first()).and_then(Value::as_str).unwrap_or(""),
        };
        hits.push(Hit {
            title,
            url: url.to_string(),
            snippet: clean(text_of("content"), MAX_SNIPPET),
            engine: clean(engine, MAX_ENGINE),
        });
    }
    if hits.is_empty() && engines_down {
        return Err(NetError::new(NetErrorKind::EnginesDown, "the search engines did not answer"));
    }
    Ok(SearchResult { hits, engines_down })
}

/// One search against `base` (already validated).
pub async fn search_at(net: &NetState, request_id: Option<&str>, base: &Url, query: &str, opts: &SearchOpts) -> Result<SearchResult, NetError> {
    let url = search_url(base, query, opts)?;
    let out = Outgoing {
        method: reqwest::Method::GET,
        url,
        headers: vec![
            ("user-agent", concat!("labnoteO/", env!("CARGO_PKG_VERSION")).to_string()),
            ("accept", "application/json, text/html;q=0.5".to_string()),
            ("accept-language", "ko,en".to_string()),
        ],
        json: None,
        timeout: Some(TIMEOUT),
        max_body: MAX_BODY,
        secret: None,
        allow_http: false,
    };
    match send(net, request_id, out).await {
        Ok(incoming) => parse_results(&incoming.text),
        Err(e) if e.kind == NetErrorKind::Status && e.status == Some(403) => Err(NetError::new(
            NetErrorKind::JsonDisabled,
            "this SearXNG instance does not allow JSON results (add json to search.formats)",
        )),
        Err(e) if e.kind == NetErrorKind::Status && e.status == Some(429) => {
            Err(NetError::new(NetErrorKind::RateLimited, "the search server asks to slow down"))
        }
        Err(e) => Err(e),
    }
}

/// The stored base URL, re-checked against the open vault's http rule.
pub fn stored_base(stored: Option<&str>, allow_http: &[String]) -> Result<Url, NetError> {
    let not_set = || NetError::new(NetErrorKind::NotConfigured, "no web search address is set");
    let url = parse_base(stored.ok_or_else(not_set)?).ok_or_else(not_set)?;
    if !clear_text_ok(&url, allow_http) {
        return Err(insecure());
    }
    Ok(url)
}

#[tauri::command]
pub async fn web_search(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    net: State<'_, NetState>,
    request_id: Option<String>,
    query: String,
    opts: Option<SearchOpts>,
) -> Result<SearchResult, NetError> {
    let cfg = read_at(&settings.0);
    let allow = allow_http_of(&settings.0, &vault);
    let base = stored_base(cfg.searxng_url.as_deref(), &allow)?;
    search_at(&net, request_id.as_deref(), &base, &query, &opts.unwrap_or_default()).await
}

/// A test search against an unsaved URL (the pane's "확인" button).
#[tauri::command]
pub async fn web_search_probe(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    net: State<'_, NetState>,
    url: String,
) -> Result<SearchResult, NetError> {
    let allow = allow_http_of(&settings.0, &vault);
    let base = probe_base(&url, &allow)?;
    search_at(&net, None, &base, PROBE_QUERY, &SearchOpts::default()).await
}

/// An unsaved URL for the probe: `insecure` for clear text the rule refuses,
/// `invalidUrl` for anything else that does not parse.
pub fn probe_base(raw: &str, allow_http: &[String]) -> Result<Url, NetError> {
    let url = parse_base(raw)
        .ok_or_else(|| NetError::new(NetErrorKind::InvalidUrl, "enter an address such as https://search.example.org"))?;
    if !clear_text_ok(&url, allow_http) {
        return Err(insecure());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::testserver::{serve, silent, Canned};
    use serde_json::json;
    use tauri::async_runtime::block_on;

    fn base(s: &str) -> Url {
        parse_searxng_url(s, &[]).unwrap()
    }

    fn search(url: &str, query: &str) -> Result<SearchResult, NetError> {
        block_on(search_at(&NetState::default(), Some("r1"), &base(url), query, &SearchOpts::default()))
    }

    fn results(v: Value) -> String {
        v.to_string()
    }

    #[test]
    fn web_search_base_url_is_normalised() {
        assert_eq!(base("https://s.example/").as_str(), "https://s.example/");
        assert_eq!(base("https://s.example/searxng/").as_str(), "https://s.example/searxng");
        let u = base("https://s.example/searxng/");
        assert_eq!(join_path(&u, "/search").as_str(), "https://s.example/searxng/search");
        assert_eq!(join_path(&base("https://s.example/"), "/search").as_str(), "https://s.example/search");
    }

    #[test]
    fn web_search_base_url_refuses_credentials_query_fragment_and_other_schemes() {
        for bad in [
            "https://u:p@s.example",
            "https://u@s.example",
            "https://s.example/?format=json",
            "https://s.example/#x",
            "ftp://s.example",
            "file:///c:/x",
            "s.example",
            "",
        ] {
            assert!(parse_searxng_url(bad, &[]).is_none(), "{bad}");
        }
        assert!(parse_searxng_url(&format!("https://s.example/{}", "a".repeat(MAX_URL)), &[]).is_none());
    }

    #[test]
    fn web_search_plain_http_only_for_loopback_or_an_allowed_origin() {
        assert!(parse_searxng_url("http://127.0.0.1:8888", &[]).is_some());
        assert!(parse_searxng_url("http://[::1]:8888", &[]).is_some());
        assert!(parse_searxng_url("http://search.lab:8080", &[]).is_none());
        assert!(parse_searxng_url("http://search.lab:8080", &["http://search.lab:8080".into()]).is_some());
        // A private address is allowed as the base (R5) when its origin is allowed.
        assert!(parse_searxng_url("http://10.0.0.5", &["http://10.0.0.5".into()]).is_some());
        assert!(parse_searxng_url("https://10.0.0.5", &[]).is_some());
    }

    #[test]
    fn web_search_without_a_stored_url_is_not_configured_and_sends_nothing() {
        assert_eq!(stored_base(None, &[]).unwrap_err().kind, NetErrorKind::NotConfigured);
        // Stored under a vault that allowed it; now the open vault does not: insecure.
        assert_eq!(stored_base(Some("http://search.lab"), &[]).unwrap_err().kind, NetErrorKind::Insecure);
        assert_eq!(stored_base(Some("https://s.example"), &[]).unwrap().as_str(), "https://s.example/");
    }

    #[test]
    fn web_search_probe_maps_bad_urls() {
        assert_eq!(probe_base("nope", &[]).unwrap_err().kind, NetErrorKind::InvalidUrl);
        assert_eq!(probe_base("http://search.lab", &[]).unwrap_err().kind, NetErrorKind::Insecure);
        assert!(probe_base(" https://s.example/ ", &[]).is_ok());
    }

    #[test]
    fn web_search_sends_the_documented_request_with_a_korean_query() {
        let s = serve(vec![Canned::ok(&results(json!({"results": [], "unresponsive_engines": []})))]);
        let r = search(&format!("{}/searxng/", s.url), "  대장균 형질전환 효율  ").unwrap();
        assert_eq!(r, SearchResult { hits: vec![], engines_down: false });
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "GET");
        let path = &reqs[0].path;
        assert!(path.starts_with("/searxng/search?q="), "{path}");
        let url = Url::parse(&format!("http://x{path}")).unwrap();
        let q: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert_eq!(
            q,
            vec![
                ("q".into(), "대장균 형질전환 효율".into()),
                ("format".into(), "json".into()),
                ("language".into(), "all".into()),
                ("safesearch".into(), "1".into()),
                ("pageno".into(), "1".into()),
            ]
        );
        // The raw path carries percent-encoded UTF-8, never raw Korean bytes.
        assert!(path.contains("%EB%8C%80%EC%9E%A5%EA%B7%A0"), "{path}");
        assert_eq!(reqs[0].header("user-agent"), Some(concat!("labnoteO/", env!("CARGO_PKG_VERSION"))));
        assert_eq!(reqs[0].header("accept"), Some("application/json, text/html;q=0.5"));
        assert_eq!(reqs[0].header("accept-language"), Some("ko,en"));
        assert_eq!(reqs[0].header("authorization"), None);
        assert_eq!(reqs[0].header("cookie"), None);
    }

    #[test]
    fn web_search_options_are_checked_and_sent() {
        let b = base("https://s.example");
        let opts = SearchOpts { language: Some("ko-KR".into()), time_range: Some("year".into()), categories: Some(vec!["science".into(), "news".into()]) };
        let u = search_url(&b, "pcr", &opts).unwrap();
        let q: Vec<(String, String)> = u.query_pairs().into_owned().collect();
        assert!(q.contains(&("language".into(), "ko-KR".into())));
        assert!(q.contains(&("time_range".into(), "year".into())));
        assert!(q.contains(&("categories".into(), "science,news".into())));
        for bad in [
            SearchOpts { language: Some("ko&x=1".into()), ..Default::default() },
            SearchOpts { time_range: Some("decade".into()), ..Default::default() },
            SearchOpts { categories: Some(vec!["images".into()]), ..Default::default() },
        ] {
            assert_eq!(search_url(&b, "pcr", &bad).unwrap_err().kind, NetErrorKind::BadInput, "{bad:?}");
        }
    }

    #[test]
    fn web_search_query_over_200_chars_or_blank_is_refused_without_a_request() {
        let s = serve(vec![Canned::ok("{}")]);
        assert_eq!(search(&s.url, &"가".repeat(201)).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(search(&s.url, "   ").unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(s.request_count(), 0);
        // Exactly 200 chars is fine.
        let s = serve(vec![Canned::ok(r#"{"results": []}"#)]);
        assert!(search(&s.url, &"가".repeat(200)).is_ok());
    }

    #[test]
    fn web_search_parser_tolerates_missing_and_non_string_fields() {
        let r = parse_results(&results(json!({
            "results": [
                {"url": "https://a.example/x", "title": 5, "content": null},
                {"title": "no url"},
                {"url": 7},
                "junk",
                {"url": "https://b.example/", "title": "B", "content": "b text", "engines": ["bing", "ddg"]},
                {"url": "https://c.example", "title": "C\u{202E}evil\u{0007}", "content": "c\n\n  text", "engine": "brave"}
            ],
            "unresponsive_engines": "junk"
        })))
        .unwrap();
        assert_eq!(r.hits.len(), 3);
        assert_eq!(r.hits[0], Hit { title: "https://a.example/x".into(), url: "https://a.example/x".into(), snippet: String::new(), engine: String::new() });
        assert_eq!(r.hits[1].engine, "bing");
        assert_eq!(r.hits[2].title, "Cevil");
        assert_eq!(r.hits[2].snippet, "c text");
        assert!(!r.engines_down);
        // No `results` at all is an empty answer, not an error.
        assert_eq!(parse_results("{}").unwrap().hits, vec![]);
        assert_eq!(parse_results("<html>").unwrap_err().kind, NetErrorKind::NotJson);
        assert_eq!(parse_results("[1]").unwrap_err().kind, NetErrorKind::NotJson);
    }

    #[test]
    fn web_search_hits_are_capped_deduped_and_http_only() {
        let mut items = vec![
            json!({"url": "javascript:alert(1)", "title": "js"}),
            json!({"url": "file:///etc/passwd", "title": "file"}),
            json!({"url": "ftp://x.example/a", "title": "ftp"}),
            json!({"url": "https://dup.example/a#one", "title": "dup 1"}),
            json!({"url": "HTTPS://DUP.example:443/a/#two", "title": "dup 2"}),
            json!({"url": "https://long.example", "title": "t".repeat(500), "content": "s".repeat(900)}),
        ];
        for i in 0..20 {
            items.push(json!({"url": format!("https://n{i}.example/"), "title": format!("n{i}")}));
        }
        let r = parse_results(&results(json!({"results": items}))).unwrap();
        assert_eq!(r.hits.len(), MAX_HITS);
        assert_eq!(r.hits[0].url, "https://dup.example/a");
        assert_eq!(r.hits[0].title, "dup 1");
        assert_eq!(r.hits[1].url, "https://long.example/");
        assert_eq!(r.hits[1].title.chars().count(), MAX_TITLE);
        assert_eq!(r.hits[1].snippet.chars().count(), MAX_SNIPPET);
        assert!(r.hits.iter().all(|h| h.url.starts_with("https://")));
    }

    #[test]
    fn web_search_403_is_json_disabled() {
        let s = serve(vec![Canned::status(403).header("Content-Type", "text/html").body("<h1>403 Forbidden</h1>")]);
        assert_eq!(search(&s.url, "pcr").unwrap_err().kind, NetErrorKind::JsonDisabled);
    }

    #[test]
    fn web_search_429_is_rate_limited() {
        let s = serve(vec![Canned::status(429).header("Retry-After", "30")]);
        assert_eq!(search(&s.url, "pcr").unwrap_err().kind, NetErrorKind::RateLimited);
    }

    #[test]
    fn web_search_3xx_is_redirect_and_not_followed() {
        let s = serve(vec![Canned::status(302).header("Location", "https://elsewhere.example/search"), Canned::ok("{}")]);
        let e = search(&s.url, "pcr").unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Redirect);
        assert_eq!(e.location.as_deref(), Some("https://elsewhere.example"));
        assert_eq!(s.request_count(), 1);
    }

    #[test]
    fn web_search_other_status_stays_status() {
        let s = serve(vec![Canned::status(500).body("boom")]);
        let e = search(&s.url, "pcr").unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(500)));
    }

    #[test]
    fn web_search_empty_with_unresponsive_engines_is_engines_down() {
        let s = serve(vec![Canned::ok(&results(json!({"results": [], "unresponsive_engines": [["google", "timeout"]]})))]);
        assert_eq!(search(&s.url, "pcr").unwrap_err().kind, NetErrorKind::EnginesDown);
        // With hits, the answer stands and says some engines were down.
        let s = serve(vec![Canned::ok(&results(json!({
            "results": [{"url": "https://a.example", "title": "A"}],
            "unresponsive_engines": [["google", "timeout"]]
        })))]);
        let r = search(&s.url, "pcr").unwrap();
        assert!(r.engines_down);
        assert_eq!(r.hits.len(), 1);
    }

    #[test]
    fn web_search_html_answer_is_not_json() {
        let s = serve(vec![Canned::status(200).header("Content-Type", "text/html").body("<html>login</html>")]);
        assert_eq!(search(&s.url, "pcr").unwrap_err().kind, NetErrorKind::NotJson);
    }

    #[test]
    fn web_search_oversize_answer_is_too_large() {
        let s = serve(vec![Canned::ok(&"x".repeat(MAX_BODY + 1))]);
        assert_eq!(search(&s.url, "pcr").unwrap_err().kind, NetErrorKind::TooLarge);
    }

    #[test]
    fn web_search_can_be_cancelled() {
        let s = silent();
        let net = NetState::default();
        assert!(!net.cancel("early"));
        let e = block_on(search_at(&net, Some("early"), &base(&s.url), "pcr", &SearchOpts::default())).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Cancelled);
    }
}
