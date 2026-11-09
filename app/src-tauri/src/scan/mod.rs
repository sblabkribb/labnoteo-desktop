//! The scan folder (SP7 B4): a folder outside (or, shared only, inside) the
//! vault that a scanner or a sync client drops page images into. Rust holds
//! it: the native picker chooses it, `folder.json` in the app data dir keeps
//! it per vault and per PC, and only Rust lists, reads, moves and watches it.
//! The webview never names a path; every command that acts on a file takes a
//! bare file name, checked before anything else.

pub mod folder;
pub mod watch;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::State;

pub use folder::*;

use crate::net::{IntegrationDirs, NetError, NetErrorKind};
use crate::vault::path::strip_verbatim;
use crate::vault::VaultState;

/// The event the webview listens for; payload `{}`.
pub const FOLDER_EVENT: &str = "scan://folder-changed";

/// What `FOLDER_EVENT` carries: nothing, it only asks for a look.
pub fn folder_changed_payload() -> serde_json::Value {
    serde_json::json!({})
}

/// The one running scan-folder watcher. `inert()` never starts a real one
/// (the IPC test), like `WatcherState::inert()`.
pub struct ScanFolderState {
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    inert: bool,
}

impl Default for ScanFolderState {
    fn default() -> Self {
        ScanFolderState { watcher: Mutex::new(None), inert: false }
    }
}

impl ScanFolderState {
    pub fn inert() -> Self {
        ScanFolderState { watcher: Mutex::new(None), inert: true }
    }

    /// Stops the running watcher, then watches `folder` (when there is one)
    /// and calls `sink` once per settled burst. A folder that cannot be
    /// watched (missing, a share without notifications) is left to the
    /// webview's 30 s poll.
    pub fn restart_with(&self, folder: Option<&Path>, sink: impl FnMut() + Send + 'static) {
        let mut cur = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        *cur = None;
        let Some(folder) = folder else { return };
        if self.inert {
            return;
        }
        match watch::start(folder, sink) {
            Ok(w) => *cur = Some(w),
            Err(e) => eprintln!("labnoteO: could not watch the scan folder: {e}"),
        }
    }

    /// `restart_with` that tells the window on `FOLDER_EVENT`.
    pub fn restart<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>, folder: Option<&Path>) {
        use tauri::Emitter;
        let app = app.clone();
        self.restart_with(folder, move || {
            let _ = app.emit(FOLDER_EVENT, folder_changed_payload());
        });
    }

    pub fn stop(&self) {
        *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    #[cfg(test)]
    fn is_watching(&self) -> bool {
        self.watcher.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }
}

fn bad_name() -> NetError {
    NetError::new(NetErrorKind::BadInput, "not a scan file name")
}

fn no_vault() -> NetError {
    NetError::new(NetErrorKind::NotConfigured, "no vault is open")
}

fn no_folder() -> NetError {
    NetError::new(NetErrorKind::NotConfigured, "no scan folder is set")
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// The integrations folder and the open vault's root, or `notConfigured`.
fn paths(vault: &VaultState, dirs: &IntegrationDirs) -> Result<(PathBuf, PathBuf), NetError> {
    let root = vault.root().map_err(|_| no_vault())?;
    Ok((dirs.0.clone(), root))
}

/// The folder in force for `root`, or `notConfigured`.
fn configured(dirs: &Path, root: &Path) -> Result<FolderConfig, NetError> {
    load_config(dirs, root)?.ok_or_else(no_folder)
}

/// Folder work can block (a slow share, a 200 MB scan): keep it off the async runtime.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, NetError> + Send + 'static) -> Result<T, NetError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| NetError::new(NetErrorKind::Io, format!("scan folder task failed: {e}")))?
}

