//! The app-owned bare repository of one link (spec §3.4, §8.1).
//!
//! There is no worktree, no index and no `core.worktree`: commits are built
//! from blobs with `TreeBuilder`, so no git2 call made here can write into the
//! vault. The bare repo lives under the app's integration data, never inside
//! the vault.

use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::Once;

use git2::{ErrorCode, ObjectType, Oid, Repository, RepositoryInitOptions, Signature};

use super::links::bare_repo_path;

/// A failure of the Git engine. Messages never hold a token: push and fetch
/// errors are redacted before they are wrapped (`push::redact`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GitError {
    /// A link id that is not 32 lower-case hex characters.
    BadLinkId,
    /// A path that cannot be a tree entry (empty, `.`, `..`, `.git`, a
    /// backslash, a NUL) or that appears twice.
    BadPath(String),
    /// A branch or target ref name git refuses, or one that starts with `+`.
    BadRef,
    /// The bare repo would sit inside the vault, or a remote URL is not under
    /// the allowed Git base.
    NotAllowed,
    /// A planned file changed after the plan was made (spec §8.1).
    PlanStale { path: String },
    /// The remote refused the token (fetch or connect).
    AuthRejected,
    /// A disk failure while reading a planned file.
    Io(String),
    /// Any other libgit2 failure, redacted.
    Git(String),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitError::BadLinkId => write!(f, "not a link id"),
            GitError::BadPath(p) => write!(f, "not a valid path in an upload: {p:?}"),
            GitError::BadRef => write!(f, "not a valid branch name"),
            GitError::NotAllowed => write!(f, "that location is not allowed"),
            GitError::PlanStale { path } => write!(f, "{path:?} changed after the preview"),
            GitError::AuthRejected => write!(f, "GitHub did not accept the sign-in"),
            GitError::Io(m) => write!(f, "could not read a file: {m}"),
            GitError::Git(m) => write!(f, "git: {m}"),
        }
    }
}

impl std::error::Error for GitError {}

impl From<git2::Error> for GitError {
    fn from(e: git2::Error) -> Self {
        GitError::Git(e.message().to_string())
    }
}

static OWNER_CHECK: Once = Once::new();

/// Turns libgit2's repository-owner check off, once per process.
///
/// The app opens only its own bare repos under its integration data (vault
/// repo detection is a plain `.git` existence check, Task 5), so the check
/// protects nothing here and would refuse a repo after a Windows profile move.
pub fn init_owner_check() {
    OWNER_CHECK.call_once(|| {
        // SAFETY: process-wide libgit2 option, set once before any repo of
        // this module is opened; no other code in the app opens repositories
        // whose ownership matters.
        let _ = unsafe { git2::opts::set_verify_owner_validation(false) };
    });
}

/// Opens, or creates, the bare repo of `link_id` at
/// `vault_dir(dirs, "github", vault_root)/repos/<linkId>.git` (spec §8.1),
/// with `core.longpaths=true` and `core.autocrlf=false`.
pub fn open_or_init(dirs: &Path, vault_root: &Path, link_id: &str) -> Result<Repository, GitError> {
    let path = bare_repo_path(dirs, vault_root, link_id).ok_or(GitError::BadLinkId)?;
    if path.starts_with(vault_root) {
        return Err(GitError::NotAllowed);
    }
    init_owner_check();
    let repo = if path.join("HEAD").is_file() {
        Repository::open_bare(&path)?
    } else {
        std::fs::create_dir_all(&path).map_err(|e| GitError::Io(e.kind().to_string()))?;
        let mut opts = RepositoryInitOptions::new();
        opts.bare(true).no_reinit(false).mkdir(true).initial_head("main");
        Repository::init_opts(&path, &opts)?
    };
    if !repo.is_bare() {
        return Err(GitError::NotAllowed);
    }
    let mut cfg = repo.config()?.open_level(git2::ConfigLevel::Local)?;
    cfg.set_bool("core.longpaths", true)?;
    cfg.set_bool("core.autocrlf", false)?;
    Ok(repo)
}

/// The commit identity `login <id+login@users.noreply.github.com>` (spec
/// §8.1): it avoids GH007 and keeps private e-mail addresses out.
pub fn signature(login: &str, id: u64) -> Result<Signature<'static>, GitError> {
    let ok = !login.is_empty()
        && login.len() <= 39
        && login.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.');
    if !ok {
        return Err(GitError::BadPath(login.to_string()));
    }
    Ok(Signature::now(login, &format!("{id}+{login}@users.noreply.github.com"))?)
}

/// `refs/heads/<name>` when `name` is a branch name git accepts and does not
/// start with `+`.
pub fn branch_ref(name: &str) -> Result<String, GitError> {
    let full = format!("refs/heads/{name}");
    if name.is_empty() || name.starts_with('+') || name.starts_with('-') || !git2::Reference::is_valid_name(&full) {
        return Err(GitError::BadRef);
    }
    Ok(full)
}

