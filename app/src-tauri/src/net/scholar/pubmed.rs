//! PubMed through NCBI E-utilities (spec §8.2): `esearch` for ids, then
//! `esummary` for compact hits; `efetch` (plain text) for an abstract.
//!
//! Every request carries `tool=labnoteO-Desktop` (NCBI's usage policy);
//! `email=` only when the user typed a contact address (`ncbiEmail`), and
//! `api_key=` only when a key is stored in the fixed-origin slot
//! `ncbiEutils|https://eutils.ncbi.nlm.nih.gov` and the bases allow it. NCBI
//! wants the key in the query string, so it is the request's secret: every
//! answer and error is redacted with it, and no URL is ever logged.
//! Pacing: 3 requests per second without a key, 10 with one.

use serde_json::Value;

use super::{authors_line, clean_block, clean_line, doi_ok, get_text, unexpected, year_of, Abstract, Ctx, Hit};
use super::{MAX_ABSTRACT, MAX_TITLE, MAX_VENUE};
use crate::net::config::Url;
use crate::net::error::{NetError, NetErrorKind};
use crate::net::http::parse_json;
use crate::net::secrets::{key_for, Slot};

/// The limiter's name for this source.
pub const SOURCE: &str = "pubmed";
/// The `tool=` value NCBI asks every client to send.
pub const TOOL: &str = "labnoteO-Desktop";

const JSON: &str = "application/json";
const TEXT: &str = "text/plain";

/// Requests per second NCBI allows (spec §8.2).
pub fn rate(with_key: bool) -> u32 {
    if with_key {
        10
    } else {
        3
    }
}

/// A PubMed id: 1 to 10 digits.
pub fn pmid_ok(id: &str) -> bool {
    (1..=10).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

/// The stored NCBI key, when the bases allow one. A keychain failure reads
/// as "no key": the search still works, just slower.
fn ncbi_key(ctx: &Ctx<'_>) -> Option<String> {
    if !ctx.bases.ncbi_key {
        return None;
    }
    key_for(ctx.store, Slot::NcbiEutils, ctx.cfg).ok().flatten()
}

/// `<base><name>?<params>&tool=…[&email=…][&api_key=…]`.
fn endpoint(ctx: &Ctx<'_>, name: &str, params: &[(&str, &str)], key: Option<&str>) -> Result<Url, NetError> {
    let mut url = ctx.bases.pubmed.join(name).map_err(|_| NetError::new(NetErrorKind::InvalidUrl, "the address is not valid"))?;
    {
        let mut q = url.query_pairs_mut();
        for (k, v) in params {
            q.append_pair(k, v);
        }
        q.append_pair("tool", TOOL);
        if let Some(email) = &ctx.cfg.ncbi_email {
            q.append_pair("email", email);
        }
        if let Some(key) = key {
            q.append_pair("api_key", key);
        }
    }
    Ok(url)
}

/// The link to a record on the PubMed site (a link, never fetched).
pub fn record_url(pmid: &str) -> String {
    format!("https://pubmed.ncbi.nlm.nih.gov/{pmid}/")
}

/// A compact hit from one `esummary` document.
fn hit_of(pmid: &str, doc: &Value) -> Hit {
    let text = |key: &str| doc.get(key).and_then(Value::as_str).unwrap_or("");
    let names = doc
        .get("authors")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.get("name").and_then(Value::as_str)).collect::<Vec<_>>())
        .unwrap_or_default();
    let doi = doc
        .get("articleids")
        .and_then(Value::as_array)
        .and_then(|ids| {
            ids.iter().find(|x| x.get("idtype").and_then(Value::as_str) == Some("doi")).and_then(|x| x.get("value")?.as_str())
        })
        .map(str::trim)
        .filter(|d| doi_ok(d))
        .map(str::to_string);
    let venue = if text("fulljournalname").trim().is_empty() { text("source") } else { text("fulljournalname") };
    Hit {
        source: SOURCE.to_string(),
        id: pmid.to_string(),
        pmid: Some(pmid.to_string()),
        doi,
        title: clean_line(text("title"), MAX_TITLE),
        authors: authors_line(names),
        venue: clean_line(venue, MAX_VENUE),
        year: year_of(text("pubdate")),
        url: record_url(pmid),
    }
}

