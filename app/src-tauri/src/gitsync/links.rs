//! Folder links (spec §4 "What is remembered"): the Rust-only
//! `GithubDoc::Links` document of one vault, keyed by the experiment folder's
//! vault-relative POSIX path, plus the per-vault `defaultOwner`.
//!
//! The upload plan reads it (user exclusions, acknowledged scan hits, the
//! last pushed commit); the upload writes it through `update_links` (temp
//! file + rename). It is never reachable through `integration_state_*`.
//!
//! Also here: the per-link lock (plan P-R13) and the rename hook (P-R14).

use std::collections::{BTreeMap, HashSet};
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use git2::{ObjectType, Oid};
use serde::{Deserialize, Serialize};

use super::state::{read_doc, write_doc, GithubDoc};
use super::walk::StatusCache;
use crate::net::store::vault_dir;
use crate::net::NetError;

/// Where an upload stands (spec §8.4). Each state is saved before its side
/// effect runs.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LinkState {
    #[default]
    Planned,
    RepoCreating,
    RepoReady,
    Committed,
    Pushed,
}

/// A scan hit the user marked "키가 아닙니다": the file and the hash of the
/// line, so an edit of that line brings the hit back.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct AllowedHit {
    pub path: String,
    pub line_hash: String,
}

/// One folder's link to a repository.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct LinkRecord {
    /// 16 random bytes in hex: names the bare repo (`repos/<linkId>.git`).
    pub link_id: String,
    pub repo_id: u64,
    pub owner: String,
    pub name: String,
    pub html_url: String,
    pub branch: String,
    /// What GitHub last said about the repository's visibility.
    pub private: bool,
    /// The visibility the user asked for when the app created the repository
    /// (`None` for a linked one). Kept apart from `private` so a repository
    /// that came out public when private was asked for is never pushed to
    /// until it is private, however often the upload is retried.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intended_private: Option<bool>,
    pub state: LinkState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_pushed_commit: Option<String>,
    /// Unix milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_pushed_at: Option<u64>,
    /// Folder-relative paths the user unticked (or that were too large).
    pub excluded: Vec<String>,
    pub allowed_hits: Vec<AllowedHit>,
    /// Unix milliseconds of the create request (journal `repoCreating`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_description: Option<String>,
}

/// The whole `GithubDoc::Links` document of one vault.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct LinksDoc {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_owner: Option<String>,
    /// Folder (vault-relative POSIX) → link.
    pub links: BTreeMap<String, LinkRecord>,
}

/// `^[0-9a-f]{32}$`: the shape of a link id (and of a plan id).
pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Reads the vault's links (a missing file is no links).
pub(crate) fn read_links(dirs: &Path, root: &Path) -> Result<LinksDoc, NetError> {
    read_doc(dirs, Some(root), GithubDoc::Links)
}

/// Serialises read-modify-write of the link documents inside this process.
/// (Two app instances may still race on different folders; each write is
/// atomic, and the per-link lock keeps two uploads of one link apart.)
static DOC_WRITE: Mutex<()> = Mutex::new(());

/// Reads the vault's links, lets `f` change them, and writes them back
/// through a temp file and a rename. Nothing is written when `f` fails.
pub(crate) fn update_links<T>(
    dirs: &Path,
    root: &Path,
    f: impl FnOnce(&mut LinksDoc) -> Result<T, NetError>,
) -> Result<T, NetError> {
    let _g = DOC_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = read_links(dirs, root)?;
    let out = f(&mut doc)?;
    write_doc(dirs, Some(root), GithubDoc::Links, &doc)?;
    Ok(out)
}

/// Reads the vault's status cache (a missing or damaged one is empty: it is
/// only a cache).
pub(crate) fn read_status_cache(dirs: &Path, root: &Path) -> StatusCache {
    read_doc(dirs, Some(root), GithubDoc::StatusCache).unwrap_or_default()
}

