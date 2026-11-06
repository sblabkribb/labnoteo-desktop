//! The search index: a SQLite FTS5 cache of the vault's notes.
//!
//! The files are the truth; this is a cache. Deleting the database loses
//! nothing, `rebuild` reproduces it. It lives in the app data directory, never
//! in the vault.

pub mod schema;
pub mod search;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::vault::fs::FsError;
pub use search::{SearchHit, SearchResults};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    /// Notes read and written by this rebuild.
    pub indexed: usize,
    /// Notes the walk listed but that could not be read this time. Their previous
    /// row, if any, is kept (stale rather than missing); a note never read has none.
    pub skipped: usize,
}

pub struct Index {
    conn: Mutex<rusqlite::Connection>,
    rebuilding: Mutex<()>,
    /// Keys written or removed by `upsert` / `remove` / `apply` since the current
    /// rebuild chunk began reading. A chunk's rows for these keys are older than
    /// what is stored and are not committed. Always locked while `conn` is held
    /// (in that order), so marking and writing are one step to a rebuild.
    touched: Mutex<std::collections::HashSet<String>>,
    /// Keys written or removed by `upsert` / `remove` / `apply` since the running
    /// rebuild began (`None` when none runs). Unlike `touched` it is not cleared
    /// per chunk: the rebuild's final sweep must not delete a note that was
    /// created after the walk listed the vault and stored by a watcher flush.
    /// Same lock order as `touched`: `conn` first.
    written_in_rebuild: Mutex<Option<std::collections::HashSet<String>>>,
}

fn db_err(e: rusqlite::Error) -> FsError {
    FsError::Io(std::io::Error::other(e.to_string()))
}

/// Notes bigger than this are not indexed (counted as skipped): a pasted
/// multi-megabyte log should not be read into memory and tokenised.
const MAX_NOTE_BYTES: u64 = 16 * 1024 * 1024;
/// Notes per transaction during a rebuild. Small enough that a search waits
/// for one batch at most, large enough that commits are not the cost.
const BATCH: usize = 200;

/// The file name without `.labnote.md` / `.md`, the title when there is none.
fn file_stem(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let lower = name.to_lowercase();
    let cut = if lower.ends_with(".labnote.md") {
        ".labnote.md".len()
    } else if lower.ends_with(".md") {
        ".md".len()
    } else {
        0
    };
    name[..name.len() - cut].to_string()
}

/// `title` from a leading `---` frontmatter block, else the file stem. Only the
/// block counts (a `title:` line in the body does not), a BOM and CRLF are
/// tolerated, surrounding quotes are dropped.
fn title_of(rel: &str, text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) == Some("---") {
        for line in lines {
            let line = line.trim_end();
            if line == "---" || line == "..." {
                break;
            }
            if let Some(v) = line.strip_prefix("title:") {
                let v = v.trim();
                let v = v
                    .strip_prefix('"')
                    .and_then(|x| x.strip_suffix('"'))
                    .or_else(|| v.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')))
                    .unwrap_or(v)
                    .trim();
                if !v.is_empty() {
                    return v.to_string();
                }
            }
        }
    }
    file_stem(rel)
}

struct Row {
    key: String,
    path: String,
    title: String,
    body: String,
}

/// What `prepare` decided about one path: store this row, drop the path (and
/// everything under it), or leave the index alone.
enum Prepared {
    Put(Row),
    Drop,
    Ignore,
}

/// Read one listed note. `None` when it cannot be read as a plain file (gone,
/// locked, a link swapped in since the walk, too big).
fn read_row(root: &Path, rel: &str) -> Option<Row> {
    let abs = root.join(rel);
    let meta = std::fs::symlink_metadata(&abs).ok()?;
    if !meta.is_file() || meta.len() > MAX_NOTE_BYTES {
        return None;
    }
    let bytes = std::fs::read(&abs).ok()?;
    // TODO(NFD): Hangul pasted from macOS can be decomposed; fold to NFC here and in the query
    // so it matches. Needs a normalisation crate; not done yet.
    let body = String::from_utf8_lossy(&bytes).into_owned();
    Some(Row { key: schema::fold(rel), path: rel.to_string(), title: title_of(rel, &body), body })
}

fn put(conn: &rusqlite::Connection, row: &Row) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO notes (key, path, title, body) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET path = excluded.path, title = excluded.title, body = excluded.body",
        (&row.key, &row.path, &row.title, &row.body),
    )?;
    Ok(())
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether `key`, or a folder above it, was touched since the chunk began.
fn overtaken(touched: &std::collections::HashSet<String>, key: &str) -> bool {
    let mut k = key;
    loop {
        if touched.contains(k) {
            return true;
        }
        match k.rfind('/') {
            Some(i) => k = &k[..i],
            None => return false,
        }
    }
}

