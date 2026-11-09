//! The scan folder's files and its stored config, as plain functions over
//! paths so they can be tested on temp dirs. Commands (in `mod.rs`) add the
//! open vault and the stored folder.
//!
//! Only top-level files whose names pass `scan_name_ok` are ever listed,
//! read or moved, plus the two subfolders `labnote-processed` and
//! `labnote-failed`. A symlink or junction (a name-surrogate reparse point)
//! is never followed: `read` checks the opened handle, `move_original` the
//! subfolder and the source. Other reparse points are ordinary files here: a
//! OneDrive or Dropbox placeholder keeps `FILE_ATTRIBUTE_REPARSE_POINT` even
//! when downloaded, and a scan folder on a cloud drive is common. A move
//! never replaces a file.

use std::io::{ErrorKind, Read as _, Write as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::net::store::vault_dir;
use crate::net::{NetError, NetErrorKind};
use crate::vault::path::strip_verbatim;

pub const PROCESSED_DIR: &str = "labnote-processed";
pub const FAILED_DIR: &str = "labnote-failed";
/// The largest original read back to the webview (a long multi-page PDF fits).
pub const MAX_SCAN_FILE_BYTES: u64 = 200 * 1024 * 1024;

/// `IntegrationDirs/scan/<vaultKey>/folder.json`.
const SERVICE: &str = "scan";
const CONFIG_FILE: &str = "folder.json";

/// `FILE_FLAG_OPEN_REPARSE_POINT`: open a link itself, never its target.
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
/// `FILE_ATTRIBUTE_REPARSE_POINT`: a symlink, junction, cloud placeholder or
/// other reparse point.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
/// `FILE_SHARE_READ | FILE_SHARE_WRITE`, without `FILE_SHARE_DELETE`: while a
/// handle opened so is held, the name cannot be renamed or removed.
#[cfg(windows)]
const SHARE_NO_DELETE: u32 = 0x1 | 0x2;

/// How many `_N` suffixes a move tries before giving up.
const MAX_SUFFIX: u32 = 10_000;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ScanMode {
    /// Originals move to `labnote-processed` / `labnote-failed` once filed.
    Dedicated,
    /// Originals stay put; a 90-day history keeps them from being read twice.
    Shared,
}

/// What `folder.json` holds. `baseline` is `None` only for a hand-made file
/// without one (the plugin's "folders set before 0.116.0"); Rust always
/// writes `Some`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderConfig {
    pub path: String,
    pub mode: ScanMode,
    /// When the folder was chosen, ms since the epoch.
    pub since: f64,
    #[serde(default)]
    pub baseline: Option<Vec<String>>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanFolderStatus {
    pub path: Option<String>,
    pub mode: ScanMode,
    pub exists: bool,
    pub inside_vault: bool,
    pub since: Option<f64>,
    pub baseline: Option<Vec<String>>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    pub name: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub birthtime_ms: Option<f64>,
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ScanOutcome {
    Processed,
    Failed,
}

impl ScanOutcome {
    fn dir(self) -> &'static str {
        match self {
            ScanOutcome::Processed => PROCESSED_DIR,
            ScanOutcome::Failed => FAILED_DIR,
        }
    }
}

/// The plugin's `SCAN_FILE_RE` extensions:
/// `(?i)\.(jpe?g|png|webp|gif|bmp|pdf|zip|heic|heif|tiff?)$`.
const SCAN_EXTENSIONS: [&str; 12] = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "pdf", "zip", "heic", "heif", "tif", "tiff"];

