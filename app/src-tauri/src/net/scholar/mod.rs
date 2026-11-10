//! Built-in literature search (spec §8): PubMed now; Europe PMC, Crossref
//! and bioRxiv follow (Task 12). Read-only lookups of public services, made
//! from Rust so the only key involved (the optional NCBI API key) never
//! reaches the webview.
//!
//! - Base URLs are constants (`ScholarBases::real`). The webview names a
//!   source and a query or id, never a host.
//! - Tests point the bases at a fake on `127.0.0.1` (`ScholarBases::for_test`,
//!   `cfg(test)` only). The real-app check uses `LABNOTEO_TEST_SCHOLAR_BASE`,
//!   read only in debug builds and only when it is a loopback `http://` URL;
//!   with it no NCBI key is ever sent.
//! - Every request: 20 s timeout, 2 MiB body, paced per source (`limiter`),
//!   one retry after a 429 (`Retry-After`, at most 5 s), cancellable by
//!   `requestId` like the other network commands.
//! - Results are compact (`Hit`): titles 300 chars, the first 3 authors plus
//!   "et al.", at most 10 hits, abstracts 3,000 chars. The text is the
//!   services' own and is fenced as untrusted by the webview (spec §8.3).

pub mod limiter;
pub mod pubmed;

use std::time::Duration;

use serde::Serialize;
use tauri::State;

use super::config::{ServiceConfig, Url};
use super::error::{redact_text, NetError, NetErrorKind};
use super::http::{send_raw, Outgoing};
use super::secrets::{SecretStore, Secrets};
use super::NetState;
use crate::vault::{SettingsFile, VaultState};
use limiter::Limiter;

/// Per-request timeout.
pub const TIMEOUT: Duration = Duration::from_secs(20);
/// Largest response body read.
pub const MAX_BODY: usize = 2 * 1024 * 1024;
/// Most hits one search returns.
pub const MAX_RESULTS: usize = 10;
/// Hits returned when the caller names no limit.
pub const DEFAULT_RESULTS: usize = 5;
/// Longest search query, in chars.
pub const MAX_QUERY: usize = 300;
/// Longest abstract text, in chars.
pub const MAX_ABSTRACT: usize = 3000;
/// Longest title, in chars.
pub const MAX_TITLE: usize = 300;
/// Longest journal or server name, in chars.
pub const MAX_VENUE: usize = 200;
/// Longest single author name, in chars.
const MAX_AUTHOR: usize = 80;
/// Authors listed before "et al.".
const AUTHORS_SHOWN: usize = 3;
/// Longest wait a `Retry-After` may ask for before the one retry.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(5);
/// The wait before the retry when a 429 names none.
const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(1);

/// The debug-only override of every base (spec §8.1).
#[cfg(debug_assertions)]
pub const TEST_BASE_ENV: &str = "LABNOTEO_TEST_SCHOLAR_BASE";

/// Where each source lives. Every base ends with `/`, so an endpoint is
/// `base.join("<name>")`.
#[derive(Clone, Debug)]
pub struct ScholarBases {
    pub pubmed: Url,
    pub europepmc: Url,
    pub crossref: Url,
    pub biorxiv: Url,
    /// Whether the NCBI key from the keychain may be attached (the real
    /// bases and the unit tests' fake; never the debug env override).
    pub ncbi_key: bool,
}

/// One of the fixed real bases (constants that always parse).
fn fixed(url: &str) -> Url {
    Url::parse(url).expect("a fixed scholarly base URL parses")
}

impl ScholarBases {
    /// The public services (spec §8.2).
    pub fn real() -> Self {
        ScholarBases {
            pubmed: fixed("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"),
            europepmc: fixed("https://www.ebi.ac.uk/europepmc/webservices/rest/"),
            crossref: fixed("https://api.crossref.org/"),
            biorxiv: fixed("https://api.biorxiv.org/"),
            ncbi_key: true,
        }
    }

    /// Every source under one fake server: `<base>/pubmed/`, `<base>/europepmc/` …
    #[cfg(any(test, debug_assertions))]
    fn under(base: &Url, ncbi_key: bool) -> Option<Self> {
        let root = base.as_str().trim_end_matches('/');
        let at = |name: &str| Url::parse(&format!("{root}/{name}/")).ok();
        Some(ScholarBases { pubmed: at("pubmed")?, europepmc: at("europepmc")?, crossref: at("crossref")?, biorxiv: at("biorxiv")?, ncbi_key })
    }

