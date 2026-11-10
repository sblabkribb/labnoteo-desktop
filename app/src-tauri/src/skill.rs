//! The labnoteO SKILL.md installer (steps 4 + 5, spec §12).
//!
//! Rust writes only the embedded `SKILL_TEXT`, and only on an explicit click:
//! to `<home>/.claude/skills/labnoteo/SKILL.md` (`skill_install`) or to a path
//! the user picks in Rust's own save dialog (`skill_save_as`). The webview never
//! sends content or a path for a write, so a compromised webview cannot write
//! arbitrary text into `~/.claude` or anywhere else.
//!
//! Safety rules:
//! - a differing file is replaced only with `overwrite`, otherwise `exists`;
//! - `.claude/skills`, `.claude/skills/labnoteo` and `SKILL.md` must not be a
//!   symlink or junction (`symlink`); `.claude` and the home folder may be links,
//!   since dotfile setups do this;
//! - writes go to a temp file in the same folder, then a rename;
//! - nothing is ever deleted (except our own temp file after a failed write).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

/// The single source, shared with the webview (`src/labnote/skill/skillText.ts`).
pub const SKILL_TEXT: &str = include_str!("../resources/skills/labnoteo/SKILL.md");

/// Where the home folder is. Managed state: `run()` builds it from the
/// environment; tests always manage a temp home.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillPaths {
    pub home: Option<PathBuf>,
}

impl SkillPaths {
    /// `USERPROFILE`, then `HOME`; with neither, commands fail with `noHome`.
    pub fn from_env() -> SkillPaths {
        SkillPaths::from_vars(std::env::var_os("USERPROFILE"), std::env::var_os("HOME"))
    }

    /// `from_env` over given values (an empty value counts as unset).
    pub fn from_vars(userprofile: Option<OsString>, home: Option<OsString>) -> SkillPaths {
        let pick = |v: Option<OsString>| v.filter(|s| !s.is_empty()).map(PathBuf::from);
        SkillPaths { home: pick(userprofile).or_else(|| pick(home)) }
    }
}

/// Shows the save dialog and returns the picked path, or `None` on cancel.
/// Blocking: commands call it inside `spawn_blocking`. Tests use a closure.
#[derive(Clone)]
pub struct SkillPicker(pub Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>);

impl SkillPicker {
    /// The production picker: the dialog plugin's save dialog (default name
    /// `SKILL.md`), modal to the main window, as `scan_folder_choose` does.
    pub fn dialog<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> SkillPicker {
        SkillPicker(Arc::new(move || {
            use tauri::Manager;
            use tauri_plugin_dialog::DialogExt;
            let mut builder = app.dialog().file().set_file_name("SKILL.md").add_filter("Markdown", &["md"]);
            if let Some(window) = app.get_webview_window("main") {
                builder = builder.set_parent(&window);
            }
            builder.blocking_save_file().and_then(|p| p.into_path().ok())
        }))
    }
}

/// What a skill command rejects with. The `kind` strings are pinned in
/// `tests/ipc-skill-errors.json` and mirrored in `src/labnote/skill/skillIpc.ts`.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkillErrorKind {
    Exists,
    Symlink,
    NoHome,
    Io,
}

/// `{kind, message}`, the same shape as the other error types.
#[derive(Serialize, Debug)]
pub struct SkillError {
    pub kind: SkillErrorKind,
    pub message: String,
}

impl SkillError {
    pub fn new(kind: SkillErrorKind, message: impl Into<String>) -> SkillError {
        SkillError { kind, message: message.into() }
    }
}