/// A bare file name the scan commands act on: not empty, at most 255 bytes,
/// no `/ \ :`, no control characters, not `.`/`..`, no leading `.`, and a
/// scan extension.
pub fn scan_name_ok(name: &str) -> bool {
    if name.is_empty() || name.len() > 255 || name.starts_with('.') {
        return false;
    }
    if name.chars().any(|c| matches!(c, '/' | '\\' | ':') || c.is_control()) {
        return false;
    }
    match name.rsplit_once('.') {
        Some((_, ext)) => SCAN_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// The plugin's `historyKey`: `name|size|round(mtimeMs)`.
pub fn history_key(e: &ScanEntry) -> String {
    format!("{}|{}|{}", e.name, e.size, e.mtime_ms.round() as i64)
}

fn io(what: &str, e: impl std::fmt::Display) -> NetError {
    NetError::new(NetErrorKind::Io, format!("scan folder {what} failed: {e}"))
}

fn bad_name() -> NetError {
    NetError::new(NetErrorKind::BadInput, "not a scan file name")
}

fn forbidden() -> NetError {
    NetError::new(NetErrorKind::ForbiddenPath, "a link or junction in the scan folder is not followed")
}

fn too_large() -> NetError {
    NetError::new(NetErrorKind::TooLarge, "the scan file is too large")
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> Option<f64> {
    let d = t.ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_secs_f64() * 1000.0)
}

#[derive(PartialEq, Debug, Clone, Copy)]
enum Reparse {
    None,
    /// A symlink, junction or mount point: never followed.
    Link,
    /// A non-surrogate reparse point (cloud placeholder, dedup, ...): a file.
    Other,
}

/// `is_symlink` is std's `FileType::is_symlink()`, which on Windows is "a
/// reparse point whose tag is a name surrogate" (the tag is read from the
/// handle with `FileAttributeTagInfo`), so junctions count and cloud
/// placeholders do not.
fn classify(attrs: u32, is_symlink: bool) -> Reparse {
    if is_symlink {
        Reparse::Link
    } else if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        Reparse::Other
    } else {
        Reparse::None
    }
}

fn reparse_of(m: &std::fs::Metadata) -> Reparse {
    #[cfg(windows)]
    let attrs = {
        use std::os::windows::fs::MetadataExt;
        m.file_attributes()
    };
    #[cfg(not(windows))]
    let attrs = 0;
    classify(attrs, m.file_type().is_symlink())
}

fn is_link(m: &std::fs::Metadata) -> bool {
    reparse_of(m) == Reparse::Link
}

/// Top-level regular files passing `scan_name_ok`, sorted by name. Links and
/// folders are left out.
pub fn list(dir: &Path) -> Result<Vec<ScanEntry>, NetError> {
    let entries = std::fs::read_dir(dir).map_err(|e| io("list", e))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        if !scan_name_ok(&name) {
            continue;
        }
        // Not followed: a link is neither a file nor listed.
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
        if !meta.is_file() || is_link(&meta) {
            continue;
        }
        out.push(ScanEntry {
            name,
            size: meta.len(),
            mtime_ms: ms(meta.modified()).unwrap_or(0.0),
            birthtime_ms: ms(meta.created()),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// The `history_key` of every file `list` shows; a missing folder gives `[]`.
pub fn baseline_of(dir: &Path) -> Vec<String> {
    list(dir).map(|v| v.iter().map(history_key).collect()).unwrap_or_default()
}

/// A freshly chosen folder: `since` is now, and every file already there is in
/// the baseline (#247). A folder inside the vault is Shared.
pub fn new_config(path: String, mode: ScanMode, inside_vault: bool, now_ms: f64) -> FolderConfig {
    let baseline = baseline_of(Path::new(&path));
    FolderConfig {
        path,
        mode: if inside_vault { ScanMode::Shared } else { mode },
        since: now_ms,
        baseline: Some(baseline),
    }
}

/// Only the mode changes; `path`, `since` and `baseline` stay. A folder inside
/// the vault cannot be Dedicated, so Rust never moves a vault file.
pub fn with_mode(cfg: &FolderConfig, mode: ScanMode, inside_vault: bool) -> Result<FolderConfig, NetError> {
    if mode == ScanMode::Dedicated && inside_vault {
        return Err(NetError::new(NetErrorKind::BadInput, "a scan folder inside the vault can only be shared"));
    }
    Ok(FolderConfig { mode, ..cfg.clone() })
}

/// The plugin's `pruneBaseline`: keeps the keys still `present`. `Some` only
/// when something was dropped, so nothing is written on every tick.
pub fn prune_baseline(cfg: &FolderConfig, present: &[String]) -> Option<FolderConfig> {
    let baseline = cfg.baseline.as_ref()?;
    let kept: Vec<String> = baseline.iter().filter(|k| present.contains(k)).cloned().collect();
    if kept.len() == baseline.len() {
        return None;
    }
    Some(FolderConfig { baseline: Some(kept), ..cfg.clone() })
}

/// Opens `path` itself, never what a link points at.
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    opts.open(path)
}

/// `open_no_follow` that also holds the name in place (no delete sharing).
fn open_pin(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).share_mode(SHARE_NO_DELETE);
    }
    opts.open(path)
}

/// For a non-link reparse point (a cloud placeholder): a handle opened with
/// `FILE_FLAG_OPEN_REPARSE_POINT` does not ask the provider to download the
/// file, so the data is read through a normal open. A pin on the name, checked
/// to be no link, is held across that open, so the name cannot be swapped for
/// a link in between.
fn open_pinned_followed(path: &Path) -> Result<std::fs::File, NetError> {
    let pin = open_pin(path).map_err(|e| io("read", e))?;
    let meta = pin.metadata().map_err(|e| io("read", e))?;
    if is_link(&meta) {
        return Err(forbidden());
    }
    if !meta.is_file() {
        return Err(io("read", "not a file"));
    }
    let file = std::fs::File::open(path).map_err(|e| io("read", e))?;
    drop(pin);
    Ok(file)
}

/// Opens a top-level scan file for reading: refused when the opened handle
/// is a link or junction or not a regular file, or over the cap.
fn open_scan(dir: &Path, name: &str) -> Result<(std::fs::File, u64), NetError> {
    if !scan_name_ok(name) {
        return Err(bad_name());
    }
    let path = dir.join(name);
    let mut file = open_no_follow(&path).map_err(|e| io("read", e))?;
    let mut meta = file.metadata().map_err(|e| io("read", e))?;
    match reparse_of(&meta) {
        Reparse::Link => return Err(forbidden()),
        Reparse::Other if meta.is_file() => {
            file = open_pinned_followed(&path)?;
            meta = file.metadata().map_err(|e| io("read", e))?;
        }
        _ => {}
    }
    if !meta.is_file() {
        return Err(io("read", "not a file"));
    }
    if meta.len() > MAX_SCAN_FILE_BYTES {
        return Err(too_large());
    }
    Ok((file, meta.len()))
}

pub fn read(dir: &Path, name: &str) -> Result<Vec<u8>, NetError> {
    let (file, len) = open_scan(dir, name)?;
    let mut buf = Vec::with_capacity(len as usize);
    // One byte past the cap, so a file that grew since the check is caught.
    file.take(MAX_SCAN_FILE_BYTES + 1).read_to_end(&mut buf).map_err(|e| io("read", e))?;
    if buf.len() as u64 > MAX_SCAN_FILE_BYTES {
        return Err(too_large());
    }
    Ok(buf)
}

/// `stem.ext` for n = 1, else `stem_n.ext`.
fn suffixed(name: &str, n: u32) -> String {
    if n == 1 {
        return name.to_string();
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) => format!("{stem}_{n}.{ext}"),
        None => format!("{name}_{n}"),
    }
}