/// `esummary` for the ids, in the order NCBI lists them; documents that
/// answer with an error (an unknown id) are left out.
async fn summaries(ctx: &Ctx<'_>, ids: &[String], key: Option<&str>, request_id: Option<&str>) -> Result<Vec<Hit>, NetError> {
    let joined = ids.join(",");
    let url = endpoint(ctx, "esummary.fcgi", &[("db", "pubmed"), ("id", &joined), ("retmode", "json")], key)?;
    let text = get_text(ctx, SOURCE, rate(key.is_some()), request_id, url, JSON, key).await?;
    let json = parse_json(&text).map_err(|e| e.redact(key))?;
    let result = json.get("result").ok_or_else(unexpected)?;
    let uids = result.get("uids").and_then(Value::as_array).ok_or_else(unexpected)?;
    Ok(uids
        .iter()
        .filter_map(Value::as_str)
        .filter(|uid| ids.iter().any(|id| id == uid))
        .filter_map(|uid| {
            let doc = result.get(uid)?;
            (doc.is_object() && doc.get("error").is_none()).then(|| hit_of(uid, doc))
        })
        .collect())
}

/// Up to `limit` hits for the query (already checked by `check_query`).
pub async fn search(ctx: &Ctx<'_>, query: &str, limit: usize, request_id: Option<&str>) -> Result<Vec<Hit>, NetError> {
    let key = ncbi_key(ctx);
    let key = key.as_deref();
    let retmax = limit.to_string();
    let url = endpoint(ctx, "esearch.fcgi", &[("db", "pubmed"), ("term", query), ("retmode", "json"), ("retmax", &retmax)], key)?;
    let text = get_text(ctx, SOURCE, rate(key.is_some()), request_id, url, JSON, key).await?;
    let json = parse_json(&text).map_err(|e| e.redact(key))?;
    let list = json.get("esearchresult").and_then(|r| r.get("idlist")).and_then(Value::as_array).ok_or_else(unexpected)?;
    let ids: Vec<String> = list.iter().filter_map(Value::as_str).filter(|id| pmid_ok(id)).take(limit).map(str::to_string).collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    summaries(ctx, &ids, key, request_id).await
}

/// One record by PMID: its hit (`esummary`) and the plain-text abstract
/// (`efetch`, capped at 3,000 chars). An unknown id is `badInput`.
pub async fn get(ctx: &Ctx<'_>, pmid: &str, request_id: Option<&str>) -> Result<Abstract, NetError> {
    if !pmid_ok(pmid) {
        return Err(NetError::new(NetErrorKind::BadInput, "a PubMed id is 1 to 10 digits"));
    }
    let key = ncbi_key(ctx);
    let key = key.as_deref();
    let hit = summaries(ctx, &[pmid.to_string()], key, request_id)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| NetError::new(NetErrorKind::BadInput, "PubMed has no record with this id"))?;
    let url = endpoint(ctx, "efetch.fcgi", &[("db", "pubmed"), ("id", pmid), ("rettype", "abstract"), ("retmode", "text")], key)?;
    let text = get_text(ctx, SOURCE, rate(key.is_some()), request_id, url, TEXT, key).await?;
    let (text, truncated) = clean_block(&text, MAX_ABSTRACT, false);
    Ok(Abstract { hit, text, truncated })
}

#[cfg(test)]
mod tests {
    use super::super::limiter::Limiter;
    use super::super::{search as scholar_search, get as scholar_get, ScholarBases};
    use super::*;
    use crate::net::config::ServiceConfig;
    use crate::net::secrets::{account, MemoryStore, SecretStore};
    use crate::net::testserver::{serve, Canned, TestServer};
    use crate::net::NetState;
    use std::time::{Duration, Instant};
    use tauri::async_runtime::block_on;

    const KEY: &str = "testncbikey123";

    const ESEARCH: &str = r#"{"header":{"type":"esearch"},"esearchresult":{"count":"2","retmax":"2","idlist":["111","222","x9"]}}"#;