/// Picks a folder in Rust's own dialog and stores it with its baseline.
/// Cancel keeps the old folder. The vault folder itself is refused, and a
/// folder inside the vault is stored as Shared.
#[tauri::command]
pub async fn scan_folder_choose<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
    state: State<'_, ScanFolderState>,
) -> Result<ScanFolderStatus, NetError> {
    use tauri_plugin_dialog::DialogExt;
    let (dirs, root) = paths(&vault, &dirs)?;
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || dialog_app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|e| NetError::new(NetErrorKind::Io, format!("folder picker failed: {e}")))?;
    let Some(picked) = picked else {
        let (d, r) = (dirs.clone(), root.clone());
        return blocking(move || status_at(&d, &r)).await;
    };
    let folder = picked
        .into_path()
        .map_err(|_| NetError::new(NetErrorKind::BadInput, "the chosen folder is not a local path"))?;
    let (d, r, f) = (dirs.clone(), root.clone(), folder.clone());
    let status = blocking(move || {
        if is_vault_root(&r, &f) {
            return Err(NetError::new(NetErrorKind::BadInput, "the vault folder itself cannot be the scan folder"));
        }
        let shown = strip_verbatim(&std::fs::canonicalize(&f).unwrap_or_else(|_| f.clone()));
        let cfg = new_config(shown, ScanMode::Dedicated, is_inside(&r, &f), now_ms());
        save_config(&d, &r, &cfg)?;
        status_at(&d, &r)
    })
    .await?;
    state.restart(&app, Some(&folder));
    Ok(status)
}

/// Forgets the folder for this vault and stops watching it.
#[tauri::command]
pub async fn scan_folder_clear(
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
    state: State<'_, ScanFolderState>,
) -> Result<(), NetError> {
    let (dirs, root) = paths(&vault, &dirs)?;
    blocking(move || clear_config(&dirs, &root)).await?;
    state.stop();
    Ok(())
}

/// Changes the mode only: `since` and the baseline stay.
#[tauri::command]
pub async fn scan_folder_set_mode(
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
    mode: ScanMode,
) -> Result<(), NetError> {
    let (dirs, root) = paths(&vault, &dirs)?;
    blocking(move || {
        let cfg = configured(&dirs, &root)?;
        let next = with_mode(&cfg, mode, is_inside(&root, Path::new(&cfg.path)))?;
        save_config(&dirs, &root, &next)
    })
    .await
}

#[tauri::command]
pub async fn scan_folder_status(
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
) -> Result<ScanFolderStatus, NetError> {
    let (dirs, root) = paths(&vault, &dirs)?;
    blocking(move || status_at(&dirs, &root)).await
}

#[tauri::command]
pub async fn scan_folder_list(
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
) -> Result<Vec<ScanEntry>, NetError> {
    let (dirs, root) = paths(&vault, &dirs)?;
    blocking(move || list(Path::new(&configured(&dirs, &root)?.path))).await
}

/// Drops the baseline keys not in `present`, saves when that changed, and
/// answers the baseline now in force.
#[tauri::command]
pub async fn scan_folder_prune_baseline(
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
    present: Vec<String>,
) -> Result<Option<Vec<String>>, NetError> {
    let (dirs, root) = paths(&vault, &dirs)?;
    blocking(move || {
        let cfg = configured(&dirs, &root)?;
        match prune_baseline(&cfg, &present) {
            Some(next) => {
                save_config(&dirs, &root, &next)?;
                Ok(next.baseline)
            }
            None => Ok(cfg.baseline),
        }
    })
    .await
}