/// Moves `name` into its outcome's subfolder, as `stem.ext`, `stem_2.ext`, …,
/// and answers the name written. A hard link then a removal of the source;
/// where links are unsupported, a `create_new` copy then a removal. Never
/// replaces a file, and refuses a subfolder that is a link or junction.
pub fn move_original(dir: &Path, name: &str, outcome: ScanOutcome) -> Result<String, NetError> {
    move_original_with(dir, name, outcome, |src, dst| std::fs::hard_link(src, dst))
}

/// `move_original` with the link step injected (tests reach the copy path).
pub fn move_original_with(
    dir: &Path,
    name: &str,
    outcome: ScanOutcome,
    link: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<String, NetError> {
    if !scan_name_ok(name) {
        return Err(bad_name());
    }
    let src = dir.join(name);
    let meta = std::fs::symlink_metadata(&src).map_err(|e| io("move", e))?;
    if is_link(&meta) {
        return Err(forbidden());
    }
    if !meta.is_file() {
        return Err(io("move", "not a file"));
    }
    let sub = dir.join(outcome.dir());
    match std::fs::symlink_metadata(&sub) {
        Ok(m) if is_link(&m) => return Err(forbidden()),
        Ok(m) if !m.is_dir() => return Err(io("move", "the target subfolder is not a folder")),
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => std::fs::create_dir(&sub).map_err(|e| io("move", e))?,
        Err(e) => return Err(io("move", e)),
    }
    for n in 1..=MAX_SUFFIX {
        let target = suffixed(name, n);
        let dst = sub.join(&target);
        let written = match link(&src, &dst) {
            Ok(()) => true,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => false,
            // No hard links here (FAT, some SMB shares): copy into a new file.
            Err(_) => copy_new(dir, name, &dst)?,
        };
        if !written {
            continue;
        }
        if let Err(e) = std::fs::remove_file(&src) {
            // Undo, so the original stays the only copy.
            let _ = std::fs::remove_file(&dst);
            return Err(io("move", e));
        }
        return Ok(target);
    }
    Err(io("move", "no free name in the target subfolder"))
}

/// Copies `dir/name` into a new file `dst`. `Ok(false)` when `dst` already
/// exists (the caller tries the next name); a half-written copy is removed.
fn copy_new(dir: &Path, name: &str, dst: &Path) -> Result<bool, NetError> {
    let (mut from, _) = open_scan(dir, name)?;
    let mut to = match std::fs::OpenOptions::new().write(true).create_new(true).open(dst) {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(io("move", e)),
    };
    let copied = std::io::copy(&mut from, &mut to).and_then(|_| to.flush()).and_then(|_| to.sync_all());
    if let Err(e) = copied {
        drop(to);
        let _ = std::fs::remove_file(dst);
        return Err(io("move", e));
    }
    Ok(true)
}

/// A comparable form of `p`: canonical when it exists, as given otherwise,
/// without the `\\?\` prefix or a trailing separator, case-folded.
fn key(p: &Path) -> String {
    let abs = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let mut s = strip_verbatim(&abs).replace('/', "\\").to_lowercase();
    while s.len() > 1 && s.ends_with('\\') {
        s.pop();
    }
    s
}

/// `folder` is the vault root or somewhere under it (canonical paths).
pub fn is_inside(root: &Path, folder: &Path) -> bool {
    let (r, f) = (key(root), key(folder));
    f == r || f.starts_with(&format!("{r}\\"))
}

pub fn is_vault_root(root: &Path, folder: &Path) -> bool {
    key(root) == key(folder)
}

/// Where `root`'s scan folder is stored, in the app data dir.
pub fn config_file(dirs: &Path, root: &Path) -> PathBuf {
    vault_dir(dirs, SERVICE, root).join(CONFIG_FILE)
}

pub fn load_config(dirs: &Path, root: &Path) -> Result<Option<FolderConfig>, NetError> {
    let text = match std::fs::read_to_string(config_file(dirs, root)) {
        Ok(t) => t,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io("settings read", e)),
    };
    serde_json::from_str(&text).map(Some).map_err(|e| io("settings read", e))
}

