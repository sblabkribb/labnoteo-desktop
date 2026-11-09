//! "Open in browser" for printed pages (worksheet and whole note).
//!
//! The webview builds a standalone HTML file from its sanitized print tree
//! (`port/printPages.ts` `buildStandaloneHtml`: one CSP meta, the app's static
//! print CSS and one hashed fit script) and hands it here. Rust writes it to
//! `%TEMP%/labnoteO-print/<noteId>_<kind>.html`, the only place outside the
//! vault Part A touches, and opens it in the default browser.
//!
//! The note ID is the only part of the file name that comes from the webview,
//! and it must be exactly `LN-` plus eight Crockford base-32 characters, so it
//! can never name another folder or file. Both checks (ID and size) run before
//! anything touches the disk.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Deserialize;

use crate::vault::fs::FsError;

/// The largest standalone file accepted (images are inlined as `data:` URIs).
pub const MAX_PRINT_HTML: usize = 64 * 1024 * 1024;

/// Print files older than this are removed the next time one is written.
const KEEP: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PrintKind {
    Worksheet,
    Note,
}

impl PrintKind {
    fn suffix(self) -> &'static str {
        match self {
            PrintKind::Worksheet => "worksheet",
            PrintKind::Note => "note",
        }
    }
}

/// `^LN-[0-9A-HJKMNP-TV-Z]{8}$`: the note-ID alphabet (Crockford base 32, upper case, no I L O U).
fn is_note_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("LN-") else { return false };
    rest.len() == 8
        && rest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b.is_ascii_uppercase() && !matches!(b, b'I' | b'L' | b'O' | b'U')))
}

/// Removes `*.html` files in `dir` last modified more than `KEEP` before `now`.
/// Best effort: a file that cannot be read or removed is left alone.
fn clean_old(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_html = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("html"));
        let Ok(meta) = entry.metadata() else { continue };
        if !is_html || !meta.is_file() {
            continue;
        }
        let old = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > KEEP);
        if old {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Writes `html` to `dir/<note_id>_<kind>.html`, replacing this note's own
/// earlier file of that kind, after removing print files older than 24 h.
/// Refuses a malformed `note_id` (`BadInput`) or an oversized `html`
/// (`TooLarge`) before touching the disk.
pub fn write_print_file(dir: &Path, kind: PrintKind, note_id: &str, html: &str, now: SystemTime) -> Result<PathBuf, FsError> {
    if !is_note_id(note_id) {
        return Err(FsError::BadInput("the note ID is not LN- plus 8 characters".into()));
    }
    if html.len() > MAX_PRINT_HTML {
        return Err(FsError::TooLarge);
    }
    std::fs::create_dir_all(dir)?;
    clean_old(dir, now);
    let path = dir.join(format!("{note_id}_{}.html", kind.suffix()));
    std::fs::write(&path, html)?;
    Ok(path)
}

/// Writes the standalone print file to `%TEMP%/labnoteO-print/` and opens it
/// in the default browser. Returns the file name only, never the full path.
#[tauri::command]
pub fn print_open_in_browser<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    kind: PrintKind,
    note_id: String,
    html: String,
) -> Result<String, FsError> {
    use tauri_plugin_opener::OpenerExt;
    let dir = std::env::temp_dir().join("labnoteO-print");
    let path = write_print_file(&dir, kind, &note_id, &html, SystemTime::now())?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| FsError::Io(std::io::Error::other(e.to_string())))?;
    Ok(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static N: AtomicU64 = AtomicU64::new(0);

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-print-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn now() -> SystemTime {
        SystemTime::now()
    }

    fn age(path: &Path, by: Duration) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - by).unwrap();
    }

    #[test]
    fn writes_named_file_and_replaces_its_own() {
        let t = Tmp::new();
        let p = write_print_file(&t.0, PrintKind::Note, "LN-7K3M9QX2", "a", now()).unwrap();
        assert_eq!(p.file_name().unwrap(), "LN-7K3M9QX2_note.html");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "a");
        write_print_file(&t.0, PrintKind::Note, "LN-7K3M9QX2", "b", now()).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "b");
        let w = write_print_file(&t.0, PrintKind::Worksheet, "LN-7K3M9QX2", "w", now()).unwrap();
        assert_eq!(w.file_name().unwrap(), "LN-7K3M9QX2_worksheet.html");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "b");
    }

    #[test]
    fn rejects_a_note_id_that_is_not_ln_plus_8_and_writes_nothing() {
        let t = Tmp::new();
        let d = t.0.join("out");
        for id in ["../x", "LN-7K3M9QX", "LN-7K3M9QXI", "LN-7K3M9QX2/..", "ln-7k3m9qx2", ""] {
            assert!(matches!(write_print_file(&d, PrintKind::Note, id, "x", now()), Err(FsError::BadInput(_))), "{id}");
        }
        assert!(!d.exists());
    }

    #[test]
    fn too_large_html_is_refused() {
        let t = Tmp::new();
        let big = "x".repeat(MAX_PRINT_HTML + 1);
        assert!(matches!(
            write_print_file(&t.0, PrintKind::Worksheet, "LN-7K3M9QX2", &big, now()),
            Err(FsError::TooLarge)
        ));
        assert_eq!(std::fs::read_dir(&t.0).unwrap().count(), 0);
    }

    #[test]
    fn old_print_files_are_cleaned_and_other_files_kept() {
        let t = Tmp::new();
        let old = t.0.join("a.html");
        let txt = t.0.join("b.txt");
        let fresh = t.0.join("fresh.html");
        for p in [&old, &txt, &fresh] {
            std::fs::write(p, "x").unwrap();
        }
        age(&old, Duration::from_secs(25 * 3600));
        age(&txt, Duration::from_secs(25 * 3600));
        write_print_file(&t.0, PrintKind::Note, "LN-7K3M9QX2", "n", now()).unwrap();
        assert!(!old.exists());
        assert!(txt.exists());
        assert!(fresh.exists());
        assert!(t.0.join("LN-7K3M9QX2_note.html").exists());
    }

    #[test]
    fn print_kind_reads_camel_case() {
        assert_eq!(serde_json::from_str::<PrintKind>("\"worksheet\"").unwrap(), PrintKind::Worksheet);
        assert_eq!(serde_json::from_str::<PrintKind>("\"note\"").unwrap(), PrintKind::Note);
    }
}
