//! Vault file commands: the eight `LabnoteFs` operations.
//!
//! Every path goes through `confine` before touching the filesystem. The
//! `.obsidian/` ban is enforced here, on the write side only: Task 5's
//! `vault_open` must be able to *look* at `.obsidian/`.
//!
//! Locking: `read`, `exists`, `write`, `modify` and `remove` take the per-path
//! lock, because they touch one file that a concurrent atomic replace can
//! swap under `confine` (see `PathLocks`). `mkdir`, `list` and `rmdir` do not:
//! they operate on directories, which this module never replaces, so there is
//! no read-modify-write to protect and no transient state to observe;
//! `create_dir_all` is idempotent and `remove_dir` is already atomic and
//! refuses non-empty directories.
//!
//! `rename` takes the locks of both paths (in a fixed order), and `trash`
//! takes the lock of the path it sends to the Recycle Bin. Both act on the
//! entry itself: a junction or symlink is moved or trashed as the link, never
//! the folder it points to (`confine_entry`).

use std::collections::HashMap;
use std::fmt;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::path::{confine, is_safe_component, strip_verbatim, to_rel, VaultError};

#[derive(Debug)]
pub enum FsError {
    Vault(VaultError),
    /// Write-side operation aimed at `.obsidian/`.
    Forbidden,
    /// No vault has been opened yet (`VaultState` has no root).
    NoVault,
    Io(std::io::Error),
    /// Windows refused the path as too long (`ERROR_FILENAME_EXCED_RANGE`, 206).
    /// A *missing* file is never this, however long its path: it stays `notFound`.
    PathTooLong(std::io::Error),
    /// `rename` target is another file or folder that already exists.
    Exists,
}

/// `ERROR_FILENAME_EXCED_RANGE`: a component over 255 characters, or a long path
/// through an API that does not take `\\?\` verbatim paths.
const ERROR_FILENAME_EXCED_RANGE: i32 = 206;

fn is_too_long(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(ERROR_FILENAME_EXCED_RANGE)
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FsError::Vault(e) => write!(f, "{e}"),
            FsError::Forbidden => write!(f, ".obsidian is never written by labnoteO"),
            FsError::NoVault => write!(f, "no vault is open"),
            FsError::Io(e) => write!(f, "io error: {e}"),
            FsError::PathTooLong(e) => write!(f, "path too long: {e}"),
            FsError::Exists => write!(f, "the target already exists"),
        }
    }
}

impl std::error::Error for FsError {}

/// Wire shape of errors: `{kind: "forbidden" | "escape" | "vaultNotFound" |
/// "noVault" | "notFound" | "pathTooLong" | "exists" | "io", message}`. `notFound` is a missing file or
/// directory; `vaultNotFound` is a missing vault root. `message` is for
/// display only; callers branch on `kind`.
impl Serialize for FsError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let kind = match self {
            FsError::Forbidden => "forbidden",
            FsError::NoVault => "noVault",
            FsError::Vault(VaultError::Escape) => "escape",
            FsError::Vault(VaultError::NotFound) => "vaultNotFound",
            FsError::PathTooLong(_) => "pathTooLong",
            FsError::Exists => "exists",
            FsError::Vault(VaultError::Io(e)) | FsError::Io(e) => {
                if is_too_long(e) {
                    "pathTooLong"
                } else if e.kind() == ErrorKind::NotFound {
                    "notFound"
                } else {
                    "io"
                }
            }
        };
        let mut st = ser.serialize_struct("FsError", 2)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

impl From<VaultError> for FsError {
    fn from(e: VaultError) -> Self {
        FsError::Vault(e)
    }
}

