//! Searching the index.
//!
//! The trigram tokenizer cannot match a term shorter than three characters, and
//! two-character words are everywhere in Korean (`형질`). So each whitespace
//! separated term is routed by length: three or more characters go to FTS5 as a
//! quoted phrase, shorter ones are a case-insensitive substring test (`LIKE`)
//! on the same row. All terms must match (AND).

use rusqlite::{params_from_iter, Connection};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

pub const MAX_LIMIT: usize = 200;

fn like_pattern(term: &str) -> String {
    let mut out = String::from("%");
    for c in term.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

fn fts_phrase(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

fn lower(text: &str) -> Vec<char> {
    text.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
}

/// A short excerpt of `body` around the first place a term occurs, whitespace
/// collapsed. When only the title or path matched, the start of the body.
pub fn snippet(body: &str, terms: &[String]) -> String {
    const BEFORE: usize = 30;
    const AFTER: usize = 70;
    let chars: Vec<char> = body.chars().collect();
    let hay = lower(body);
    let at = terms
        .iter()
        .filter_map(|t| {
            let needle = lower(t);
            if needle.is_empty() || needle.len() > hay.len() {
                return None;
            }
            hay.windows(needle.len()).position(|w| w == needle.as_slice()).map(|p| (p, needle.len()))
        })
        .min_by_key(|(p, _)| *p);
    let (start, end) = match at {
        Some((p, len)) => (p.saturating_sub(BEFORE), (p + len + AFTER).min(chars.len())),
        None => (0, (BEFORE + AFTER).min(chars.len())),
    };
    let text: String = chars[start..end].iter().collect();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}{text}{}", if start > 0 { "…" } else { "" }, if end < chars.len() { "…" } else { "" })
}

pub fn search(conn: &Connection, query: &str, limit: usize) -> rusqlite::Result<Vec<SearchHit>> {
    let terms: Vec<String> = query.split_whitespace().map(str::to_owned).collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, MAX_LIMIT);
    let (long, short): (Vec<&String>, Vec<&String>) = terms.iter().partition(|t| t.chars().count() >= 3);

    let mut sql = String::from("SELECT n.path, n.title, n.body FROM ");
    let mut args: Vec<String> = Vec::new();
    let mut wheres: Vec<String> = Vec::new();
    if long.is_empty() {
        sql.push_str("notes n");
    } else {
        sql.push_str("notes_fts JOIN notes n ON n.id = notes_fts.rowid");
        wheres.push("notes_fts MATCH ?".into());
        args.push(long.iter().map(|t| fts_phrase(t)).collect::<Vec<_>>().join(" AND "));
    }
    for t in &short {
        wheres.push("(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR n.path LIKE ? ESCAPE '\\')".into());
        let p = like_pattern(t);
        args.extend([p.clone(), p.clone(), p]);
    }
    sql.push_str(" WHERE ");
    sql.push_str(&wheres.join(" AND "));
    sql.push_str(if long.is_empty() { " ORDER BY n.title, n.path" } else { " ORDER BY rank" });
    sql.push_str(&format!(" LIMIT {limit}"));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })?;
    rows.map(|row| {
        let (path, title, body) = row?;
        Ok(SearchHit { snippet: snippet(&body, &terms), path, title })
    })
    .collect()
}
