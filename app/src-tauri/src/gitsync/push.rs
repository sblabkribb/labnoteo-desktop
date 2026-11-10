//! Push and fetch for the app-owned bare repo (spec §8.2, §8.3).
//!
//! - The remote is anonymous (`remote_anonymous`): its clean URL is never
//!   written to any config, and it never carries a token.
//! - The credential callback answers `x-access-token` + the token only for the
//!   allowed Git base (`https://github.com/`, or a loopback test base), at
//!   most once; a second call means the token was refused.
//! - Every refspec is a plain `src:dst`; nothing here ever force-pushes.
//! - Every line or message that leaves this module is redacted.

use std::cell::{Cell, RefCell};

use git2::{
    CredentialType, Cred, Direction, ErrorClass, ErrorCode, FetchOptions, Oid, ProxyOptions, PushOptions,
    RemoteCallbacks, Repository,
};
use serde::Serialize;
use zeroize::Zeroizing;

use super::repo::{branch_ref, GitError};
use crate::net::config::{is_loopback, Url};
use crate::net::github::{GithubEndpoints, GITHUB_GIT};

/// The user name sent with the token (spec §8.2).
const TOKEN_USER: &str = "x-access-token";
/// What a redacted secret is replaced with.
const MASK: &str = "***";

/// The one Git base remote URLs may live under: `https://github.com/`, or in
/// a test build a loopback `http(s)` base or a local `file:///` base.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitBase(Url);

impl GitBase {
    /// `https://github.com/`.
    pub fn production() -> GitBase {
        GitBase(Url::parse(GITHUB_GIT).expect("the GitHub git base parses"))
    }

    /// The `git` base of `ep` (already restricted by `net::github::endpoints`).
    pub fn from_endpoints(ep: &GithubEndpoints) -> GitBase {
        GitBase::new(&ep.git).unwrap_or_else(GitBase::production)
    }

    /// `base` when it is the production base, a loopback `http(s)` base or a
    /// host-less `file:///` base, with no user info, query or fragment.
    pub fn new(base: &Url) -> Option<GitBase> {
        if !base.username().is_empty() || base.password().is_some() || base.query().is_some() || base.fragment().is_some() {
            return None;
        }
        let mut b = base.clone();
        if !b.path().ends_with('/') {
            let p = format!("{}/", b.path());
            b.set_path(&p);
        }
        let prod = b.as_str() == GITHUB_GIT;
        let loopback = matches!(b.scheme(), "http" | "https") && is_loopback(&b);
        let file = b.scheme() == "file" && b.host_str().map_or(true, str::is_empty);
        (prod || loopback || file).then_some(GitBase(b))
    }

    pub fn url(&self) -> &Url {
        &self.0
    }

    fn same_origin(&self, url: &Url) -> bool {
        url.scheme() == self.0.scheme()
            && url.host_str() == self.0.host_str()
            && url.port_or_known_default() == self.0.port_or_known_default()
    }

    /// Whether `remote` is a clean URL under this base.
    pub fn covers(&self, remote: &Url) -> bool {
        remote.username().is_empty()
            && remote.password().is_none()
            && remote.query().is_none()
            && remote.fragment().is_none()
            && self.same_origin(remote)
            && remote.path().starts_with(self.0.path())
    }

    /// Whether the credential callback may answer for `url` (as libgit2 hands
    /// it over): never for `file`, only `https://github.com` in production,
    /// and only the exact loopback origin of a test base.
    pub fn may_send_token(&self, url: &str) -> bool {
        let Ok(u) = Url::parse(url) else { return false };
        if u.scheme() == "file" || u.password().is_some() {
            return false;
        }
        if self.0.as_str() == GITHUB_GIT {
            return u.scheme() == "https" && u.host_str() == Some("github.com") && u.port_or_known_default() == Some(443);
        }
        matches!(self.0.scheme(), "http" | "https") && is_loopback(&self.0) && self.same_origin(&u)
    }
}

/// Push progress handed to the caller. Returning `false` from the callback
/// cancels, which only works before objects are sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Progress {
    /// About to connect.
    Starting,
    /// The remote told us what it has; the transfer is next.
    Negotiated,
    /// Objects sent so far.
    Sending { current: usize, total: usize, bytes: usize },
}

/// Why the remote refused the push (spec §8.2).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RejectKind {
    SecretDetected,
    EmailPrivacy,
    ProtectedBranch,
    NonFastForward,
    Other,
}

/// How a push ended.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum PushResult {
    Ok,
    Rejected { kind: RejectKind, lines: Vec<String> },
    AuthRejected,
    Cancelled,
}

/// Replaces the token, every `redact` entry and anything shaped like a GitHub
/// token with `***`.
pub fn redact(text: &str, token: &str, extra: &[&str]) -> String {
    let mut out = text.to_string();
    let mut secrets: Vec<&str> = extra.iter().copied().filter(|s| s.len() >= 4).collect();
    if !token.is_empty() {
        secrets.push(token);
    }
    // Longest first, so a secret that contains another is masked whole.
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for s in secrets {
        out = out.replace(s, MASK);
    }
    mask_token_shapes(&out)
}