/// Delete a note, or every note under a folder, by vault-relative path.
fn delete_tree(conn: &rusqlite::Connection, rel: &str) -> rusqlite::Result<()> {
    let key = schema::fold(rel);
    let mut like = String::new();
    for c in key.chars() {
        if matches!(c, '%' | '_' | '\\') {
            like.push('\\');
        }
        like.push(c);
    }
    like.push_str("/%");
    conn.execute("DELETE FROM notes WHERE key = ?1 OR key LIKE ?2 ESCAPE '\\'", (&key, &like))?;
    Ok(())
}

impl Index {
    pub fn open(db: &Path) -> Result<Index, FsError> {
        let conn = schema::open(db).map_err(db_err)?;
        Ok(Index { conn: Mutex::new(conn), rebuilding: Mutex::new(()), touched: Mutex::default(), written_in_rebuild: Mutex::default() })
    }

    /// Bring the index in line with the vault from scratch: every listed note is
    /// read and written, then rows for notes that no longer exist are dropped.
    ///
    /// Files are read with no lock held and written in batches of `BATCH`, each
    /// its own transaction, so a search is never blocked for longer than one
    /// batch. Every batch leaves rows that are each correct; closing the app
    /// part way keeps what was committed (nothing is half-written) and the next
    /// rebuild finishes the job. Stale rows are only removed at the very end, so
    /// an interrupted rebuild can leave a deleted note findable until then. A listed
    /// note that cannot be read keeps its previous row and is only counted in
    /// `skipped`; only notes the walk no longer lists are dropped.
    pub fn rebuild(&self, root: &Path) -> Result<IndexStats, FsError> {
        self.rebuild_with(root, &mut || {})
    }

    /// `rebuild`, calling `mid` once after the notes are written and before the
    /// sweep of vanished notes (tests use it to change the vault at that point).
    fn rebuild_with(&self, root: &Path, mid: &mut dyn FnMut()) -> Result<IndexStats, FsError> {
        let _one_at_a_time = lock(&self.rebuilding);
        *lock(&self.written_in_rebuild) = Some(Default::default());
        let result = self.rebuild_locked(root, mid);
        // Also on an error: nothing may keep collecting keys once no rebuild runs.
        *lock(&self.written_in_rebuild) = None;
        result
    }