/// Written through a temp file and a rename. Only Rust writes this file.
pub fn save_config(dirs: &Path, root: &Path, cfg: &FolderConfig) -> Result<(), NetError> {
    let text = serde_json::to_string(cfg).map_err(|e| io("settings write", e))?;
    crate::vault::fs::write_atomic(&config_file(dirs, root), &text).map_err(|e| io("settings write", format!("{e:?}")))
}

pub fn clear_config(dirs: &Path, root: &Path) -> Result<(), NetError> {
    match std::fs::remove_file(config_file(dirs, root)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io("settings clear", e)),
    }
}

/// The folder in force for `root`, or an empty status when none is set.
pub fn status_at(dirs: &Path, root: &Path) -> Result<ScanFolderStatus, NetError> {
    Ok(match load_config(dirs, root)? {
        None => ScanFolderStatus {
            path: None,
            mode: ScanMode::Dedicated,
            exists: false,
            inside_vault: false,
            since: None,
            baseline: None,
        },
        Some(cfg) => {
            let folder = Path::new(&cfg.path);
            ScanFolderStatus {
                exists: folder.is_dir(),
                inside_vault: is_inside(root, folder),
                path: Some(cfg.path),
                mode: cfg.mode,
                since: Some(cfg.since),
                baseline: cfg.baseline,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_name_surrogates_are_links_and_a_cloud_placeholder_is_accepted() {
        // A OneDrive/Dropbox placeholder keeps FILE_ATTRIBUTE_REPARSE_POINT
        // (IO_REPARSE_TAG_CLOUD_*, no name-surrogate bit) even when hydrated.
        assert_eq!(classify(0x400 | 0x20, false), Reparse::Other);
        assert_eq!(classify(0x400 | 0x10, false), Reparse::Other, "a placeholder folder");
        // Symlinks and junctions are name surrogates: std reports them as symlinks.
        assert_eq!(classify(0x400, true), Reparse::Link);
        assert_eq!(classify(0x20, false), Reparse::None);
    }

    fn tmp() -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("labnoteo-scanf-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn the_pinned_reopen_reads_the_same_file_and_never_a_link() {
        let t = tmp();
        let elsewhere = tmp();
        std::fs::write(t.join("a.jpg"), "abc").unwrap();
        std::fs::write(elsewhere.join("secret.jpg"), "secret").unwrap();
        let mut f = open_pinned_followed(&t.join("a.jpg")).unwrap();
        let mut s = String::new();
        f.read_to_string(&mut s).unwrap();
        assert_eq!(s, "abc");
        drop(f);
        // While the pin is held the name cannot be renamed or removed away.
        #[cfg(windows)]
        {
            let pin = open_pin(&t.join("a.jpg")).unwrap();
            assert!(std::fs::rename(t.join("a.jpg"), t.join("b.jpg")).is_err());
            assert!(std::fs::remove_file(t.join("a.jpg")).is_err());
            drop(pin);
            match std::os::windows::fs::symlink_file(elsewhere.join("secret.jpg"), t.join("l.jpg")) {
                Ok(()) => assert_eq!(open_pinned_followed(&t.join("l.jpg")).unwrap_err().kind, NetErrorKind::ForbiddenPath),
                Err(e) => println!("note: no symlink here ({e}); that half was skipped"),
            }
        }
        let _ = std::fs::remove_dir_all(&t);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }
}
