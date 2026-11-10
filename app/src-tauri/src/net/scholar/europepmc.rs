//! Europe PMC REST (spec §8.2): `search` with `resultType=lite` for compact
//! hits, and the same `search` narrowed to one record (`EXT_ID:… AND SRC:…`)
//! with `resultType=core` for its abstract. No key, no contact address.
//! Pacing: 5 requests per second, one in flight.
//!
//! An id is `SRC:ID` with the source one of `MED` (PubMed), `PMC` or `PPR`
//! (preprints); a bare id reads as `PMC` when it starts with `PMC`, `PPR`
//! when it starts with `PPR`, else `MED`.

use serde_json::Value;

use super::{authors_line, clean_block, clean_line, doi_ok, get_text, unexpected, year_of, Abstract, Ctx, Hit};
use super::{MAX_ABSTRACT, MAX_TITLE, MAX_VENUE};
use crate::net::config::Url;
use crate::net::error::{NetError, NetErrorKind};
use crate::net::http::parse_json;

/// The limiter's name for this source.
pub const SOURCE: &str = "europepmc";
/// Requests per second (spec §8.2).
pub const RATE: u32 = 5;

const JSON: &str = "application/json";
/// The record sources an id may name.
const KINDS: [&str; 3] = ["MED", "PMC", "PPR"];

fn bad_id() -> NetError {
    NetError::new(NetErrorKind::BadInput, "a Europe PMC id is like MED:12345, PMC:PMC12345 or PPR:PPR12345")
}

/// `(source, id)` of an id as typed, checked: the id is 1 to 20 ASCII
/// letters and digits; a `PMC` id starts with `PMC`, a `MED` id is digits.
pub fn parse_id(raw: &str) -> Result<(&'static str, String), NetError> {
    let raw = raw.trim();
    let (kind, id) = match raw.split_once(':') {
        Some((k, id)) => {
            let k = k.trim().to_ascii_uppercase();
            (KINDS.into_iter().find(|x| *x == k).ok_or_else(bad_id)?, id.trim())
        }
        None => {
            let upper = raw.to_ascii_uppercase();
            let kind = if upper.starts_with("PMC") {
                "PMC"
            } else if upper.starts_with("PPR") {
                "PPR"
            } else {
                "MED"
            };
            (kind, raw)
        }
    };
    let id = id.to_ascii_uppercase();
    let ok = (1..=20).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric())
        && match kind {
            "MED" => id.bytes().all(|b| b.is_ascii_digit()),
            "PMC" => id.starts_with("PMC") && id.len() > 3,
            _ => true,
        };
    if !ok {
        return Err(bad_id());
    }
    Ok((kind, id))
}

/// `<base>search?query=…&format=json&pageSize=N&resultType=…`.
fn search_url(ctx: &Ctx<'_>, query: &str, page_size: usize, result_type: &str) -> Result<Url, NetError> {
    let mut url = ctx.bases.europepmc.join("search").map_err(|_| NetError::new(NetErrorKind::InvalidUrl, "the address is not valid"))?;
    url.query_pairs_mut()
        .append_pair("query", query)
        .append_pair("format", "json")
        .append_pair("pageSize", &page_size.to_string())
        .append_pair("resultType", result_type);
    Ok(url)
}

/// The link to a record on the Europe PMC site (a link, never fetched).
pub fn record_url(kind: &str, id: &str) -> String {
    format!("https://europepmc.org/article/{kind}/{id}")
}

/// A compact hit from one result, or `None` when its source or id is not
/// one this module can look up again.
fn hit_of(r: &Value) -> Option<Hit> {
    let text = |key: &str| r.get(key).and_then(Value::as_str).unwrap_or("").trim();
    let kind = KINDS.into_iter().find(|k| *k == text("source"))?;
    let (_, id) = parse_id(&format!("{kind}:{}", text("id"))).ok()?;
    let pmid = Some(text("pmid")).filter(|p| !p.is_empty() && p.len() <= 10 && p.bytes().all(|b| b.is_ascii_digit())).map(str::to_string);
    let doi = Some(text("doi")).filter(|d| doi_ok(d)).map(str::to_string);
    let authors = text("authorString").trim_end_matches('.');
    let venue = match text("journalTitle") {
        "" => r.get("bookOrReportDetails").and_then(|b| b.get("publisher")).and_then(Value::as_str).unwrap_or(""),
        j => j,
    };
    let year = year_of(text("pubYear")).or_else(|| year_of(text("firstPublicationDate")));
    Some(Hit {
        source: SOURCE.to_string(),
        id: format!("{kind}:{id}"),
        pmid,
        doi,
        title: clean_line(text("title"), MAX_TITLE),
        authors: authors_line(authors.split(',')),
        venue: clean_line(venue, MAX_VENUE),
        year,
        url: record_url(kind, &id),
    })
}

