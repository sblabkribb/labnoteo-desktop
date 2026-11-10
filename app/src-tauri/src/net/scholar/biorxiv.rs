//! bioRxiv API (spec §8.2): `details/biorxiv/{doi}/na/json` for one
//! preprint, `details/biorxiv/{from}/{to}/0/json?category=…` for the
//! preprints posted in a date range. The API has no keyword search (Europe
//! PMC `SRC:PPR` covers that). No key. Pacing: 1 request per second.
//!
//! - The DOI must match `^10\.1101/[0-9A-Za-z.]{1,64}$`; it goes into the
//!   path as it is (its one `/` a separator, nothing to encode).
//! - A range is `YYYY-MM-DD YYYY-MM-DD` (from ≤ to, at most 31 days),
//!   optionally followed by a category of ASCII letters (`cell biology` and
//!   `Cell_Biology` both become `cell_biology`).

use serde_json::Value;

use super::{authors_line, clean_block, clean_line, get_text, unexpected, year_of, Abstract, Ctx, Hit};
use super::{MAX_ABSTRACT, MAX_TITLE};
use crate::net::config::Url;
use crate::net::error::{NetError, NetErrorKind};
use crate::net::http::parse_json;

/// The limiter's name for this source.
pub const SOURCE: &str = "biorxiv";
/// Requests per second (spec §8.2).
pub const RATE: u32 = 1;
/// Longest date range, in days.
pub const MAX_RANGE_DAYS: i64 = 31;
/// Longest category, in chars.
const MAX_CATEGORY: usize = 40;

const JSON: &str = "application/json";

fn bad_input(message: &str) -> NetError {
    NetError::new(NetErrorKind::BadInput, message)
}

/// A bioRxiv DOI: `10.1101/` then 1 to 64 ASCII letters, digits or dots.
pub fn doi_ok(doi: &str) -> bool {
    doi.strip_prefix("10.1101/")
        .is_some_and(|rest| (1..=64).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.'))
}

/// Days since 1970-01-01 of a `YYYY-MM-DD` date that exists (years
/// 1900..=2999), else `None`.
pub fn day_number(date: &str) -> Option<i64> {
    let b = date.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let s = &date[r];
        s.bytes().all(|c| c.is_ascii_digit()).then(|| s.parse().ok()).flatten()
    };
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days_in = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1900..=2999).contains(&y) || !(1..=12).contains(&m) || d < 1 || d > days_in[(m - 1) as usize] {
        return None;
    }
    // Days from civil (Howard Hinnant's algorithm).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// A range query, checked: `(from, to, category)`.
pub fn parse_range(query: &str) -> Result<(String, String, Option<String>), NetError> {
    const SHAPE: &str = "bioRxiv takes dates as YYYY-MM-DD YYYY-MM-DD (at most 31 days), then an optional category";
    let mut words = query.split_whitespace();
    let (Some(from), Some(to)) = (words.next(), words.next()) else {
        return Err(bad_input(SHAPE));
    };
    let (Some(a), Some(b)) = (day_number(from), day_number(to)) else {
        return Err(bad_input(SHAPE));
    };
    if b < a || b - a > MAX_RANGE_DAYS {
        return Err(bad_input(SHAPE));
    }
    let rest: Vec<&str> = words.collect();
    let category = if rest.is_empty() {
        None
    } else {
        let c = rest.join("_").to_ascii_lowercase();
        if c.len() > MAX_CATEGORY || !c.bytes().all(|x| x.is_ascii_lowercase() || x == b'_') {
            return Err(bad_input("a bioRxiv category is letters only, like cell_biology"));
        }
        Some(c)
    };
    Ok((from.to_string(), to.to_string(), category))
}

fn endpoint(ctx: &Ctx<'_>, path: &str) -> Result<Url, NetError> {
    ctx.bases.biorxiv.join(path).map_err(|_| NetError::new(NetErrorKind::InvalidUrl, "the address is not valid"))
}

/// `"Smith J, Lee K, …"` from the API's `"Smith, J.; Lee, K.; …"`.
fn authors(list: &str) -> String {
    authors_line(list.split(';').map(|a| match a.split_once(',') {
        Some((family, given)) => format!("{} {}", family.trim(), given.replace(['.', ' '], "")),
        None => a.trim().to_string(),
    }))
}