/// Lets `f` change the status cache and writes it back.
pub(crate) fn update_status_cache(dirs: &Path, root: &Path, f: impl FnOnce(&mut StatusCache)) -> Result<(), NetError> {
    let _g = DOC_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut cache = read_status_cache(dirs, root);
    f(&mut cache);
    write_doc(dirs, Some(root), GithubDoc::StatusCache, &cache)
}

/// What a lock is taken on: a link, or a folder that has no link yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LockKey {
    Link(String),
    Folder(String),
}

impl LockKey {
    fn name(&self) -> String {
        match self {
            LockKey::Link(id) => format!("link:{id}"),
            LockKey::Folder(f) => format!("folder:{f}"),
        }
    }

    /// The OS lock file beside the bare repos: `<linkId>.lock`, or
    /// `folder-<hash>.lock` for a folder (its path hashed, so no vault name
    /// lands in a file name).
    fn file(&self, dirs: &Path, root: &Path) -> Option<PathBuf> {
        let repos = vault_dir(dirs, "github", root).join("repos");
        match self {
            LockKey::Link(id) => valid_id(id).then(|| repos.join(format!("{id}.lock"))),
            LockKey::Folder(f) => {
                let h = Oid::hash_object(ObjectType::Blob, f.as_bytes()).ok()?;
                Some(repos.join(format!("folder-{h}.lock")))
            }
        }
    }
}

/// The links and folders being uploaded in this process (P-R13).
#[derive(Default, Debug)]
pub struct BusySet(Mutex<HashSet<String>>);

