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
    run(conn, query, None, limit)
}

/// Why a folder prefix was refused by `scope_like`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadPrefix(pub String);

/// The `LIKE` pattern (escape `\`) that matches the keys of notes inside the
/// vault-relative folder `prefix`: the folded folder, LIKE-escaped, then `/%`.
/// The trailing `/` keeps `labnote/001_A` from matching `labnote/001_AB`.
/// Refused: an empty folder, a leading `/`, a backslash, a drive (`C:`), and
/// empty, `.` or `..` segments. One trailing `/` is allowed and dropped.
pub fn scope_like(prefix: &str) -> Result<String, BadPrefix> {
    let bad = |why: &str| Err(BadPrefix(format!("folder prefix {prefix:?}: {why}")));
    let trimmed = prefix.strip_suffix('/').unwrap_or(prefix);
    if trimmed.trim().is_empty() {
        return bad("empty");
    }
    if trimmed.starts_with('/') || trimmed.contains(':') {
        return bad("must be vault-relative");
    }
    if trimmed.contains('\\') {
        return bad("use / between folders");
    }
    if trimmed.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
        return bad("empty, . or .. segment");
    }
    let like = like_pattern(&super::schema::fold(trimmed));
    // `like_pattern` wraps the term in `%...%`; a prefix wants no leading `%`.
    let inner = &like[1..like.len() - 1];
    Ok(format!("{inner}/%"))
}

/// `search` restricted to the notes inside the vault-relative folder `prefix`
/// (any depth). Same plans and ranking. A bad prefix is refused before any
/// query runs (`rusqlite::Error::InvalidParameterName` carrying the reason;
/// `Index::search_in` checks first and answers `badInput`).
pub fn search_in(conn: &Connection, query: &str, prefix: &str, limit: usize) -> rusqlite::Result<SearchResults> {
    let scope = scope_like(prefix).map_err(|e| rusqlite::Error::InvalidParameterName(e.0))?;
    run(conn, query, Some(&scope), limit)
}