    fn esummary() -> String {
        let long = "T".repeat(400);
        serde_json::json!({"result": {
            "uids": ["111", "222"],
            "111": {"uid": "111", "pubdate": "2024 Mar 5", "source": "Nat Biotechnol", "fulljournalname": "Nature biotechnology",
                "title": "<i>E. coli</i> chassis &amp; design", "authors": [{"name": "Smith J"}, {"name": "Lee K"}, {"name": "Park Y"}, {"name": "Kim H"}],
                "articleids": [{"idtype": "pubmed", "value": "111"}, {"idtype": "doi", "value": "10.1038/nbt.1"}]},
            "222": {"uid": "222", "pubdate": "", "source": "Bio", "fulljournalname": "", "title": long, "authors": [{"name": "Solo A"}], "articleids": []}
        }})
        .to_string()
    }

    /// The query of a recorded request as `(key, value)` pairs, decoded.
    fn query(path: &str) -> Vec<(String, String)> {
        Url::parse(&format!("http://x{path}")).unwrap().query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect()
    }

    fn param(path: &str, name: &str) -> Option<String> {
        query(path).into_iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }

    struct Rig {
        net: NetState,
        limiter: Limiter,
        bases: ScholarBases,
        cfg: ServiceConfig,
        store: MemoryStore,
    }

    impl Rig {
        fn new(srv: &TestServer, settings: &str) -> Rig {
            Rig {
                net: NetState::default(),
                limiter: Limiter::default(),
                bases: ScholarBases::for_test(&srv.url).unwrap(),
                cfg: ServiceConfig::from_settings_json(settings),
                store: MemoryStore::default(),
            }
        }

        fn with_key(self) -> Rig {
            self.store.set(&account(Slot::NcbiEutils, &self.cfg).unwrap(), KEY).unwrap();
            self
        }