fn io(what: &str, path: &Path, e: std::io::Error) -> SkillError {
    SkillError::new(SkillErrorKind::Io, format!("{what} {}: {e}", path.display()))
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillStatus {
    pub target: String,
    pub exists: bool,
    pub same: bool,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub written: bool,
}

/// `<home>/.claude/skills/labnoteo/SKILL.md`.
pub fn target(paths: &SkillPaths) -> Result<PathBuf, SkillError> {
    let home = paths
        .home
        .as_ref()
        .ok_or_else(|| SkillError::new(SkillErrorKind::NoHome, "no home folder (USERPROFILE / HOME is not set)"))?;
    Ok(home.join(".claude").join("skills").join("labnoteo").join("SKILL.md"))
}

/// Whether the target exists and holds exactly `SKILL_TEXT`. Reads only;
/// never creates anything.
pub fn status(paths: &SkillPaths) -> Result<SkillStatus, SkillError> {
    let file = target(paths)?;
    let shown = file.to_string_lossy().into_owned();
    match std::fs::read(&file) {
        Ok(bytes) => Ok(SkillStatus { target: shown, exists: true, same: bytes == SKILL_TEXT.as_bytes() }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SkillStatus { target: shown, exists: false, same: false }),
        Err(e) => Err(io("cannot read", &file, e)),
    }
}

/// Refuses a link; `Ok(false)` when nothing is there.
fn present_not_link(path: &Path) -> Result<bool, SkillError> {
    match std::fs::symlink_metadata(path) {
        // On Windows this covers name-surrogate reparse points: symlinks and junctions.
        Ok(m) if m.file_type().is_symlink() => Err(SkillError::new(
            SkillErrorKind::Symlink,
            format!("{} is a link; refusing to write through it", path.display()),
        )),
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(io("cannot inspect", path, e)),
    }
}

/// Makes `dir` (one level) when missing; refuses a link and a non-folder.
fn ensure_dir_not_link(dir: &Path) -> Result<(), SkillError> {
    if !present_not_link(dir)? {
        match std::fs::create_dir(dir) {
            Ok(()) => {}
            // Made by someone else in between: check it again below.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(io("cannot create", dir, e)),
        }
        present_not_link(dir)?;
    }
    if !dir.is_dir() {
        return Err(SkillError::new(SkillErrorKind::Io, format!("{} is not a folder", dir.display())));
    }
    Ok(())
}

/// Installs `SKILL_TEXT` for Claude Code. Identical content gives
/// `written:false`; differing content needs `overwrite`, else `exists` and the
/// file is untouched.
pub fn install(paths: &SkillPaths, overwrite: bool) -> Result<InstallOutcome, SkillError> {
    let file = target(paths)?;
    let dir = file.parent().expect("target has a parent").to_path_buf();
    let skills = dir.parent().expect("target has a skills folder").to_path_buf();
    let claude = skills.parent().expect("target has a .claude folder").to_path_buf();
    // `.claude` (and the home) may be links; only make it when missing.
    if !claude.exists() {
        std::fs::create_dir_all(&claude).map_err(|e| io("cannot create", &claude, e))?;
    }
    ensure_dir_not_link(&skills)?;
    ensure_dir_not_link(&dir)?;
    if present_not_link(&file)? {
        let bytes = std::fs::read(&file).map_err(|e| io("cannot read", &file, e))?;
        if bytes == SKILL_TEXT.as_bytes() {
            return Ok(InstallOutcome { written: false });
        }
        if !overwrite {
            return Err(SkillError::new(
                SkillErrorKind::Exists,
                format!("{} exists with different content", file.display()),
            ));
        }
    }
    write_text_to(&file)?;
    Ok(InstallOutcome { written: true })
}

/// Writes `SKILL_TEXT` to `path`: a temp file in the same folder, then a
/// rename over the target. The temp file is removed when anything fails.
pub fn write_text_to(path: &Path) -> Result<(), SkillError> {
    use std::io::Write;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| SkillError::new(SkillErrorKind::Io, format!("{} has no folder", path.display())))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "SKILL.md".into());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(".{name}.{}-{nanos}.tmp", std::process::id()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| io("cannot create", &tmp, e))?;
        f.write_all(SKILL_TEXT.as_bytes()).map_err(|e| io("cannot write", &tmp, e))?;
        f.sync_all().map_err(|e| io("cannot write", &tmp, e))?;
        drop(f);
        std::fs::rename(&tmp, path).map_err(|e| io("cannot replace", path, e))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Asks the picker for a path and writes `SKILL_TEXT` there. Cancel gives
/// `Ok(None)` and writes nothing.
pub fn save_as(picker: &SkillPicker) -> Result<Option<PathBuf>, SkillError> {
    let Some(path) = (picker.0)() else { return Ok(None) };
    write_text_to(&path)?;
    Ok(Some(path))
}

/// File work and the dialog block: keep them off the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, SkillError> + Send + 'static,
) -> Result<T, SkillError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| SkillError::new(SkillErrorKind::Io, format!("skill task failed: {e}")))?
}

/// Where the skill would go and whether it is installed and up to date.
#[tauri::command]
pub async fn skill_status(paths: State<'_, SkillPaths>) -> Result<SkillStatus, SkillError> {
    let paths = paths.inner().clone();
    blocking(move || status(&paths)).await
}