/// The results of a `search` answer.
fn results(text: &str) -> Result<Vec<Value>, NetError> {
    let json = parse_json(text)?;
    json.get("resultList").and_then(|l| l.get("result")).and_then(Value::as_array).cloned().ok_or_else(unexpected)
}

/// Up to `limit` hits for the query (already checked by `check_query`);
/// `preprints_only` keeps preprints (`(query) AND SRC:PPR`).
pub async fn search(ctx: &Ctx<'_>, query: &str, limit: usize, preprints_only: bool, request_id: Option<&str>) -> Result<Vec<Hit>, NetError> {
    let query = if preprints_only { format!("({query}) AND SRC:PPR") } else { query.to_string() };
    let url = search_url(ctx, &query, limit, "lite")?;
    let text = get_text(ctx, SOURCE, RATE, request_id, url, JSON, None).await?;
    Ok(results(&text)?.iter().filter_map(hit_of).take(limit).collect())
}

/// Block-level tags turned into line breaks before the markup is removed,
/// so paragraphs do not run together.
fn breaks(html: &str) -> String {
    let mut s = html.to_string();
    for tag in ["</p>", "</P>", "</h4>", "</h3>", "</div>", "<br>", "<br/>", "<br />"] {
        s = s.replace(tag, &format!("{tag}\n"));
    }
    s
}

/// One record with its abstract (markup removed, capped at 3,000 chars).
/// An unknown id is `badInput`; a record without an abstract has empty text.
pub async fn get(ctx: &Ctx<'_>, raw_id: &str, request_id: Option<&str>) -> Result<Abstract, NetError> {
    let (kind, id) = parse_id(raw_id)?;
    let url = search_url(ctx, &format!("EXT_ID:{id} AND SRC:{kind}"), 1, "core")?;
    let text = get_text(ctx, SOURCE, RATE, request_id, url, JSON, None).await?;
    let list = results(&text)?;
    let record = list.first().ok_or_else(|| NetError::new(NetErrorKind::BadInput, "Europe PMC has no record with this id"))?;
    let hit = hit_of(record).ok_or_else(unexpected)?;
    let raw = record.get("abstractText").and_then(Value::as_str).unwrap_or("");
    let (text, truncated) = clean_block(&breaks(raw), MAX_ABSTRACT, true);
    Ok(Abstract { hit, text, truncated })
}

#[cfg(test)]
mod tests {
    use super::super::rig::{param, paths, route, Rig};
    use super::super::{get as scholar_get, search as scholar_search};
    use super::*;
    use crate::net::testserver::{serve, Canned};
    use tauri::async_runtime::block_on;

    fn lite() -> String {
        serde_json::json!({"hitCount": 3, "resultList": {"result": [
            {"id": "111", "source": "MED", "pmid": "111", "pmcid": "PMC9", "doi": "10.1038/nbt.1",
             "title": "<i>E. coli</i> chassis &amp; design.", "authorString": "Smith J, Lee K, Park Y, Kim H.",
             "journalTitle": "Nat Biotechnol", "pubYear": "2024"},
            {"id": "PPR555", "source": "PPR", "doi": "10.1101/2024.01.02.123456", "title": "A preprint",
             "authorString": "Solo A.", "bookOrReportDetails": {"publisher": "bioRxiv"}, "firstPublicationDate": "2024-01-03"},
            {"id": "X1", "source": "PAT", "title": "a patent, not a record we can look up again"}
        ]}})
        .to_string()
    }

    #[test]
    fn search_is_lite_json_with_a_page_size() {
        let srv = serve(vec![Canned::ok(&lite())]);
        let rig = Rig::new(&srv, "{}");
        let hits = block_on(scholar_search(&rig.ctx(), "europepmc", " E. coli chassis ", Some(7), false, None)).unwrap();
        assert_eq!(
            hits[0],
            Hit {
                source: "europepmc".into(),
                id: "MED:111".into(),
                pmid: Some("111".into()),
                doi: Some("10.1038/nbt.1".into()),
                title: "E. coli chassis & design.".into(),
                authors: "Smith J, Lee K, Park Y, et al.".into(),
                venue: "Nat Biotechnol".into(),
                year: Some(2024),
                url: "https://europepmc.org/article/MED/111".into(),
            }
        );
        let pre = &hits[1];
        assert_eq!((pre.id.as_str(), pre.pmid.as_deref(), pre.venue.as_str(), pre.year), ("PPR:PPR555", None, "bioRxiv", Some(2024)));
        assert_eq!(pre.authors, "Solo A");
        assert_eq!(hits.len(), 2, "a record of another source is left out");
        let p = paths(&srv);
        assert_eq!(route(&p[0]), "/europepmc/search");
        for (k, v) in [("query", "E. coli chassis"), ("format", "json"), ("pageSize", "7"), ("resultType", "lite")] {
            assert_eq!(param(&p[0], k).as_deref(), Some(v), "{k}");
        }
    }