    fn rebuild_locked(&self, root: &Path, mid: &mut dyn FnMut()) -> Result<IndexStats, FsError> {
        let root = std::fs::canonicalize(root).map_err(FsError::Io)?;
        let files: Vec<String> = crate::vault::tree::walk(&root)?
            .into_iter()
            .filter(|e| !e.is_dir && crate::vault::tree::is_listed_path(&e.path, false))
            .map(|e| e.path)
            .collect();
        // Every path the walk listed counts as present, readable or not: a note that
        // cannot be read right now (locked, not yet downloaded, too big) keeps its
        // previous row instead of vanishing from search.
        let seen: std::collections::HashSet<String> = files.iter().map(|f| schema::fold(f)).collect();
        let mut skipped = 0;
        let mut overtaken: Vec<String> = Vec::new();
        for chunk in files.chunks(BATCH) {
            self.begin_chunk();
            let rows: Vec<Row> = chunk
                .iter()
                .filter_map(|rel| {
                    let row = read_row(&root, rel);
                    if row.is_none() {
                        skipped += 1;
                    }
                    row
                })
                .collect();
            overtaken.extend(self.commit_chunk(&rows)?);
        }
        self.retry_overtaken(&root, &overtaken)?;
        mid();
        let conn = lock(&self.conn);
        // Taken under the connection, so no flush is half-way between its write
        // and its mark: a note written since the rebuild began is not stale.
        let written = lock(&self.written_in_rebuild).take().unwrap_or_default();
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let stale: Vec<String> = {
            let mut stmt = tx.prepare("SELECT key FROM notes").map_err(db_err)?;
            let keys = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(db_err)?;
            keys.collect::<Result<Vec<_>, _>>().map_err(db_err)?
        };
        for key in stale.iter().filter(|k| !seen.contains(*k) && !written.contains(*k)) {
            tx.execute("DELETE FROM notes WHERE key = ?1", [key]).map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(IndexStats { indexed: seen.len() - skipped, skipped })
    }

    /// Start a chunk: from here on, every `upsert` / `remove` is remembered
    /// until the chunk is committed.
    fn begin_chunk(&self) {
        lock(&self.touched).clear();
    }

    /// Write one chunk of rows read by `rebuild` (after `begin_chunk`), in one
    /// transaction, and return the paths it did not write.
    ///
    /// The chunk was read with no lock held (holding the connection while
    /// reading would make every search wait for file reads), so a note may have
    /// changed since and `upsert` / `remove` may already have stored the newer
    /// state. A row whose key (or a folder above it) was touched since
    /// `begin_chunk` is older than what is stored and is skipped. This is a
    /// counter-free ordering argument, not a timestamp one: the touch is
    /// recorded under the same connection lock as the write, so either the
    /// write came first (we see the mark and skip) or it comes after our commit
    /// (it overwrites us).
    fn commit_chunk(&self, rows: &[Row]) -> Result<Vec<String>, FsError> {
        let conn = lock(&self.conn);
        let touched = lock(&self.touched);
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let mut skipped = Vec::new();
        for row in rows {
            if overtaken(&touched, &row.key) {
                skipped.push(row.path.clone());
            } else {
                put(&tx, row).map_err(db_err)?;
            }
        }
        tx.commit().map_err(db_err)?;
        Ok(skipped)
    }

    /// One bounded extra pass over the notes `commit_chunk` skipped: whatever
    /// touched them may not have left a row (a removal, an upsert that found the
    /// note unreadable, an event for a note that was not there yet), so read
    /// them again and write what is still unmarked. Not repeated: a note that is
    /// touched again meanwhile is being handled by whoever touched it.
    fn retry_overtaken(&self, root: &Path, paths: &[String]) -> Result<(), FsError> {
        if paths.is_empty() {
            return Ok(());
        }
        self.begin_chunk();
        let rows: Vec<Row> = paths.iter().filter_map(|p| read_row(root, p)).collect();
        self.commit_chunk(&rows).map(|_| ())
    }

    /// Decide what one path means for the index (no lock held). What is not
    /// part of the vault (`is_listed_path`, or reached through a link) is
    /// ignored, so the index and the tree agree on what exists; a note that is
    /// gone is dropped; a path that escapes the vault is refused like in every
    /// file command. `root` must be canonical.
    fn prepare(root: &Path, rel: &str) -> Result<Prepared, FsError> {
        use crate::vault::path::{confine, to_rel};
        let abs = confine(root, rel)?;
        if !crate::vault::tree::is_listed_path(rel, false) {
            return Ok(Prepared::Ignore);
        }
        let meta = match std::fs::symlink_metadata(&abs) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Prepared::Drop),
            Err(e) => return Err(e.into()),
        };
        // `confine` resolves links; the tree does not follow them. A path that
        // resolves somewhere else than it was spelled goes through a link.
        let on_disk = to_rel(root, &abs)?;
        if !meta.is_file() || schema::fold(&on_disk) != schema::fold(rel) {
            return Ok(Prepared::Ignore);
        }
        Ok(read_row(root, &on_disk).map_or(Prepared::Ignore, Prepared::Put))
    }

    /// Store the outcome of `prepare` for each path in one transaction, marking
    /// each written key for a rebuild in progress.
    fn store(&self, items: Vec<(String, Prepared)>) -> Result<(), FsError> {
        let conn = lock(&self.conn);
        let mut touched = lock(&self.touched);
        let mut written = lock(&self.written_in_rebuild);
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        for (rel, p) in &items {
            let key = match p {
                Prepared::Put(row) => {
                    put(&tx, row).map_err(db_err)?;
                    row.key.clone()
                }
                Prepared::Drop => {
                    delete_tree(&tx, rel).map_err(db_err)?;
                    schema::fold(rel)
                }
                Prepared::Ignore => continue,
            };
            if let Some(w) = written.as_mut() {
                w.insert(key.clone());
            }
            touched.insert(key);
        }
        tx.commit().map_err(db_err)
    }

    /// Re-read one note and replace its row (see `prepare` for what is ignored).
    pub fn upsert(&self, root: &Path, rel: &str) -> Result<(), FsError> {
        let root = std::fs::canonicalize(root).map_err(FsError::Io)?;
        let p = Self::prepare(&root, rel)?;
        self.store(vec![(rel.to_string(), p)])
    }

    /// Apply many changes as one transaction: `(path, removed)`. The root is
    /// resolved once and the connection taken once, however many paths. A path
    /// that cannot be applied (escapes the vault, unreadable) does not stop the
    /// others; the first such error is returned after the rest are stored.
    pub fn apply(&self, root: &Path, changes: &[(String, bool)]) -> Result<(), FsError> {
        let root = std::fs::canonicalize(root).map_err(FsError::Io)?;
        let mut first_err = None;
        let mut items = Vec::with_capacity(changes.len());
        for (rel, removed) in changes {
            let p = if *removed { Ok(Prepared::Drop) } else { Self::prepare(&root, rel) };
            match p {
                Ok(p) => items.push((rel.clone(), p)),
                Err(e) => {
                    first_err.get_or_insert(e);
                }
            }
        }
        self.store(items)?;
        first_err.map_or(Ok(()), Err)
    }

    /// Drop a note, or every note under a folder, by vault-relative path. No
    /// file is touched, so no path check is needed.
    pub fn remove(&self, rel: &str) -> Result<(), FsError> {
        self.store(vec![(rel.to_string(), Prepared::Drop)])
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<SearchResults, FsError> {
        search::search(&lock(&self.conn), query, limit).map_err(db_err)
    }

    /// Every indexed path, in on-disk spelling.
    pub fn paths(&self) -> Result<Vec<String>, FsError> {
        let conn = lock(&self.conn);
        let mut stmt = conn.prepare("SELECT path FROM notes ORDER BY key").map_err(db_err)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }
}

