//! Crossref REST (spec §8.2): `works?query=…&rows=N&select=…` for compact
//! hits, `works/{doi}` for one record and the abstract when the publisher
//! deposited one (JATS markup, removed). No key; `mailto=` (Crossref's
//! "polite" pool) only when the user typed a contact address
//! (`crossrefMailto`). Pacing: 5 requests per second, one in flight.

use serde_json::Value;

use super::{authors_line, clean_block, clean_line, doi_ok, get_text, unexpected, year_of, Abstract, Ctx, Hit};
use super::{MAX_ABSTRACT, MAX_TITLE, MAX_VENUE};
use crate::net::config::Url;
use crate::net::error::{NetError, NetErrorKind};
use crate::net::http::parse_json;

/// The limiter's name for this source.
pub const SOURCE: &str = "crossref";
/// Requests per second (spec §8.2).
pub const RATE: u32 = 5;
/// The fields a search asks for (spec §8.2).
pub const SELECT: &str = "DOI,title,author,container-title,issued,type,URL";

const JSON: &str = "application/json";

fn invalid_url() -> NetError {
    NetError::new(NetErrorKind::InvalidUrl, "the address is not valid")
}

/// `mailto=` when the user typed a contact address.
fn polite(ctx: &Ctx<'_>, url: &mut Url) {
    if let Some(mail) = &ctx.cfg.crossref_mailto {
        url.query_pairs_mut().append_pair("mailto", mail);
    }
}

/// A DOI as typed, checked (`10.` prefix, no blanks, at most 200 chars); a
/// leading `https://doi.org/` or `doi:` is dropped.
pub fn parse_doi(raw: &str) -> Result<String, NetError> {
    let raw = raw.trim();
    let lower = raw.to_ascii_lowercase();
    let doi = ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "doi:"]
        .into_iter()
        .find(|p| lower.starts_with(p))
        .map_or(raw, |p| &raw[p.len()..]);
    if !doi_ok(doi) {
        return Err(NetError::new(NetErrorKind::BadInput, "a DOI starts with 10. and has no spaces"));
    }
    Ok(doi.to_string())
}

/// The link to a DOI (a link, never fetched).
pub fn doi_url(doi: &str) -> String {
    format!("https://doi.org/{doi}")
}

/// The first string of a Crossref list field (`title`, `container-title`).
fn first<'a>(item: &'a Value, key: &str) -> &'a str {
    item.get(key).and_then(Value::as_array).and_then(|a| a.iter().find_map(Value::as_str)).unwrap_or("")
}

/// `"Family G"` (initials of the given names), or an organisation's `name`.
fn author_name(a: &Value) -> String {
    let text = |key: &str| a.get(key).and_then(Value::as_str).unwrap_or("").trim();
    let family = text("family");
    if family.is_empty() {
        return text("name").to_string();
    }
    let initials: String = text("given").split([' ', '-', '.']).filter_map(|w| w.chars().next()).filter(|c| c.is_alphabetic()).collect();
    if initials.is_empty() {
        family.to_string()
    } else {
        format!("{family} {initials}")
    }
}

/// The first year of `issued.date-parts`.
fn year(item: &Value) -> Option<u16> {
    let n = item.get("issued")?.get("date-parts")?.get(0)?.get(0)?;
    let y = n.as_u64().map(|y| y.to_string()).or_else(|| n.as_str().map(str::to_string))?;
    year_of(&y)
}

/// A compact hit from one work, or `None` without a usable DOI.
fn hit_of(item: &Value) -> Option<Hit> {
    let doi = item.get("DOI").and_then(Value::as_str).map(str::trim).filter(|d| doi_ok(d))?.to_string();
    let authors = item.get("author").and_then(Value::as_array).map(|a| a.iter().map(author_name).collect::<Vec<_>>()).unwrap_or_default();
    Some(Hit {
        source: SOURCE.to_string(),
        id: doi.clone(),
        pmid: None,
        url: doi_url(&doi),
        doi: Some(doi),
        title: clean_line(first(item, "title"), MAX_TITLE),
        authors: authors_line(authors),
        venue: clean_line(first(item, "container-title"), MAX_VENUE),
        year: year(item),
    })
}

