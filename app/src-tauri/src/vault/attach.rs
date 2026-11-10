//! Attachments outside the editor: open a vault file with the system's default
//! app, and show it in Explorer. The path comes from JS as a vault-relative
//! POSIX path and is confined to the vault here (links resolved first, so a
//! junction out of the vault is `escape`). The JS opener capability stays
//! URL-only (plan ruling R7): nothing here takes an absolute path from JS.

use std::path::{Path, PathBuf};

use super::fs::FsError;
use super::path::confine;

/// Extensions (lowercase) that are never opened with the default app: running
/// them would execute code, not show a document.
pub const BLOCKED_EXTS: &[&str] = &[
    "exe", "msi", "msp", "msix", "appx", "bat", "cmd", "com", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf",
    "wsh", "hta", "scr", "pif", "lnk", "url", "reg", "cpl", "msc", "jar", "dll", "sys", "scf", "inf", "gadget",
    "application", "appref-ms", "settingcontent-ms", "website", "library-ms", "search-ms", "chm", "iso", "img", "vhd",
    "vhdx",
];

/// Whether `name`'s last extension is in `BLOCKED_EXTS`. Windows strips
/// trailing dots and spaces, but `confine` already refuses such names.
pub fn is_blocked_name(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| BLOCKED_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// What actually opens things; a trait so tests never launch anything.
pub trait Opener {
    fn open_path(&self, abs: &Path) -> Result<(), String>;
    fn reveal(&self, abs: &Path) -> Result<(), String>;
}

fn opener_error(e: String) -> FsError {
    FsError::Io(std::io::Error::other(e))
}

/// The absolute path of an existing regular vault file that may be opened.
fn openable(root: &Path, rel: &str) -> Result<PathBuf, FsError> {
    let abs = confine(root, rel)?;
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if is_blocked_name(name) {
        return Err(FsError::BadInput(format!("{name}: this kind of file is not opened from labnoteO")));
    }
    if !std::fs::metadata(&abs)?.is_file() {
        return Err(FsError::BadInput(format!("{name}: not a file")));
    }
    Ok(abs)
}

/// Open a vault file with the default app. Refuses executables and scripts,
/// folders, missing files and anything outside the vault.
pub fn open_default(root: &Path, rel: &str, opener: &dyn Opener) -> Result<(), FsError> {
    let abs = openable(root, rel)?;
    opener.open_path(&abs).map_err(opener_error)
}

/// Show a vault file or folder selected in Explorer. Only the containment
/// check applies: revealing runs nothing.
pub fn reveal(root: &Path, rel: &str, opener: &dyn Opener) -> Result<(), FsError> {
    let abs = confine(root, rel)?;
    std::fs::metadata(&abs)?;
    opener.reveal(&abs).map_err(opener_error)
}

/// The real opener: `tauri-plugin-opener` from Rust (no JS scope involved).
struct AppOpener<'a, R: tauri::Runtime>(&'a tauri::AppHandle<R>);

impl<R: tauri::Runtime> Opener for AppOpener<'_, R> {
    fn open_path(&self, abs: &Path) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        let shown = super::path::strip_verbatim(abs);
        self.0.opener().open_path(shown, None::<&str>).map_err(|e| e.to_string())
    }
    fn reveal(&self, abs: &Path) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        let shown = PathBuf::from(super::path::strip_verbatim(abs));
        self.0.opener().reveal_item_in_dir(shown).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn vault_open_default<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, super::VaultState>,
    path: String,
) -> Result<(), FsError> {
    let root = state.root()?;
    open_default(&root, &path, &AppOpener(&app))
}

#[tauri::command]
pub async fn vault_reveal<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, super::VaultState>,
    path: String,
) -> Result<(), FsError> {
    let root = state.root()?;
    reveal(&root, &path, &AppOpener(&app))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-attach-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(std::fs::canonicalize(&p).unwrap())
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Default)]
    struct Spy {
        opened: RefCell<Vec<PathBuf>>,
        revealed: RefCell<Vec<PathBuf>>,
    }
    impl Opener for Spy {
        fn open_path(&self, abs: &Path) -> Result<(), String> {
            self.opened.borrow_mut().push(abs.to_path_buf());
            Ok(())
        }
        fn reveal(&self, abs: &Path) -> Result<(), String> {
            self.revealed.borrow_mut().push(abs.to_path_buf());
            Ok(())
        }
    }

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    #[test]
    fn opens_a_vault_file_with_the_default_app() {
        let t = Tmp::new();
        touch(&t.0, "exp/resources/gel.png");
        let spy = Spy::default();
        open_default(&t.0, "exp/resources/gel.png", &spy).unwrap();
        assert_eq!(*spy.opened.borrow(), vec![t.0.join("exp").join("resources").join("gel.png")]);
    }

    #[test]
    fn refuses_executables_scripts_folders_missing_files_and_escapes() {
        let t = Tmp::new();
        for name in ["run.exe", "a.ps1", "b.BAT", "c.lnk", "d.js", "e.hta"] {
            touch(&t.0, name);
        }
        std::fs::create_dir_all(t.0.join("folder")).unwrap();
        let spy = Spy::default();
        for rel in ["run.exe", "a.ps1", "b.BAT", "c.lnk", "d.js", "e.hta"] {
            assert!(matches!(open_default(&t.0, rel, &spy), Err(FsError::BadInput(_))), "{rel}");
        }
        assert!(matches!(open_default(&t.0, "folder", &spy), Err(FsError::BadInput(_))));
        assert!(matches!(open_default(&t.0, "missing.pdf", &spy), Err(FsError::Io(_))));
        assert!(matches!(open_default(&t.0, "../x.pdf", &spy), Err(FsError::Vault(_))));
        assert!(matches!(open_default(&t.0, "/etc/x.pdf", &spy), Err(FsError::Vault(_))));
        assert!(spy.opened.borrow().is_empty());
    }

    #[test]
    fn reveals_files_and_folders_inside_the_vault_only() {
        let t = Tmp::new();
        touch(&t.0, "exp/run.exe");
        let spy = Spy::default();
        // revealing runs nothing: an executable may be shown in its folder
        reveal(&t.0, "exp/run.exe", &spy).unwrap();
        reveal(&t.0, "exp", &spy).unwrap();
        assert!(matches!(reveal(&t.0, "../x", &spy), Err(FsError::Vault(_))));
        assert!(matches!(reveal(&t.0, "nope.csv", &spy), Err(FsError::Io(_))));
        assert_eq!(spy.revealed.borrow().len(), 2);
    }

    #[test]
    fn blocked_names_are_case_insensitive_and_use_the_last_extension() {
        assert!(is_blocked_name("Setup.EXE"));
        assert!(is_blocked_name("x.tar.ps1"));
        assert!(!is_blocked_name("plate.csv"));
        assert!(!is_blocked_name("exe"));
        assert!(!is_blocked_name("report.pdf"));
    }
}