/// Managed app state: where index databases live (the app data directory) and
/// the index of the vault that is open. Switching vaults opens that vault's own
/// database file.
pub struct IndexState {
    dir: PathBuf,
    current: Mutex<Option<(String, Arc<Index>)>>,
}

impl IndexState {
    pub fn new(dir: PathBuf) -> Self {
        IndexState { dir, current: Mutex::new(None) }
    }

    pub fn get(&self, root: &Path) -> Result<Arc<Index>, FsError> {
        let key = schema::fold(&crate::vault::path::strip_verbatim(root));
        let mut cur = lock(&self.current);
        if let Some((k, ix)) = cur.as_ref() {
            if *k == key {
                return Ok(ix.clone());
            }
        }
        let ix = Arc::new(Index::open(&schema::db_path(&self.dir, root))?);
        *cur = Some((key, ix.clone()));
        Ok(ix)
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, FsError> + Send + 'static) -> Result<T, FsError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| FsError::Io(std::io::Error::other(e.to_string())))?
}

/// Rebuild the open vault's index from its files. Runs off the async workers.
#[tauri::command]
pub async fn index_rebuild(
    vault: tauri::State<'_, crate::vault::VaultState>,
    state: tauri::State<'_, IndexState>,
) -> Result<IndexStats, FsError> {
    let root = vault.root()?;
    let ix = state.get(&root)?;
    blocking(move || ix.rebuild(&root)).await
}

#[tauri::command]
pub async fn index_upsert(
    vault: tauri::State<'_, crate::vault::VaultState>,
    state: tauri::State<'_, IndexState>,
    path: String,
) -> Result<(), FsError> {
    let root = vault.root()?;
    let ix = state.get(&root)?;
    blocking(move || ix.upsert(&root, &path)).await
}

#[tauri::command]
pub async fn index_remove(
    vault: tauri::State<'_, crate::vault::VaultState>,
    state: tauri::State<'_, IndexState>,
    path: String,
) -> Result<(), FsError> {
    let root = vault.root()?;
    let ix = state.get(&root)?;
    blocking(move || ix.remove(&path)).await
}

#[tauri::command]
pub async fn search(
    vault: tauri::State<'_, crate::vault::VaultState>,
    state: tauri::State<'_, IndexState>,
    query: String,
    limit: u32,
) -> Result<SearchResults, FsError> {
    let root = vault.root()?;
    let ix = state.get(&root)?;
    blocking(move || ix.search(&query, limit as usize)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// A scratch dir holding `vault/` and `data/` (the app data dir) side by side.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-index-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(p.join("vault")).unwrap();
            std::fs::create_dir_all(p.join("data")).unwrap();
            Scratch(p)
        }
        fn vault(&self) -> PathBuf {
            std::fs::canonicalize(self.0.join("vault")).unwrap()
        }
        fn db(&self) -> PathBuf {
            schema::db_path(&self.0.join("data"), &self.vault())
        }
        fn note(&self, rel: &str, text: &str) {
            let p = self.0.join("vault").join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        fn index(&self) -> Index {
            Index::open(&self.db()).unwrap()
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn found(ix: &Index, q: &str) -> Vec<String> {
        ix.search(q, 50).unwrap().hits.into_iter().map(|h| h.path).collect()
    }

    #[test]
    fn rebuild_indexes_every_markdown_file() {
        let s = Scratch::new();
        s.note("top.md", "one");
        s.note("a/two.labnote.md", "two");
        s.note("a/b/three.md", "three");
        s.note("a/readme.txt", "not a note");
        s.note(".obsidian/hidden.md", "never");
        s.note("node_modules/x/y.md", "never");
        let ix = s.index();
        let stats = ix.rebuild(&s.vault()).unwrap();
        assert_eq!(stats, IndexStats { indexed: 3, skipped: 0 });
        let mut paths = ix.paths().unwrap();
        paths.sort();
        assert_eq!(paths, ["a/b/three.md", "a/two.labnote.md", "top.md"]);
    }

    #[test]
    fn rebuild_does_not_overwrite_an_upsert_that_landed_after_its_read() {
        let s = Scratch::new();
        s.note("a.md", "old text");
        let ix = s.index();
        let root = s.vault();
        // What a rebuild read of the note before it commits its chunk...
        ix.begin_chunk();
        let stale = vec![read_row(&root, "a.md").unwrap()];
        // ...then the note changes (same length, written back to back: no timestamp
        // can tell the two apart) and the watcher's upsert lands first.
        s.note("a.md", "new text");
        ix.upsert(&root, "a.md").unwrap();
        let skipped = ix.commit_chunk(&stale).unwrap();
        assert_eq!(skipped, ["a.md"]);
        assert_eq!(found(&ix, "new"), ["a.md"], "the older bytes must not win");
        assert!(found(&ix, "old").is_empty());
        // A folder removed meanwhile overtakes the notes under it too.
        s.note("d/x.md", "inside");
        ix.begin_chunk();
        let rows = vec![read_row(&root, "d/x.md").unwrap()];
        ix.remove("d").unwrap();
        assert_eq!(ix.commit_chunk(&rows).unwrap(), ["d/x.md"]);
        assert!(found(&ix, "inside").is_empty());
        // A chunk read of a note nobody touched is written as usual.
        ix.begin_chunk();
        s.note("b.md", "other");
        assert!(ix.commit_chunk(&[read_row(&root, "b.md").unwrap()]).unwrap().is_empty());
        assert_eq!(found(&ix, "other"), ["b.md"]);
    }

    #[test]
    fn retry_overtaken_writes_a_skipped_note_that_has_no_row() {
        let s = Scratch::new();
        s.note("b.md", "created during the walk");
        let ix = s.index();
        let root = s.vault();
        ix.begin_chunk();
        let rows = vec![read_row(&root, "b.md").unwrap()];
        // Something touched the key without leaving a row (here a removal that
        // raced the note's creation): the chunk skips it and nothing is stored.
        ix.remove("b.md").unwrap();
        let skipped = ix.commit_chunk(&rows).unwrap();
        assert_eq!(skipped, ["b.md"]);
        assert!(found(&ix, "walk").is_empty());
        ix.retry_overtaken(&root, &skipped).unwrap();
        assert_eq!(found(&ix, "walk"), ["b.md"]);
    }

    #[test]
    fn a_note_that_appears_during_a_rebuild_is_still_searchable_afterwards() {
        let s = Scratch::new();
        s.note("early.md", "listed by the walk");
        let ix = s.index();
        let root = s.vault();
        // The note is created after the walk listed the vault; the watcher's
        // flush (`apply`) stores its row; then the rebuild reaches its sweep of
        // notes the walk did not list.
        let stats = ix
            .rebuild_with(&root, &mut || {
                s.note("late.md", "appeared mid rebuild");
                ix.apply(&root, &[("late.md".to_string(), false)]).unwrap();
            })
            .unwrap();
        assert_eq!(stats.indexed, 1);
        assert_eq!(found(&ix, "mid rebuild"), ["late.md"], "the sweep deleted a note written after the walk");
        assert_eq!(found(&ix, "walk"), ["early.md"]);
        // A note that vanished after the walk, with nobody writing it, is still swept.
        s.note("old.md", "was here");
        ix.upsert(&root, "old.md").unwrap();
        std::fs::remove_file(root.join("old.md")).unwrap();
        ix.rebuild(&root).unwrap();
        assert!(found(&ix, "here").is_empty());
    }

    #[test]
    fn apply_stores_many_changes_in_one_go() {
        let s = Scratch::new();
        s.note("keep.md", "kept");
        s.note("gone.md", "going");
        s.note("dir/in.md", "inside");
        let ix = s.index();
        ix.rebuild(&s.vault()).unwrap();
        std::fs::remove_file(s.0.join("vault/gone.md")).unwrap();
        s.note("new.md", "fresh");
        s.note("keep.md", "changed");
        let changes: Vec<(String, bool)> = vec![
            ("gone.md".into(), true),
            ("dir".into(), true),
            ("new.md".into(), false),
            ("keep.md".into(), false),
            (".obsidian/x.md".into(), false),
        ];
        ix.apply(&s.vault(), &changes).unwrap();
        let mut paths = ix.paths().unwrap();
        paths.sort();
        assert_eq!(paths, ["keep.md", "new.md"]);
        assert_eq!(found(&ix, "changed"), ["keep.md"]);
        // One bad path (escapes the vault) is reported but does not stop the rest.
        s.note("late.md", "late");
        let r = ix.apply(&s.vault(), &[("../x.md".into(), false), ("late.md".into(), false)]);
        assert!(r.is_err());
        assert_eq!(found(&ix, "late"), ["late.md"]);
    }

    #[test]
    fn search_matches_body_text() {
        let s = Scratch::new();
        s.note("a.md", "Cells were grown in LB medium overnight at 37 degrees.");
        s.note("b.md", "Nothing relevant here.");
        let ix = s.index();
        ix.rebuild(&s.vault()).unwrap();
        let hits = ix.search("overnight", 10).unwrap().hits;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.md");
        assert!(hits[0].snippet.contains("overnight"), "{}", hits[0].snippet);
        // Case-insensitive, and every term must match.
        assert_eq!(found(&ix, "LB MEDIUM"), ["a.md"]);
        assert!(found(&ix, "medium relevant").is_empty());
        assert!(found(&ix, "").is_empty());
        assert!(found(&ix, "   ").is_empty());
    }

    #[test]
    fn search_matches_frontmatter_title() {
        let s = Scratch::new();
        s.note("x/0001.labnote.md", "---\ntitle: \"Plasmid prep protocol\"\n---\nbody words only\n");
        s.note("x/plain-note.md", "no frontmatter at all");
        s.note("x/crlf.md", "---\r\ntitle: Gel run\r\n---\r\ntext");
        let ix = s.index();
        ix.rebuild(&s.vault()).unwrap();
        let hits = ix.search("plasmid prep", 10).unwrap().hits;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "x/0001.labnote.md");
        assert_eq!(hits[0].title, "Plasmid prep protocol");
        // No title: the file name without its extension.
        let hit = &ix.search("frontmatter", 10).unwrap().hits[0];
        assert_eq!(hit.title, "plain-note");
        assert_eq!(ix.search("gel run", 10).unwrap().hits[0].title, "Gel run");
    }

    #[test]
    fn search_matches_korean_text() {
        let s = Scratch::new();
        s.note("k.md", "---\ntitle: 대장균 실험\n---\n대장균에 플라스미드를 도입하는 형질전환 실험을 했다.\n");
        s.note("other.md", "완전히 다른 내용입니다");
        let ix = s.index();
        ix.rebuild(&s.vault()).unwrap();
        // The whole word, a piece from the middle of a longer run, a two-character
        // piece (below the trigram size), a particle-attached form, and two terms.
        for q in ["형질전환", "질전환", "형질", "플라스미드를", "전환 실험", "대장균"] {
            assert_eq!(found(&ix, q), ["k.md"], "query {q:?}");
        }
        assert!(found(&ix, "형질전환체").is_empty());
        assert_eq!(found(&ix, "내용"), ["other.md"]);
    }

    #[test]
    fn deleting_the_index_file_loses_no_notes() {
        let s = Scratch::new();
        s.note("a.md", "---\ntitle: Alpha\n---\n형질전환 효율");
        s.note("sub/b.md", "beta text 형질전환");
        let before = {
            let ix = s.index();
            ix.rebuild(&s.vault()).unwrap();
            ix.search("형질전환", 10).unwrap().hits
        };
        assert_eq!(before.len(), 2);
        // The index is a cache: delete the database and its WAL files.
        assert!(s.db().exists());
        for suffix in ["", "-wal", "-shm"] {
            let mut p = s.db().into_os_string();
            p.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(p));
        }
        let ix = s.index();
        assert!(ix.search("형질전환", 10).unwrap().hits.is_empty(), "a fresh index starts empty");
        ix.rebuild(&s.vault()).unwrap();
        assert_eq!(ix.search("형질전환", 10).unwrap().hits, before);
        // The notes themselves were never touched.
        assert_eq!(std::fs::read_to_string(s.vault().join("sub/b.md")).unwrap(), "beta text 형질전환");
    }

    #[test]
    fn upsert_replaces_the_previous_row() {
        let s = Scratch::new();
        s.note("n.md", "first draft about agarose");
        let ix = s.index();
        ix.upsert(&s.vault(), "n.md").unwrap();
        assert_eq!(found(&ix, "agarose"), ["n.md"]);
        s.note("n.md", "second draft about polyacrylamide");
        ix.upsert(&s.vault(), "n.md").unwrap();
        assert!(found(&ix, "agarose").is_empty(), "the old text is gone from the FTS index");
        assert_eq!(found(&ix, "polyacrylamide"), ["n.md"]);
        assert_eq!(ix.paths().unwrap(), ["n.md"]);
    }

    #[test]
    fn one_note_is_one_row_whatever_the_case_of_its_path() {
        let s = Scratch::new();
        s.note("Note.md", "body one");
        let ix = s.index();
        ix.rebuild(&s.vault()).unwrap();
        // Same NTFS file by another spelling: still one row, on-disk spelling kept.
        ix.upsert(&s.vault(), "note.md").unwrap();
        ix.upsert(&s.vault(), "NOTE.MD").unwrap();
        assert_eq!(ix.paths().unwrap(), ["Note.md"]);
        ix.remove("nOtE.md").unwrap();
        assert!(ix.paths().unwrap().is_empty());
    }

    #[test]
    fn upsert_follows_the_trees_rule_and_a_vanished_file() {
        let s = Scratch::new();
        s.note(".obsidian/x.md", "secret");
        s.note("a.txt", "text");
        s.note("keep.md", "keep");
        let ix = s.index();
        ix.upsert(&s.vault(), ".obsidian/x.md").unwrap();
        ix.upsert(&s.vault(), "a.txt").unwrap();
        ix.upsert(&s.vault(), "folder-not-note").unwrap();
        assert!(ix.paths().unwrap().is_empty());
        // A path that escapes is refused, not indexed.
        assert!(ix.upsert(&s.vault(), "../x.md").is_err());
        ix.upsert(&s.vault(), "keep.md").unwrap();
        std::fs::remove_file(s.vault().join("keep.md")).unwrap();
        ix.upsert(&s.vault(), "keep.md").unwrap();
        assert!(ix.paths().unwrap().is_empty(), "upserting a deleted note drops its row");
    }

    #[test]
    fn remove_drops_a_note_or_a_whole_folder() {
        let s = Scratch::new();
        s.note("a/one.md", "x");
        s.note("a/b/two.md", "x");
        s.note("ab.md", "x");
        let ix = s.index();
        ix.rebuild(&s.vault()).unwrap();
        ix.remove("a/one.md").unwrap();
        assert_eq!(ix.paths().unwrap().len(), 2);
        ix.remove("a").unwrap();
        assert_eq!(ix.paths().unwrap(), ["ab.md"], "a folder takes its notes, not a sibling sharing its prefix");
        // `_` in a folder name is literal: removing `a_b` must not take `axb`.
        s.note("a_b/n.md", "x");
        s.note("axb/n.md", "x");
        ix.rebuild(&s.vault()).unwrap();
        ix.remove("a_b").unwrap();
        let left = ix.paths().unwrap();
        assert!(left.contains(&"axb/n.md".to_string()) && !left.contains(&"a_b/n.md".to_string()), "{left:?}");
    }

    #[test]
    fn rebuild_drops_notes_that_no_longer_exist() {
        let s = Scratch::new();
        s.note("gone.md", "x");
        s.note("stay.md", "x");
        let ix = s.index();
        ix.rebuild(&s.vault()).unwrap();
        std::fs::remove_file(s.vault().join("gone.md")).unwrap();
        let stats = ix.rebuild(&s.vault()).unwrap();
        assert_eq!(stats.indexed, 1);
        assert_eq!(ix.paths().unwrap(), ["stay.md"]);
    }

    #[test]
    fn a_term_with_like_wildcards_or_quotes_is_searched_literally() {
        let s = Scratch::new();
        s.note("a.md", "100% done, \"quoted\" and snake_case");
        s.note("b.md", "100 percent");
        let ix = s.index();
        ix.rebuild(&s.vault()).unwrap();
        assert_eq!(found(&ix, "0%"), ["a.md"]);
        assert_eq!(found(&ix, "\"quoted\""), ["a.md"]);
        assert_eq!(found(&ix, "e_c"), ["a.md"]);
        assert!(found(&ix, "x_y").is_empty());
        // Two characters travel the LIKE branch, where `_` must not be a wildcard:
        // `e_` would match "e " in b.md if it were.
        s.note("c.md", "scale tool");
        ix.rebuild(&s.vault()).unwrap();
        assert_eq!(found(&ix, "e_"), ["a.md"]);
        assert_eq!(found(&ix, "0%"), ["a.md"]);
    }

    #[test]
    fn the_database_is_outside_the_vault_and_the_vault_is_untouched() {
        let s = Scratch::new();
        s.note("a.md", "x");
        let ix = s.index();
        ix.rebuild(&s.vault()).unwrap();
        assert!(!s.db().starts_with(s.vault()));
        assert!(s.db().exists());
        let names: Vec<_> = std::fs::read_dir(s.vault())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["a.md"]);
    }