impl BusySet {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Another window or app instance is uploading this link (`busy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Busy;

/// Held locks. Dropping it releases them (the in-process keys and the OS
/// file locks).
pub struct LinkGuard<'a> {
    set: &'a BusySet,
    keys: Vec<String>,
    files: Vec<File>,
}

impl std::fmt::Debug for LinkGuard<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinkGuard").field("keys", &self.keys).field("files", &self.files.len()).finish()
    }
}

impl Drop for LinkGuard<'_> {
    fn drop(&mut self) {
        // Closing the handles releases the OS locks.
        self.files.clear();
        let mut set = self.set.lock();
        for k in &self.keys {
            set.remove(k);
        }
    }
}

impl LinkGuard<'_> {
    /// Takes one more lock (a link id that was just made). On `Busy` the
    /// locks already held stay held.
    pub fn add(&mut self, dirs: &Path, root: &Path, key: LockKey) -> Result<(), Busy> {
        let name = key.name();
        if self.keys.contains(&name) {
            return Ok(());
        }
        if !self.set.lock().insert(name.clone()) {
            return Err(Busy);
        }
        match lock_file(dirs, root, &key) {
            Ok(file) => {
                self.keys.push(name);
                self.files.extend(file);
                Ok(())
            }
            Err(Busy) => {
                self.set.lock().remove(&name);
                Err(Busy)
            }
        }
    }
}

/// The OS file lock of `key`. A lock file that cannot be created (a
/// read-only app data folder) is no OS lock rather than a failure: the
/// in-process set still holds.
fn lock_file(dirs: &Path, root: &Path, key: &LockKey) -> Result<Option<File>, Busy> {
    let Some(path) = key.file(dirs, root) else { return Ok(None) };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(file) = OpenOptions::new().create(true).truncate(false).write(true).open(&path) else {
        return Ok(None);
    };
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Err(Busy),
        Err(TryLockError::Error(_)) => Ok(None),
    }
}

/// Takes the lock on every key in `keys`, or on none of them.
pub fn lock_link<'a>(set: &'a BusySet, dirs: &Path, root: &Path, keys: &[LockKey]) -> Result<LinkGuard<'a>, Busy> {
    let mut guard = LinkGuard { set, keys: Vec::new(), files: Vec::new() };
    for k in keys {
        guard.add(dirs, root, k.clone())?;
    }
    Ok(guard)
}

/// `key` re-rooted at `to` when it is `from` or lies under it.
fn rekey(key: &str, from: &str, to: &str) -> Option<String> {
    if key == from {
        return Some(to.to_string());
    }
    key.strip_prefix(from).and_then(|rest| rest.strip_prefix('/')).map(|rest| format!("{to}/{rest}"))
}

fn clean_rel(p: &str) -> String {
    p.replace('\\', "/").trim_matches('/').to_string()
}

/// The rename hook (P-R14): after `vault_rename(from, to)` succeeded, every
/// link whose folder is `from` or lies under it is re-keyed, and so is its
/// status cache. Called from Rust only; the webview can never re-point a link.
pub fn on_rename(dirs: &Path, root: &Path, from: &str, to: &str) -> Result<(), NetError> {
    let (from, to) = (clean_rel(from), clean_rel(to));
    if from.is_empty() || to.is_empty() || from == to {
        return Ok(());
    }
    if !read_links(dirs, root)?.links.keys().any(|k| rekey(k, &from, &to).is_some()) {
        return Ok(());
    }
    update_links(dirs, root, |doc| {
        let old = std::mem::take(&mut doc.links);
        for (k, v) in old {
            doc.links.insert(rekey(&k, &from, &to).unwrap_or(k), v);
        }
        Ok(())
    })?;
    update_status_cache(dirs, root, |cache| {
        let old = std::mem::take(&mut cache.0);
        for (k, v) in old {
            cache.0.insert(rekey(&k, &from, &to).unwrap_or(k), v);
        }
    })
}

/// The app-owned bare repository of a link (spec §8.1), outside the vault:
/// `<IntegrationDirs>/github/<vaultKey>/repos/<linkId>.git`. `None` for a
/// link id that is not 32 hex characters.
pub(crate) fn bare_repo_path(dirs: &Path, root: &Path, link_id: &str) -> Option<PathBuf> {
    valid_id(link_id).then(|| vault_dir(dirs, "github", root).join("repos").join(format!("{link_id}.git")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitsync::state::write_doc;
    use crate::net::config::tests::scratch_dir;

    #[test]
    fn links_round_trip_and_tolerate_missing_fields() {
        let dirs = scratch_dir("gh-links");
        let root = dirs.join("vault");
        assert_eq!(read_links(&dirs, &root).unwrap(), LinksDoc::default());
        let doc: LinksDoc = serde_json::from_value(serde_json::json!({
            "defaultOwner": "kim-lab",
            "links": {"labnote/001_a": {"linkId": "0123456789abcdef0123456789abcdef", "excluded": ["big.czi"],
                "allowedHits": [{"path": "a.md", "lineHash": "ab"}], "state": "pushed", "lastPushedCommit": "00"}}
        }))
        .unwrap();
        write_doc(&dirs, Some(&root), GithubDoc::Links, &doc).unwrap();
        let back = read_links(&dirs, &root).unwrap();
        assert_eq!(back, doc);
        let link = &back.links["labnote/001_a"];
        assert_eq!(link.state, LinkState::Pushed);
        assert_eq!(link.excluded, ["big.czi"]);
        let _ = std::fs::remove_dir_all(&dirs);
    }

    const ID_A: &str = "0123456789abcdef0123456789abcdef";
    const ID_B: &str = "fedcba9876543210fedcba9876543210";

    fn linked(dirs: &Path, root: &Path, folders: &[(&str, &str)]) {
        let mut doc = LinksDoc { default_owner: Some("kim-lab".into()), ..LinksDoc::default() };
        for (folder, id) in folders {
            doc.links.insert(folder.to_string(), LinkRecord { link_id: id.to_string(), ..LinkRecord::default() });
        }
        write_doc(dirs, Some(root), GithubDoc::Links, &doc).unwrap();
    }

    #[test]
    fn a_held_link_is_busy_until_released() {
        let dirs = scratch_dir("gh-lock");
        let root = dirs.join("vault");
        let set = BusySet::default();
        let other = BusySet::default();
        let a = LockKey::Link(ID_A.into());
        let folder = LockKey::Folder("labnote/001_a".into());
        let g = lock_link(&set, &dirs, &root, &[folder.clone(), a.clone()]).unwrap();
        assert!(lock_link(&set, &dirs, &root, &[a.clone()]).is_err());
        assert!(lock_link(&set, &dirs, &root, &[folder.clone()]).is_err());
        // Another app instance (its own set) is stopped by the OS file lock.
        assert_eq!(lock_link(&other, &dirs, &root, &[a.clone()]).unwrap_err(), Busy);
        assert_eq!(lock_link(&other, &dirs, &root, &[folder.clone()]).unwrap_err(), Busy);
        // A failed lock takes nothing: a different key is still free.
        let b = lock_link(&set, &dirs, &root, &[LockKey::Link(ID_B.into())]).unwrap();
        drop(b);
        assert!(dirs.join("github").read_dir().is_ok());
        drop(g);
        let again = lock_link(&other, &dirs, &root, &[folder, a]).unwrap();
        drop(again);
        // The lock files live beside the bare repos and name no folder.
        let repos = vault_dir(&dirs, "github", &root).join("repos");
        let names: Vec<String> = std::fs::read_dir(&repos).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(names.contains(&format!("{ID_A}.lock")), "{names:?}");
        assert!(names.iter().all(|n| !n.contains("labnote")), "{names:?}");
        let _ = std::fs::remove_dir_all(&dirs);
    }

    #[test]
    fn rename_rekeys_links_and_status_cache() {
        let dirs = scratch_dir("gh-rename");
        let root = dirs.join("vault");
        linked(&dirs, &root, &[("labnote/001_a", ID_A), ("labnote/002_b", ID_B)]);
        update_status_cache(&dirs, &root, |c| {
            c.0.insert("labnote/001_a".into(), Default::default());
        })
        .unwrap();
        on_rename(&dirs, &root, "labnote/001_a", "labnote/001_b").unwrap();
        let doc = read_links(&dirs, &root).unwrap();
        assert_eq!(doc.links.keys().collect::<Vec<_>>(), ["labnote/001_b", "labnote/002_b"]);
        assert_eq!(doc.links["labnote/001_b"].link_id, ID_A);
        assert_eq!(doc.default_owner.as_deref(), Some("kim-lab"));
        assert!(read_status_cache(&dirs, &root).0.contains_key("labnote/001_b"));
        // Renaming a parent re-keys every link under it.
        on_rename(&dirs, &root, "labnote", "실험/labnote").unwrap();
        let doc = read_links(&dirs, &root).unwrap();
        assert_eq!(doc.links.keys().collect::<Vec<_>>(), ["실험/labnote/001_b", "실험/labnote/002_b"]);
        // A rename that only shares a prefix, or an unrelated one, changes nothing.
        let before = std::fs::read(GithubDoc::Links.path(&dirs, Some(&root)).unwrap()).unwrap();
        on_rename(&dirs, &root, "실험/labnote/001", "x").unwrap();
        on_rename(&dirs, &root, "notes/a.md", "notes/b.md").unwrap();
        assert_eq!(std::fs::read(GithubDoc::Links.path(&dirs, Some(&root)).unwrap()).unwrap(), before);
        let _ = std::fs::remove_dir_all(&dirs);
    }

    #[test]
    fn bare_repo_paths_need_a_hex_id() {
        let dirs = Path::new("C:/data/integrations");
        let root = Path::new("D:/vault");
        let p = bare_repo_path(dirs, root, "0123456789abcdef0123456789abcdef").unwrap();
        assert!(p.ends_with("repos/0123456789abcdef0123456789abcdef.git"));
        assert!(p.starts_with(vault_dir(dirs, "github", root)));
        for bad in ["", "../x", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde"] {
            assert!(bare_repo_path(dirs, root, bad).is_none(), "{bad}");
        }
    }
}
