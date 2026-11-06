//! The link-update journal (D15): the latest rename's plan and per-note before
//! and after texts, kept in `app_local_data_dir/link-journal/<vault_key>/`,
//! outside the vault so the watcher, the search index and git never see it.
//! It holds `header.json` and one `<n>.json` per planned note. The contents are
//! opaque JSON strings written by the frontend; this module only stores them.

use std::path::{Path, PathBuf};

use super::fs::{write_atomic, FsError};
use super::settings::vault_key;
use super::{LinkJournalDir, VaultState};

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct JournalFiles {
    pub header: String,
    /// Note records in ascending `n`.
    pub notes: Vec<String>,
}

/// `root`'s journal folder: `dir/<vault_key(root)>`. `dir` is the app's
/// `link-journal` folder, never a folder in the vault.
pub fn journal_dir(dir: &Path, root: &Path) -> PathBuf {
    dir.join(vault_key(root))
}

const HEADER: &str = "header.json";

/// The `n` of a note record file name `<n>.json`; anything else (the header,
/// a leftover temp file) is `None`.
fn record_number(name: &str) -> Option<u32> {
    let digits = name.strip_suffix(".json")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// The header and every note record of `root`'s journal, records in ascending
/// `n`. `None` when there is no `header.json` (no journal, or a cleared one).
pub fn read_at(dir: &Path, root: &Path) -> Result<Option<JournalFiles>, FsError> {
    let folder = journal_dir(dir, root);
    let header = match std::fs::read_to_string(folder.join(HEADER)) {
        Ok(h) => h,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut records: Vec<(u32, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(&folder)? {
        let entry = entry?;
        if let Some(n) = record_number(&entry.file_name().to_string_lossy()) {
            records.push((n, entry.path()));
        }
    }
    records.sort_by_key(|(n, _)| *n);
    let notes = records
        .into_iter()
        .map(|(_, p)| std::fs::read_to_string(p))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(JournalFiles { header, notes }))
}

/// Write `header.json` (temp file + rename, so a crash never leaves half a header).
pub fn write_header_at(dir: &Path, root: &Path, content: &str) -> Result<(), FsError> {
    write_atomic(&journal_dir(dir, root).join(HEADER), content)
}

/// Write the note record `<n>.json` (temp file + rename).
pub fn write_note_at(dir: &Path, root: &Path, n: u32, content: &str) -> Result<(), FsError> {
    write_atomic(&journal_dir(dir, root).join(format!("{n}.json")), content)
}

/// Remove `root`'s whole journal. A journal that is not there is fine.
pub fn clear_at(dir: &Path, root: &Path) -> Result<(), FsError> {
    match std::fs::remove_dir_all(journal_dir(dir, root)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Runs `f` off the async workers, as the `index_*` commands do: a journal
/// write never runs on the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, FsError> + Send + 'static) -> Result<T, FsError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| FsError::Io(std::io::Error::other(e.to_string())))?
}

/// The open vault's root and the journal folder, cloned out of the states.
fn paths(state: &VaultState, dir: &LinkJournalDir) -> Result<(PathBuf, PathBuf), FsError> {
    Ok((dir.0.clone(), state.root()?))
}

#[tauri::command]
pub async fn link_journal_read(
    state: tauri::State<'_, VaultState>,
    dir: tauri::State<'_, LinkJournalDir>,
) -> Result<Option<JournalFiles>, FsError> {
    let (d, root) = paths(&state, &dir)?;
    blocking(move || read_at(&d, &root)).await
}

#[tauri::command]
pub async fn link_journal_write_header(
    state: tauri::State<'_, VaultState>,
    dir: tauri::State<'_, LinkJournalDir>,
    content: String,
) -> Result<(), FsError> {
    let (d, root) = paths(&state, &dir)?;
    blocking(move || write_header_at(&d, &root, &content)).await
}

#[tauri::command]
pub async fn link_journal_write_note(
    state: tauri::State<'_, VaultState>,
    dir: tauri::State<'_, LinkJournalDir>,
    n: u32,
    content: String,
) -> Result<(), FsError> {
    let (d, root) = paths(&state, &dir)?;
    blocking(move || write_note_at(&d, &root, n, &content)).await
}

#[tauri::command]
pub async fn link_journal_clear(
    state: tauri::State<'_, VaultState>,
    dir: tauri::State<'_, LinkJournalDir>,
) -> Result<(), FsError> {
    let (d, root) = paths(&state, &dir)?;
    blocking(move || clear_at(&d, &root)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// A fresh scratch dir under the temp dir.
    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "labnoteo-journal-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn journal_round_trips_per_vault() {
        let d = tmp();
        let a = tmp();
        let b = tmp();
        write_header_at(&d, &a, "{\"id\":\"1\"}").unwrap();
        write_note_at(&d, &a, 1, "n1").unwrap();
        write_note_at(&d, &a, 0, "n0").unwrap();
        assert_eq!(
            read_at(&d, &a).unwrap(),
            Some(JournalFiles { header: "{\"id\":\"1\"}".into(), notes: vec!["n0".into(), "n1".into()] })
        );
        assert_eq!(read_at(&d, &b).unwrap(), None);
    }

    #[test]
    fn journal_orders_notes_numerically() {
        let d = tmp();
        let a = tmp();
        write_header_at(&d, &a, "h").unwrap();
        for n in [10u32, 2, 1] {
            write_note_at(&d, &a, n, &n.to_string()).unwrap();
        }
        assert_eq!(read_at(&d, &a).unwrap().unwrap().notes, vec!["1", "2", "10"]);
    }

    #[test]
    fn journal_overwrite_leaves_no_temp_files() {
        let d = tmp();
        let a = tmp();
        write_header_at(&d, &a, "1").unwrap();
        write_header_at(&d, &a, "2").unwrap();
        write_note_at(&d, &a, 0, "x").unwrap();
        write_note_at(&d, &a, 0, "y").unwrap();
        assert_eq!(std::fs::read_dir(journal_dir(&d, &a)).unwrap().count(), 2);
        assert_eq!(read_at(&d, &a).unwrap().unwrap().header, "2");
        assert_eq!(read_at(&d, &a).unwrap().unwrap().notes, vec!["y".to_string()]);
    }

    #[test]
    fn clearing_removes_notes_and_a_missing_journal_is_ok() {
        let d = tmp();
        let a = tmp();
        write_header_at(&d, &a, "1").unwrap();
        write_note_at(&d, &a, 0, "x").unwrap();
        clear_at(&d, &a).unwrap();
        clear_at(&d, &a).unwrap();
        assert_eq!(read_at(&d, &a).unwrap(), None);
    }

    #[test]
    fn the_journal_is_never_inside_the_vault() {
        let d = tmp();
        let a = tmp();
        assert!(!journal_dir(&d, &a).starts_with(&a));
    }
}