    #[test]
    fn a_damaged_database_file_is_replaced_not_fatal() {
        let s = Scratch::new();
        s.note("a.md", "findme");
        std::fs::write(s.db(), b"this is not a sqlite database at all").unwrap();
        let ix = s.index();
        ix.rebuild(&s.vault()).unwrap();
        assert_eq!(found(&ix, "findme"), ["a.md"]);
    }

    #[test]
    fn each_vault_gets_its_own_index_file() {
        let a = schema::db_file_name(Path::new(r"D:\lab"));
        assert_eq!(a, schema::db_file_name(Path::new(r"d:\LAB")), "case-insensitive like the volume");
        assert_ne!(a, schema::db_file_name(Path::new(r"D:\other")));
    }

    #[test]
    fn state_reuses_an_index_per_vault_and_switches_with_the_vault() {
        let s = Scratch::new();
        s.note("a.md", "alpha");
        let other = s.0.join("vault2");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("b.md"), "beta").unwrap();
        let state = IndexState::new(s.0.join("data"));
        let one = state.get(&s.vault()).unwrap();
        one.rebuild(&s.vault()).unwrap();
        assert!(Arc::ptr_eq(&one, &state.get(&s.vault()).unwrap()));
        let other = std::fs::canonicalize(other).unwrap();
        let two = state.get(&other).unwrap();
        assert!(two.search("alpha", 5).unwrap().hits.is_empty(), "another vault does not see this one's rows");
        two.rebuild(&other).unwrap();
        assert_eq!(found(&two, "beta"), ["b.md"]);
    }

    #[test]
    fn title_parsing_handles_quotes_bom_and_missing_values() {
        assert_eq!(title_of("a/b.md", "---\ntitle: 'Q'\n---\n"), "Q");
        assert_eq!(title_of("a/b.md", "\u{feff}---\ntitle: Bom\n---\n"), "Bom");
        assert_eq!(title_of("a/b.md", "---\ntitle:\n---\n"), "b");
        assert_eq!(title_of("a/B.LABNOTE.MD", "text"), "B");
        // Only the frontmatter block counts, not a `title:` line in the body.
        assert_eq!(title_of("a/b.md", "text\ntitle: Nope\n"), "b");
        assert_eq!(title_of("a/b.md", "---\nother: 1\n---\ntitle: Nope\n"), "b");
    }

    #[test]
    fn an_unreadable_note_keeps_its_previous_row() {
        use std::os::windows::fs::OpenOptionsExt;
        let s = Scratch::new();
        s.note("locked.md", "original text");
        s.note("other.md", "x");
        let ix = s.index();
        assert_eq!(ix.rebuild(&s.vault()).unwrap(), IndexStats { indexed: 2, skipped: 0 });
        // Another program holds the file exclusively: it lists, but cannot be read.
        let hold = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(s.vault().join("locked.md"))
            .unwrap();
        let stats = ix.rebuild(&s.vault()).unwrap();
        assert_eq!(stats, IndexStats { indexed: 1, skipped: 1 });
        assert_eq!(found(&ix, "original"), ["locked.md"], "its old row survives a failed read");
        drop(hold);
        // A note the walk no longer lists is still dropped.
        std::fs::remove_file(s.vault().join("locked.md")).unwrap();
        ix.rebuild(&s.vault()).unwrap();
        assert!(found(&ix, "original").is_empty());
    }

    #[test]
    fn short_terms_rank_title_before_body_then_earlier_match_and_skip_the_path() {
        let s = Scratch::new();
        s.note("a-late.md", &format!("{} 실험", "가".repeat(40)));
        s.note("b-early.md", "실험 이른 본문");
        s.note("z-title.md", "---
title: 실험 노트
---
본문");
        s.note("md/plain.md", "nothing");
        let ix = s.index();
        ix.rebuild(&s.vault()).unwrap();
        // Alphabetical order would put a-late first; relevance puts the title match first,
        // then the earlier body match.
        assert_eq!(found(&ix, "실험"), ["z-title.md", "b-early.md", "a-late.md"]);
        // A two-character query does not match a note by its folder name alone.
        assert!(found(&ix, "md").is_empty());
    }

    #[test]
    fn a_cut_off_result_list_says_so() {
        let s = Scratch::new();
        for i in 0..5 {
            s.note(&format!("n{i}.md"), "실험 기록");
        }
        let ix = s.index();
        ix.rebuild(&s.vault()).unwrap();
        let cut = ix.search("실험", 3).unwrap();
        assert_eq!((cut.hits.len(), cut.truncated), (3, true));
        let exact = ix.search("실험", 5).unwrap();
        assert_eq!((exact.hits.len(), exact.truncated), (5, false));
        // The same through the FTS branch.
        let cut = ix.search("기록", 2).unwrap();
        let fts = ix.search("실험 기록", 2).unwrap();
        assert_eq!((cut.truncated, fts.hits.len(), fts.truncated), (true, 2, true));
    }
}
