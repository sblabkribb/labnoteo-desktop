//! Searching the index.
//!
//! The trigram tokenizer cannot match a term shorter than three characters, and
//! two-character words are everywhere in Korean (`형질`). So each whitespace
//! separated term is routed by length: three or more characters go to FTS5 as a
//! quoted phrase, shorter ones are a case-insensitive substring test (`LIKE`)
//! on the title and body (not the path: a two-character query such as `md` or
//! `01` would match nearly every note by its path, which is noise; longer
//! terms still match the path through FTS). All terms must match (AND).

use rusqlite::{params_from_iter, Connection};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

/// One page of results. `truncated` means more notes matched than `hits` holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
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

/// Which query plan a search uses. Decided in one place (`plan_for`) and read
/// by `search`, so a test can assert the plan it meant to exercise instead of
/// inferring it from the outcome (two plans that return the same notes made
/// tests pass on the wrong branch more than once).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// No terms: nothing is searched.
    Empty,
    /// Every term is shorter than three characters: substring tests only.
    Like,
    /// Every term is three or more characters: FTS5 only.
    Fts,
    /// Both: FTS5 for the long terms, a substring test on top for the short ones.
    FtsThenLike,
}

fn is_long(term: &str) -> bool {
    term.chars().count() >= 3
}

pub fn plan_for(query: &str) -> Plan {
    let all = query.split_whitespace().count();
    let long = query.split_whitespace().filter(|t| is_long(t)).count();
    match (long, all - long) {
        (0, 0) => Plan::Empty,
        (0, _) => Plan::Like,
        (_, 0) => Plan::Fts,
        _ => Plan::FtsThenLike,
    }
}

pub fn search(conn: &Connection, query: &str, limit: usize) -> rusqlite::Result<SearchResults> {
    let terms: Vec<String> = query.split_whitespace().map(str::to_owned).collect();
    let plan = plan_for(query);
    if plan == Plan::Empty {
        return Ok(SearchResults { hits: Vec::new(), truncated: false });
    }
    let limit = limit.clamp(1, MAX_LIMIT);
    let (long, short): (Vec<&String>, Vec<&String>) = terms.iter().partition(|t| is_long(t));

    let mut sql = String::from("SELECT n.path, n.title, n.body FROM ");
    let mut args: Vec<String> = Vec::new();
    let mut wheres: Vec<String> = Vec::new();
    if plan == Plan::Like {
        sql.push_str("notes n");
    } else {
        sql.push_str("notes_fts JOIN notes n ON n.id = notes_fts.rowid");
        wheres.push("notes_fts MATCH ?".into());
        args.push(long.iter().map(|t| fts_phrase(t)).collect::<Vec<_>>().join(" AND "));
    }
    for t in &short {
        wheres.push("(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\')".into());
        let p = like_pattern(t);
        args.extend([p.clone(), p]);
    }
    sql.push_str(" WHERE ");
    sql.push_str(&wheres.join(" AND "));
    if plan == Plan::Like {
        // No bm25 here, so rank by hand: a note whose title holds the term comes
        // before one that only has it in the body, then the earlier the first
        // body match the better, then title and path for a stable order.
        let mut title_miss = Vec::new();
        let mut offset = Vec::new();
        for _ in &short {
            title_miss.push("(instr(lower(n.title), lower(?)) = 0)");
            offset.push("(CASE WHEN instr(lower(n.body), lower(?)) = 0 THEN 1000000000 ELSE instr(lower(n.body), lower(?)) END)");
        }
        // Placeholders appear in SQL order: all title terms, then all offset terms.
        args.extend(short.iter().map(|t| (*t).clone()));
        for t in &short {
            args.extend([(*t).clone(), (*t).clone()]);
        }
        sql.push_str(&format!(
            " ORDER BY ({}), ({}), n.title, n.path",
            title_miss.join(" + "),
            offset.join(" + ")
        ));
    } else {
        sql.push_str(" ORDER BY rank");
    }
    // One more than asked for tells whether the list was cut.
    sql.push_str(&format!(" LIMIT {}", limit + 1));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })?;
    let mut hits = rows
        .map(|row| {
            let (path, title, body) = row?;
            Ok(SearchHit { snippet: snippet(&body, &terms), path, title })
        })
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let truncated = hits.len() > limit;
    hits.truncate(limit);
    Ok(SearchResults { hits, truncated })
}