/// Up to `limit` hits for the query (already checked by `check_query`).
pub async fn search(ctx: &Ctx<'_>, query: &str, limit: usize, request_id: Option<&str>) -> Result<Vec<Hit>, NetError> {
    let mut url = ctx.bases.crossref.join("works").map_err(|_| invalid_url())?;
    url.query_pairs_mut().append_pair("query", query).append_pair("rows", &limit.to_string()).append_pair("select", SELECT);
    polite(ctx, &mut url);
    let text = get_text(ctx, SOURCE, RATE, request_id, url, JSON, None).await?;
    let json = parse_json(&text)?;
    let items = json.get("message").and_then(|m| m.get("items")).and_then(Value::as_array).ok_or_else(unexpected)?;
    Ok(items.iter().filter_map(hit_of).take(limit).collect())
}

/// One work by DOI: its hit and its abstract (JATS removed, capped at 3,000
/// chars; empty when Crossref has none). The DOI is one path segment, so its
/// `/` and anything else unsafe is percent-encoded. A 404 is `badInput`.
pub async fn get(ctx: &Ctx<'_>, raw: &str, request_id: Option<&str>) -> Result<Abstract, NetError> {
    let doi = parse_doi(raw)?;
    let mut url = ctx.bases.crossref.clone();
    url.path_segments_mut().map_err(|_| invalid_url())?.pop_if_empty().push("works").push(&doi);
    polite(ctx, &mut url);
    let text = match get_text(ctx, SOURCE, RATE, request_id, url, JSON, None).await {
        Err(e) if e.status == Some(404) => return Err(NetError::new(NetErrorKind::BadInput, "Crossref has no work with this DOI")),
        other => other?,
    };
    let json = parse_json(&text)?;
    let item = json.get("message").ok_or_else(unexpected)?;
    let hit = hit_of(item).ok_or_else(unexpected)?;
    let raw = item.get("abstract").and_then(Value::as_str).unwrap_or("");
    let (text, truncated) = clean_block(&raw.replace("</jats:p>", "</jats:p>\n").replace("</jats:title>", "</jats:title>\n"), MAX_ABSTRACT, true);
    Ok(Abstract { hit, text, truncated })
}

#[cfg(test)]
mod tests {
    use super::super::rig::{param, paths, route, Rig};
    use super::super::{get as scholar_get, search as scholar_search};
    use super::*;
    use crate::net::testserver::{serve, Canned};
    use std::time::Duration;
    use tauri::async_runtime::block_on;

    fn works() -> String {
        serde_json::json!({"status": "ok", "message": {"items": [
            {"DOI": "10.1038/nbt.1", "title": ["<i>E. coli</i> chassis &amp; design"], "container-title": ["Nature Biotechnology"],
             "author": [{"given": "John", "family": "Smith"}, {"given": "Kyung-Hee", "family": "Lee"}, {"name": "iGEM Consortium"}, {"given": "Y.", "family": "Park"}],
             "issued": {"date-parts": [[2024, 3, 5]]}, "type": "journal-article", "URL": "http://dx.doi.org/10.1038/nbt.1"},
            {"DOI": "not a doi", "title": ["dropped"]},
            {"DOI": "10.5555/x", "title": [], "issued": {"date-parts": [[null]]}}
        ]}})
        .to_string()
    }

    #[test]
    fn search_asks_for_rows_and_the_selected_fields() {
        let srv = serve(vec![Canned::ok(&works())]);
        let rig = Rig::new(&srv, "{}");
        let hits = block_on(scholar_search(&rig.ctx(), "crossref", " E. coli chassis ", Some(3), false, None)).unwrap();
        assert_eq!(
            hits[0],
            Hit {
                source: "crossref".into(),
                id: "10.1038/nbt.1".into(),
                pmid: None,
                doi: Some("10.1038/nbt.1".into()),
                title: "E. coli chassis & design".into(),
                authors: "Smith J, Lee KH, iGEM Consortium, et al.".into(),
                venue: "Nature Biotechnology".into(),
                year: Some(2024),
                url: "https://doi.org/10.1038/nbt.1".into(),
            }
        );
        assert_eq!(hits.len(), 2, "a work without a valid DOI is left out");
        assert_eq!((hits[1].title.as_str(), hits[1].year, hits[1].authors.as_str()), ("", None, ""));
        let p = paths(&srv);
        assert_eq!(route(&p[0]), "/crossref/works");
        for (k, v) in [("query", "E. coli chassis"), ("rows", "3"), ("select", SELECT)] {
            assert_eq!(param(&p[0], k).as_deref(), Some(v), "{k}");
        }
        assert_eq!(param(&p[0], "mailto"), None, "no mailto when the user typed none");
    }