/// A compact hit from one record, or `None` without a bioRxiv DOI.
fn hit_of(r: &Value) -> Option<Hit> {
    let text = |key: &str| r.get(key).and_then(Value::as_str).unwrap_or("").trim();
    let doi = Some(text("doi")).filter(|d| doi_ok(d))?.to_string();
    Some(Hit {
        source: SOURCE.to_string(),
        id: doi.clone(),
        pmid: None,
        url: format!("https://doi.org/{doi}"),
        doi: Some(doi),
        title: clean_line(text("title"), MAX_TITLE),
        authors: authors(text("authors")),
        venue: "bioRxiv".to_string(),
        year: year_of(text("date")),
    })
}

/// The `collection` of an answer.
fn collection(text: &str) -> Result<Vec<Value>, NetError> {
    let json = parse_json(text)?;
    json.get("collection").and_then(Value::as_array).cloned().ok_or_else(unexpected)
}

/// One preprint by DOI: the latest version listed, with its abstract
/// (capped at 3,000 chars). A malformed DOI sends nothing; an unknown one is
/// `badInput`.
pub async fn get(ctx: &Ctx<'_>, doi: &str, request_id: Option<&str>) -> Result<Abstract, NetError> {
    let doi = doi.strip_prefix("https://doi.org/").unwrap_or(doi);
    if !doi_ok(doi) {
        return Err(bad_input("a bioRxiv DOI is like 10.1101/2024.01.02.123456"));
    }
    let url = endpoint(ctx, &format!("details/biorxiv/{doi}/na/json"))?;
    let text = get_text(ctx, SOURCE, RATE, request_id, url, JSON, None).await?;
    let list = collection(&text)?;
    let record = list.iter().rev().find(|r| hit_of(r).is_some()).ok_or_else(|| bad_input("bioRxiv has no preprint with this DOI"))?;
    let hit = hit_of(record).ok_or_else(unexpected)?;
    let (text, truncated) = clean_block(record.get("abstract").and_then(Value::as_str).unwrap_or(""), MAX_ABSTRACT, true);
    Ok(Abstract { hit, text, truncated })
}

/// The preprints posted in a date range (first page, at most `limit`).
pub async fn recent(ctx: &Ctx<'_>, query: &str, limit: usize, request_id: Option<&str>) -> Result<Vec<Hit>, NetError> {
    let (from, to, category) = parse_range(query)?;
    let mut url = endpoint(ctx, &format!("details/biorxiv/{from}/{to}/0/json"))?;
    if let Some(c) = category {
        url.query_pairs_mut().append_pair("category", &c);
    }
    let text = get_text(ctx, SOURCE, RATE, request_id, url, JSON, None).await?;
    Ok(collection(&text)?.iter().filter_map(hit_of).take(limit).collect())
}

#[cfg(test)]
mod tests {
    use super::super::rig::{param, paths, route, Rig};
    use super::super::{get as scholar_get, search as scholar_search};
    use super::*;
    use crate::net::testserver::{serve, Canned};
    use std::time::{Duration, Instant};
    use tauri::async_runtime::block_on;

    const DOI: &str = "10.1101/2024.01.02.123456";

    fn details() -> String {
        serde_json::json!({"messages": [{"status": "ok"}], "collection": [
            {"doi": DOI, "title": "Old <i>title</i>", "authors": "Smith, J.; Lee, K. H.", "date": "2024-01-02", "version": "1", "abstract": "v1"},
            {"doi": DOI, "title": "A <i>Bacillus</i> chassis", "authors": "Smith, J.; Lee, K. H.; Park, Y.; Kim, H.", "date": "2024-02-03",
             "version": "2", "category": "synthetic biology", "abstract": format!("We built strains.\n\n{}", "y".repeat(4000))}
        ]})
        .to_string()
    }

    #[test]
    fn details_by_doi_takes_the_latest_version() {
        let srv = serve(vec![Canned::ok(&details())]);
        let rig = Rig::new(&srv, "{}");
        let a = block_on(scholar_get(&rig.ctx(), "biorxiv", DOI, None)).unwrap();
        assert_eq!(
            a.hit,
            Hit {
                source: "biorxiv".into(),
                id: DOI.into(),
                pmid: None,
                doi: Some(DOI.into()),
                title: "A Bacillus chassis".into(),
                authors: "Smith J, Lee KH, Park Y, et al.".into(),
                venue: "bioRxiv".into(),
                year: Some(2024),
                url: format!("https://doi.org/{DOI}"),
            }
        );
        assert!(a.text.starts_with("We built strains.\n\nyyy"));
        assert!(a.truncated);
        assert_eq!(a.text.chars().count(), 3000);
        assert_eq!(paths(&srv), vec![format!("/biorxiv/details/biorxiv/{DOI}/na/json")], "the DOI goes in as it is");
    }

