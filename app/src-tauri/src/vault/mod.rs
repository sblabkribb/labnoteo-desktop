pub mod fs;
pub mod path;
pub mod tree;
pub mod watcher;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Managed app state: the open vault's root (set by `vault_open`) and the
/// per-path lock map shared by every file command.
#[derive(Default)]
pub struct VaultState {
    root: Mutex<Option<PathBuf>>,
    pub(crate) locks: fs::PathLocks,
}

impl VaultState {
    pub fn set_root(&self, root: Option<PathBuf>) {
        *self.root.lock().unwrap_or_else(|e| e.into_inner()) = root;
    }

    pub(crate) fn root(&self) -> Result<PathBuf, fs::FsError> {
        self.root
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or(fs::FsError::NoVault)
    }
}

/// What the frontend learns about an opened vault. `root` is for display and
/// is the plain form (no `\?\` prefix); file commands never take it back.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
    pub has_obsidian_config: bool,
}

/// Where the last vault is remembered: `settings.json` in the app config dir
/// (`%APPDATA%\kr.sblab.labnoteo`), resolved once at startup and managed so
/// tests can point it elsewhere.
pub struct SettingsFile(pub PathBuf);

fn info_for(root: &Path) -> VaultInfo {
    let shown = path::strip_verbatim(root);
    VaultInfo {
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            // A drive root such as `D:\` has no file name.
            .unwrap_or_else(|| shown.clone()),
        // A stat only. Nothing inside `.obsidian/` is ever opened, listed or written.
        has_obsidian_config: root.join(".obsidian").is_dir(),
        root: shown,
    }
}

/// Read the remembered root. Anything unusable (no file, unreadable, not JSON,
/// wrong shape, empty) is "nothing remembered".
fn remembered(settings: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(settings).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let p = value.get("lastVault")?.as_str()?;
    (!p.is_empty()).then(|| PathBuf::from(p))
}

fn remember(settings: &Path, root: &Path) -> std::io::Result<()> {
    if let Some(dir) = settings.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::json!({ "lastVault": path::strip_verbatim(root) });
    // Write-then-rename so a crash cannot leave a half-written settings file.
    let tmp = settings.with_extension("json.tmp");
    std::fs::write(&tmp, body.to_string())?;
    std::fs::rename(&tmp, settings).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Open `path` as the vault: it must be an existing directory. Sweeps orphaned
/// temp files first (before any write; a failed sweep only logs), then lifts
/// the `noVault` refusal, then remembers the choice (a failure to remember
/// only logs: the user can still work).
pub fn open_at(state: &VaultState, settings: &Path, path: &str) -> Result<VaultInfo, fs::FsError> {
    if path.is_empty() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "empty vault path").into());
    }
    let root = std::fs::canonicalize(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => fs::FsError::Vault(path::VaultError::NotFound),
        _ => fs::FsError::Io(e),
    })?;
    if !root.is_dir() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a directory").into());
    }
    refuse_obsidian(&root)?;
    if let Err(e) = fs::sweep_temp(&root) {
        eprintln!("labnoteO: temp-file cleanup in {} failed: {e}", root.display());
    }
    state.set_root(Some(root.clone()));
    if let Err(e) = remember(settings, &root) {
        eprintln!("labnoteO: could not remember the vault: {e}");
    }
    Ok(info_for(&root))
}

/// `.obsidian/` is never a vault, and never inside one that we write to: refuse
/// any path with a `.obsidian` component (NTFS is case-insensitive).
fn refuse_obsidian(p: &Path) -> Result<(), fs::FsError> {
    let inside = p
        .components()
        .any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".obsidian"));
    if inside {
        Err(fs::FsError::Forbidden)
    } else {
        Ok(())
    }
}

/// Create a new, empty vault folder at `path` and open it. The parent must
/// already exist (the save dialog picked it), so one folder is made, never a
/// chain. A folder that is already there is simply opened: nothing in it is
/// touched. A path inside `.obsidian/` is refused: that folder is never written.
pub fn create_at(state: &VaultState, settings: &Path, path: &str) -> Result<VaultInfo, fs::FsError> {
    let target = Path::new(path);
    if path.is_empty() || !target.is_absolute() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "vault path must be absolute").into());
    }
    refuse_obsidian(target)?;
    match std::fs::create_dir(target) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && target.is_dir() => {}
        Err(e) => return Err(e.into()),
    }
    open_at(state, settings, path)
}

/// The open vault, else the remembered one if it still opens, else `None`
/// (the frontend then shows the picker). Never fails: a deleted, renamed,
/// unplugged or now-a-file folder and a damaged settings file all mean `None`.
/// The memory is left in place so a reconnected drive is found next launch.
pub fn current_at(state: &VaultState, settings: &Path) -> Option<VaultInfo> {
    if let Ok(root) = state.root() {
        return Some(info_for(&root));
    }
    open_at(state, settings, &remembered(settings)?.to_string_lossy()).ok()
}