    #[test]
    fn mailto_is_sent_only_when_set_and_rows_are_capped() {
        let srv = serve(vec![Canned::ok(r#"{"message":{"items":[]}}"#), Canned::ok(r#"{"message":{"total":1}}"#)]);
        let rig = Rig::new(&srv, r#"{"crossrefMailto":"lab@example.org"}"#);
        assert!(block_on(scholar_search(&rig.ctx(), "crossref", "crispr", Some(50), false, None)).unwrap().is_empty());
        let p = paths(&srv);
        assert_eq!(param(&p[0], "mailto").as_deref(), Some("lab@example.org"));
        assert_eq!(param(&p[0], "rows").as_deref(), Some("10"));
        assert_eq!(block_on(scholar_search(&rig.ctx(), "crossref", "crispr", None, false, None)).unwrap_err().kind, NetErrorKind::NotJson);
    }

    #[test]
    fn a_work_by_doi_has_an_encoded_path_and_its_abstract() {
        let body = serde_json::json!({"status": "ok", "message": {
            "DOI": "10.1000/a(b)?c#d", "title": ["T"], "author": [{"given": "A", "family": "B"}], "container-title": [],
            "issued": {"date-parts": [["2019"]]},
            "abstract": "<jats:title>Abstract</jats:title><jats:p>We built <jats:italic>E. coli</jats:italic> strains.</jats:p>"
        }})
        .to_string();
        let srv = serve(vec![Canned::ok(&body)]);
        let rig = Rig::new(&srv, r#"{"crossrefMailto":"lab@example.org"}"#);
        let a = block_on(scholar_get(&rig.ctx(), "crossref", " https://doi.org/10.1000/a(b)?c#d ", None)).unwrap();
        assert_eq!(a.text, "Abstract\nWe built E. coli strains.");
        assert!(!a.truncated);
        assert_eq!((a.hit.id.as_str(), a.hit.year, a.hit.authors.as_str()), ("10.1000/a(b)?c#d", Some(2019), "B A"));
        let p = paths(&srv);
        assert_eq!(route(&p[0]), "/crossref/works/10.1000%2Fa(b)%3Fc%23d", "the DOI is one encoded path segment");
        assert_eq!(param(&p[0], "mailto").as_deref(), Some("lab@example.org"));
    }

    #[test]
    fn a_missing_abstract_is_empty_text_and_a_404_is_bad_input() {
        let srv = serve(vec![Canned::ok(r#"{"message":{"DOI":"10.1/x","title":["T"]}}"#), Canned::status(404).body("Resource not found.")]);
        let rig = Rig::new(&srv, "{}");
        let a = block_on(scholar_get(&rig.ctx(), "crossref", "doi:10.1/x", None)).unwrap();
        assert_eq!((a.text.as_str(), a.truncated), ("", false));
        assert_eq!(block_on(scholar_get(&rig.ctx(), "crossref", "10.1/missing", None)).unwrap_err().kind, NetErrorKind::BadInput);
    }

    #[test]
    fn a_bad_doi_sends_nothing() {
        let srv = serve(vec![Canned::ok("{}")]);
        let rig = Rig::new(&srv, "{}");
        for bad in ["", "11.1/x", "10.", "10.1/a b", "10.1/a\tb", "https://example.org/10.1/x"] {
            assert_eq!(block_on(scholar_get(&rig.ctx(), "crossref", bad, None)).unwrap_err().kind, NetErrorKind::BadInput, "{bad:?}");
        }
        assert_eq!(srv.request_count(), 0);
    }

    #[test]
    fn one_request_in_flight() {
        let srv = serve(vec![Canned::ok(r#"{"message":{"items":[]}}"#)]);
        let rig = Rig::new(&srv, "{}");
        block_on(async {
            let held = rig.limiter.acquire(SOURCE, RATE).await;
            let waited = tokio::time::timeout(Duration::from_millis(400), scholar_search(&rig.ctx(), "crossref", "x", None, false, None)).await;
            assert!(waited.is_err(), "the search waited for the request in flight");
            assert_eq!(srv.request_count(), 0);
            drop(held);
            assert!(scholar_search(&rig.ctx(), "crossref", "x", None, false, None).await.unwrap().is_empty());
        });
        assert_eq!(srv.request_count(), 1);
    }
}