#[tauri::command]
pub async fn scan_folder_read(
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
    name: String,
) -> Result<tauri::ipc::Response, NetError> {
    if !scan_name_ok(&name) {
        return Err(bad_name());
    }
    let (dirs, root) = paths(&vault, &dirs)?;
    let bytes = blocking(move || read(Path::new(&configured(&dirs, &root)?.path), &name)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Moves an original into `labnote-processed` or `labnote-failed`, never
/// replacing a file there. A shared folder never moves anything, and neither
/// does a folder inside the vault, whatever its stored mode says.
#[tauri::command]
pub async fn scan_folder_move(
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
    name: String,
    outcome: ScanOutcome,
) -> Result<String, NetError> {
    if !scan_name_ok(&name) {
        return Err(bad_name());
    }
    let (dirs, root) = paths(&vault, &dirs)?;
    blocking(move || {
        let cfg = configured(&dirs, &root)?;
        let folder = PathBuf::from(&cfg.path);
        if cfg.mode == ScanMode::Shared || is_inside(&root, &folder) {
            return Err(NetError::new(NetErrorKind::BadInput, "a shared scan folder is never moved from"));
        }
        move_original(&folder, &name, outcome)
    })
    .await
}

/// (Re)starts the watcher for the open vault's folder; called on vault open.
/// No folder stops it.
#[tauri::command]
pub async fn scan_folder_watch<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
    state: State<'_, ScanFolderState>,
) -> Result<(), NetError> {
    let (dirs, root) = paths(&vault, &dirs)?;
    let cfg = blocking(move || load_config(&dirs, &root)).await?;
    state.restart(&app, cfg.as_ref().map(|c| Path::new(&c.path)));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-scan-{}-{}",
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

    fn cfg_with(baseline: &[&str]) -> FolderConfig {
        FolderConfig {
            path: "D:/scans".into(),
            mode: ScanMode::Dedicated,
            since: 1.0,
            baseline: Some(baseline.iter().map(|s| s.to_string()).collect()),
        }
    }

    #[test]
    fn scan_commands_refuse_separators_dotdot_and_unlisted_names() {
        for n in ["../a.jpg", "a/b.jpg", "a\\b.jpg", "C:a.jpg", "..", ".hidden.jpg", "note.md", "a.exe", "a\u{7}.jpg", ""] {
            assert!(!scan_name_ok(n), "{n}");
        }
        assert!(!scan_name_ok(&format!("{}.jpg", "a".repeat(252))), "over 255 bytes");
        assert!(scan_name_ok(&format!("{}.jpg", "a".repeat(251))), "255 bytes");
        assert!(scan_name_ok("Scan 001.PDF"));
        for n in ["a.jpeg", "a.png", "a.webp", "a.gif", "a.bmp", "a.zip", "a.heic", "a.heif", "a.tif", "a.TIFF", "스캔.jpg"] {
            assert!(scan_name_ok(n), "{n}");
        }
        let t = Tmp::new();
        std::fs::write(t.0.join("x.md"), "secret").unwrap();
        assert_eq!(read(&t.0, "x.md").unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(read(&t.0, "../x.jpg").unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(move_original(&t.0, "../x.jpg", ScanOutcome::Processed).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(move_original(&t.0, "x.md", ScanOutcome::Failed).unwrap_err().kind, NetErrorKind::BadInput);
        assert!(t.0.join("x.md").exists());
    }

    #[test]
    fn list_returns_top_level_scan_files_only() {
        let t = Tmp::new();
        std::fs::write(t.0.join("a.jpg"), "abc").unwrap();
        std::fs::create_dir(t.0.join("sub")).unwrap();
        std::fs::write(t.0.join("sub").join("b.jpg"), "abc").unwrap();
        std::fs::write(t.0.join("c.txt"), "abc").unwrap();
        std::fs::create_dir(t.0.join(PROCESSED_DIR)).unwrap();
        std::fs::write(t.0.join(PROCESSED_DIR).join("d.jpg"), "abc").unwrap();
        std::fs::create_dir(t.0.join("dir.jpg")).unwrap();
        let v = list(&t.0).unwrap();
        assert_eq!(v.len(), 1, "{:?}", v.iter().map(|e| &e.name).collect::<Vec<_>>());
        assert_eq!(v[0].name, "a.jpg");
        assert_eq!(v[0].size, 3);
        assert!(v[0].mtime_ms > 1.6e12);
        let wire = serde_json::to_value(&v[0]).unwrap();
        assert!(wire.get("mtimeMs").is_some() && wire.get("birthtimeMs").is_some(), "{wire}");
    }

    #[test]
    fn list_is_sorted_by_name_and_a_missing_folder_is_io() {
        let t = Tmp::new();
        for n in ["c.jpg", "a.png", "b.pdf"] {
            std::fs::write(t.0.join(n), "x").unwrap();
        }
        let names: Vec<_> = list(&t.0).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["a.png", "b.pdf", "c.jpg"]);
        assert_eq!(list(&t.0.join("missing")).unwrap_err().kind, NetErrorKind::Io);
        assert!(baseline_of(&t.0.join("missing")).is_empty());
    }

    #[test]
    fn history_key_is_name_size_and_rounded_mtime() {
        let e = ScanEntry { name: "a.jpg".into(), size: 3, mtime_ms: 1000.6, birthtime_ms: None };
        assert_eq!(history_key(&e), "a.jpg|3|1001");
    }

    #[test]
    fn choose_records_the_baseline_and_a_mode_change_keeps_it() {
        let t = Tmp::new();
        std::fs::write(t.0.join("old.jpg"), "abc").unwrap();
        let cfg = new_config(t.0.to_string_lossy().into(), ScanMode::Dedicated, false, 5.0);
        let key = history_key(&list(&t.0).unwrap()[0]);
        assert_eq!(cfg.baseline.as_deref(), Some(&[key.clone()][..]));
        assert_eq!(cfg.since, 5.0);
        let shared = with_mode(&cfg, ScanMode::Shared, false).unwrap();
        assert_eq!(shared.baseline, cfg.baseline);
        assert_eq!(shared.since, 5.0);
        assert_eq!(shared.mode, ScanMode::Shared);
        assert_eq!(shared.path, cfg.path);
        // A folder that does not exist yet starts with an empty baseline.
        let missing = new_config(t.0.join("later").to_string_lossy().into(), ScanMode::Dedicated, false, 1.0);
        assert_eq!(missing.baseline, Some(vec![]));
    }

    #[test]
    fn a_removed_file_leaves_the_baseline() {
        let cfg = cfg_with(&["a|3|1000", "b|3|1000"]);
        let next = prune_baseline(&cfg, &["b|3|1000".into()]).expect("a key was dropped");
        assert_eq!(next.baseline, Some(vec!["b|3|1000".to_string()]));
        assert_eq!((next.since, next.mode, next.path.as_str()), (1.0, ScanMode::Dedicated, "D:/scans"));
        assert!(prune_baseline(&next, &["b|3|1000".into()]).is_none());
        // A hand-made file without a baseline has nothing to prune.
        let none = FolderConfig { baseline: None, ..cfg };
        assert!(prune_baseline(&none, &[]).is_none());
    }

    #[test]
    fn dedicated_mode_is_refused_for_a_folder_inside_the_vault() {
        let t = Tmp::new();
        let inner = t.0.join("scans");
        std::fs::create_dir(&inner).unwrap();
        assert!(is_inside(&t.0, &inner));
        assert!(is_vault_root(&t.0, &t.0));
        assert!(!is_vault_root(&t.0, &inner));
        let other = Tmp::new();
        assert!(!is_inside(&t.0, &other.0));
        // A sibling whose name starts with the vault's is not inside it.
        let sibling = PathBuf::from(format!("{}-x", t.0.to_string_lossy()));
        std::fs::create_dir(&sibling).unwrap();
        assert!(!is_inside(&t.0, &sibling));
        let _ = std::fs::remove_dir_all(&sibling);
        let cfg = new_config(inner.to_string_lossy().into(), ScanMode::Dedicated, true, 1.0);
        assert_eq!(cfg.mode, ScanMode::Shared);
        assert_eq!(with_mode(&cfg, ScanMode::Dedicated, true).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(with_mode(&cfg, ScanMode::Shared, true).unwrap().mode, ScanMode::Shared);
    }

    #[test]
    fn move_never_replaces_an_existing_target_and_refuses_a_junctioned_subfolder() {
        let t = Tmp::new();
        std::fs::create_dir(t.0.join(PROCESSED_DIR)).unwrap();
        std::fs::write(t.0.join(PROCESSED_DIR).join("a.jpg"), "old").unwrap();
        std::fs::write(t.0.join("a.jpg"), "new").unwrap();
        assert_eq!(move_original(&t.0, "a.jpg", ScanOutcome::Processed).unwrap(), "a_2.jpg");
        assert_eq!(std::fs::read_to_string(t.0.join(PROCESSED_DIR).join("a.jpg")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(t.0.join(PROCESSED_DIR).join("a_2.jpg")).unwrap(), "new");
        assert!(!t.0.join("a.jpg").exists());
        // The next one with that name takes the next free suffix.
        std::fs::write(t.0.join("a.jpg"), "third").unwrap();
        assert_eq!(move_original(&t.0, "a.jpg", ScanOutcome::Processed).unwrap(), "a_3.jpg");
        // A missing subfolder is created.
        std::fs::write(t.0.join("c.pdf"), "c").unwrap();
        assert_eq!(move_original(&t.0, "c.pdf", ScanOutcome::Failed).unwrap(), "c.pdf");
        assert_eq!(std::fs::read_to_string(t.0.join(FAILED_DIR).join("c.pdf")).unwrap(), "c");
        // A missing source is io, not a silent success.
        assert_eq!(move_original(&t.0, "gone.jpg", ScanOutcome::Processed).unwrap_err().kind, NetErrorKind::Io);

        #[cfg(windows)]
        {
            let t = Tmp::new();
            let elsewhere = Tmp::new();
            std::fs::write(t.0.join("b.jpg"), "b").unwrap();
            let out = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(t.0.join(FAILED_DIR))
                .arg(&elsewhere.0)
                .output();
            match out {
                Ok(o) if o.status.success() => {
                    assert_eq!(move_original(&t.0, "b.jpg", ScanOutcome::Failed).unwrap_err().kind, NetErrorKind::ForbiddenPath);
                    assert_eq!(std::fs::read_dir(&elsewhere.0).unwrap().count(), 0);
                    assert!(t.0.join("b.jpg").exists());
                    let _ = std::fs::remove_dir(t.0.join(FAILED_DIR));
                }
                _ => println!("note: mklink /J failed here; the junction half of this test was skipped"),
            }
        }
    }

    #[test]
    fn move_falls_back_to_a_copy_that_never_replaces() {
        let t = Tmp::new();
        let sub = t.0.join(PROCESSED_DIR);
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("a.jpg"), "old").unwrap();
        std::fs::write(t.0.join("a.jpg"), "new").unwrap();
        let unsupported = |_: &Path, _: &Path| Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no links"));
        assert_eq!(move_original_with(&t.0, "a.jpg", ScanOutcome::Processed, unsupported).unwrap(), "a_2.jpg");
        assert_eq!(std::fs::read_to_string(sub.join("a.jpg")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(sub.join("a_2.jpg")).unwrap(), "new");
        assert!(!t.0.join("a.jpg").exists());
    }

    #[test]
    fn read_returns_the_bytes_and_refuses_over_the_cap() {
        let t = Tmp::new();
        std::fs::write(t.0.join("a.png"), [1u8, 2, 3]).unwrap();
        assert_eq!(read(&t.0, "a.png").unwrap(), vec![1, 2, 3]);
        assert_eq!(read(&t.0, "missing.png").unwrap_err().kind, NetErrorKind::Io);
        let big = std::fs::File::create(t.0.join("big.pdf")).unwrap();
        big.set_len(MAX_SCAN_FILE_BYTES + 1).unwrap();
        drop(big);
        assert_eq!(read(&t.0, "big.pdf").unwrap_err().kind, NetErrorKind::TooLarge);
    }

    #[test]
    fn read_refuses_a_symlink() {
        #[cfg(windows)]
        {
            let t = Tmp::new();
            let elsewhere = Tmp::new();
            std::fs::write(elsewhere.0.join("secret.jpg"), "secret").unwrap();
            match std::os::windows::fs::symlink_file(elsewhere.0.join("secret.jpg"), t.0.join("a.jpg")) {
                Ok(()) => {
                    assert_eq!(read(&t.0, "a.jpg").unwrap_err().kind, NetErrorKind::ForbiddenPath);
                    assert!(list(&t.0).unwrap().is_empty(), "a link is not listed either");
                    let _ = std::fs::remove_file(t.0.join("a.jpg"));
                }
                Err(e) => println!("note: could not create a symlink here ({e}); the symlink half was skipped"),
            }
            // A junction (no privilege needed) named like a scan is never read or listed.
            let out = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(t.0.join("j.jpg"))
                .arg(&elsewhere.0)
                .output();
            match out {
                Ok(o) if o.status.success() => {
                    assert!(read(&t.0, "j.jpg").is_err());
                    assert!(list(&t.0).unwrap().iter().all(|e| e.name != "j.jpg"));
                    assert!(move_original(&t.0, "j.jpg", ScanOutcome::Processed).is_err());
                    assert!(elsewhere.0.join("secret.jpg").exists());
                    let _ = std::fs::remove_dir(t.0.join("j.jpg"));
                }
                _ => println!("note: mklink /J failed here; the junction half was skipped"),
            }
        }
    }

    #[test]
    fn config_is_per_vault_and_never_written_from_webview_args() {
        let dirs = Tmp::new();
        let a = Tmp::new();
        let b = Tmp::new();
        let scans = Tmp::new();
        let cfg = new_config(scans.0.to_string_lossy().into(), ScanMode::Dedicated, false, 7.0);
        save_config(&dirs.0, &a.0, &cfg).unwrap();
        assert!(config_file(&dirs.0, &a.0).starts_with(dirs.0.join("scan")));
        let sa = status_at(&dirs.0, &a.0).unwrap();
        assert_eq!(sa.path.as_deref(), Some(cfg.path.as_str()));
        assert!(sa.exists && !sa.inside_vault);
        assert_eq!((sa.mode, sa.since), (ScanMode::Dedicated, Some(7.0)));
        let sb = status_at(&dirs.0, &b.0).unwrap();
        assert_eq!(sb.path, None);
        assert_eq!(
            serde_json::to_value(&sb).unwrap(),
            serde_json::json!({"path": null, "mode": "dedicated", "exists": false, "insideVault": false, "since": null, "baseline": null})
        );
        // Nothing lands in either vault.
        assert_eq!(std::fs::read_dir(&a.0).unwrap().count(), 0);
        // Clear forgets it; clearing twice is fine.
        clear_config(&dirs.0, &a.0).unwrap();
        clear_config(&dirs.0, &a.0).unwrap();
        assert_eq!(status_at(&dirs.0, &a.0).unwrap().path, None);
        // A hand-made file without a baseline reads as `None`.
        std::fs::create_dir_all(config_file(&dirs.0, &a.0).parent().unwrap()).unwrap();
        std::fs::write(config_file(&dirs.0, &a.0), r#"{"path":"D:/s","mode":"shared","since":3}"#).unwrap();
        assert_eq!(load_config(&dirs.0, &a.0).unwrap().unwrap().baseline, None);
        // No scan command takes a path from the webview.
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../tests/ipc-args.json")).unwrap();
        let mut scan_cmds = 0;
        for (cmd, names) in fixture.as_object().unwrap() {
            if cmd.starts_with("scan_folder_") {
                scan_cmds += 1;
                for n in names.as_array().unwrap() {
                    let n = n.as_str().unwrap().to_lowercase();
                    assert!(!n.contains("path") && !n.contains("dir") && !n.contains("folder"), "{cmd} takes {n}");
                }
            }
        }
        assert_eq!(scan_cmds, 9);
    }

    #[test]
    fn watcher_emits_once_per_burst() {
        let t = Tmp::new();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let w = watch::start(&t.0, move || {
            c.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        for i in 0..5 {
            std::fs::write(t.0.join(format!("p{i}.jpg")), "x").unwrap();
            std::thread::sleep(Duration::from_millis(15));
        }
        std::thread::sleep(Duration::from_millis(1500));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(w);
    }

    #[test]
    fn an_inert_state_never_watches_and_restart_replaces_the_watcher() {
        let t = Tmp::new();
        let inert = ScanFolderState::inert();
        inert.restart_with(Some(&t.0), || {});
        assert!(!inert.is_watching());
        let live = ScanFolderState::default();
        live.restart_with(Some(&t.0), || {});
        assert!(live.is_watching());
        live.restart_with(None, || {});
        assert!(!live.is_watching());
        live.restart_with(Some(&t.0.join("missing")), || {});
        assert!(!live.is_watching(), "a missing folder is left to the poll");
    }
}