/// The components of a planned path, or `BadPath`.
fn components(rel: &str) -> Result<Vec<&str>, GitError> {
    let bad = || GitError::BadPath(rel.to_string());
    if rel.is_empty() || rel.contains('\\') || rel.contains('\0') {
        return Err(bad());
    }
    let parts: Vec<&str> = rel.split('/').collect();
    for p in &parts {
        if p.is_empty() || *p == "." || *p == ".." || p.eq_ignore_ascii_case(".git") {
            return Err(bad());
        }
    }
    Ok(parts)
}

/// A directory of the tree being built: blobs by name and sub-directories.
#[derive(Default)]
struct Dir<'a> {
    blobs: Vec<(&'a str, Oid)>,
    dirs: Vec<(&'a str, Dir<'a>)>,
}

impl<'a> Dir<'a> {
    fn insert(&mut self, parts: &[&'a str], id: Oid, rel: &str) -> Result<(), GitError> {
        let dup = || GitError::BadPath(rel.to_string());
        match parts {
            [name] => {
                if self.blobs.iter().any(|(n, _)| n == name) || self.dirs.iter().any(|(n, _)| n == name) {
                    return Err(dup());
                }
                self.blobs.push((name, id));
                Ok(())
            }
            [head, rest @ ..] => {
                if self.blobs.iter().any(|(n, _)| n == head) {
                    return Err(dup());
                }
                let at = match self.dirs.iter().position(|(n, _)| n == head) {
                    Some(i) => i,
                    None => {
                        self.dirs.push((head, Dir::default()));
                        self.dirs.len() - 1
                    }
                };
                self.dirs[at].1.insert(rest, id, rel)
            }
            [] => Err(dup()),
        }
    }

    /// Writes the tree bottom-up. `TreeBuilder` sorts entries the way git
    /// does, so the result is deterministic.
    fn write(&self, repo: &Repository) -> Result<Oid, GitError> {
        let mut tb = repo.treebuilder(None)?;
        for (name, id) in &self.blobs {
            tb.insert(*name, *id, 0o100644)?;
        }
        for (name, dir) in &self.dirs {
            let id = dir.write(repo)?;
            tb.insert(*name, id, 0o040000)?;
        }
        Ok(tb.write()?)
    }
}

/// Streams `reader` into the object database and answers the blob id.
fn stream_blob<R: Read>(repo: &Repository, mut reader: R) -> Result<Oid, GitError> {
    // No hint path: no filter (CRLF, smudge) ever touches the bytes.
    let mut w = repo.blob_writer(None)?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(GitError::Io(e.kind().to_string())),
        };
        w.write_all(&buf[..n]).map_err(|e| GitError::Io(e.kind().to_string()))?;
    }
    Ok(w.commit()?)
}

/// Builds one commit from a plan (spec §8.1) and points `refs/heads/<branch>`
/// of the bare repo at it.
///
/// - Every planned file is re-read through `read` and streamed into the ODB;
///   a blob id different from the planned one aborts with `PlanStale` before
///   any ref moves.
/// - `overlays` are the generated files, written from their exact bytes.
/// - Paths are UTF-8 `/`-separated and kept byte-exact (Hangul, spaces, NFD).
pub fn commit_plan<R: Read>(
    repo: &Repository,
    branch: &str,
    entries: &[(String, Oid)],
    read: impl Fn(&str) -> io::Result<R>,
    overlays: &[(String, Vec<u8>)],
    parent: Option<Oid>,
    sig: &Signature<'_>,
    message: &str,
) -> Result<Oid, GitError> {
    let refname = branch_ref(branch)?;
    let mut root = Dir::default();
    for (rel, planned) in entries {
        let parts = components(rel)?;
        let reader = read(rel).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => GitError::PlanStale { path: rel.clone() },
            k => GitError::Io(k.to_string()),
        })?;
        let id = stream_blob(repo, reader)?;
        if id != *planned {
            return Err(GitError::PlanStale { path: rel.clone() });
        }
        root.insert(&parts, id, rel)?;
    }
    for (rel, bytes) in overlays {
        let parts = components(rel)?;
        let id = repo.blob(bytes)?;
        root.insert(&parts, id, rel)?;
    }
    let tree_id = root.write(repo)?;
    let tree = repo.find_tree(tree_id)?;
    let parent_commit = match parent {
        Some(p) => Some(repo.find_commit(p)?),
        None => None,
    };
    let parents: Vec<&git2::Commit<'_>> = parent_commit.iter().collect();
    let id = repo.commit(None, sig, sig, message, &tree, &parents)?;
    // The bare repo's own branch: the app is its only writer.
    repo.reference(&refname, id, true, "labnoteO upload")?;
    Ok(id)
}

/// The blob of `rel` in `commit`'s tree, if any (used by tests and status).
pub fn blob_at(repo: &Repository, commit: Oid, rel: &str) -> Option<Vec<u8>> {
    let tree = repo.find_commit(commit).ok()?.tree().ok()?;
    let entry = tree.get_path(Path::new(rel)).ok()?;
    if entry.kind() != Some(ObjectType::Blob) {
        return None;
    }
    Some(repo.find_blob(entry.id()).ok()?.content().to_vec())
}