    #[test]
    fn a_bad_doi_sends_nothing_and_an_unknown_one_is_bad_input() {
        let srv = serve(vec![Canned::ok(r#"{"messages":[{"status":"no posts found"}],"collection":[]}"#)]);
        let rig = Rig::new(&srv, "{}");
        let long = format!("10.1101/{}", "1".repeat(65));
        for bad in ["", "10.1038/nbt.1", "10.1101/", "10.1101/2024/01", "10.1101/a b", "10.1101/x?y=1", "10.1101/..%2F", long.as_str()] {
            assert_eq!(block_on(scholar_get(&rig.ctx(), "biorxiv", bad, None)).unwrap_err().kind, NetErrorKind::BadInput, "{bad:?}");
        }
        assert_eq!(srv.request_count(), 0);
        assert_eq!(block_on(scholar_get(&rig.ctx(), "biorxiv", "10.1101/000", None)).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(srv.request_count(), 1);
    }

    #[test]
    fn recent_lists_a_date_range_with_a_category() {
        let page = serde_json::json!({"messages": [{"status": "ok", "count": 30}], "collection": (0..30).map(|i| serde_json::json!({
            "doi": format!("10.1101/2024.03.{i:02}.1"), "title": format!("P{i}"), "authors": "Solo, A.", "date": "2024-03-01"
        })).collect::<Vec<_>>()})
        .to_string();
        let srv = serve(vec![Canned::ok(&page), Canned::ok(r#"{"collection":[]}"#)]);
        let rig = Rig::new(&srv, "{}");
        let hits = block_on(scholar_search(&rig.ctx(), "biorxiv", " 2024-03-01  2024-03-31 Cell Biology ", Some(4), false, None)).unwrap();
        assert_eq!(hits.iter().map(|h| h.title.as_str()).collect::<Vec<_>>(), ["P0", "P1", "P2", "P3"]);
        assert_eq!(hits[0].authors, "Solo A");
        assert!(block_on(scholar_search(&rig.ctx(), "biorxiv", "2024-02-28 2024-03-01", None, false, None)).unwrap().is_empty());
        let p = paths(&srv);
        assert_eq!(route(&p[0]), "/biorxiv/details/biorxiv/2024-03-01/2024-03-31/0/json");
        assert_eq!(param(&p[0], "category").as_deref(), Some("cell_biology"));
        assert_eq!(p[1], "/biorxiv/details/biorxiv/2024-02-28/2024-03-01/0/json", "no category, no query");
    }

    #[test]
    fn ranges_are_checked_before_anything_is_sent() {
        let srv = serve(vec![Canned::ok("{}")]);
        let rig = Rig::new(&srv, "{}");
        for bad in [
            "2024-03-01",
            "2024-03-01 2024-04-02",
            "2024-03-02 2024-03-01",
            "2024-02-30 2024-03-01",
            "2023-02-29 2023-03-01",
            "2024-3-1 2024-03-05",
            "24-03-01 24-03-05",
            "2024-03-01 2024-03-05 cell-biology",
            "2024-03-01 2024-03-05 biology&x=1",
            "2024-03-01 2024-03-05 생물",
            "crispr base editing",
        ] {
            assert_eq!(block_on(scholar_search(&rig.ctx(), "biorxiv", bad, None, false, None)).unwrap_err().kind, NetErrorKind::BadInput, "{bad:?}");
        }
        assert_eq!(srv.request_count(), 0);
        assert!(parse_range("2024-02-29 2024-03-31").is_ok(), "31 days in a leap year");
        assert!(parse_range("2023-12-15 2024-01-15").is_ok(), "across a year");
        assert!(parse_range("2024-03-01 2024-04-01").is_ok(), "exactly 31 days");
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2000-03-01").unwrap() - day_number("2000-02-28").unwrap(), 2);
    }

    #[test]
    fn one_request_per_second() {
        let srv = serve(vec![Canned::ok(&details()), Canned::ok(&details())]);
        let rig = Rig::new(&srv, "{}");
        let t0 = Instant::now();
        block_on(scholar_get(&rig.ctx(), "biorxiv", DOI, None)).unwrap();
        block_on(scholar_get(&rig.ctx(), "biorxiv", DOI, None)).unwrap();
        assert!(t0.elapsed() >= Duration::from_millis(950), "{:?}", t0.elapsed());
    }
}