        fn ctx(&self) -> Ctx<'_> {
            Ctx { net: &self.net, limiter: &self.limiter, bases: &self.bases, cfg: &self.cfg, store: &self.store }
        }
    }

    fn paths(srv: &TestServer) -> Vec<String> {
        srv.requests.lock().unwrap().iter().map(|r| r.path.clone()).collect()
    }

    #[test]
    fn search_gives_compact_hits() {
        let srv = serve(vec![Canned::ok(ESEARCH), Canned::ok(&esummary())]);
        let rig = Rig::new(&srv, "{}");
        let hits = block_on(scholar_search(&rig.ctx(), "pubmed", "  E. coli chassis  ", None, false, None)).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(
            hits[0],
            Hit {
                source: "pubmed".into(),
                id: "111".into(),
                pmid: Some("111".into()),
                doi: Some("10.1038/nbt.1".into()),
                title: "E. coli chassis & design".into(),
                authors: "Smith J, Lee K, Park Y, et al.".into(),
                venue: "Nature biotechnology".into(),
                year: Some(2024),
                url: "https://pubmed.ncbi.nlm.nih.gov/111/".into(),
            }
        );
        let second = &hits[1];
        assert_eq!(second.title.chars().count(), 300);
        assert!(second.title.ends_with('…'));
        assert_eq!((second.doi.as_deref(), second.year, second.venue.as_str(), second.authors.as_str()), (None, None, "Bio", "Solo A"));

        let p = paths(&srv);
        assert!(p[0].starts_with("/pubmed/esearch.fcgi?"), "{}", p[0]);
        assert_eq!(
            query(&p[0]),
            [("db", "pubmed"), ("term", "E. coli chassis"), ("retmode", "json"), ("retmax", "5"), ("tool", "labnoteO-Desktop")]
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .to_vec()
        );
        assert!(p[1].starts_with("/pubmed/esummary.fcgi?"), "{}", p[1]);
        assert_eq!(param(&p[1], "id").as_deref(), Some("111,222"), "the malformed id is dropped");
        for path in &p {
            assert_eq!(param(path, "tool").as_deref(), Some("labnoteO-Desktop"));
            assert_eq!(param(path, "email"), None, "no email when the user typed none");
            assert_eq!(param(path, "api_key"), None, "no key when the slot is empty");
        }
    }

    #[test]
    fn email_and_key_are_sent_only_when_set() {
        let srv = serve(vec![Canned::ok(ESEARCH), Canned::ok(&esummary())]);
        let rig = Rig::new(&srv, r#"{"ncbiEmail":"lab.member+ncbi@example.org"}"#).with_key();
        let hits = block_on(scholar_search(&rig.ctx(), "pubmed", "crispr", Some(50), false, None)).unwrap();
        assert_eq!(hits.len(), 2);
        let p = paths(&srv);
        assert_eq!(param(&p[0], "retmax").as_deref(), Some("10"), "limit is capped at 10");
        for path in &p {
            assert_eq!(param(path, "email").as_deref(), Some("lab.member+ncbi@example.org"));
            assert_eq!(param(path, "api_key").as_deref(), Some(KEY));
            assert_eq!(param(path, "tool").as_deref(), Some("labnoteO-Desktop"));
        }
        assert_eq!((rate(false), rate(true)), (3, 10));
    }

    #[test]
    fn an_error_echoing_the_key_is_redacted() {
        let srv = serve(vec![Canned::status(500).header("Content-Type", "text/plain").body(format!("bad api_key={KEY} for you"))]);
        let rig = Rig::new(&srv, "{}").with_key();
        let e = block_on(scholar_search(&rig.ctx(), "pubmed", "crispr", None, false, None)).unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(500)));
        let shown = format!("{} {:?} {}", serde_json::to_string(&e).unwrap(), e, e);
        assert!(!shown.contains(KEY), "{shown}");
        assert!(shown.contains("bad api_key=*** for you"), "{shown}");
        // A 2xx that echoes the key (in JSON that is not the expected shape) is redacted too.
        let srv = serve(vec![Canned::ok(&format!(r#"{{"esearchresult":{{"ERROR":"{KEY}"}}}}"#))]);
        let rig = Rig::new(&srv, "{}").with_key();
        let e = block_on(scholar_search(&rig.ctx(), "pubmed", "crispr", None, false, None)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::NotJson);
        assert!(!format!("{e:?}").contains(KEY));
    }

    #[test]
    fn the_outgoing_debug_never_shows_the_key_in_the_url() {
        let out = crate::net::http::Outgoing {
            method: reqwest::Method::GET,
            url: Url::parse(&format!("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?term=x&api_key={KEY}")).unwrap(),
            headers: Vec::new(),
            json: None,
            timeout: None,
            max_body: 1,
            secret: Some(KEY.to_string()),
            allow_http: false,
        };
        let shown = format!("{out:?}");
        assert!(!shown.contains(KEY), "{shown}");
        assert!(shown.contains("api_key=***"), "{shown}");
    }

    #[test]
    fn no_hits_means_one_request() {
        let srv = serve(vec![Canned::ok(r#"{"esearchresult":{"count":"0","idlist":[]}}"#)]);
        let rig = Rig::new(&srv, "{}");
        assert_eq!(block_on(scholar_search(&rig.ctx(), "pubmed", "zzzz", None, false, None)).unwrap(), Vec::<Hit>::new());
        assert_eq!(srv.request_count(), 1);
    }

    #[test]
    fn abstract_is_plain_text_capped_at_3000() {
        let body = format!("1. Nature biotechnology. 2024.\r\n\r\n\r\nAbstract: {}", "x".repeat(5000));
        let srv = serve(vec![Canned::ok(&esummary()), Canned::status(200).header("Content-Type", "text/plain").body(body)]);
        let rig = Rig::new(&srv, "{}");
        let a = block_on(scholar_get(&rig.ctx(), "pubmed", " 111 ", None)).unwrap();
        assert_eq!(a.hit.id, "111");
        assert_eq!(a.hit.title, "E. coli chassis & design");
        assert!(a.truncated);
        assert_eq!(a.text.chars().count(), 3000);
        assert!(a.text.starts_with("1. Nature biotechnology. 2024.\n\nAbstract: xxx"));
        let p = paths(&srv);
        assert!(p[0].starts_with("/pubmed/esummary.fcgi?"));
        assert_eq!(param(&p[0], "id").as_deref(), Some("111"));
        assert!(p[1].starts_with("/pubmed/efetch.fcgi?"), "{}", p[1]);
        for (k, v) in [("db", "pubmed"), ("id", "111"), ("rettype", "abstract"), ("retmode", "text"), ("tool", "labnoteO-Desktop")] {
            assert_eq!(param(&p[1], k).as_deref(), Some(v), "{k}");
        }
    }

    #[test]
    fn a_bad_or_unknown_pmid_is_bad_input() {
        let srv = serve(vec![Canned::ok(r#"{"result":{"uids":["999"],"999":{"uid":"999","error":"cannot get document summary"}}}"#)]);
        let rig = Rig::new(&srv, "{}");
        for bad in ["12a", "", "12345678901", "1 2"] {
            assert_eq!(block_on(scholar_get(&rig.ctx(), "pubmed", bad, None)).unwrap_err().kind, NetErrorKind::BadInput, "{bad:?}");
        }
        assert_eq!(srv.request_count(), 0, "nothing sent for a malformed id");
        assert_eq!(block_on(scholar_get(&rig.ctx(), "pubmed", "999", None)).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(srv.request_count(), 1, "no efetch for an unknown id");
    }

    #[test]
    fn disabled_unknown_and_bad_queries_send_nothing() {
        let srv = serve(vec![Canned::ok(ESEARCH)]);
        let off = Rig::new(&srv, r#"{"scholarSources":{"pubmed":false}}"#);
        assert_eq!(block_on(scholar_search(&off.ctx(), "pubmed", "x", None, false, None)).unwrap_err().kind, NetErrorKind::NotConfigured);
        assert_eq!(block_on(scholar_get(&off.ctx(), "pubmed", "111", None)).unwrap_err().kind, NetErrorKind::NotConfigured);
        let rig = Rig::new(&srv, "{}");
        let long = "q".repeat(301);
        let e = block_on(scholar_search(&rig.ctx(), "pubmed", &long, None, false, None)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::BadInput);
        assert!(!e.message.contains(&long));
        assert_eq!(block_on(scholar_search(&rig.ctx(), "scholar", "x", None, false, None)).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(block_on(scholar_get(&rig.ctx(), "PubMed", "1", None)).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(srv.request_count(), 0);
    }

    #[test]
    fn a_cancelled_request_id_sends_nothing() {
        let srv = serve(vec![Canned::ok(ESEARCH)]);
        let rig = Rig::new(&srv, "{}");
        assert!(!rig.net.cancel("r1"), "cancelled before it started");
        let e = block_on(scholar_search(&rig.ctx(), "pubmed", "crispr", None, false, Some("r1"))).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Cancelled);
        assert_eq!(srv.request_count(), 0);
    }

    #[test]
    fn a_cancel_between_the_two_requests_stops_the_second() {
        let srv = serve(vec![Canned::ok(ESEARCH), Canned::ok(&esummary())]);
        let rig = Rig::new(&srv, "{}");
        let ctx = rig.ctx();
        let run = scholar_search(&ctx, "pubmed", "crispr", None, false, Some("r2"));
        let cancel = async {
            // Wait for esearch to be answered; esummary then waits ~333 ms for its slot.
            while srv.request_count() < 1 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            rig.net.cancel("r2");
        };
        let (result, ()) = block_on(async { tokio::join!(run, cancel) });
        assert_eq!(result.unwrap_err().kind, NetErrorKind::Cancelled);
        assert_eq!(srv.request_count(), 1);
    }

    #[test]
    fn a_429_waits_for_retry_after_and_retries_once() {
        let srv = serve(vec![
            Canned::status(429).header("Retry-After", "1"),
            Canned::ok(r#"{"esearchresult":{"idlist":[]}}"#),
        ]);
        let rig = Rig::new(&srv, "{}");
        let t0 = Instant::now();
        assert!(block_on(scholar_search(&rig.ctx(), "pubmed", "crispr", None, false, None)).unwrap().is_empty());
        assert!(t0.elapsed() >= Duration::from_millis(950), "{:?}", t0.elapsed());
        assert_eq!(srv.request_count(), 2);
    }

    #[test]
    fn a_second_429_fails_without_another_retry() {
        let srv = serve(vec![
            Canned::status(429).header("Retry-After", "1").body(format!("slow down {KEY}")),
            Canned::status(429).header("Retry-After", "1").body(format!("slow down {KEY}")),
            Canned::ok(r#"{"esearchresult":{"idlist":[]}}"#),
        ]);
        let rig = Rig::new(&srv, "{}").with_key();
        let e = block_on(scholar_search(&rig.ctx(), "pubmed", "crispr", None, false, None)).unwrap_err();
        assert_eq!((e.kind, e.status), (NetErrorKind::Status, Some(429)));
        assert!(!format!("{e:?}").contains(KEY));
        assert_eq!(srv.request_count(), 2);
    }
}