    #[test]
    fn preprints_only_adds_src_ppr_and_the_limit_is_capped() {
        let srv = serve(vec![Canned::ok(r#"{"resultList":{"result":[]}}"#)]);
        let rig = Rig::new(&srv, "{}");
        assert!(block_on(scholar_search(&rig.ctx(), "europepmc", "crispr OR cas9", Some(99), true, None)).unwrap().is_empty());
        let p = paths(&srv);
        assert_eq!(param(&p[0], "query").as_deref(), Some("(crispr OR cas9) AND SRC:PPR"));
        assert_eq!(param(&p[0], "pageSize").as_deref(), Some("10"));
    }

    #[test]
    fn get_is_core_with_the_abstract_stripped_and_capped() {
        let abs = format!("<h4>Background</h4><p>We built <i>E. coli</i> &lt;strains&gt;.</p><p>{}</p>", "x".repeat(5000));
        let body = serde_json::json!({"resultList": {"result": [
            {"id": "111", "source": "MED", "pmid": "111", "title": "<b>T</b>", "authorString": "Smith J.", "journalTitle": "J", "pubYear": "2020",
             "abstractText": abs}
        ]}})
        .to_string();
        let srv = serve(vec![Canned::ok(&body)]);
        let rig = Rig::new(&srv, "{}");
        let a = block_on(scholar_get(&rig.ctx(), "europepmc", " med:111 ", None)).unwrap();
        assert_eq!((a.hit.id.as_str(), a.hit.title.as_str()), ("MED:111", "T"));
        assert!(a.text.starts_with("Background\nWe built E. coli <strains>.\nxxx"), "{}", a.text.chars().take(60).collect::<String>());
        assert!(a.truncated);
        assert_eq!(a.text.chars().count(), 3000);
        let p = paths(&srv);
        assert_eq!(route(&p[0]), "/europepmc/search");
        for (k, v) in [("query", "EXT_ID:111 AND SRC:MED"), ("format", "json"), ("pageSize", "1"), ("resultType", "core")] {
            assert_eq!(param(&p[0], k).as_deref(), Some(v), "{k}");
        }
    }

    #[test]
    fn ids_are_checked_before_anything_is_sent() {
        assert_eq!(parse_id("123").unwrap(), ("MED", "123".to_string()));
        assert_eq!(parse_id("pmc77").unwrap(), ("PMC", "PMC77".to_string()));
        assert_eq!(parse_id("PPR:ppr9").unwrap(), ("PPR", "PPR9".to_string()));
        assert_eq!(parse_id("PMC:PMC1").unwrap(), ("PMC", "PMC1".to_string()));
        let srv = serve(vec![Canned::ok(r#"{"resultList":{"result":[]}}"#)]);
        let rig = Rig::new(&srv, "{}");
        let long = "9".repeat(21);
        for bad in ["", "MED:", "MED:12a", "PAT:1", "PMC:123", "MED:1 OR 2", "MED:1) OR (x", "x:y:z", long.as_str()] {
            assert_eq!(block_on(scholar_get(&rig.ctx(), "europepmc", bad, None)).unwrap_err().kind, NetErrorKind::BadInput, "{bad:?}");
        }
        assert_eq!(srv.request_count(), 0);
        assert_eq!(block_on(scholar_get(&rig.ctx(), "europepmc", "MED:999", None)).unwrap_err().kind, NetErrorKind::BadInput, "no record");
        assert_eq!(srv.request_count(), 1);
    }

    #[test]
    fn a_turned_off_source_sends_nothing() {
        let srv = serve(vec![Canned::ok(&lite())]);
        let rig = Rig::new(&srv, r#"{"scholarSources":{"europepmc":false}}"#);
        assert_eq!(block_on(scholar_search(&rig.ctx(), "europepmc", "x", None, false, None)).unwrap_err().kind, NetErrorKind::NotConfigured);
        assert_eq!(block_on(scholar_get(&rig.ctx(), "europepmc", "MED:1", None)).unwrap_err().kind, NetErrorKind::NotConfigured);
        assert_eq!(srv.request_count(), 0);
    }
}