/// Masks `gh[opusr]_<alnum>` and `github_pat_<alnum/_>` runs.
fn mask_token_shapes(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    while i < b.len() {
        let at_word = i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_');
        let prefix = if !at_word {
            0
        } else if b[i..].starts_with(b"github_pat_") {
            11
        } else if b.len() >= i + 4 && b[i] == b'g' && b[i + 1] == b'h' && b"opusr".contains(&b[i + 2]) && b[i + 3] == b'_' {
            4
        } else {
            0
        };
        if prefix > 0 {
            let mut j = i + prefix;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                j += 1;
            }
            if j - (i + prefix) >= 8 {
                out.push_str(&text[copied..i]);
                out.push_str(MASK);
                copied = j;
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// The rejection kind from the remote's status and `remote:` lines.
pub fn classify(lines: &[String]) -> RejectKind {
    let all = lines.join("\n").to_lowercase();
    if all.contains("gh013") || all.contains("secret") {
        RejectKind::SecretDetected
    } else if all.contains("gh007") || all.contains("private email") {
        RejectKind::EmailPrivacy
    } else if all.contains("protected branch") || all.contains("gh006") {
        RejectKind::ProtectedBranch
    } else if all.contains("non-fast-forward") || all.contains("fetch first") || all.contains("not present locally") {
        RejectKind::NonFastForward
    } else {
        RejectKind::Other
    }
}

/// The credential callback shared by push and fetch: the allowed base only,
/// plaintext user/password only, at most once.
fn credentials<'a>(
    token: &'a Zeroizing<String>,
    allowed: &'a GitBase,
    calls: &'a Cell<u32>,
) -> impl FnMut(&str, Option<&str>, CredentialType) -> Result<Cred, git2::Error> + 'a {
    move |url, _user, types| {
        calls.set(calls.get() + 1);
        if calls.get() > 1 {
            return Err(git2::Error::from_str("auth-rejected"));
        }
        if !types.contains(CredentialType::USER_PASS_PLAINTEXT) || !allowed.may_send_token(url) {
            return Err(git2::Error::from_str("credentials refused for this location"));
        }
        Cred::userpass_plaintext(TOKEN_USER, token.as_str())
    }
}

fn is_auth_error(e: &git2::Error) -> bool {
    e.code() == ErrorCode::Auth || (e.class() == ErrorClass::Http && e.message().contains("401"))
}

fn proxy() -> ProxyOptions<'static> {
    let mut p = ProxyOptions::new();
    p.auto();
    p
}

/// Pushes `refs/heads/<branch>` of the bare repo to `refs/heads/<target_ref>`
/// at `remote_url` (spec §8.2). Never forced: a remote that moved answers
/// `Rejected{nonFastForward}`.
#[allow(clippy::too_many_arguments)]
pub fn push(
    repo: &Repository,
    remote_url: &Url,
    branch: &str,
    target_ref: &str,
    token: &Zeroizing<String>,
    allowed: &GitBase,
    progress: impl FnMut(Progress) -> bool,
    redact_list: &[&str],
) -> Result<PushResult, GitError> {
    let src = branch_ref(branch)?;
    let dst = branch_ref(target_ref)?;
    if !allowed.covers(remote_url) {
        return Err(GitError::NotAllowed);
    }
    let progress = RefCell::new(progress);
    if !(progress.borrow_mut())(Progress::Starting) {
        return Ok(PushResult::Cancelled);
    }
    let refspec = format!("{src}:{dst}");
    let calls = Cell::new(0u32);
    let cancelled = Cell::new(false);
    let rejected: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let sideband: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let result = {
        let mut cb = RemoteCallbacks::new();
        cb.credentials(credentials(token, allowed, &calls));
        cb.push_update_reference(|refname, status| {
            if let Some(msg) = status {
                rejected.borrow_mut().push(format!("{refname}: {msg}"));
            }
            Ok(())
        });
        cb.sideband_progress(|bytes| {
            let text = String::from_utf8_lossy(bytes);
            for line in text.split(['\n', '\r']) {
                let line = line.trim();
                if !line.is_empty() {
                    sideband.borrow_mut().push(line.to_string());
                }
            }
            true
        });
        cb.push_negotiation(|_| {
            if (progress.borrow_mut())(Progress::Negotiated) {
                Ok(())
            } else {
                cancelled.set(true);
                Err(git2::Error::from_str("cancelled"))
            }
        });
        cb.push_transfer_progress(|current, total, bytes| {
            let _ = (progress.borrow_mut())(Progress::Sending { current, total, bytes });
        });
        let mut opts = PushOptions::new();
        opts.remote_callbacks(cb);
        opts.proxy_options(proxy());
        let mut remote = repo.remote_anonymous(remote_url.as_str())?;
        remote.push(&[refspec.as_str()], Some(&mut opts))
    };
    let clean = |lines: Vec<String>| -> Vec<String> {
        lines.iter().map(|l| redact(l, token, redact_list)).collect()
    };
    match result {
        Err(_) if cancelled.get() => Ok(PushResult::Cancelled),
        Err(e) if calls.get() > 1 || is_auth_error(&e) => Ok(PushResult::AuthRejected),
        Err(e) if e.code() == ErrorCode::NotFastForward => {
            let mut lines = clean(sideband.into_inner());
            lines.push(redact(e.message(), token, redact_list));
            Ok(PushResult::Rejected { kind: RejectKind::NonFastForward, lines })
        }
        Err(e) => Err(GitError::Git(redact(e.message(), token, redact_list))),
        Ok(()) => {
            let rejected = rejected.into_inner();
            if rejected.is_empty() {
                return Ok(PushResult::Ok);
            }
            let mut lines = clean(sideband.into_inner());
            lines.extend(clean(rejected));
            Ok(PushResult::Rejected { kind: classify(&lines), lines })
        }
    }
}