/// Installs the embedded SKILL.md for Claude Code. Takes no content or path.
#[tauri::command]
pub async fn skill_install(paths: State<'_, SkillPaths>, overwrite: bool) -> Result<InstallOutcome, SkillError> {
    let paths = paths.inner().clone();
    blocking(move || install(&paths, overwrite)).await
}

/// Saves the embedded SKILL.md where the user picks in Rust's save dialog.
/// Returns the path written, or `None` on cancel. Takes no content or path.
#[tauri::command]
pub async fn skill_save_as(picker: State<'_, SkillPicker>) -> Result<Option<String>, SkillError> {
    let picker = picker.inner().clone();
    blocking(move || save_as(&picker).map(|p| p.map(|p| p.to_string_lossy().into_owned()))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    /// A fresh temp folder standing in for the home folder. Never the real home.
    struct TempHome(PathBuf);
    impl TempHome {
        fn new(tag: &str) -> TempHome {
            let n = SEQ.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!("labnoteo-skill-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempHome(dir)
        }
        fn paths(&self) -> SkillPaths {
            SkillPaths { home: Some(self.0.clone()) }
        }
        fn skill(&self) -> PathBuf {
            self.0.join(".claude").join("skills").join("labnoteo").join("SKILL.md")
        }
    }
    impl Drop for TempHome {
        fn drop(&mut self) {
            // Links are removed as links first, never followed.
            remove_links(&self.0);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn remove_links(dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            match std::fs::symlink_metadata(&p) {
                Ok(m) if m.file_type().is_symlink() => {
                    let _ = std::fs::remove_dir(&p).or_else(|_| std::fs::remove_file(&p));
                }
                Ok(m) if m.is_dir() => remove_links(&p),
                _ => {}
            }
        }
    }

    /// A folder link: a junction on Windows (no privilege needed), a symlink elsewhere.
    fn link_dir(link: &Path, target: &Path) -> bool {
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    fn tmp_files(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn the_embedded_text_is_the_skill_file() {
        assert!(SKILL_TEXT.starts_with("---"));
        assert!(SKILL_TEXT.contains("name: labnoteo"));
    }

    #[test]
    fn from_vars_prefers_userprofile_then_home_and_ignores_empty_values() {
        let up = Some(OsString::from("C:\\Users\\a"));
        let home = Some(OsString::from("/home/b"));
        assert_eq!(SkillPaths::from_vars(up, home.clone()).home, Some(PathBuf::from("C:\\Users\\a")));
        assert_eq!(SkillPaths::from_vars(None, home.clone()).home, Some(PathBuf::from("/home/b")));
        assert_eq!(SkillPaths::from_vars(Some("".into()), home).home, Some(PathBuf::from("/home/b")));
        assert_eq!(SkillPaths::from_vars(None, Some("".into())).home, None);
        assert_eq!(SkillPaths::from_vars(None, None).home, None);
    }

    #[test]
    fn target_is_under_dot_claude_skills_labnoteo() {
        let h = TempHome::new("target");
        assert_eq!(target(&h.paths()).unwrap(), h.skill());
    }

    #[test]
    fn a_fresh_install_creates_the_folders_and_writes_exactly_the_text() {
        let h = TempHome::new("fresh");
        assert_eq!(install(&h.paths(), false).unwrap(), InstallOutcome { written: true });
        assert_eq!(std::fs::read(h.skill()).unwrap(), SKILL_TEXT.as_bytes());
        assert!(tmp_files(h.skill().parent().unwrap()).is_empty());
    }

    #[test]
    fn identical_content_is_not_written_again() {
        let h = TempHome::new("same");
        install(&h.paths(), false).unwrap();
        assert_eq!(install(&h.paths(), false).unwrap(), InstallOutcome { written: false });
        assert_eq!(install(&h.paths(), true).unwrap(), InstallOutcome { written: false });
    }

    #[test]
    fn differing_content_needs_overwrite_and_is_left_untouched_without_it() {
        let h = TempHome::new("differs");
        std::fs::create_dir_all(h.skill().parent().unwrap()).unwrap();
        std::fs::write(h.skill(), b"my own skill").unwrap();
        assert_eq!(install(&h.paths(), false).unwrap_err().kind, SkillErrorKind::Exists);
        assert_eq!(std::fs::read(h.skill()).unwrap(), b"my own skill");
        assert_eq!(install(&h.paths(), true).unwrap(), InstallOutcome { written: true });
        assert_eq!(std::fs::read(h.skill()).unwrap(), SKILL_TEXT.as_bytes());
        assert!(tmp_files(h.skill().parent().unwrap()).is_empty(), "no temp file is left behind");
    }

    #[test]
    fn a_linked_skills_folder_is_refused_and_nothing_is_written_through_it() {
        let h = TempHome::new("link-skills");
        let elsewhere = h.0.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::create_dir_all(h.0.join(".claude")).unwrap();
        if !link_dir(&h.0.join(".claude").join("skills"), &elsewhere) {
            eprintln!("skipped: could not create a folder junction/symlink here");
            return;
        }
        assert_eq!(install(&h.paths(), true).unwrap_err().kind, SkillErrorKind::Symlink);
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0, "nothing was written through the link");
    }

    #[test]
    fn a_linked_labnoteo_folder_is_refused_and_nothing_is_written_through_it() {
        let h = TempHome::new("link-labnoteo");
        let elsewhere = h.0.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::create_dir_all(h.0.join(".claude").join("skills")).unwrap();
        if !link_dir(&h.0.join(".claude").join("skills").join("labnoteo"), &elsewhere) {
            eprintln!("skipped: could not create a folder junction/symlink here");
            return;
        }
        assert_eq!(install(&h.paths(), true).unwrap_err().kind, SkillErrorKind::Symlink);
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0, "nothing was written through the link");
    }

    #[test]
    fn a_linked_dot_claude_folder_is_allowed() {
        let h = TempHome::new("link-claude");
        let dotfiles = h.0.join("dotfiles-claude");
        std::fs::create_dir_all(&dotfiles).unwrap();
        if !link_dir(&h.0.join(".claude"), &dotfiles) {
            eprintln!("skipped: could not create a folder junction/symlink here");
            return;
        }
        assert_eq!(install(&h.paths(), false).unwrap(), InstallOutcome { written: true });
        let through = dotfiles.join("skills").join("labnoteo").join("SKILL.md");
        assert_eq!(std::fs::read(through).unwrap(), SKILL_TEXT.as_bytes());
    }

    #[test]
    fn no_home_gives_no_home() {
        let p = SkillPaths { home: None };
        assert_eq!(target(&p).unwrap_err().kind, SkillErrorKind::NoHome);
        assert_eq!(status(&p).unwrap_err().kind, SkillErrorKind::NoHome);
        assert_eq!(install(&p, true).unwrap_err().kind, SkillErrorKind::NoHome);
    }

    #[test]
    fn status_reports_absent_same_and_differs() {
        let h = TempHome::new("status");
        let shown = h.skill().to_string_lossy().into_owned();
        assert_eq!(status(&h.paths()).unwrap(), SkillStatus { target: shown.clone(), exists: false, same: false });
        assert!(!h.0.join(".claude").exists(), "status never creates anything");
        install(&h.paths(), false).unwrap();
        assert_eq!(status(&h.paths()).unwrap(), SkillStatus { target: shown.clone(), exists: true, same: true });
        std::fs::write(h.skill(), b"changed").unwrap();
        assert_eq!(status(&h.paths()).unwrap(), SkillStatus { target: shown, exists: true, same: false });
    }

    #[test]
    fn save_as_writes_the_text_to_the_picked_path_and_cancel_writes_nothing() {
        let h = TempHome::new("save-as");
        let picked = h.0.join("picked").join("SKILL.md");
        std::fs::create_dir_all(picked.parent().unwrap()).unwrap();
        let p = picked.clone();
        let picker = SkillPicker(Arc::new(move || Some(p.clone())));
        assert_eq!(save_as(&picker).unwrap(), Some(picked.clone()));
        assert_eq!(std::fs::read(&picked).unwrap(), SKILL_TEXT.as_bytes());
        assert!(tmp_files(picked.parent().unwrap()).is_empty());

        let cancel = SkillPicker(Arc::new(|| None));
        assert_eq!(save_as(&cancel).unwrap(), None);
        assert_eq!(std::fs::read_dir(picked.parent().unwrap()).unwrap().count(), 1, "cancel wrote nothing");
    }

    #[test]
    fn writing_into_a_missing_folder_is_io_and_leaves_nothing() {
        let h = TempHome::new("io");
        let e = write_text_to(&h.0.join("missing").join("SKILL.md")).unwrap_err();
        assert_eq!(e.kind, SkillErrorKind::Io);
        assert!(!h.0.join("missing").exists());
    }

    #[test]
    fn errors_serialize_as_kind_and_message() {
        let v = serde_json::to_value(SkillError::new(SkillErrorKind::NoHome, "m")).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "noHome", "message": "m"}));
    }
}
