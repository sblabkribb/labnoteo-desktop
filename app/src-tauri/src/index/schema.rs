//! The index database: where it lives, its tables, and opening it.
//!
//! The database is a cache of the vault, never a source of truth. It lives in
//! the app data directory (never inside the vault), one file per vault, and any
//! problem with it (corrupt, older layout) is answered by deleting it and
//! starting empty: a rebuild reproduces everything.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// Bump when the tables below change; an index with another version is dropped.
const SCHEMA_VERSION: i64 = 1;

/// `notes` holds one row per note: `key` is the case-folded vault-relative path
/// (NTFS treats `Note.md` and `note.md` as one file, so one key), `path` keeps
/// the on-disk spelling. `notes_fts` is an external-content FTS5 index over the
/// same rows; the triggers keep the two in step. The trigram tokenizer indexes
/// every run of three characters, so a Korean word is found inside a longer
/// run of text (the default tokenizer only splits on spaces and punctuation).
const SCHEMA: &str = "
CREATE TABLE notes (
    id    INTEGER PRIMARY KEY,
    key   TEXT NOT NULL UNIQUE,
    path  TEXT NOT NULL,
    title TEXT NOT NULL,
    body  TEXT NOT NULL
);
CREATE VIRTUAL TABLE notes_fts USING fts5(
    path, title, body,
    content='notes', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, path, title, body) VALUES (new.id, new.path, new.title, new.body);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, path, title, body) VALUES ('delete', old.id, old.path, old.title, old.body);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, path, title, body) VALUES ('delete', old.id, old.path, old.title, old.body);
    INSERT INTO notes_fts(rowid, path, title, body) VALUES (new.id, new.path, new.title, new.body);
END;
";

/// The case-fold used for keys: the same one the tree uses to compare paths.
pub fn fold(path: &str) -> String {
    path.to_lowercase()
}

/// File name of the index for a vault: a stable hash of the folded root, so two
/// vaults never share rows and reopening a vault finds its own index again.
pub fn db_file_name(root: &Path) -> String {
    let folded = fold(&crate::vault::path::strip_verbatim(root));
    // FNV-1a: stable across Rust versions (DefaultHasher is not).
    let mut h: u64 = 0xcbf29ce484222325;
    for b in folded.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("index-{h:016x}.db")
}

fn init(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    // WAL lets a search read while a rebuild commits a batch.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version != SCHEMA_VERSION {
        conn.execute_batch("DROP TABLE IF EXISTS notes_fts; DROP TABLE IF EXISTS notes;")?;
        conn.execute_batch(SCHEMA)?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    // Reads the table to notice a damaged file now rather than mid-search.
    conn.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0))?;
    Ok(conn)
}

fn remove_files(path: &Path) {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(path.with_file_name(format!("{name}{suffix}")));
    }
}

/// Open (creating if needed) the index at `path`. An unusable file is deleted
/// and recreated empty: the vault holds the truth, the next rebuild refills it.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match init(path) {
        Ok(c) => Ok(c),
        Err(_) => {
            remove_files(path);
            init(path)
        }
    }
}

/// Where the index for `root` lives under the app data dir.
pub fn db_path(data_dir: &Path, root: &Path) -> PathBuf {
    data_dir.join(db_file_name(root))
}