/// The ref a remote branch is fetched into.
fn tracking_ref(branch: &str) -> Result<String, GitError> {
    branch_ref(branch)?;
    Ok(format!("refs/remotes/origin/{branch}"))
}

/// Fetches `refs/heads/<branch>` into `refs/remotes/origin/<branch>` (spec
/// §8.3) and answers its tip, or `None` when the remote has no such branch.
/// The tracking ref is deleted first, so a moved remote never needs a forced
/// update.
pub fn fetch(
    repo: &Repository,
    remote_url: &Url,
    branch: &str,
    token: &Zeroizing<String>,
    allowed: &GitBase,
) -> Result<Option<Oid>, GitError> {
    let src = branch_ref(branch)?;
    let dst = tracking_ref(branch)?;
    if !allowed.covers(remote_url) {
        return Err(GitError::NotAllowed);
    }
    if let Ok(mut r) = repo.find_reference(&dst) {
        r.delete()?;
    }
    let calls = Cell::new(0u32);
    let result = {
        let mut cb = RemoteCallbacks::new();
        cb.credentials(credentials(token, allowed, &calls));
        let mut opts = FetchOptions::new();
        opts.remote_callbacks(cb);
        opts.proxy_options(proxy());
        opts.update_fetchhead(false);
        opts.download_tags(git2::AutotagOption::None);
        let mut remote = repo.remote_anonymous(remote_url.as_str())?;
        let refspec = format!("{src}:{dst}");
        remote.fetch(&[refspec.as_str()], Some(&mut opts), None)
    };
    match result {
        Err(e) if calls.get() > 1 || is_auth_error(&e) => Err(GitError::AuthRejected),
        Err(e) => Err(GitError::Git(redact(e.message(), token, &[]))),
        Ok(()) => match repo.refname_to_id(&dst) {
            Ok(id) => Ok(Some(id)),
            Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
            Err(e) => Err(GitError::Git(redact(e.message(), token, &[]))),
        },
    }
}