/// The commit `refs/heads/<branch>` points at, if the branch exists.
pub fn branch_tip(repo: &Repository, branch: &str) -> Result<Option<Oid>, GitError> {
    match repo.refname_to_id(&branch_ref(branch)?) {
        Ok(id) => Ok(Some(id)),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::net::config::tests::scratch_dir;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
    use std::time::SystemTime;

    pub const LINK: &str = "0123456789abcdef0123456789abcdef";

    /// Every file and directory under `root`: bytes (files) and mtime.
    pub fn snapshot(root: &Path) -> BTreeMap<PathBuf, (Option<Vec<u8>>, SystemTime)> {
        let mut out = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let meta = fs::metadata(&dir).unwrap();
            out.insert(dir.clone(), (None, meta.modified().unwrap()));
            for e in fs::read_dir(&dir).unwrap() {
                let e = e.unwrap();
                let p = e.path();
                if e.file_type().unwrap().is_dir() {
                    stack.push(p);
                } else {
                    let m = e.metadata().unwrap().modified().unwrap();
                    out.insert(p.clone(), (Some(fs::read(&p).unwrap()), m));
                }
            }
        }
        out
    }

    #[test]
    fn open_or_init_makes_a_bare_repo_outside_the_vault() {
        let base = scratch_dir("gh-repo");
        let dirs = base.join("사용자").join("integrations");
        let vault = base.join("vault");
        fs::create_dir_all(&vault).unwrap();
        let before = snapshot(&vault);
        let repo = open_or_init(&dirs, &vault, LINK).unwrap();
        assert!(repo.is_bare());
        assert!(repo.workdir().is_none());
        let path = repo.path().to_path_buf();
        assert!(!path.starts_with(&vault));
        assert!(path.starts_with(&dirs));
        assert!(path.ends_with(format!("repos/{LINK}.git/")) || path.ends_with(format!("repos/{LINK}.git")));
        let cfg = repo.config().unwrap().open_level(git2::ConfigLevel::Local).unwrap();
        assert!(cfg.get_bool("core.longpaths").unwrap());
        assert!(!cfg.get_bool("core.autocrlf").unwrap());
        assert!(cfg.get_string("core.worktree").is_err());
        drop(repo);
        // Opening again reuses it.
        let again = open_or_init(&dirs, &vault, LINK).unwrap();
        assert_eq!(fs::canonicalize(again.path()).unwrap(), fs::canonicalize(&path).unwrap());
        assert_eq!(snapshot(&vault), before);
        for bad in ["", "../x", "0123456789ABCDEF0123456789ABCDEF"] {
            assert!(matches!(open_or_init(&dirs, &vault, bad), Err(GitError::BadLinkId)), "{bad}");
        }
        // App data inside the vault is refused.
        assert!(matches!(open_or_init(&vault.join("x"), &vault, LINK), Err(GitError::NotAllowed)));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn the_signature_is_the_noreply_address() {
        let s = signature("octo-cat", 42).unwrap();
        assert_eq!(s.name().ok(), Some("octo-cat"));
        assert_eq!(s.email().ok(), Some("42+octo-cat@users.noreply.github.com"));
        for bad in ["", "a b", "x<y>", "a\nb"] {
            assert!(signature(bad, 1).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn branch_names_are_checked() {
        assert_eq!(branch_ref("main").unwrap(), "refs/heads/main");
        assert_eq!(branch_ref("labnoteo/20261110-1200").unwrap(), "refs/heads/labnoteo/20261110-1200");
        for bad in ["", "+main", "a..b", "a b", "-x", "main.lock", "a~1"] {
            assert!(branch_ref(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn bad_and_duplicate_paths_are_refused() {
        let base = scratch_dir("gh-repo-paths");
        let vault = base.join("vault");
        fs::create_dir_all(&vault).unwrap();
        let repo = open_or_init(&base.join("data"), &vault, LINK).unwrap();
        let sig = signature("t", 1).unwrap();
        let none = |_: &str| -> io::Result<&[u8]> { Err(io::ErrorKind::NotFound.into()) };
        for bad in ["", "a//b", "../x", "./x", ".git/config", "a\\b", "x/.GIT/y"] {
            let ov = vec![(bad.to_string(), b"x".to_vec())];
            let r = commit_plan(&repo, "main", &[], none, &ov, None, &sig, "m");
            assert!(matches!(r, Err(GitError::BadPath(_))), "{bad:?}");
        }
        let ov = vec![("a".to_string(), b"x".to_vec()), ("a/b".to_string(), b"y".to_vec())];
        assert!(matches!(commit_plan(&repo, "main", &[], none, &ov, None, &sig, "m"), Err(GitError::BadPath(_))));
        let ov = vec![("a".to_string(), b"x".to_vec()), ("a".to_string(), b"y".to_vec())];
        assert!(matches!(commit_plan(&repo, "main", &[], none, &ov, None, &sig, "m"), Err(GitError::BadPath(_))));
        assert_eq!(branch_tip(&repo, "main").unwrap(), None);
        let _ = fs::remove_dir_all(&base);
    }
}