/// The one query builder behind `search` and `search_in`. `scope` is a
/// `scope_like` pattern on `n.key`, or `None` for the whole vault.
fn run(conn: &Connection, query: &str, scope: Option<&str>, limit: usize) -> rusqlite::Result<SearchResults> {
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
    if let Some(scope) = scope {
        wheres.push("n.key LIKE ? ESCAPE '\\'".into());
        args.push(scope.to_owned());
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// An index database in a fresh temp dir, removed on drop.
    struct Db(std::path::PathBuf, Connection);
    impl Db {
        fn new(notes: &[(&str, &str)]) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "labnoteo-search-in-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let conn = super::super::schema::open(&dir.join("i.db")).unwrap();
            for (path, body) in notes {
                conn.execute(
                    "INSERT INTO notes (key, path, title, body) VALUES (?1, ?2, ?3, ?4)",
                    (super::super::schema::fold(path), path, path, body),
                )
                .unwrap();
            }
            Db(dir, conn)
        }
        fn paths(&self, q: &str, prefix: &str) -> Vec<String> {
            let mut p: Vec<String> =
                search_in(&self.1, q, prefix, 50).unwrap().hits.into_iter().map(|h| h.path).collect();
            p.sort();
            p
        }
    }
    impl Drop for Db {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn vault() -> Db {
        Db::new(&[
            ("labnote/001_A/README.labnote.md", "agarose gel 실험"),
            ("labnote/001_A/workflows/002_PCR.md", "agarose 전기영동 go"),
            ("labnote/001_AB/README.md", "agarose gel 실험 go"),
            ("labnote/001_AX/README.md", "agarose gel 실험"),
            ("labnote/001_A%/README.md", "agarose gel 실험"),
            ("labnote/002_형질전환/README.md", "agarose 형질전환 실험"),
            ("other.md", "agarose gel 실험"),
        ])
    }

    #[test]
    fn hits_only_under_the_prefix_for_every_plan() {
        let db = vault();
        let want = ["labnote/001_A/README.labnote.md", "labnote/001_A/workflows/002_PCR.md"];
        assert_eq!(plan_for("agarose"), Plan::Fts);
        assert_eq!(db.paths("agarose", "labnote/001_A"), want);
        assert_eq!(plan_for("go"), Plan::Like);
        assert_eq!(db.paths("go", "labnote/001_A"), ["labnote/001_A/workflows/002_PCR.md"]);
        assert_eq!(plan_for("agarose 실험"), Plan::FtsThenLike);
        assert_eq!(db.paths("agarose 실험", "labnote/001_A"), ["labnote/001_A/README.labnote.md"]);
        // A trailing slash is the same folder; the whole-vault search still sees all.
        assert_eq!(db.paths("agarose", "labnote/001_A/"), want);
        assert_eq!(search(&db.1, "agarose", 50).unwrap().hits.len(), 7);
        // A parent folder includes every experiment below it.
        assert_eq!(db.paths("agarose", "labnote").len(), 6);
    }

    #[test]
    fn a_folder_does_not_match_a_longer_sibling_name() {
        let db = vault();
        let hits = db.paths("agarose", "labnote/001_A");
        assert!(hits.iter().all(|p| p.starts_with("labnote/001_A/")), "{hits:?}");
        assert_eq!(db.paths("agarose", "labnote/001_AB"), ["labnote/001_AB/README.md"]);
    }

    #[test]
    fn like_wildcards_in_the_folder_name_are_literal() {
        let db = vault();
        // Unescaped, `%` would match `001_AX`, `001_AB`, ... and `_` any one character.
        assert_eq!(db.paths("agarose", "labnote/001_A%"), ["labnote/001_A%/README.md"]);
        assert!(db.paths("agarose", "labnote/001%").is_empty());
        assert!(db.paths("agarose", "labnote/001_").is_empty());
        assert!(db.paths("agarose", "labnote/0_1_A").is_empty());
    }

    #[test]
    fn a_korean_folder_works_and_the_prefix_is_folded_like_keys() {
        let db = vault();
        assert_eq!(db.paths("형질전환", "labnote/002_형질전환"), ["labnote/002_형질전환/README.md"]);
        assert_eq!(db.paths("agarose", "LABNOTE/001_a"), db.paths("agarose", "labnote/001_A"));
        assert_eq!(scope_like("LabNote/001_A").unwrap(), "labnote/001\\_a/%");
    }

    #[test]
    fn bad_prefixes_are_refused_before_any_query() {
        // No `notes` table at all: a query that ran would fail differently.
        let conn = Connection::open_in_memory().unwrap();
        for p in ["", "/", " ", "/labnote/001_A", "labnote/../x", "..", "labnote/./x", "labnote//x", "labnote\\001_A", "C:/x", "c:"] {
            assert!(scope_like(p).is_err(), "{p:?} accepted");
            match search_in(&conn, "agarose", p, 10) {
                Err(rusqlite::Error::InvalidParameterName(m)) => assert!(m.contains("folder prefix"), "{m}"),
                other => panic!("{p:?}: {other:?}"),
            }
        }
        // An empty query with a bad prefix is still refused.
        assert!(search_in(&conn, "", "..", 10).is_err());
    }

    #[test]
    fn the_limit_is_clamped() {
        let notes: Vec<(String, String)> =
            (0..MAX_LIMIT + 5).map(|i| (format!("labnote/001_A/n{i:03}.md"), "agarose".to_string())).collect();
        let refs: Vec<(&str, &str)> = notes.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let db = Db::new(&refs);
        let all = search_in(&db.1, "agarose", "labnote/001_A", 10_000).unwrap();
        assert_eq!(all.hits.len(), MAX_LIMIT);
        assert!(all.truncated);
        let one = search_in(&db.1, "agarose", "labnote/001_A", 0).unwrap();
        assert_eq!(one.hits.len(), 1);
        assert!(one.truncated);
    }
}