#[tauri::command]
pub fn vault_open(
    state: tauri::State<'_, VaultState>,
    settings: tauri::State<'_, SettingsFile>,
    watcher: tauri::State<'_, watcher::WatcherState>,
    path: String,
) -> Result<VaultInfo, fs::FsError> {
    let info = open_at(&state, &settings.0, &path)?;
    // The watched vault follows the open one (the same vault again keeps its watcher).
    watcher.follow(&state.root()?);
    Ok(info)
}

#[tauri::command]
pub fn vault_create(
    state: tauri::State<'_, VaultState>,
    settings: tauri::State<'_, SettingsFile>,
    watcher: tauri::State<'_, watcher::WatcherState>,
    path: String,
) -> Result<VaultInfo, fs::FsError> {
    let info = create_at(&state, &settings.0, &path)?;
    watcher.follow(&state.root()?);
    Ok(info)
}

#[tauri::command]
pub fn vault_current(
    state: tauri::State<'_, VaultState>,
    settings: tauri::State<'_, SettingsFile>,
    watcher: tauri::State<'_, watcher::WatcherState>,
) -> Option<VaultInfo> {
    let info = current_at(&state, &settings.0)?;
    if let Ok(root) = state.root() {
        watcher.follow(&root);
    }
    Some(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// Scratch dir holding a `vault/` and a settings path next to it.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-vault-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(p.join("vault")).unwrap();
            Scratch(p)
        }
        fn vault(&self) -> PathBuf {
            self.0.join("vault")
        }
        fn settings(&self) -> PathBuf {
            self.0.join("config").join("settings.json")
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open(s: &Scratch, state: &VaultState, p: &Path) -> Result<VaultInfo, fs::FsError> {
        open_at(state, &s.settings(), &p.to_string_lossy())
    }

    #[test]
    fn open_rejects_path_that_is_not_a_directory() {
        let s = Scratch::new();
        let state = VaultState::default();
        let file = s.0.join("note.md");
        std::fs::write(&file, "x").unwrap();
        assert!(open(&s, &state, &file).is_err());
        assert!(open(&s, &state, &s.0.join("missing")).is_err());
        assert!(open_at(&state, &s.settings(), "").is_err());
        // A refused open leaves the app without a vault and remembers nothing.
        assert!(matches!(state.root(), Err(fs::FsError::NoVault)));
        assert!(!s.settings().exists());
    }

    #[test]
    fn create_makes_one_folder_and_opens_it() {
        let s = Scratch::new();
        let state = VaultState::default();
        let target = s.vault().join("new-lab");
        let info = create_at(&state, &s.settings(), &target.to_string_lossy()).unwrap();
        assert!(target.is_dir());
        assert_eq!(info.name, "new-lab");
        assert!(!info.has_obsidian_config);
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0, "a new vault starts empty");
        assert_eq!(
            remembered(&s.settings()).unwrap(),
            PathBuf::from(path::strip_verbatim(&std::fs::canonicalize(&target).unwrap()))
        );
    }

    #[test]
    fn create_refuses_a_missing_parent_and_a_relative_path() {
        let s = Scratch::new();
        let state = VaultState::default();
        let deep = s.vault().join("no").join("such").join("lab");
        assert!(create_at(&state, &s.settings(), &deep.to_string_lossy()).is_err());
        assert!(!s.vault().join("no").exists(), "no parent chain is created");
        assert!(create_at(&state, &s.settings(), "lab").is_err());
        assert!(create_at(&state, &s.settings(), "").is_err());
        assert!(matches!(state.root(), Err(fs::FsError::NoVault)));
    }

    #[test]
    fn create_over_an_existing_obsidian_vault_opens_it_untouched() {
        let s = Scratch::new();
        let state = VaultState::default();
        std::fs::create_dir(s.vault().join(".obsidian")).unwrap();
        std::fs::write(s.vault().join(".obsidian").join("app.json"), "{}").unwrap();
        std::fs::write(s.vault().join("a.md"), "keep").unwrap();
        let info = create_at(&state, &s.settings(), &s.vault().to_string_lossy()).unwrap();
        assert!(info.has_obsidian_config);
        assert_eq!(std::fs::read_to_string(s.vault().join(".obsidian/app.json")).unwrap(), "{}");
        assert_eq!(std::fs::read_to_string(s.vault().join("a.md")).unwrap(), "keep");
    }

    #[test]
    fn open_refuses_obsidian_itself_as_the_vault() {
        let s = Scratch::new();
        let state = VaultState::default();
        std::fs::create_dir(s.vault().join(".obsidian")).unwrap();
        std::fs::write(s.vault().join(".obsidian").join("app.json"), "{}").unwrap();
        let r = open(&s, &state, &s.vault().join(".obsidian"));
        assert!(matches!(r, Err(fs::FsError::Forbidden)));
        assert!(matches!(state.root(), Err(fs::FsError::NoVault)));
        assert!(!s.settings().exists(), "a refused folder is not remembered");
    }

    #[test]
    fn create_never_writes_inside_obsidian() {
        let s = Scratch::new();
        let state = VaultState::default();
        std::fs::create_dir(s.vault().join(".obsidian")).unwrap();
        for p in [s.vault().join(".obsidian").join("sub"), s.vault().join(".OBSIDIAN").join("sub")] {
            assert!(matches!(
                create_at(&state, &s.settings(), &p.to_string_lossy()),
                Err(fs::FsError::Forbidden)
            ));
        }
        assert_eq!(std::fs::read_dir(s.vault().join(".obsidian")).unwrap().count(), 0);
    }

    #[test]
    fn open_reports_existing_obsidian_vault() {
        let s = Scratch::new();
        let state = VaultState::default();
        assert!(!open(&s, &state, &s.vault()).unwrap().has_obsidian_config);
        std::fs::create_dir(s.vault().join(".obsidian")).unwrap();
        std::fs::write(s.vault().join(".obsidian").join("app.json"), "{}").unwrap();
        let info = open(&s, &state, &s.vault()).unwrap();
        assert!(info.has_obsidian_config);
        assert_eq!(info.name, "vault");
        assert!(!info.root.starts_with(r"\\?\"), "display root has no verbatim prefix");
        // Looking must not touch: the folder holds exactly what we put there.
        let names: Vec<_> = std::fs::read_dir(s.vault().join(".obsidian"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["app.json"]);
        assert_eq!(std::fs::read_to_string(s.vault().join(".obsidian/app.json")).unwrap(), "{}");
    }

    #[test]
    fn open_sweeps_orphaned_temp_files() {
        let s = Scratch::new();
        let state = VaultState::default();
        let tmp = s.vault().join(".n.labnote.md.1.2.labnote-tmp");
        std::fs::write(&tmp, "orphan").unwrap();
        open(&s, &state, &s.vault()).unwrap();
        assert!(!tmp.exists());
    }

    #[test]
    fn open_lifts_the_no_vault_refusal() {
        let s = Scratch::new();
        let state = VaultState::default();
        assert!(matches!(state.root(), Err(fs::FsError::NoVault)));
        open(&s, &state, &s.vault()).unwrap();
        assert!(state.root().is_ok());
    }

    #[test]
    fn current_returns_last_opened_after_restart() {
        let s = Scratch::new();
        let first = VaultState::default();
        let opened = open(&s, &first, &s.vault()).unwrap();
        let restarted = VaultState::default();
        assert_eq!(current_at(&restarted, &s.settings()), Some(opened));
        assert!(restarted.root().is_ok(), "restoring also lifts noVault");
    }

    #[test]
    fn current_is_none_when_nothing_was_remembered() {
        let s = Scratch::new();
        assert_eq!(current_at(&VaultState::default(), &s.settings()), None);
    }

    #[test]
    fn current_is_none_when_the_remembered_folder_is_gone_or_now_a_file() {
        let s = Scratch::new();
        open(&s, &VaultState::default(), &s.vault()).unwrap();
        // Renamed / deleted / unplugged drive: the path no longer exists.
        std::fs::rename(s.vault(), s.0.join("moved")).unwrap();
        let state = VaultState::default();
        assert_eq!(current_at(&state, &s.settings()), None);
        assert!(matches!(state.root(), Err(fs::FsError::NoVault)));
        // Same path, now a file.
        std::fs::write(s.vault(), "not a folder").unwrap();
        assert_eq!(current_at(&state, &s.settings()), None);
        // The memory is kept, so a reconnected drive is found again.
        std::fs::remove_file(s.vault()).unwrap();
        std::fs::rename(s.0.join("moved"), s.vault()).unwrap();
        assert!(current_at(&VaultState::default(), &s.settings()).is_some());
    }

    #[test]
    fn current_is_none_when_the_settings_file_is_unusable() {
        let s = Scratch::new();
        std::fs::create_dir_all(s.settings().parent().unwrap()).unwrap();
        for junk in ["", "{", "[]", "null", r#"{"lastVault": 7}"#, r#"{"lastVault": ""}"#, "\u{0}\u{1}"] {
            std::fs::write(s.settings(), junk).unwrap();
            assert_eq!(current_at(&VaultState::default(), &s.settings()), None, "{junk:?}");
        }
        // Not UTF-8 at all.
        std::fs::write(s.settings(), [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(current_at(&VaultState::default(), &s.settings()), None);
        // A directory where the file should be.
        std::fs::remove_file(s.settings()).unwrap();
        std::fs::create_dir(s.settings()).unwrap();
        assert_eq!(current_at(&VaultState::default(), &s.settings()), None);
    }

    #[test]
    fn open_still_succeeds_when_the_choice_cannot_be_remembered() {
        let s = Scratch::new();
        // The settings folder is blocked by a file of the same name.
        std::fs::write(s.0.join("config"), "x").unwrap();
        let state = VaultState::default();
        assert!(open(&s, &state, &s.vault()).is_ok());
        assert!(state.root().is_ok());
    }

    #[test]
    fn current_prefers_the_vault_already_open() {
        let s = Scratch::new();
        let state = VaultState::default();
        let a = open(&s, &state, &s.vault()).unwrap();
        std::fs::remove_file(s.settings()).unwrap();
        assert_eq!(current_at(&state, &s.settings()), Some(a));
    }
}