    /// The tests' fake server; anything but a loopback base is refused.
    #[cfg(test)]
    pub fn for_test(base: &str) -> Option<Self> {
        let url = Url::parse(base).ok()?;
        if !super::config::is_loopback(&url) {
            return None;
        }
        Self::under(&url, true)
    }

    /// `LABNOTEO_TEST_SCHOLAR_BASE` as typed: only a loopback `http://` URL
    /// with no userinfo, query or fragment.
    #[cfg(debug_assertions)]
    pub fn parse_test_base(raw: &str) -> Option<Url> {
        let url = super::config::parse_service_url(raw)?;
        (url.scheme() == "http" && super::config::is_loopback(&url)).then_some(url)
    }

    /// The bases the commands use: the real ones, or in a debug build the
    /// loopback override (without the NCBI key).
    pub fn current() -> Self {
        #[cfg(debug_assertions)]
        if let Some(bases) = std::env::var(TEST_BASE_ENV)
            .ok()
            .as_deref()
            .and_then(Self::parse_test_base)
            .and_then(|url| Self::under(&url, false))
        {
            return bases;
        }
        Self::real()
    }
}

/// One search hit, compact (spec §8.3).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// `pubmed`, `europepmc`, `crossref` or `biorxiv`.
    pub source: String,
    /// The id to pass to `scholar_get` for this source.
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pmid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    pub title: String,
    /// `"Smith J, Lee K, Park Y, et al."`.
    pub authors: String,
    pub venue: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<u16>,
    pub url: String,
}

/// One record with its abstract (or the text the source gives for it).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Abstract {
    pub hit: Hit,
    pub text: String,
    pub truncated: bool,
}

/// What a lookup needs; the commands build it from the app state, the tests
/// from fakes.
pub struct Ctx<'a> {
    pub net: &'a NetState,
    pub limiter: &'a Limiter,
    pub bases: &'a ScholarBases,
    pub cfg: &'a ServiceConfig,
    pub store: &'a dyn SecretStore,
}

fn bad_input(message: &str) -> NetError {
    NetError::new(NetErrorKind::BadInput, message)
}

/// The query, trimmed: 1..=300 chars with no control chars. The error never
/// repeats it.
pub fn check_query(query: &str) -> Result<String, NetError> {
    let q = query.trim();
    if q.is_empty() || q.chars().count() > MAX_QUERY || q.chars().any(char::is_control) {
        return Err(bad_input("the search must be 1 to 300 characters on one line"));
    }
    Ok(q.to_string())
}

/// The number of hits to ask for: 5 when not named, else 1..=10.
pub fn clamp_limit(limit: Option<u8>) -> usize {
    limit.map_or(DEFAULT_RESULTS, |n| usize::from(n).clamp(1, MAX_RESULTS))
}