/// The remote's `refs/heads/<branch>` without downloading anything.
pub fn ls_remote_tip(
    repo: &Repository,
    remote_url: &Url,
    branch: &str,
    token: &Zeroizing<String>,
    allowed: &GitBase,
) -> Result<Option<Oid>, GitError> {
    let name = branch_ref(branch)?;
    if !allowed.covers(remote_url) {
        return Err(GitError::NotAllowed);
    }
    let calls = Cell::new(0u32);
    let mut cb = RemoteCallbacks::new();
    cb.credentials(credentials(token, allowed, &calls));
    let mut remote = repo.remote_anonymous(remote_url.as_str())?;
    let conn = remote.connect_auth(Direction::Fetch, Some(cb), Some(proxy()));
    let conn = match conn {
        Ok(c) => c,
        Err(e) if calls.get() > 1 || is_auth_error(&e) => return Err(GitError::AuthRejected),
        Err(e) => return Err(GitError::Git(redact(e.message(), token, &[]))),
    };
    let heads = conn.list().map_err(|e| GitError::Git(redact(e.message(), token, &[])))?;
    Ok(heads.iter().find(|h| h.name() == name).map(|h| h.oid()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitsync::repo::tests::{snapshot, LINK};
    use crate::gitsync::repo::{blob_at, branch_tip, commit_plan, open_or_init, signature};
    use crate::net::config::tests::scratch_dir;
    use git2::ObjectType;
    use std::fs;
    use std::path::{Path, PathBuf};

    const FAKE: &str = "gho_FAKE8AFAKE8AFAKE8AFAKE8AFAKE8A0000";
    const FOLDER: &str = "002 실험 폴더";
    const NFD: &str = "\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af}.txt";

    struct Fx {
        base: PathBuf,
        dirs: PathBuf,
        vault: PathBuf,
        remotes: PathBuf,
    }

    impl Fx {
        fn new(tag: &str) -> Fx {
            let base = scratch_dir(tag);
            let dirs = base.join("사용자").join("integrations");
            let vault = base.join("vault");
            let remotes = base.join("remotes");
            fs::create_dir_all(vault.join(FOLDER)).unwrap();
            fs::create_dir_all(remotes.join("o")).unwrap();
            Fx { base, dirs, vault, remotes }
        }
        fn folder(&self) -> PathBuf {
            self.vault.join(FOLDER)
        }
        fn put(&self, rel: &str, bytes: &[u8]) {
            let p = self.folder().join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, bytes).unwrap();
        }
        fn remote(&self, name: &str) -> (Repository, Url) {
            let path = self.remotes.join("o").join(format!("{name}.git"));
            let repo = Repository::init_bare(&path).unwrap();
            let url = Url::from_file_path(&path).unwrap();
            (repo, url)
        }
        fn allowed(&self) -> GitBase {
            GitBase::new(&Url::from_directory_path(&self.remotes).unwrap()).unwrap()
        }
        /// `(rel, planned id)` of the current bytes of `rels`.
        fn entries(&self, rels: &[&str]) -> Vec<(String, Oid)> {
            rels.iter()
                .map(|r| {
                    let bytes = fs::read(self.folder().join(r)).unwrap();
                    (r.to_string(), Oid::hash_object(ObjectType::Blob, &bytes).unwrap())
                })
                .collect()
        }
        fn commit(&self, repo: &Repository, rels: &[&str], parent: Option<Oid>) -> Result<Oid, GitError> {
            let folder = self.folder();
            let entries = self.entries(rels);
            let overlays = vec![(".gitattributes".to_string(), b"* -text\n".to_vec())];
            let sig = signature("octo", 7).unwrap();
            commit_plan(repo, "main", &entries, |rel| fs::File::open(folder.join(rel)), &overlays, parent, &sig, "upload")
        }
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn token() -> Zeroizing<String> {
        Zeroizing::new(FAKE.to_string())
    }

    fn push_main(repo: &Repository, url: &Url, allowed: &GitBase) -> PushResult {
        push(repo, url, "main", "main", &token(), allowed, |_| true, &[]).unwrap()
    }

    fn remote_tip(remote: &Repository) -> Option<Oid> {
        remote.refname_to_id("refs/heads/main").ok()
    }

    /// Every file under `dir` holds no copy of the fake token.
    fn no_token_under(dir: &Path) {
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    let bytes = fs::read(&p).unwrap();
                    assert!(!bytes.windows(FAKE.len()).any(|w| w == FAKE.as_bytes()), "token in {p:?}");
                }
            }
        }
    }

    const CSV_BOM_CRLF: &[u8] = b"\xEF\xBB\xBFwell,od\r\nA1,0.12\r\n";
    const CSV_CP949: &[u8] = b"\xC7\xD1\xB1\xDB,\xB0\xAA\r\n1,2\r\n";
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\r\n";

    fn first_files(fx: &Fx) -> Vec<&'static str> {
        fx.put("결과 요약.md", "# 결과\n\nOD 0.12\n".as_bytes());
        fx.put("data/plate 1.csv", CSV_BOM_CRLF);
        fx.put("data/cp949.csv", CSV_CP949);
        fx.put(NFD, "nfd".as_bytes());
        fx.put("이미지/gel.png", PNG);
        vec!["결과 요약.md", "data/plate 1.csv", "data/cp949.csv", NFD, "이미지/gel.png"]
    }

    #[test]
    fn first_commit_and_push_keep_every_byte() {
        let fx = Fx::new("gh-push-first");
        let rels = first_files(&fx);
        let before = snapshot(&fx.vault);
        let repo = open_or_init(&fx.dirs, &fx.vault, LINK).unwrap();
        assert!(!repo.path().starts_with(&fx.vault));
        let commit = fx.commit(&repo, &rels, None).unwrap();
        assert_eq!(branch_tip(&repo, "main").unwrap(), Some(commit));
        let (remote, url) = fx.remote("r");
        assert_eq!(push_main(&repo, &url, &fx.allowed()), PushResult::Ok);
        assert_eq!(remote_tip(&remote), Some(commit));
        for rel in &rels {
            let src = fs::read(fx.folder().join(rel)).unwrap();
            assert_eq!(blob_at(&remote, commit, rel).as_deref(), Some(src.as_slice()), "{rel}");
        }
        assert_eq!(blob_at(&remote, commit, ".gitattributes").as_deref(), Some(&b"* -text\n"[..]));
        // The NFD name went up as NFD bytes, not recomposed.
        let tree = remote.find_commit(commit).unwrap().tree().unwrap();
        assert!(tree.iter().any(|e| e.name_bytes() == NFD.as_bytes()));
        let c = remote.find_commit(commit).unwrap();
        assert_eq!(c.author().email().ok(), Some("7+octo@users.noreply.github.com"));
        assert_eq!(c.parent_count(), 0);
        assert_eq!(snapshot(&fx.vault), before);
        // No config of the bare repo names the remote.
        let cfg = fs::read_to_string(repo.path().join("config")).unwrap();
        assert!(!cfg.contains("remote"), "{cfg}");
        no_token_under(&fx.dirs);
        no_token_under(&fx.remotes);
    }

    #[test]
    fn a_second_commit_fast_forwards() {
        let fx = Fx::new("gh-push-second");
        let rels = first_files(&fx);
        let repo = open_or_init(&fx.dirs, &fx.vault, LINK).unwrap();
        let first = fx.commit(&repo, &rels, None).unwrap();
        let (remote, url) = fx.remote("r");
        assert_eq!(push_main(&repo, &url, &fx.allowed()), PushResult::Ok);
        // Modify one, add one, delete one.
        fx.put("결과 요약.md", "# 결과\n\nOD 0.34\n".as_bytes());
        fx.put("새 파일.txt", b"new");
        fs::remove_file(fx.folder().join("data/cp949.csv")).unwrap();
        let before = snapshot(&fx.vault);
        let rels2 = ["결과 요약.md", "data/plate 1.csv", NFD, "이미지/gel.png", "새 파일.txt"];
        let second = fx.commit(&repo, &rels2, Some(first)).unwrap();
        assert_eq!(push_main(&repo, &url, &fx.allowed()), PushResult::Ok);
        assert_eq!(remote_tip(&remote), Some(second));
        let c = remote.find_commit(second).unwrap();
        assert_eq!(c.parent_id(0).unwrap(), first);
        assert_eq!(blob_at(&remote, second, "결과 요약.md").unwrap(), "# 결과\n\nOD 0.34\n".as_bytes());
        assert_eq!(blob_at(&remote, second, "새 파일.txt").unwrap(), b"new");
        assert!(blob_at(&remote, second, "data/cp949.csv").is_none());
        assert_eq!(snapshot(&fx.vault), before);
    }

    #[test]
    fn a_push_whose_parent_is_not_the_remote_tip_is_rejected() {
        let fx = Fx::new("gh-push-nff");
        let rels = first_files(&fx);
        let repo = open_or_init(&fx.dirs, &fx.vault, LINK).unwrap();
        let first = fx.commit(&repo, &rels, None).unwrap();
        let (remote, url) = fx.remote("r");
        assert_eq!(push_main(&repo, &url, &fx.allowed()), PushResult::Ok);
        // Someone else moved the remote on.
        let sig = signature("labmate", 9).unwrap();
        let tree = remote.find_commit(first).unwrap().tree().unwrap();
        let parent = remote.find_commit(first).unwrap();
        let theirs = remote.commit(Some("refs/heads/main"), &sig, &sig, "edit on GitHub", &tree, &[&parent]).unwrap();
        // Ours still builds on `first`.
        fx.put("결과 요약.md", b"mine");
        let ours = fx.commit(&repo, &rels, Some(first)).unwrap();
        assert_ne!(ours, theirs);
        match push_main(&repo, &url, &fx.allowed()) {
            PushResult::Rejected { kind: RejectKind::NonFastForward, lines } => {
                assert!(lines.iter().all(|l| !l.contains(FAKE)));
            }
            other => panic!("expected nonFastForward, got {other:?}"),
        }
        assert_eq!(remote_tip(&remote), Some(theirs));
    }

    #[test]
    fn a_file_changed_after_the_plan_is_stale() {
        let fx = Fx::new("gh-push-stale");
        let rels = first_files(&fx);
        let repo = open_or_init(&fx.dirs, &fx.vault, LINK).unwrap();
        let first = fx.commit(&repo, &rels, None).unwrap();
        // Plan, then the file changes before the commit.
        let entries = fx.entries(&rels);
        fx.put("data/plate 1.csv", b"changed after the preview");
        let folder = fx.folder();
        let sig = signature("octo", 7).unwrap();
        let r = commit_plan(&repo, "main", &entries, |rel| fs::File::open(folder.join(rel)), &[], Some(first), &sig, "m");
        assert_eq!(r, Err(GitError::PlanStale { path: "data/plate 1.csv".into() }));
        assert_eq!(branch_tip(&repo, "main").unwrap(), Some(first));
        // A planned file that disappeared is stale too.
        let entries = fx.entries(&rels);
        fs::remove_file(fx.folder().join(NFD)).unwrap();
        let r = commit_plan(&repo, "main", &entries, |rel| fs::File::open(folder.join(rel)), &[], Some(first), &sig, "m");
        assert_eq!(r, Err(GitError::PlanStale { path: NFD.into() }));
        assert_eq!(branch_tip(&repo, "main").unwrap(), Some(first));
    }

    #[test]
    fn cancel_before_the_transfer_leaves_the_remote_alone() {
        let fx = Fx::new("gh-push-cancel");
        let rels = first_files(&fx);
        let repo = open_or_init(&fx.dirs, &fx.vault, LINK).unwrap();
        fx.commit(&repo, &rels, None).unwrap();
        let (remote, url) = fx.remote("r");
        let r = push(&repo, &url, "main", "main", &token(), &fx.allowed(), |_| false, &[]).unwrap();
        assert_eq!(r, PushResult::Cancelled);
        let r = push(&repo, &url, "main", "main", &token(), &fx.allowed(), |p| p == Progress::Starting, &[]).unwrap();
        assert_eq!(r, PushResult::Cancelled);
        assert_eq!(remote_tip(&remote), None);
    }

    #[test]
    fn push_to_a_side_branch_and_refuse_urls_outside_the_base() {
        let fx = Fx::new("gh-push-side");
        let rels = first_files(&fx);
        let repo = open_or_init(&fx.dirs, &fx.vault, LINK).unwrap();
        let c = fx.commit(&repo, &rels, None).unwrap();
        let (remote, url) = fx.remote("r");
        let r = push(&repo, &url, "main", "labnoteo/20261110-1200", &token(), &fx.allowed(), |_| true, &[]).unwrap();
        assert_eq!(r, PushResult::Ok);
        assert_eq!(remote.refname_to_id("refs/heads/labnoteo/20261110-1200").unwrap(), c);
        assert_eq!(remote_tip(&remote), None);
        // A remote outside the allowed base is never contacted.
        let other = scratch_dir("gh-push-elsewhere");
        let elsewhere = Url::from_file_path(other.join("x.git")).unwrap();
        let r = push(&repo, &elsewhere, "main", "main", &token(), &fx.allowed(), |_| true, &[]);
        assert_eq!(r, Err(GitError::NotAllowed));
        let _ = fs::remove_dir_all(&other);
        let r = push(&repo, &url, "main", "+main", &token(), &fx.allowed(), |_| true, &[]);
        assert_eq!(r, Err(GitError::BadRef));
    }

    #[test]
    fn fetch_and_ls_remote_follow_a_moved_remote() {
        let fx = Fx::new("gh-fetch");
        let rels = first_files(&fx);
        let repo = open_or_init(&fx.dirs, &fx.vault, LINK).unwrap();
        let (remote, url) = fx.remote("r");
        let allowed = fx.allowed();
        assert_eq!(fetch(&repo, &url, "main", &token(), &allowed).unwrap(), None);
        assert_eq!(ls_remote_tip(&repo, &url, "main", &token(), &allowed).unwrap(), None);
        let first = fx.commit(&repo, &rels, None).unwrap();
        assert_eq!(push_main(&repo, &url, &allowed), PushResult::Ok);
        assert_eq!(fetch(&repo, &url, "main", &token(), &allowed).unwrap(), Some(first));
        // The remote moves to a commit that is not a descendant.
        let sig = signature("labmate", 9).unwrap();
        let tree = remote.find_commit(first).unwrap().tree().unwrap();
        let orphan = remote.commit(None, &sig, &sig, "rewritten", &tree, &[]).unwrap();
        remote.reference("refs/heads/main", orphan, true, "test").unwrap();
        assert_eq!(ls_remote_tip(&repo, &url, "main", &token(), &allowed).unwrap(), Some(orphan));
        assert_eq!(fetch(&repo, &url, "main", &token(), &allowed).unwrap(), Some(orphan));
        assert_eq!(repo.refname_to_id("refs/remotes/origin/main").unwrap(), orphan);
        assert!(repo.find_commit(orphan).is_ok());
        no_token_under(&fx.dirs);
    }

    #[test]
    fn the_token_goes_only_to_the_allowed_base() {
        let prod = GitBase::production();
        assert!(prod.may_send_token("https://github.com/o/r.git"));
        assert!(prod.may_send_token("https://github.com/o/r.git/info/refs?service=git-receive-pack"));
        for bad in [
            "http://github.com/o/r.git",
            "https://github.com.evil.example/o/r.git",
            "https://api.github.com/o/r.git",
            "https://gist.github.com/o/r.git",
            "https://github.com:8443/o/r.git",
            "https://x:y@github.com/o/r.git",
            "file:///C:/o/r.git",
            "nonsense",
        ] {
            assert!(!prod.may_send_token(bad), "{bad}");
        }
        let test = GitBase::new(&Url::parse("http://127.0.0.1:4567/git").unwrap()).unwrap();
        assert_eq!(test.url().as_str(), "http://127.0.0.1:4567/git/");
        assert!(test.may_send_token("http://127.0.0.1:4567/git/o/r.git"));
        for bad in ["http://localhost:4567/o/r.git", "http://127.0.0.2:4567/o/r.git", "http://127.0.0.1:4568/o/r.git", "https://github.com/o/r.git"] {
            assert!(!test.may_send_token(bad), "{bad}");
        }
        let file = GitBase::new(&Url::parse("file:///C:/tmp/remotes/").unwrap()).unwrap();
        assert!(!file.may_send_token("file:///C:/tmp/remotes/o/r.git"));
        // Only the three kinds of base exist.
        for bad in ["https://example.com/", "http://10.0.0.1/", "file://server/share/", "https://github.com/o/"] {
            assert!(GitBase::new(&Url::parse(bad).unwrap()).is_none(), "{bad}");
        }
        assert!(prod.covers(&Url::parse("https://github.com/o/r.git").unwrap()));
        assert!(!prod.covers(&Url::parse("https://x-access-token:t@github.com/o/r.git").unwrap()));
        assert!(!test.covers(&Url::parse("http://127.0.0.1:4567/other/o/r.git").unwrap()));
    }

    #[test]
    fn credentials_answer_at_most_once() {
        let allowed = GitBase::production();
        let calls = Cell::new(0);
        let tok = token();
        let mut cb = credentials(&tok, &allowed, &calls);
        assert!(cb("https://github.com/o/r.git", None, CredentialType::USER_PASS_PLAINTEXT).is_ok());
        let second = cb("https://github.com/o/r.git", None, CredentialType::USER_PASS_PLAINTEXT);
        assert_eq!(second.err().unwrap().message(), "auth-rejected");
        let calls = Cell::new(0);
        let mut cb = credentials(&tok, &allowed, &calls);
        assert!(cb("https://github.com/o/r.git", None, CredentialType::SSH_KEY).is_err());
        let calls = Cell::new(0);
        let mut cb = credentials(&tok, &allowed, &calls);
        let e = cb("https://evil.example/o/r.git", None, CredentialType::USER_PASS_PLAINTEXT).err().unwrap();
        assert!(!e.message().contains(FAKE));
    }

    #[test]
    fn redaction_masks_the_token_extras_and_token_shapes() {
        let line = format!("remote: GH013 found {FAKE} and ghp_ABCDEFGH12345678 and github_pat_11AAAA_bbbbbbbb and sk-live-zzzz");
        let out = redact(&line, FAKE, &["sk-live-zzzz", "ab"]);
        assert!(!out.contains(FAKE));
        assert!(!out.contains("ghp_ABCDEFGH"));
        assert!(!out.contains("github_pat_11"));
        assert!(!out.contains("sk-live-zzzz"));
        assert!(out.contains("remote: GH013 found ***"));
        // Short or word-internal look-alikes are left alone.
        assert_eq!(redact("ghp_x and xghp_ABCDEFGH12345678", "", &[]), "ghp_x and xghp_ABCDEFGH12345678");
        assert_eq!(redact("한글 gho_ABCDEFGH12345678 끝", "", &[]), "한글 *** 끝");
    }

    #[test]
    fn rejections_are_classified() {
        let k = |s: &str| classify(&[s.to_string()]);
        assert_eq!(k("remote: error: GH013: Repository rule violations found"), RejectKind::SecretDetected);
        assert_eq!(k("remote: error: GH007: Your push would publish a private email address."), RejectKind::EmailPrivacy);
        assert_eq!(k("refs/heads/main: protected branch hook declined"), RejectKind::ProtectedBranch);
        assert_eq!(k("refs/heads/main: non-fast-forward"), RejectKind::NonFastForward);
        assert_eq!(k("refs/heads/main: pre-receive hook declined"), RejectKind::Other);
        let json = serde_json::to_value(PushResult::Rejected { kind: RejectKind::NonFastForward, lines: vec![] }).unwrap();
        assert_eq!(json, serde_json::json!({"outcome": "rejected", "kind": "nonFastForward", "lines": []}));
    }

    // ---- Push over HTTP against the smart-HTTP stub (plan Task 8B) ----

    use crate::gitsync::smart_http_stub::{base64, Mode, Stub};

    /// A committed bare repo plus a stub serving `o/r.git`.
    fn over_http(tag: &str, mode: Mode, also_127_0_0_2: bool) -> (Fx, Repository, Stub, Url, GitBase) {
        let fx = Fx::new(tag);
        let rels = first_files(&fx);
        let repo = open_or_init(&fx.dirs, &fx.vault, LINK).unwrap();
        fx.commit(&repo, &rels, None).unwrap();
        let stub = Stub::start(mode, also_127_0_0_2);
        let url = Url::parse(&format!("{}o/r.git", stub.base)).unwrap();
        let allowed = GitBase::new(&Url::parse(&stub.base).unwrap()).unwrap();
        (fx, repo, stub, url, allowed)
    }

    fn basic() -> String {
        format!("Basic {}", base64(format!("x-access-token:{FAKE}").as_bytes()))
    }

    fn has_token(bytes: &[u8]) -> bool {
        bytes.windows(FAKE.len()).any(|w| w == FAKE.as_bytes())
    }

    /// No copy of the token in the bare repo (config, FETCH_HEAD, packed-refs,
    /// logs/ …), the temp app data, or anything the stub received besides the
    /// `Authorization` header.
    fn no_leaks(fx: &Fx, repo: &Repository, stub: &Stub) {
        for f in ["config", "FETCH_HEAD", "packed-refs"] {
            if let Ok(s) = fs::read(repo.path().join(f)) {
                assert!(!has_token(&s), "{f}");
            }
        }
        no_token_under(&fx.base);
        for s in stub.seen() {
            assert!(!s.target.contains(FAKE));
            assert!(!has_token(&s.body));
        }
    }

    #[test]
    fn http_a_refused_token_is_tried_once_and_reported_as_auth_rejected() {
        let (fx, repo, stub, url, allowed) = over_http("gh-http-401", Mode::always_unauthorized(), false);
        let r = push(&repo, &url, "main", "main", &token(), &allowed, |_| true, &[]);
        assert_eq!(r, Ok(PushResult::AuthRejected));
        assert!(!format!("{r:?}").contains(FAKE));
        // The token went out exactly once (one credential answer), as Basic
        // `x-access-token`, and libgit2 then gave up.
        assert_eq!(stub.authorizations(), vec![basic()]);
        // Fetch and ls-remote say the same, each with one try.
        assert_eq!(fetch(&repo, &url, "main", &token(), &allowed), Err(GitError::AuthRejected));
        assert_eq!(ls_remote_tip(&repo, &url, "main", &token(), &allowed), Err(GitError::AuthRejected));
        assert_eq!(stub.authorizations().len(), 3);
        no_leaks(&fx, &repo, &stub);
    }

    #[test]
    fn http_a_protected_branch_is_rejected() {
        let (fx, repo, stub, url, allowed) = over_http("gh-http-ng", Mode::ng("protected branch hook declined"), false);
        match push(&repo, &url, "main", "main", &token(), &allowed, |_| true, &[]).unwrap() {
            PushResult::Rejected { kind: RejectKind::ProtectedBranch, lines } => {
                assert!(lines.iter().any(|l| l.contains("protected branch hook declined")), "{lines:?}");
            }
            other => panic!("expected protectedBranch, got {other:?}"),
        }
        no_leaks(&fx, &repo, &stub);
    }

    #[test]
    fn http_a_secret_rejection_is_classified_and_redacted() {
        let leak = format!("remote:       - token: {FAKE}");
        let mode = Mode::sideband(
            &[
                "remote: error: GH013: Repository rule violations found for refs/heads/main.",
                "remote: - GITHUB PUSH PROTECTION",
                leak.as_str(),
                "remote:       - other: ghp_ABCDEFGH12345678abcdefgh",
            ],
            "push declined due to repository rule violations",
        );
        let (fx, repo, stub, url, allowed) = over_http("gh-http-gh013", mode, false);
        match push(&repo, &url, "main", "main", &token(), &allowed, |_| true, &[]).unwrap() {
            PushResult::Rejected { kind: RejectKind::SecretDetected, lines } => {
                assert!(lines.iter().any(|l| l.contains("GH013")), "{lines:?}");
                assert!(lines.iter().any(|l| l == "remote:       - token: ***"), "{lines:?}");
                assert!(lines.iter().all(|l| !l.contains(FAKE) && !l.contains("ghp_ABCDEFGH")), "{lines:?}");
                assert!(lines.iter().any(|l| l.contains("repository rule violations")), "{lines:?}");
            }
            other => panic!("expected secretDetected, got {other:?}"),
        }
        no_leaks(&fx, &repo, &stub);
    }

    #[test]
    fn http_ok_sends_basic_x_access_token() {
        let (fx, repo, stub, url, allowed) = over_http("gh-http-ok", Mode::ok(), false);
        let mut stages = Vec::new();
        let r = push(&repo, &url, "main", "labnoteo/20261110-1200", &token(), &allowed, |p| {
            stages.push(p);
            true
        }, &[]);
        assert_eq!(r, Ok(PushResult::Ok));
        assert!(stages.contains(&Progress::Starting) && stages.contains(&Progress::Negotiated), "{stages:?}");
        let seen = stub.seen();
        // GitHub-like: the first request is anonymous and answered 401; every
        // later one carries the one Basic credential.
        assert_eq!(seen[0].authorization, None);
        assert!(seen.len() >= 3, "{seen:?}");
        for s in &seen[1..] {
            assert_eq!(s.authorization.as_deref(), Some(basic().as_str()), "{}", s.target);
        }
        let post = seen.iter().find(|s| s.method == "POST").expect("a receive-pack POST");
        assert!(post.target.ends_with("/o/r.git/git-receive-pack"), "{}", post.target);
        assert!(post.body.windows(4).any(|w| w == b"PACK"));
        assert!(post.body.windows(28).any(|w| w == b"refs/heads/labnoteo/20261110"));
        no_leaks(&fx, &repo, &stub);
    }

    #[test]
    fn http_the_token_never_goes_to_another_loopback_host() {
        // A remote URL outside the allowed base is never contacted.
        let (fx, repo, stub, _url, allowed) = over_http("gh-http-host", Mode::ok(), true);
        for host in ["localhost", "127.0.0.2"] {
            let other = Url::parse(&format!("http://{host}:{}/o/r.git", stub.port)).unwrap();
            assert_eq!(push(&repo, &other, "main", "main", &token(), &allowed, |_| true, &[]), Err(GitError::NotAllowed));
        }
        assert!(stub.seen().is_empty());
        // Past that pre-check, the credential callback itself refuses: libgit2
        // reaches the same stub as `localhost` / `127.0.0.2`, gets the 401,
        // asks the callback once (allowed base `127.0.0.1:<port>`), and no
        // request ever carries a token.
        let tok = token();
        let mut asked = 0;
        for host in ["localhost", "127.0.0.2"] {
            let before = stub.seen().len();
            let calls = Cell::new(0u32);
            let r = {
                let mut cb = RemoteCallbacks::new();
                cb.credentials(credentials(&tok, &allowed, &calls));
                let mut opts = PushOptions::new();
                opts.remote_callbacks(cb);
                let other = format!("http://{host}:{}/o/r.git", stub.port);
                let mut remote = repo.remote_anonymous(&other).unwrap();
                remote.push(&["refs/heads/main:refs/heads/main"], Some(&mut opts))
            };
            let e = r.expect_err(host);
            assert!(!e.message().contains(FAKE), "{host}: {}", e.message());
            if stub.seen().len() > before {
                // The stub answered this host: the callback was asked and said no.
                assert_eq!(calls.get(), 1, "{host}");
                assert!(stub.seen()[before..].iter().all(|s| s.host.as_deref() != Some(&format!("127.0.0.1:{}", stub.port))));
                asked += 1;
            }
        }
        // `localhost` always reaches a 127.0.0.1 listener on Windows.
        assert!(asked >= 1, "{:?}", stub.seen());
        assert!(stub.authorizations().is_empty(), "{:?}", stub.seen());
        no_leaks(&fx, &repo, &stub);
        // A redirect from the allowed origin to another loopback host never
        // gets the token either (libgit2 does not switch hosts; whatever it
        // does, no request carries a token and the push fails).
        for host in ["localhost", "127.0.0.2"] {
            let stub = Stub::start(Mode::redirect_to(host), true);
            let url = Url::parse(&format!("{}o/r.git", stub.base)).unwrap();
            let allowed = GitBase::new(&Url::parse(&stub.base).unwrap()).unwrap();
            let r = push(&repo, &url, "main", "main", &token(), &allowed, |_| true, &[]);
            assert!(!matches!(r, Ok(PushResult::Ok)), "{host}: {r:?}");
            assert!(!format!("{r:?}").contains(FAKE));
            assert!(!stub.seen().is_empty(), "{host}: the stub was asked");
            assert!(stub.authorizations().is_empty(), "{host}: {:?}", stub.seen());
            no_leaks(&fx, &repo, &stub);
        }
    }

    /// No refspec in the GitHub code ever starts with `+` (no force push).
    /// Reads every `gitsync/*.rs` and `net/github/*.rs`, so files added later
    /// are covered too; `include_str!` pins the ones that exist now.
    #[test]
    fn no_forced_refspec_in_the_source() {
        let pinned = [include_str!("push.rs"), include_str!("repo.rs"), include_str!("../net/github/repos.rs")];
        let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut sources: Vec<(String, String)> = Vec::new();
        for sub in ["gitsync", "net/github"] {
            for e in fs::read_dir(src_dir.join(sub)).unwrap() {
                let p = e.unwrap().path();
                if p.extension().and_then(|x| x.to_str()) == Some("rs") {
                    sources.push((p.display().to_string(), fs::read_to_string(&p).unwrap()));
                }
            }
        }
        assert!(sources.len() >= 14, "{}", sources.len());
        sources.extend(pinned.iter().enumerate().map(|(i, s)| (format!("pinned {i}"), s.to_string())));
        let plus = '+';
        let needles = [format!("\"{plus}refs/"), format!("\"{plus}{{"), format!("\"{plus}\""), format!("push_str(\"{plus}")];
        for (name, src) in &sources {
            for n in &needles {
                assert!(!src.contains(n.as_str()), "{name} contains {n}");
            }
        }
    }
}