/// Every `?` on an `io::Error` in this module goes through here, so error 206
/// becomes `PathTooLong` wherever it comes from. `NotFound` stays `Io`.
impl From<std::io::Error> for FsError {
    fn from(e: std::io::Error) -> Self {
        if is_too_long(&e) {
            FsError::PathTooLong(e)
        } else {
            FsError::Io(e)
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ModifyResult {
    Ok,
    Conflict { current: String },
}

/// Per-path mutexes. Entries are pruned when nobody holds or waits for them.
///
/// Pruning is safe because an `Arc` is only ever cloned out of the map while
/// the map lock is held, and the prune check (`strong_count == 2`: the map's
/// copy plus ours) also runs under the map lock. A caller that is about to
/// take the lock must clone first, so it either bumps the count before we
/// check (no prune) or finds a fresh entry after we removed the old one, and
/// nobody holds the old one. Keys are lowercased because NTFS is
/// case-insensitive: `A.md` and `a.md` are the same file and must share a lock.
///
/// The key is the vault-relative path, not the confined one, and `confine`
/// runs *inside* the lock. `confine` canonicalizes existing entries, and while
/// another thread's rename is replacing that file it can transiently fail
/// (reported as `Escape`). Holding the path lock around it rules that out for
/// our own writers.
#[derive(Default)]
pub struct PathLocks {
    map: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A panic inside a critical section leaves no half-state we rely on.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl PathLocks {
    fn key(root: &Path, rel: &str) -> PathBuf {
        PathBuf::from(format!("{}\0{rel}", root.to_string_lossy()).to_lowercase())
    }

    fn acquire(&self, key: &Path) -> Arc<Mutex<()>> {
        lock(&self.map).entry(key.to_path_buf()).or_default().clone()
    }

    fn release(&self, key: &Path, entry: Arc<Mutex<()>>) {
        let mut map = lock(&self.map);
        if Arc::strong_count(&entry) == 2 {
            map.remove(key);
        }
    }

    fn with<R>(&self, root: &Path, rel: &str, f: impl FnOnce() -> R) -> R {
        let key = Self::key(root, rel);
        let entry = self.acquire(&key);
        let result = {
            let _guard = lock(&entry);
            f()
        };
        self.release(&key, entry);
        result
    }

    /// Both paths' locks, taken in sorted key order so two crossing renames
    /// (`a -> b` and `b -> a`) cannot deadlock. A case-only rename folds to one
    /// key, which is taken once.
    fn with_two<R>(&self, root: &Path, a: &str, b: &str, f: impl FnOnce() -> R) -> R {
        let (mut first, mut second) = (Self::key(root, a), Self::key(root, b));
        if first == second {
            return self.with(root, a, f);
        }
        if second < first {
            std::mem::swap(&mut first, &mut second);
        }
        let e1 = self.acquire(&first);
        let e2 = self.acquire(&second);
        let result = {
            let _g1 = lock(&e1);
            let _g2 = lock(&e2);
            f()
        };
        self.release(&second, e2);
        self.release(&first, e1);
        result
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        lock(&self.map).len()
    }
}

fn is_obsidian(rel: &str) -> bool {
    rel.split('/').next().is_some_and(|c| c.eq_ignore_ascii_case(".obsidian"))
}

/// Confine for write-side commands: rejects `.obsidian/`, both by the name the
/// caller gave and by where the path actually resolves (a link into it).
fn confine_write(root: &Path, rel: &str) -> Result<PathBuf, FsError> {
    if is_obsidian(rel) {
        return Err(FsError::Forbidden);
    }
    let abs = confine(root, rel)?;
    if is_obsidian(&to_rel(root, &abs)?) {
        return Err(FsError::Forbidden);
    }
    Ok(abs)
}

const TMP_SUFFIX: &str = ".labnote-tmp";

fn is_tmp_name(name: &str) -> bool {
    name.starts_with('.') && name.ends_with(TMP_SUFFIX)
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Atomic replace: write a sibling temp file, fsync, rename over the target.
///
/// The temp lives in the same directory so the rename never crosses volumes.
/// Its name ends in `.labnote-tmp`, never `.labnote.md`, so a leftover after a
/// crash can not be mistaken for a note.
fn write_atomic(abs: &Path, content: &str) -> Result<(), FsError> {
    let parent = abs.parent().ok_or(VaultError::Escape)?;
    std::fs::create_dir_all(parent)?;
    let name = abs.file_name().ok_or(VaultError::Escape)?.to_string_lossy();
    let tmp = parent.join(format!(
        ".{name}.{}.{}{TMP_SUFFIX}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        drop(f);
        // A reader (antivirus, indexer) can briefly hold the target open
        // without share-delete; retry a few times before giving up.
        let mut attempt = 0;
        loop {
            match std::fs::rename(&tmp, abs) {
                Err(e) if e.kind() == ErrorKind::PermissionDenied && attempt < 5 => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(20 * attempt));
                }
                other => return other,
            }
        }
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(result?)
}

fn read_or_empty(abs: &Path) -> Result<String, FsError> {
    match std::fs::read_to_string(abs) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.into()),
    }
}

pub fn read(locks: &PathLocks, root: &Path, rel: &str) -> Result<String, FsError> {
    locks.with(root, rel, || Ok(std::fs::read_to_string(confine(root, rel)?)?))
}

pub fn write(locks: &PathLocks, root: &Path, rel: &str, content: &str) -> Result<(), FsError> {
    locks.with(root, rel, || write_atomic(&confine_write(root, rel)?, content))
}

/// Read-modify-write under the path's lock. A missing file reads as "".
pub fn modify_with(
    locks: &PathLocks,
    root: &Path,
    rel: &str,
    f: impl FnOnce(&str) -> String,
) -> Result<(), FsError> {
    locks.with(root, rel, || {
        let abs = confine_write(root, rel)?;
        let current = read_or_empty(&abs)?;
        write_atomic(&abs, &f(&current))
    })
}

pub fn modify(
    locks: &PathLocks,
    root: &Path,
    rel: &str,
    content: &str,
    expected_before: Option<&str>,
) -> Result<ModifyResult, FsError> {
    modify_paused(locks, root, rel, content, expected_before, || {})
}

/// `modify`, with `pause` run between the compare and the write: the one place a
/// missing lock would lose an update. Production passes a no-op; a test passes a
/// sleep to widen that window.
fn modify_paused(
    locks: &PathLocks,
    root: &Path,
    rel: &str,
    content: &str,
    expected_before: Option<&str>,
    pause: impl FnOnce(),
) -> Result<ModifyResult, FsError> {
    locks.with(root, rel, || {
        let abs = confine_write(root, rel)?;
        let current = read_or_empty(&abs)?;
        if expected_before.is_some_and(|e| e != current) {
            return Ok(ModifyResult::Conflict { current });
        }
        pause();
        write_atomic(&abs, content)?;
        Ok(ModifyResult::Ok)
    })
}

pub fn exists(locks: &PathLocks, root: &Path, rel: &str) -> Result<bool, FsError> {
    locks.with(root, rel, || Ok(confine(root, rel)?.try_exists()?))
}

pub fn mkdir(root: &Path, rel: &str) -> Result<(), FsError> {
    Ok(std::fs::create_dir_all(confine_write(root, rel)?)?)
}

/// Entry names (not paths) of `dir`; missing dir lists as empty. An empty
/// `dir` means the vault root.
pub fn list(root: &Path, dir: &str) -> Result<Vec<String>, FsError> {
    let abs = if dir.is_empty() {
        std::fs::canonicalize(root).map_err(|e| match e.kind() {
            ErrorKind::NotFound => FsError::Vault(VaultError::NotFound),
            _ => FsError::from(e),
        })?
    } else {
        confine(root, dir)?
    };
    let rd = match std::fs::read_dir(&abs) {
        Ok(rd) => rd,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut names = Vec::new();
    for entry in rd {
        let name = entry?.file_name().to_string_lossy().into_owned();
        // In-flight or orphaned atomic-write temp files are not vault content.
        if !is_tmp_name(&name) {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

pub fn remove(locks: &PathLocks, root: &Path, rel: &str) -> Result<(), FsError> {
    locks.with(root, rel, || match std::fs::remove_file(confine_write(root, rel)?) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        other => Ok(other?),
    })
}

/// Removes an empty directory. Missing or non-empty is a no-op: user files
/// inside are never deleted along with it.
pub fn rmdir(root: &Path, rel: &str) -> Result<(), FsError> {
    match std::fs::remove_dir(confine_write(root, rel)?) {
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty) => Ok(()),
        other => Ok(other?),
    }
}

/// Whether two paths name the same file-system entry: same volume and same file
/// index, compared without following a final link (a link and its target are two
/// entries). Hard links of one file are the same entry.
#[cfg(windows)]
fn same_entry(a: &Path, b: &Path) -> std::io::Result<bool> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    #[derive(Default)]
    struct ByHandleFileInformation {
        attributes: u32,
        creation: [u32; 2],
        last_access: [u32; 2],
        last_write: [u32; 2],
        volume_serial: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(file: *mut std::ffi::c_void, info: *mut ByHandleFileInformation) -> i32;
    }
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    fn id(p: &Path) -> std::io::Result<(u32, u32, u32)> {
        // Access 0 is enough to query attributes; backup semantics opens folders.
        let f = std::fs::OpenOptions::new()
            .access_mode(0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(p)?;
        let mut info = ByHandleFileInformation::default();
        // SAFETY: `f` is an open handle for the whole call and `info` is a
        // properly sized, writable BY_HANDLE_FILE_INFORMATION.
        if unsafe { GetFileInformationByHandle(f.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok((info.volume_serial, info.index_high, info.index_low))
    }
    Ok(id(a)? == id(b)?)
}

#[cfg(unix)]
fn same_entry(a: &Path, b: &Path) -> std::io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let (ma, mb) = (std::fs::symlink_metadata(a)?, std::fs::symlink_metadata(b)?);
    Ok(ma.dev() == mb.dev() && ma.ino() == mb.ino())
}

/// Confine for commands that act on an entry itself (`rename`, `trash`): the
/// parent goes through `confine_write`, the final component is kept literally.
///
/// `confine` canonicalizes existing entries, so `confine(rel)` of a junction or
/// symlink is the folder it points to, and of `A.md` is the on-disk `a.md`.
/// Moving or trashing must touch the link itself and must see the spelling the
/// caller asked for (a case-only rename), so the last component is not resolved.
fn confine_entry(root: &Path, rel: &str) -> Result<PathBuf, FsError> {
    if rel.starts_with('/') {
        return Err(VaultError::Escape.into());
    }
    let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    if matches!(name, "" | "." | "..") || !is_safe_component(name) {
        return Err(VaultError::Escape.into());
    }
    if is_obsidian(rel) {
        return Err(FsError::Forbidden);
    }
    let parent_abs = if parent.is_empty() {
        std::fs::canonicalize(root).map_err(|e| match e.kind() {
            ErrorKind::NotFound => FsError::Vault(VaultError::NotFound),
            _ => FsError::from(e),
        })?
    } else {
        confine_write(root, parent)?
    };
    let abs = parent_abs.join(name);
    if is_obsidian(&to_rel(root, &abs)?) {
        return Err(FsError::Forbidden);
    }
    Ok(abs)
}

fn lower(p: &Path) -> PathBuf {
    PathBuf::from(p.to_string_lossy().to_lowercase())
}

/// Move or rename a file or folder inside the vault.
///
/// Both ends are resolved with `confine_entry` (see there): a link is moved as
/// a link, and `a.md -> A.md` is not folded back to the old spelling. An
/// existing target is `Exists` unless it is a case-only rename of the very same
/// entry (same spelling ignoring case *and* same file identity, so the two
/// distinct files `a.md` / `A.md` of a case-sensitive folder stay apart). A
/// folder can not move into its own subtree. Missing target parents are created,
/// and removed again if the move then fails.
pub fn rename(locks: &PathLocks, root: &Path, from: &str, to: &str) -> Result<(), FsError> {
    locks.with_two(root, from, to, || {
        let src = confine_entry(root, from)?;
        std::fs::symlink_metadata(&src)?;
        let dst = confine_entry(root, to)?;
        let (src_l, dst_l) = (lower(&src), lower(&dst));
        if dst_l != src_l && dst_l.starts_with(&src_l) {
            return Err(FsError::Io(std::io::Error::new(
                ErrorKind::InvalidInput,
                "a folder can not be moved into itself",
            )));
        }
        match std::fs::symlink_metadata(&dst) {
            Ok(_) => {
                if dst_l != src_l || !same_entry(&src, &dst)? {
                    return Err(FsError::Exists);
                }
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let dst_parent = dst.parent().ok_or(VaultError::Escape)?;
        let mut created = Vec::new();
        let mut dir = dst_parent;
        while std::fs::symlink_metadata(dir).is_err() {
            created.push(dir.to_path_buf());
            dir = match dir.parent() {
                Some(d) => d,
                None => break,
            };
        }
        let result = std::fs::create_dir_all(dst_parent).and_then(|()| std::fs::rename(&src, &dst));
        if result.is_err() {
            // Deepest first; `remove_dir` only ever removes an empty folder.
            for d in &created {
                let _ = std::fs::remove_dir(d);
            }
        }
        Ok(result?)
    })
}

/// Send a file or folder to the Windows Recycle Bin. A missing path is Ok. A
/// link is sent as the link, never the folder it points to (`confine_entry`).
pub fn trash(locks: &PathLocks, root: &Path, rel: &str) -> Result<(), FsError> {
    trash_with(locks, root, rel, |p| trash::delete(p))
}

/// `trash` with the deleter injected. The deleter gets the plain path (no
/// `\\?\` prefix: the shell API does not take verbatim paths). A deleter error
/// surfaces as `io`; this never falls back to a permanent delete.
pub fn trash_with(
    locks: &PathLocks,
    root: &Path,
    rel: &str,
    deleter: impl FnOnce(&Path) -> Result<(), trash::Error>,
) -> Result<(), FsError> {
    locks.with(root, rel, || {
        let abs = confine_entry(root, rel)?;
        match std::fs::symlink_metadata(&abs) {
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        }
        let plain = PathBuf::from(strip_verbatim(&abs));
        deleter(&plain).map_err(|e| FsError::Io(std::io::Error::new(ErrorKind::Other, e.to_string())))
    })
}

/// Delete orphaned atomic-write temp files (left by a crash between create and
/// rename) anywhere under `root`; returns how many were removed. Call it once
/// when a vault is opened, before any writes: a temp file belonging to a live
/// `write` would be indistinguishable from an orphan. Skips `.obsidian/` (never
/// touched) and does not follow links.
pub fn sweep_temp(root: &Path) -> Result<usize, FsError> {
    fn walk(dir: &Path, top: bool, removed: &mut usize) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let ft = entry.file_type()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if !(top && name.eq_ignore_ascii_case(".obsidian")) {
                    walk(&entry.path(), false, removed)?;
                }
            } else if is_tmp_name(&name) && std::fs::remove_file(entry.path()).is_ok() {
                *removed += 1;
            }
        }
        Ok(())
    }
    let canon = std::fs::canonicalize(root).map_err(|e| match e.kind() {
        ErrorKind::NotFound => FsError::Vault(VaultError::NotFound),
        _ => FsError::Io(e),
    })?;
    let mut removed = 0;
    walk(&canon, true, &mut removed)?;
    Ok(removed)
}

// ---- Tauri layer ----------------------------------------------------------

#[tauri::command]
pub fn vault_read(state: tauri::State<'_, super::VaultState>, path: String) -> Result<String, FsError> {
    read(&state.locks, &state.root()?, &path)
}

#[tauri::command]
pub fn vault_write(state: tauri::State<'_, super::VaultState>, path: String, content: String) -> Result<(), FsError> {
    write(&state.locks, &state.root()?, &path, &content)
}

// Tauri maps JS camelCase args to these snake_case parameters.
#[tauri::command]
pub fn vault_modify(
    state: tauri::State<'_, super::VaultState>,
    path: String,
    content: String,
    expected_before: Option<String>,
) -> Result<ModifyResult, FsError> {
    modify(&state.locks, &state.root()?, &path, &content, expected_before.as_deref())
}

#[tauri::command]
pub fn vault_exists(state: tauri::State<'_, super::VaultState>, path: String) -> Result<bool, FsError> {
    exists(&state.locks, &state.root()?, &path)
}

#[tauri::command]
pub fn vault_mkdir(state: tauri::State<'_, super::VaultState>, path: String) -> Result<(), FsError> {
    mkdir(&state.root()?, &path)
}

#[tauri::command]
pub fn vault_list(state: tauri::State<'_, super::VaultState>, dir: String) -> Result<Vec<String>, FsError> {
    list(&state.root()?, &dir)
}

#[tauri::command]
pub fn vault_remove(state: tauri::State<'_, super::VaultState>, path: String) -> Result<(), FsError> {
    remove(&state.locks, &state.root()?, &path)
}

#[tauri::command]
pub fn vault_rmdir(state: tauri::State<'_, super::VaultState>, path: String) -> Result<(), FsError> {
    rmdir(&state.root()?, &path)
}

#[tauri::command]
pub fn vault_rename(state: tauri::State<'_, super::VaultState>, from: String, to: String) -> Result<(), FsError> {
    rename(&state.locks, &state.root()?, &from, &to)
}

/// Async and off the main thread: a sync command runs on the main thread, and a
/// large folder going to the Recycle Bin would freeze the window.
#[tauri::command]
pub async fn vault_trash(state: tauri::State<'_, super::VaultState>, path: String) -> Result<(), FsError> {
    let root = state.root()?;
    let locks = Arc::clone(&state.locks);
    tauri::async_runtime::spawn_blocking(move || trash(&locks, &root, &path))
        .await
        .map_err(|e| FsError::Io(std::io::Error::new(ErrorKind::Other, e.to_string())))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-fs-{}-{}",
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

    #[test]
    fn read_rejects_missing_file() {
        let t = Tmp::new();
        let l = PathLocks::default();
        match read(&l, &t.0, "nope.md") {
            Err(FsError::Io(e)) => assert_eq!(e.kind(), ErrorKind::NotFound),
            other => panic!("expected Io(NotFound), got {other:?}"),
        }
    }

    #[test]
    fn write_creates_then_replaces() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "a.md", "one").unwrap();
        assert_eq!(read(&l, &t.0, "a.md").unwrap(), "one");
        write(&l, &t.0, "a.md", "two").unwrap();
        assert_eq!(read(&l, &t.0, "a.md").unwrap(), "two");
        // no temp file left behind
        assert_eq!(list(&t.0, "").unwrap(), vec!["a.md"]);
    }

    #[test]
    fn write_creates_missing_parent_dirs() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&PathLocks::default(), &t.0, "x/y/z.md", "hi").unwrap();
        assert_eq!(read(&l, &t.0, "x/y/z.md").unwrap(), "hi");
    }

    #[test]
    fn modify_sees_empty_string_for_missing_file() {
        let t = Tmp::new();
        let l = PathLocks::default();
        let mut seen = None;
        modify_with(&l, &t.0, "m.md", |cur| {
            seen = Some(cur.to_string());
            "made".into()
        })
        .unwrap();
        assert_eq!(seen.as_deref(), Some(""));
        assert_eq!(read(&l, &t.0, "m.md").unwrap(), "made");
        // expected_before Some("") matches a missing file; a wrong one conflicts
        assert_eq!(modify(&l, &t.0, "n.md", "v", Some("")).unwrap(), ModifyResult::Ok);
        assert_eq!(
            modify(&l, &t.0, "n.md", "w", Some("stale")).unwrap(),
            ModifyResult::Conflict { current: "v".into() }
        );
        assert_eq!(read(&l, &t.0, "n.md").unwrap(), "v");
    }

    /// The "new note" flow in the app is `exists` then `modify(content "", expected_before
    /// Some(""))`. These pin what it relies on, against a real directory.
    #[test]
    fn creating_a_note_never_overwrites_and_rejects_windows_names() {
        let t = Tmp::new();
        let l = PathLocks::default();
        // A free name is created, empty.
        assert_eq!(modify(&l, &t.0, "Day 1.labnote.md", "", Some("")).unwrap(), ModifyResult::Ok);
        assert_eq!(read(&l, &t.0, "Day 1.labnote.md").unwrap(), "");
        // NTFS ignores case: the same note under another spelling already exists.
        assert!(exists(&l, &t.0, "DAY 1.labnote.md").unwrap());
        // A note with content is not replaced by a second create.
        write(&l, &t.0, "a.labnote.md", "my data").unwrap();
        assert_eq!(
            modify(&l, &t.0, "a.labnote.md", "", Some("")).unwrap(),
            ModifyResult::Conflict { current: "my data".into() }
        );
        assert_eq!(read(&l, &t.0, "a.labnote.md").unwrap(), "my data");
        // Names Windows forbids are refused as Escape, and nothing is created.
        let before = list(&t.0, "").unwrap();
        for bad in ["CON.labnote.md", "nul.labnote.md", "a:b.labnote.md", "a?.labnote.md", "a<b.labnote.md"] {
            assert!(matches!(exists(&l, &t.0, bad), Err(FsError::Vault(VaultError::Escape))), "{bad}");
            assert!(matches!(modify(&l, &t.0, bad, "", Some("")), Err(FsError::Vault(VaultError::Escape))), "{bad}");
        }
        assert_eq!(list(&t.0, "").unwrap(), before);
    }

    #[test]
    fn exists_true_for_file_and_dir() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&PathLocks::default(), &t.0, "d/f.md", "x").unwrap();
        assert!(exists(&l, &t.0, "d/f.md").unwrap());
        assert!(exists(&l, &t.0, "d").unwrap());
        assert!(!exists(&l, &t.0, "d/none.md").unwrap());
    }

    #[test]
    fn list_returns_entry_names_not_paths() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "d/b.md", "x").unwrap();
        write(&l, &t.0, "d/a.md", "x").unwrap();
        mkdir(&t.0, "d/sub").unwrap();
        assert_eq!(list(&t.0, "d").unwrap(), vec!["a.md", "b.md", "sub"]);
    }

    #[test]
    fn list_returns_empty_for_missing_dir() {
        let t = Tmp::new();
        assert!(list(&t.0, "nope").unwrap().is_empty());
    }

    #[test]
    fn remove_is_noop_when_missing() {
        let t = Tmp::new();
        let l = PathLocks::default();
        remove(&l, &t.0, "gone.md").unwrap();
        write(&l, &t.0, "g.md", "x").unwrap();
        remove(&l, &t.0, "g.md").unwrap();
        assert!(!exists(&l, &t.0, "g.md").unwrap());
    }

    #[test]
    fn rmdir_is_noop_when_dir_has_entries() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&PathLocks::default(), &t.0, "d/user.md", "keep").unwrap();
        rmdir(&t.0, "d").unwrap();
        assert_eq!(read(&l, &t.0, "d/user.md").unwrap(), "keep");
        mkdir(&t.0, "empty").unwrap();
        rmdir(&t.0, "empty").unwrap();
        assert!(!exists(&l, &t.0, "empty").unwrap());
        rmdir(&t.0, "empty").unwrap(); // missing: no-op
    }

    #[test]
    fn concurrent_modify_does_not_lose_updates() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "c.md", "0").unwrap();
        // Each thread does read -> (widen the race window) -> write inside
        // modify_with, with no retry. Without the per-path lock this loses
        // updates essentially every run.
        std::thread::scope(|s| {
            for _ in 0..100 {
                s.spawn(|| {
                    modify_with(&l, &t.0, "c.md", |cur| {
                        let n: u32 = cur.parse().unwrap();
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        (n + 1).to_string()
                    })
                    .unwrap();
                });
            }
        });
        assert_eq!(read(&l, &t.0, "c.md").unwrap(), "100");
        assert_eq!(l.len(), 0, "lock map is pruned once idle");
    }

    #[test]
    fn concurrent_modify_compare_and_swap_does_not_lose_updates() {
        // Same guarantee through the real `modify` semantics: callers retry on
        // Conflict, and the check+write is atomic under the lock.
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "c.md", "0").unwrap();
        std::thread::scope(|s| {
            for _ in 0..100 {
                s.spawn(|| loop {
                    let cur = read(&l, &t.0, "c.md").unwrap();
                    let next = (cur.parse::<u32>().unwrap() + 1).to_string();
                    // The sleep sits between the compare and the write, inside the
                    // critical section, as in the sibling test above.
                    let pause = || std::thread::sleep(std::time::Duration::from_millis(2));
                    if modify_paused(&l, &t.0, "c.md", &next, Some(&cur), pause).unwrap() == ModifyResult::Ok {
                        break;
                    }
                });
            }
        });
        assert_eq!(read(&l, &t.0, "c.md").unwrap(), "100");
    }

    #[test]
    fn lock_is_shared_across_case_variants() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "Case.md", "0").unwrap();
        std::thread::scope(|s| {
            for i in 0..40 {
                let l = &l;
                let root = &t.0;
                s.spawn(move || {
                    let name = if i % 2 == 0 { "Case.md" } else { "case.md" };
                    modify_with(l, root, name, |cur| {
                        let n: u32 = cur.parse().unwrap();
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        (n + 1).to_string()
                    })
                    .unwrap();
                });
            }
        });
        assert_eq!(read(&l, &t.0, "Case.md").unwrap(), "40");
    }

    #[test]
    fn write_commands_reject_dot_obsidian() {
        let t = Tmp::new();
        let l = PathLocks::default();
        for p in [".obsidian/app.json", ".obsidian", ".OBSIDIAN/x.json"] {
            assert!(matches!(write(&l, &t.0, p, "x"), Err(FsError::Forbidden)), "write {p}");
            assert!(matches!(modify(&l, &t.0, p, "x", None), Err(FsError::Forbidden)), "modify {p}");
            assert!(matches!(modify_with(&l, &t.0, p, |_| "x".into()), Err(FsError::Forbidden)), "modify_with {p}");
            assert!(matches!(mkdir(&t.0, p), Err(FsError::Forbidden)), "mkdir {p}");
            assert!(matches!(remove(&l, &t.0, p), Err(FsError::Forbidden)), "remove {p}");
            assert!(matches!(rmdir(&t.0, p), Err(FsError::Forbidden)), "rmdir {p}");
        }
        assert!(!t.0.join(".obsidian").exists());
        // only a first component of `.obsidian` is banned
        write(&l, &t.0, "notes/.obsidian/x.md", "ok").unwrap();
    }

    #[test]
    fn list_empty_means_root_only() {
        let t = Tmp::new();
        std::fs::write(t.0.join("r.md"), "x").unwrap();
        assert_eq!(list(&t.0, "").unwrap(), vec!["r.md"]);
        // anything else still goes through confine
        for bad in ["..", "/", ".", "a//b", "../x"] {
            assert!(matches!(list(&t.0, bad), Err(FsError::Vault(VaultError::Escape))), "{bad}");
        }
    }

    #[test]
    fn list_hides_atomic_write_temp_files() {
        let t = Tmp::new();
        std::fs::write(t.0.join("n.labnote.md"), "x").unwrap();
        std::fs::write(t.0.join(".n.labnote.md.1.2.labnote-tmp"), "partial").unwrap();
        assert_eq!(list(&t.0, "").unwrap(), vec!["n.labnote.md"]);
    }

    #[test]
    fn sweep_removes_orphaned_temp_files() {
        let t = Tmp::new();
        std::fs::create_dir_all(t.0.join("a/b")).unwrap();
        std::fs::create_dir_all(t.0.join(".obsidian")).unwrap();
        std::fs::write(t.0.join("keep.labnote.md"), "x").unwrap();
        std::fs::write(t.0.join(".keep.labnote.md.1.2.labnote-tmp"), "p").unwrap();
        std::fs::write(t.0.join("a/b/.deep.md.3.4.labnote-tmp"), "p").unwrap();
        // not ours: no leading dot / inside .obsidian
        std::fs::write(t.0.join("user.labnote-tmp"), "mine").unwrap();
        std::fs::write(t.0.join(".obsidian/.x.1.1.labnote-tmp"), "o").unwrap();
        assert_eq!(sweep_temp(&t.0).unwrap(), 2);
        assert!(!t.0.join(".keep.labnote.md.1.2.labnote-tmp").exists());
        assert!(!t.0.join("a/b/.deep.md.3.4.labnote-tmp").exists());
        assert_eq!(std::fs::read_to_string(t.0.join("keep.labnote.md")).unwrap(), "x");
        assert!(t.0.join("user.labnote-tmp").exists());
        assert!(t.0.join(".obsidian/.x.1.1.labnote-tmp").exists());
    }

    #[test]
    fn errors_serialize_with_a_kind() {
        let t = Tmp::new();
        let l = PathLocks::default();
        let kind = |e: FsError| serde_json::to_value(&e).unwrap()["kind"].as_str().unwrap().to_string();
        assert_eq!(kind(read(&l, &t.0, "nope.md").unwrap_err()), "notFound");
        assert_eq!(kind(write(&l, &t.0, ".obsidian/a", "x").unwrap_err()), "forbidden");
        assert_eq!(kind(read(&l, &t.0, "../x").unwrap_err()), "escape");
        assert_eq!(kind(FsError::NoVault), "noVault");
        assert_eq!(kind(read(&l, &t.0.join("missing-root"), "a.md").unwrap_err()), "vaultNotFound");
        assert!(serde_json::to_value(FsError::Forbidden).unwrap()["message"].is_string());
        assert_eq!(kind(FsError::PathTooLong(std::io::Error::from_raw_os_error(206))), "pathTooLong");
        assert_eq!(kind(FsError::Vault(VaultError::Io(std::io::Error::from_raw_os_error(206)))), "pathTooLong");
        assert_eq!(kind(FsError::Exists), "exists");
        write(&l, &t.0, "x.md", "1").unwrap();
        write(&l, &t.0, "y.md", "2").unwrap();
        assert_eq!(kind(rename(&l, &t.0, "x.md", "y.md").unwrap_err()), "exists");
    }

    fn kind_of(e: FsError) -> String {
        serde_json::to_value(&e).unwrap()["kind"].as_str().unwrap().to_string()
    }

    #[test]
    fn rename_moves_a_file_and_creates_the_target_parent() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "a.md", "body").unwrap();
        rename(&l, &t.0, "a.md", "new/deep/b.md").unwrap();
        assert!(!exists(&l, &t.0, "a.md").unwrap());
        assert_eq!(read(&l, &t.0, "new/deep/b.md").unwrap(), "body");
        // folders move too
        rename(&l, &t.0, "new", "moved").unwrap();
        assert_eq!(read(&l, &t.0, "moved/deep/b.md").unwrap(), "body");
        assert_eq!(l.len(), 0, "lock map is pruned once idle");
    }

    #[test]
    fn rename_refuses_an_existing_target_with_exists() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "a.md", "a").unwrap();
        write(&l, &t.0, "b.md", "b").unwrap();
        assert!(matches!(rename(&l, &t.0, "a.md", "b.md"), Err(FsError::Exists)));
        // another spelling of the same existing file is still another file
        assert!(matches!(rename(&l, &t.0, "a.md", "B.md"), Err(FsError::Exists)));
        assert_eq!(read(&l, &t.0, "a.md").unwrap(), "a");
        assert_eq!(read(&l, &t.0, "b.md").unwrap(), "b");
    }

    #[test]
    fn rename_allows_a_case_only_change_on_the_same_file() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "a.md", "keep").unwrap();
        rename(&l, &t.0, "a.md", "A.md").unwrap();
        let names: Vec<String> =
            std::fs::read_dir(&t.0).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["A.md".to_string()]);
        assert_eq!(read(&l, &t.0, "A.md").unwrap(), "keep");
    }

    #[test]
    fn rename_of_a_missing_source_is_not_found() {
        let t = Tmp::new();
        let l = PathLocks::default();
        assert_eq!(kind_of(rename(&l, &t.0, "nope.md", "b.md").unwrap_err()), "notFound");
        assert!(!exists(&l, &t.0, "b.md").unwrap());
    }

    #[test]
    fn rename_rejects_dot_obsidian_on_either_side() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "a.md", "a").unwrap();
        std::fs::create_dir_all(t.0.join(".obsidian")).unwrap();
        std::fs::write(t.0.join(".obsidian/app.json"), "{}").unwrap();
        assert_eq!(kind_of(rename(&l, &t.0, "a.md", ".obsidian/a.md").unwrap_err()), "forbidden");
        assert_eq!(kind_of(rename(&l, &t.0, "a.md", ".OBSIDIAN").unwrap_err()), "forbidden");
        assert_eq!(kind_of(rename(&l, &t.0, ".obsidian/app.json", "b.json").unwrap_err()), "forbidden");
        assert_eq!(kind_of(rename(&l, &t.0, ".obsidian", "x").unwrap_err()), "forbidden");
        assert_eq!(read(&l, &t.0, "a.md").unwrap(), "a");
        assert!(t.0.join(".obsidian/app.json").exists());
    }

    #[test]
    fn rename_rejects_an_unsafe_target_name() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "a.md", "a").unwrap();
        for bad in ["CON.md", "a:b.md", "d/x?.md", "../a.md", "", "."] {
            assert_eq!(kind_of(rename(&l, &t.0, "a.md", bad).unwrap_err()), "escape", "{bad}");
        }
        assert_eq!(read(&l, &t.0, "a.md").unwrap(), "a");
    }

    #[test]
    fn rename_refuses_moving_a_folder_into_itself_and_leaves_no_parents() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "d/f.md", "x").unwrap();
        for bad in ["d/new/x", "D/new/x", "d/x"] {
            assert_eq!(kind_of(rename(&l, &t.0, "d", bad).unwrap_err()), "io", "{bad}");
        }
        assert!(!t.0.join("d/new").exists(), "no empty parent left behind");
        assert_eq!(read(&l, &t.0, "d/f.md").unwrap(), "x");
        // a sibling whose name only starts with the folder's name is not inside it
        rename(&l, &t.0, "d", "d2").unwrap();
        assert_eq!(read(&l, &t.0, "d2/f.md").unwrap(), "x");
    }

    #[test]
    fn a_failed_rename_removes_the_parents_it_created() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "a.md", "x").unwrap();
        mkdir(&t.0, "keep").unwrap();
        // Open without FILE_SHARE_DELETE so the move is refused by Windows.
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(t.0.join("a.md")).unwrap();
        assert!(rename(&l, &t.0, "a.md", "keep/new/deep/b.md").is_err());
        drop(held);
        assert!(t.0.join("keep").is_dir(), "a parent that existed before stays");
        assert!(!t.0.join("keep/new").exists(), "created parents are removed again");
        assert_eq!(read(&l, &t.0, "a.md").unwrap(), "x");
    }

    #[test]
    fn same_entry_compares_file_identity_not_names() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "a.md", "a").unwrap();
        write(&l, &t.0, "b.md", "b").unwrap();
        std::fs::hard_link(t.0.join("a.md"), t.0.join("link.md")).unwrap();
        assert!(same_entry(&t.0.join("a.md"), &t.0.join("A.MD")).unwrap());
        assert!(same_entry(&t.0.join("a.md"), &t.0.join("link.md")).unwrap());
        assert!(!same_entry(&t.0.join("a.md"), &t.0.join("b.md")).unwrap());
        mkdir(&t.0, "d").unwrap();
        assert!(same_entry(&t.0.join("d"), &t.0.join("D")).unwrap());
        assert!(!same_entry(&t.0.join("d"), &t.0.join("a.md")).unwrap());
    }

    /// A per-directory case-sensitive folder (`fsutil file setCaseSensitiveInfo`,
    /// as WSL creates) can hold `a.md` and `A.md` as two files: renaming one onto
    /// the other is not a case-only rename and must not replace it.
    #[test]
    fn rename_never_replaces_a_distinct_file_in_a_case_sensitive_folder() {
        let t = Tmp::new();
        let l = PathLocks::default();
        mkdir(&t.0, "cs").unwrap();
        let ok = std::process::Command::new("fsutil")
            .args(["file", "setCaseSensitiveInfo"])
            .arg(t.0.join("cs"))
            .arg("enable")
            .output()
            .is_ok_and(|o| o.status.success());
        if !ok {
            eprintln!("skipped: per-directory case sensitivity is not available here");
            return;
        }
        std::fs::write(t.0.join("cs/a.md"), "lower").unwrap();
        std::fs::write(t.0.join("cs/A.md"), "upper").unwrap();
        if std::fs::read_to_string(t.0.join("cs/a.md")).unwrap() != "lower" {
            eprintln!("skipped: the folder did not become case-sensitive");
            return;
        }
        assert!(matches!(rename(&l, &t.0, "cs/a.md", "cs/A.md"), Err(FsError::Exists)));
        assert_eq!(std::fs::read_to_string(t.0.join("cs/a.md")).unwrap(), "lower");
        assert_eq!(std::fs::read_to_string(t.0.join("cs/A.md")).unwrap(), "upper");
    }

    fn junction(link: &Path, target: &Path) {
        let out = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("failed to run cmd");
        assert!(out.status.success(), "mklink /J failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// `rename` and `trash` act on a link itself, never on the folder it points to.
    #[test]
    fn rename_and_trash_act_on_a_junction_not_its_target() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "real/f.md", "x").unwrap();
        junction(&t.0.join("alias"), &t.0.join("real"));
        rename(&l, &t.0, "alias", "moved").unwrap();
        assert!(t.0.join("real/f.md").is_file(), "the target folder stays put");
        assert!(std::fs::symlink_metadata(t.0.join("moved")).unwrap().file_type().is_symlink());
        let mut seen = Vec::new();
        trash_with(&l, &t.0, "moved", |p| {
            seen.push(p.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].ends_with("moved"), "{:?}", seen[0]);
        std::fs::remove_dir(t.0.join("moved")).unwrap();
        assert_eq!(read(&l, &t.0, "real/f.md").unwrap(), "x");
    }

    /// Two threads take the same two keys in opposite orders (`a -> b` while
    /// `b -> a`): without the sorted acquisition in `with_two` this is the
    /// classic lock-order inversion and hangs. The renames themselves mostly
    /// fail (`exists` / `notFound`), but the locks are taken before any
    /// filesystem check, so every call still exercises the ordering.
    #[test]
    fn crossing_renames_do_not_deadlock() {
        let t = Tmp::new();
        let l = Arc::new(PathLocks::default());
        write(&l, &t.0, "a", "x").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let root = t.0.clone();
        let l2 = l.clone();
        std::thread::spawn(move || {
            std::thread::scope(|s| {
                let (l, root) = (&l2, &root);
                s.spawn(move || {
                    for _ in 0..2_000 {
                        let _ = rename(l, root, "a", "b");
                        let _ = rename(l, root, "b", "a");
                    }
                });
                s.spawn(move || {
                    for _ in 0..2_000 {
                        let _ = rename(l, root, "b", "a");
                        let _ = rename(l, root, "a", "b");
                    }
                });
            });
            tx.send(()).unwrap();
        });
        rx.recv_timeout(std::time::Duration::from_secs(60)).expect("crossing renames deadlocked");
        assert_eq!(l.len(), 0, "lock map is pruned once idle");
    }

    #[test]
    fn trash_of_a_missing_path_is_ok() {
        let t = Tmp::new();
        let l = PathLocks::default();
        let mut called = false;
        trash_with(&l, &t.0, "gone.md", |_| {
            called = true;
            Ok(())
        })
        .unwrap();
        assert!(!called, "nothing to send to the Recycle Bin");
        trash(&l, &t.0, "gone/too.md").unwrap();
    }

    #[test]
    fn trash_passes_the_stripped_path_to_the_deleter() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "d/f.md", "x").unwrap();
        let mut seen = Vec::new();
        trash_with(&l, &t.0, "d/f.md", |p| {
            seen.push(p.to_path_buf());
            Ok(())
        })
        .unwrap();
        trash_with(&l, &t.0, "d", |p| {
            seen.push(p.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(seen.len(), 2);
        for p in &seen {
            assert!(!p.to_string_lossy().starts_with("\\\\?\\"), "{p:?}");
            assert!(p.is_absolute(), "{p:?}");
        }
        assert!(seen[0].ends_with("d\\f.md"), "{:?}", seen[0]);
        assert!(seen[1].ends_with("d"), "{:?}", seen[1]);
    }

    #[test]
    fn trash_never_falls_back_to_remove_file() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "keep.md", "data").unwrap();
        let err = trash_with(&l, &t.0, "keep.md", |_| Err(trash::Error::Unknown { description: "no bin".into() }))
            .unwrap_err();
        assert_eq!(kind_of(err), "io");
        assert_eq!(read(&l, &t.0, "keep.md").unwrap(), "data");
    }

    #[test]
    fn trash_refuses_dot_obsidian() {
        let t = Tmp::new();
        let l = PathLocks::default();
        std::fs::create_dir_all(t.0.join(".obsidian")).unwrap();
        let err = trash_with(&l, &t.0, ".obsidian", |_| panic!("must not be called")).unwrap_err();
        assert_eq!(kind_of(err), "forbidden");
    }

    /// Real Recycle Bin. Never run in CI (it would fill the runner's bin); the
    /// manual run is a smoke step: `cargo test trash_moves -- --ignored`.
    #[test]
    #[ignore]
    fn trash_moves_a_file_to_the_recycle_bin() {
        let t = Tmp::new();
        let l = PathLocks::default();
        write(&l, &t.0, "labnoteo-trash-smoke.md", "x").unwrap();
        trash(&l, &t.0, "labnoteo-trash-smoke.md").unwrap();
        assert!(!exists(&l, &t.0, "labnoteo-trash-smoke.md").unwrap());
    }

    #[test]
    fn io_206_is_path_too_long_and_not_found_stays_not_found() {
        let t = Tmp::new();
        let l = PathLocks::default();
        assert_eq!(kind_of(FsError::from(std::io::Error::from_raw_os_error(206))), "pathTooLong");
        assert!(matches!(FsError::from(std::io::Error::from_raw_os_error(206)), FsError::PathTooLong(_)));
        assert_eq!(kind_of(FsError::from(std::io::Error::from(ErrorKind::NotFound))), "notFound");
        let long = format!("{}/{}/{}.md", "a".repeat(100), "b".repeat(100), "c".repeat(100));
        assert!(long.len() >= 300);
        assert_eq!(kind_of(read(&l, &t.0, &long).unwrap_err()), "notFound");
    }

    #[test]
    fn read_commands_allow_dot_obsidian() {
        let t = Tmp::new();
        let l = PathLocks::default();
        std::fs::create_dir_all(t.0.join(".obsidian")).unwrap();
        std::fs::write(t.0.join(".obsidian/app.json"), "{}").unwrap();
        assert_eq!(read(&l, &t.0, ".obsidian/app.json").unwrap(), "{}");
        assert!(exists(&l, &t.0, ".obsidian").unwrap());
        assert_eq!(list(&t.0, ".obsidian").unwrap(), vec!["app.json"]);
    }
}