/// A DOI as a source gives it: `10.` then at least one more char, at most
/// 200 chars, nothing blank or control.
pub fn doi_ok(doi: &str) -> bool {
    doi.starts_with("10.") && doi.len() > 3 && doi.chars().count() <= 200 && !doi.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The first run of four digits in a date text, as a year 1000..=2999.
pub fn year_of(date: &str) -> Option<u16> {
    let bytes = date.as_bytes();
    bytes
        .windows(4)
        .enumerate()
        .find(|(i, w)| {
            w.iter().all(u8::is_ascii_digit)
                && (*i == 0 || !bytes[i - 1].is_ascii_digit())
                && bytes.get(i + 4).map_or(true, |b| !b.is_ascii_digit())
        })
        .and_then(|(_, w)| std::str::from_utf8(w).ok()?.parse::<u16>().ok())
        .filter(|y| (1000..=2999).contains(y))
}

/// Removes markup tags: a `<` followed by a letter (or `/` and a letter) up
/// to the next `>` within 200 chars. A lone `<` (`p<0.05`, `a < b`) stays.
fn strip_tags(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
            let start = if chars.get(i + 1) == Some(&'/') { i + 2 } else { i + 1 };
            if chars.get(start).is_some_and(|c| c.is_ascii_alphabetic()) {
                if let Some(end) = chars[start..].iter().take(200).position(|&c| c == '>') {
                    i = start + end + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Decodes the HTML entities a title or abstract may carry: `&amp;` `&lt;`
/// `&gt;` `&quot;` `&apos;` `&nbsp;` and numeric ones. Others stay as written.
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let decoded = tail.find(';').filter(|&end| end <= 10).and_then(|end| {
            let name = &tail[1..end];
            let ch = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => {
                    let num = name.strip_prefix('#')?;
                    let code = match num.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                        None => num.parse::<u32>().ok()?,
                    };
                    char::from_u32(code)
                }
            }?;
            Some((ch, end + 1))
        });
        match decoded {
            Some((ch, len)) => {
                out.push(ch);
                rest = &tail[len..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// At most `max` chars; a cut text ends with `…` (within the `max`).
fn cap(text: &str, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        return (text.to_string(), false);
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out = out.trim_end().to_string();
    out.push('…');
    (out, true)
}

/// One line of text from a source: tags removed, entities decoded, control
/// chars and runs of blanks turned into one space, trimmed, capped at `max`.
pub fn clean_line(text: &str, max: usize) -> String {
    let plain = decode_entities(&strip_tags(text));
    let words: Vec<&str> = plain.split(|c: char| c.is_whitespace() || c.is_control()).filter(|w| !w.is_empty()).collect();
    cap(&words.join(" "), max).0
}

/// A block of text (an abstract): line breaks kept (CRLF to LF, at most one
/// blank line in a row), other control chars dropped, each line's blanks
/// collapsed, trimmed, capped at `max`. Tags are removed only when `markup`.
pub fn clean_block(text: &str, max: usize, markup: bool) -> (String, bool) {
    let plain = if markup { decode_entities(&strip_tags(text)) } else { text.to_string() };
    let mut lines: Vec<String> = Vec::new();
    for raw in plain.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        let words: Vec<&str> = raw.split(|c: char| c.is_whitespace() || c.is_control()).filter(|w| !w.is_empty()).collect();
        let line = words.join(" ");
        if line.is_empty() && lines.last().is_none_or(String::is_empty) {
            continue;
        }
        lines.push(line);
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    cap(&lines.join("\n"), max)
}

/// `"A, B, C, et al."`: the first three non-empty names (each one line, 80
/// chars at most), and "et al." when there are more.
pub fn authors_line<S: AsRef<str>>(names: impl IntoIterator<Item = S>) -> String {
    let all: Vec<String> = names.into_iter().map(|n| clean_line(n.as_ref(), MAX_AUTHOR)).filter(|n| !n.is_empty()).collect();
    let mut shown: Vec<String> = all.iter().take(AUTHORS_SHOWN).cloned().collect();
    if all.len() > AUTHORS_SHOWN {
        shown.push("et al.".to_string());
    }
    shown.join(", ")
}

/// The wait a 429 asks for: `Retry-After` in seconds, at most 5 s; 1 s when
/// it names none (or an HTTP date).
fn retry_after(headers: &[(String, String)]) -> Duration {
    headers
        .iter()
        .find(|(k, _)| k == "retry-after")
        .and_then(|(_, v)| v.trim().parse::<u64>().ok())
        .map_or(DEFAULT_RETRY_AFTER, |s| Duration::from_secs(s).min(MAX_RETRY_AFTER))
}

/// One GET to a source, paced by the limiter (one in flight, `rate` per
/// second), with one retry after a 429. The answer is text with `secret`
/// redacted; any other non-2xx is a `status` error, redacted too.
pub(crate) async fn get_text(
    ctx: &Ctx<'_>,
    source: &'static str,
    rate: u32,
    request_id: Option<&str>,
    url: Url,
    accept: &'static str,
    secret: Option<&str>,
) -> Result<String, NetError> {
    let _permit = ctx.limiter.acquire(source, rate).await;
    let mut retried = false;
    loop {
        let out = Outgoing {
            method: reqwest::Method::GET,
            url: url.clone(),
            headers: vec![("Accept", accept.to_string())],
            json: None,
            timeout: Some(TIMEOUT),
            max_body: MAX_BODY,
            secret: secret.map(str::to_string),
            allow_http: false,
        };
        let raw = send_raw(ctx.net, request_id, out).await?;
        let text = String::from_utf8_lossy(&raw.bytes);
        if raw.status != 429 {
            return Ok(redact_text(&text, secret));
        }
        if retried {
            return Err(NetError::status(429, &text, secret));
        }
        retried = true;
        tokio::time::sleep(retry_after(&raw.headers)).await;
    }
}

/// The JSON of an answer that did not have the expected shape.
pub(crate) fn unexpected() -> NetError {
    NetError::new(NetErrorKind::NotJson, "the answer is not in the expected shape")
}

/// The sources this build knows, as the webview names them.
const SOURCES: [&str; 4] = ["pubmed", "europepmc", "crossref", "biorxiv"];

/// Checks the source name and that the user left it on. Nothing is sent
/// for an unknown (`badInput`) or switched-off (`notConfigured`) source.
fn check_source(cfg: &ServiceConfig, source: &str) -> Result<(), NetError> {
    if !SOURCES.contains(&source) {
        return Err(bad_input("unknown literature source"));
    }
    let s = cfg.scholar_sources;
    let on = match source {
        "pubmed" => s.pubmed,
        "europepmc" => s.europepmc,
        "crossref" => s.crossref,
        _ => s.biorxiv,
    };
    if !on {
        return Err(NetError::new(NetErrorKind::NotConfigured, "this literature source is turned off in settings"));
    }
    Ok(())
}

fn not_yet() -> NetError {
    bad_input("this literature source is not available yet")
}

/// A search of one source: at most `limit` (1..=10, default 5) compact hits.
pub async fn search(
    ctx: &Ctx<'_>,
    source: &str,
    query: &str,
    limit: Option<u8>,
    _preprints_only: bool,
    request_id: Option<&str>,
) -> Result<Vec<Hit>, NetError> {
    check_source(ctx.cfg, source)?;
    let query = check_query(query)?;
    let limit = clamp_limit(limit);
    match source {
        "pubmed" => pubmed::search(ctx, &query, limit, request_id).await,
        _ => Err(not_yet()),
    }
}

/// One record of a source, with its abstract.
pub async fn get(ctx: &Ctx<'_>, source: &str, id: &str, request_id: Option<&str>) -> Result<Abstract, NetError> {
    check_source(ctx.cfg, source)?;
    match source {
        "pubmed" => pubmed::get(ctx, id.trim(), request_id).await,
        _ => Err(not_yet()),
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn scholar_search(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    source: String,
    query: String,
    limit: Option<u8>,
    preprints_only: Option<bool>,
    request_id: Option<String>,
) -> Result<Vec<Hit>, NetError> {
    let cfg = ServiceConfig::load(&settings.0, vault.root().ok().as_deref())?;
    let bases = ScholarBases::current();
    let ctx = Ctx { net: &net, limiter: Limiter::global(), bases: &bases, cfg: &cfg, store: secrets.0.as_ref() };
    search(&ctx, &source, &query, limit, preprints_only.unwrap_or(false), request_id.as_deref()).await
}

#[tauri::command]
pub async fn scholar_get(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    source: String,
    id: String,
    request_id: Option<String>,
) -> Result<Abstract, NetError> {
    let cfg = ServiceConfig::load(&settings.0, vault.root().ok().as_deref())?;
    let bases = ScholarBases::current();
    let ctx = Ctx { net: &net, limiter: Limiter::global(), bases: &bases, cfg: &cfg, store: secrets.0.as_ref() };
    get(&ctx, &source, &id, request_id.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::config::origin;
    use crate::net::secrets::NCBI_EUTILS_ORIGIN;

    #[test]
    fn real_bases_are_the_fixed_https_services() {
        let b = ScholarBases::real();
        assert_eq!(b.pubmed.as_str(), "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/");
        assert_eq!(b.europepmc.as_str(), "https://www.ebi.ac.uk/europepmc/webservices/rest/");
        assert_eq!(b.crossref.as_str(), "https://api.crossref.org/");
        assert_eq!(b.biorxiv.as_str(), "https://api.biorxiv.org/");
        assert_eq!(origin(&b.pubmed), NCBI_EUTILS_ORIGIN, "the NCBI key only goes to the origin it is bound to");
        assert!(b.ncbi_key);
    }

    #[test]
    fn for_test_takes_only_a_loopback_base() {
        let b = ScholarBases::for_test("http://127.0.0.1:4567").unwrap();
        assert_eq!(b.pubmed.as_str(), "http://127.0.0.1:4567/pubmed/");
        assert_eq!(b.biorxiv.as_str(), "http://127.0.0.1:4567/biorxiv/");
        assert!(ScholarBases::for_test("http://localhost:1/").is_some());
        for bad in ["https://eutils.ncbi.nlm.nih.gov", "http://10.0.0.2:80", "http://example.org", "not a url"] {
            assert!(ScholarBases::for_test(bad).is_none(), "{bad}");
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn the_env_base_must_be_loopback_http() {
        assert_eq!(ScholarBases::parse_test_base(" http://127.0.0.1:4567/ ").unwrap().as_str(), "http://127.0.0.1:4567/");
        assert!(ScholarBases::parse_test_base("http://[::1]:9").is_some());
        for bad in [
            "https://127.0.0.1:4567",
            "http://eutils.ncbi.nlm.nih.gov",
            "https://api.crossref.org",
            "http://192.168.0.2:80",
            "http://u:p@127.0.0.1:1",
            "http://127.0.0.1:1/?x=1",
            "file:///C:/x",
            "",
        ] {
            assert!(ScholarBases::parse_test_base(bad).is_none(), "{bad}");
        }
        // The override never carries the NCBI key.
        let url = ScholarBases::parse_test_base("http://127.0.0.1:4567").unwrap();
        assert!(!ScholarBases::under(&url, false).unwrap().ncbi_key);
        assert_eq!(TEST_BASE_ENV, "LABNOTEO_TEST_SCHOLAR_BASE");
    }

    #[test]
    fn query_and_limit_rules() {
        assert_eq!(check_query("  crispr base editing ").unwrap(), "crispr base editing");
        assert_eq!(check_query(&"가".repeat(300)).unwrap().chars().count(), 300);
        for bad in ["", "   ", "a\nb", "a\u{7}"] {
            assert_eq!(check_query(bad).unwrap_err().kind, NetErrorKind::BadInput, "{bad:?}");
        }
        let long = "q".repeat(301);
        let e = check_query(&long).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::BadInput);
        assert!(!e.message.contains(&long));
        assert_eq!(clamp_limit(None), 5);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(7)), 7);
        assert_eq!(clamp_limit(Some(200)), 10);
    }

    #[test]
    fn text_cleaning() {
        assert_eq!(clean_line("<i>E. coli</i>  chassis\n&amp; <sup>13</sup>C &#x3b1;-&#946;", 300), "E. coli chassis & 13C α-β");
        assert_eq!(clean_line("p<0.05 and a < b &unknown; &", 300), "p<0.05 and a < b &unknown; &");
        let long = clean_line(&"word ".repeat(100), 300);
        assert_eq!(long.chars().count(), 300);
        assert!(long.ends_with('…'));
        let (block, cut) = clean_block("Title.\r\n\r\n\r\n  Abstract\tline \u{7}one.\r\nTwo.\n\n", 3000, false);
        assert_eq!(block, "Title.\n\nAbstract line one.\nTwo.");
        assert!(!cut);
        let (block, cut) = clean_block(&"x".repeat(5000), 3000, false);
        assert_eq!((block.chars().count(), cut), (3000, true));
        assert_eq!(clean_block("<p>a</p>&lt;b&gt;", 100, true).0, "a<b>");
        assert_eq!(clean_block("<p>a</p>", 100, false).0, "<p>a</p>");
    }

    #[test]
    fn authors_years_and_dois() {
        assert_eq!(authors_line(["Smith J", "Lee K", "Park Y", "Kim H"]), "Smith J, Lee K, Park Y, et al.");
        assert_eq!(authors_line(["Smith J", "", "Lee K"]), "Smith J, Lee K");
        assert_eq!(authors_line(Vec::<String>::new()), "");
        assert_eq!(authors_line([&"n".repeat(200)]).chars().count(), 80);
        assert_eq!(year_of("2024 Mar 5"), Some(2024));
        assert_eq!(year_of("Spring 1998"), Some(1998));
        assert_eq!(year_of("20240"), None);
        assert_eq!(year_of(""), None);
        assert_eq!(year_of("0999"), None);
        assert!(doi_ok("10.1038/nbt.1"));
        for bad in ["", "10.", "11.1/x", "10.1/a b", format!("10.{}", "x".repeat(200)).as_str()] {
            assert!(!doi_ok(bad), "{bad}");
        }
    }

    #[test]
    fn retry_after_is_capped() {
        let h = |v: &str| vec![("retry-after".to_string(), v.to_string())];
        assert_eq!(retry_after(&h("2")), Duration::from_secs(2));
        assert_eq!(retry_after(&h("120")), MAX_RETRY_AFTER);
        assert_eq!(retry_after(&h("Wed, 21 Oct 2026 07:28:00 GMT")), Duration::from_secs(1));
        assert_eq!(retry_after(&[]), Duration::from_secs(1));
    }

    #[test]
    fn hits_serialize_in_camel_case_without_missing_fields() {
        let hit = Hit {
            source: "pubmed".into(),
            id: "1".into(),
            pmid: Some("1".into()),
            doi: None,
            title: "T".into(),
            authors: "A".into(),
            venue: "V".into(),
            year: None,
            url: "https://pubmed.ncbi.nlm.nih.gov/1/".into(),
        };
        let v = serde_json::to_value(Abstract { hit, text: "x".into(), truncated: false }).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"hit": {"source":"pubmed","id":"1","pmid":"1","title":"T","authors":"A","venue":"V","url":"https://pubmed.ncbi.nlm.nih.gov/1/"},
                "text":"x","truncated":false})
        );
    }
}
