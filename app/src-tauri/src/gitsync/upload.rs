//! Uploading a planned folder (spec §5.3–§5.6, §8): create the repository,
//! commit in the app-owned bare repo, push; plus the folder status, the
//! default owner and "연결 끊기".
//!
//! - The webview names only a `planId` and narrowing choices: `untick` may
//!   only remove paths the plan listed, `allowHits` only acknowledges hits
//!   the plan found (never a private key or a saved key).
//! - Every planned file is hashed again before anything is sent (`planStale`),
//!   and once more while its blob is written.
//! - The journal state is saved before each side effect (spec §8.4).
//! - The create body is fixed here; a repository that is not private when
//!   private was asked for stops before any push (`visibilityMismatch`), on
//!   this upload and on every later one until it is private (the link keeps
//!   `intendedPrivate`).
//! - One upload per link at a time (`busy`), in this process and across app
//!   instances (P-R13).
//! - Status, default owner and unlink never reach the network.

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::Instant;

use git2::{ObjectType, Oid, Repository};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Emitter, Manager, State};
use zeroize::Zeroizing;

use super::journal::{self, now_ms};
use super::links::{
    bare_repo_path, lock_link, read_links, read_status_cache, update_links, update_status_cache, valid_id, AllowedHit,
    BusySet, LinkRecord, LinkState, LockKey,
};
use super::overlay::{folder_title, Counts, SAMPLES_DIR};
use super::plan::{base_tree, new_id, Change, Plan, PlanEntry, PlanTarget, Red, COMMIT_MESSAGE_PATH};
use super::push::{self as git_push, GitBase, Progress, PushResult, RejectKind};
use super::repo::{branch_ref, commit_plan, open_or_init, signature, GitError};
use super::state::{github_client_id, read_doc, GithubAppSettings, GithubDoc};
use super::walk::{status_hash, walk, CacheEntry, FolderCache, Limits, WalkError};
use crate::net::config::Url;
use crate::net::github::api::{classify, valid_segment, ApiOutcome, ApiReply, GithubCall};
use crate::net::github::auth::{call_authed, token, Account};
use crate::net::github::repos::repo_facts;
use crate::net::github::{endpoints, GithubEndpoints, GithubState, GITHUB_WEB};
use crate::net::secrets::{SecretStore, Secrets};
use crate::net::{IntegrationDirs, NetError, NetErrorKind, NetState};
use crate::vault::path::confine;
use crate::vault::VaultState;

/// The progress event (`tests/ipc-events.json` → `githubProgress`).
pub const PROGRESS_EVENT: &str = "github://progress";

/// The branch a new repository gets.
const NEW_BRANCH: &str = "main";

/// What the user chose in the preview. Every field can only narrow.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadChoices {
    /// Paths to leave out; only paths the plan listed as untickable count.
    #[serde(default)]
    pub untick: Vec<String>,
    /// "키가 아닙니다" for overridable hits the plan found.
    #[serde(default)]
    pub allow_hits: Vec<AllowedHit>,
    /// The typed repository name that confirms a public repository.
    #[serde(default)]
    pub public_confirm: Option<String>,
    /// Upload the sample snapshot the plan offered.
    #[serde(default)]
    pub include_samples: bool,
    /// The answer to `diverged` (Task 9B).
    #[serde(default)]
    pub diverged: Option<DivergedChoice>,
    /// The files the user ticked on the divergence screen (Task 9B).
    #[serde(default)]
    pub ack_files: Vec<String>,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DivergedChoice {
    Mine,
    Separate,
}

/// A warning on a finished upload.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UploadWarning {
    /// The repository became public since the last upload (said once).
    NowPublic,
}

/// One file that changed on GitHub (the divergence screen).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DivergedFile {
    pub path: String,
    pub change: Change,
}

/// `github_upload`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum UploadOutcome {
    #[serde(rename_all = "camelCase")]
    Done { html_url: String, full_name: String, counts: Counts, warnings: Vec<UploadWarning> },
    NothingChanged,
    NeedsSignIn,
    Blocked { red: Vec<Red> },
    PlanStale,
    PlanExpired,
    Diverged { files: Vec<DivergedFile> },
    #[serde(rename_all = "camelCase")]
    PushedSeparately { compare_url: String },
    #[serde(rename_all = "camelCase")]
    OrgRestricted { org: String, approve_url: String },
    SsoRequired { url: String },
    CannotCreateInOrg { org: String },
    NameTaken,
    NotFoundOrNoAccess,
    ReadOnly,
    RateLimited { seconds: u64 },
    Rejected { kind: RejectKind, lines: Vec<String> },
    LegalBlock { message: String },
    #[serde(rename_all = "camelCase")]
    VisibilityMismatch { html_url: String },
    Busy,
}

/// The steps of the progress dialog (spec §5.5).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// 저장소 만드는 중
    Creating,
    /// 파일 정리 중
    Preparing,
    /// 올리는 중 (`done` / `total` bytes)
    Uploading,
    /// 확인 중
    Checking,
}

/// The `github://progress` payload.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubProgress {
    pub request_id: String,
    pub stage: Stage,
    pub done: u64,
    pub total: u64,
}

/// Points before each side effect, where tests inject faults.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Point {
    BeforeCreate,
    BeforeFetch,
    BeforeCommit,
    BeforePush,
}

/// The Git side effects of an upload, behind a trait so tests can count
/// them, pause at a point, or fail a step. `RealSteps` is the app's.
///
/// Only the fetch and the push can be replaced. The create request, the
/// journal writes and the commit are reachable only through `reached`;
/// fault injection at every journal state (a lost create answer, a crash
/// after the push and before its journal write) will need more seams here
/// (Task 9C).
pub trait Steps: Sync {
    /// Called before the side effect at `point` runs.
    fn reached(&self, _point: Point) {}

    fn fetch(
        &self,
        repo: &Repository,
        remote: &Url,
        branch: &str,
        token: &Zeroizing<String>,
        allowed: &GitBase,
    ) -> Result<Option<Oid>, GitError> {
        git_push::fetch(repo, remote, branch, token, allowed)
    }

    fn push(
        &self,
        repo: &Repository,
        remote: &Url,
        branch: &str,
        token: &Zeroizing<String>,
        allowed: &GitBase,
        progress: &mut dyn FnMut(Progress) -> bool,
    ) -> Result<PushResult, GitError> {
        git_push::push(repo, remote, branch, branch, token, allowed, progress, &[])
    }
}

/// The real Git steps.
pub struct RealSteps;

impl Steps for RealSteps {}

/// What an upload runs with.
pub struct UploadEnv<'a> {
    pub ep: &'a GithubEndpoints,
    pub dirs: &'a Path,
    pub root: &'a Path,
    pub store: &'a dyn SecretStore,
    pub net: &'a NetState,
    pub gh: &'a GithubState,
    pub request_id: Option<&'a str>,
    pub steps: &'a dyn Steps,
    pub progress: &'a (dyn Fn(Stage, u64, u64) + Sync),
}

fn bad_input(msg: &str) -> NetError {
    NetError::new(NetErrorKind::BadInput, msg)
}

fn git_error(e: GitError) -> NetError {
    // GitError text is redacted where it is made (`push::redact`).
    NetError::new(NetErrorKind::Io, e.to_string())
}

fn unexpected() -> NetError {
    NetError::new(NetErrorKind::NotJson, "GitHub's answer is not what was expected")
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

/// `rel` (POSIX, folder-relative) under the confined folder path.
fn file_path(folder_abs: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(folder_abs.to_path_buf(), |p, c| p.join(c))
}

/// The remote URL `<git base><owner>/<name>.git`.
fn remote_url(ep: &GithubEndpoints, owner: &str, name: &str) -> Result<Url, NetError> {
    if !valid_segment(owner) || !valid_segment(name) {
        return Err(bad_input("not a valid GitHub owner or repository name"));
    }
    ep.git
        .join(&format!("{owner}/{name}.git"))
        .map_err(|_| NetError::new(NetErrorKind::InvalidUrl, "the address is not valid"))
}

/// "Approve the app for this organization" on GitHub.
fn approve_url(dirs: &Path) -> String {
    let app: GithubAppSettings = read_doc(dirs, None, GithubDoc::App).unwrap_or_default();
    match github_client_id(&app) {
        Some(id) => format!("{GITHUB_WEB}settings/connections/applications/{id}"),
        None => format!("{GITHUB_WEB}settings/applications"),
    }
}

/// An API answer the UI explains.
fn api_outcome(dirs: &Path, o: ApiOutcome, reply: &ApiReply) -> Result<UploadOutcome, NetError> {
    Ok(match o {
        ApiOutcome::NeedsSignIn => UploadOutcome::NeedsSignIn,
        ApiOutcome::OrgRestricted { org } => UploadOutcome::OrgRestricted { org, approve_url: approve_url(dirs) },
        ApiOutcome::SsoRequired { url } => UploadOutcome::SsoRequired { url },
        ApiOutcome::CannotCreateInOrg { org } => UploadOutcome::CannotCreateInOrg { org },
        ApiOutcome::RateLimited { seconds } => UploadOutcome::RateLimited { seconds },
        ApiOutcome::NameTaken => UploadOutcome::NameTaken,
        ApiOutcome::NotFoundOrNoAccess => UploadOutcome::NotFoundOrNoAccess,
        ApiOutcome::LegalBlock { message } => UploadOutcome::LegalBlock { message },
        ApiOutcome::Other { status } => {
            let body = if reply.json.is_null() { String::new() } else { reply.json.to_string() };
            return Err(NetError::status(status, &body, None));
        }
        ApiOutcome::Ok | ApiOutcome::Moved { .. } => return Err(unexpected()),
    })
}

/// Where the upload goes, decided under the lock.
enum Dest {
    Create { owner: String, name: String, private: bool },
    Update(LinkRecord),
}

/// The plan narrowed by the user's choices.
struct Selection<'p> {
    unticked: HashSet<&'p str>,
    entries: Vec<&'p PlanEntry>,
    overlays: Vec<(String, Vec<u8>)>,
}

fn select<'p>(plan: &'p Plan, choices: &'p UploadChoices) -> Selection<'p> {
    let unticked: HashSet<&str> =
        choices.untick.iter().map(String::as_str).filter(|p| plan.untickable.contains(*p)).collect();
    let entries = plan.entries.iter().filter(|e| !unticked.contains(e.rel.as_str())).collect();
    let mut overlays = plan.overlays.clone();
    if choices.include_samples {
        overlays.extend(plan.sample_overlays.iter().filter(|(p, _)| !unticked.contains(p.as_str())).cloned());
    }
    Selection { unticked, entries, overlays }
}

/// The red items left after the user's choices. Private-key and saved-key
/// hits (`overridable == false`) stay whatever `allowHits` says.
fn remaining_red(plan: &Plan, sel: &Selection<'_>, choices: &UploadChoices) -> Vec<Red> {
    let going: HashSet<&str> = sel
        .entries
        .iter()
        .map(|e| e.rel.as_str())
        .chain(sel.overlays.iter().map(|(p, _)| p.as_str()))
        .chain(std::iter::once(COMMIT_MESSAGE_PATH))
        .collect();
    let allowed: HashSet<(&str, &str)> =
        choices.allow_hits.iter().map(|a| (a.path.as_str(), a.line_hash.as_str())).collect();
    let bytes: u64 = sel.entries.iter().map(|e| e.size).sum::<u64>() + sel.overlays.iter().map(|(_, b)| b.len() as u64).sum::<u64>();
    plan.red
        .iter()
        .filter(|r| match r {
            Red::Secret { hit, .. } => {
                going.contains(hit.path.as_str())
                    && !(hit.overridable && allowed.contains(&(hit.path.as_str(), hit.line_hash.as_str())))
            }
            Red::TooLarge { path, .. } | Red::Unreadable { path } => !sel.unticked.contains(path.as_str()),
            Red::UploadTooLarge { limit, .. } => bytes > *limit,
            Red::NfdCollision { paths } => paths.iter().filter(|p| going.contains(p.as_str())).count() > 1,
            Red::PublicNotConfirmed => true,
        })
        .cloned()
        .collect()
}

/// The user-facing counts after the choices (generated and sample files
/// left out).
fn counts(plan: &Plan, sel: &Selection<'_>) -> Counts {
    let mut c = Counts::default();
    for f in plan.files.iter().filter(|f| !f.generated && !f.sample) {
        let gone = sel.unticked.contains(f.path.as_str());
        match (f.change, gone) {
            (Change::New, false) => c.new += 1,
            (Change::Changed, false) => c.changed += 1,
            (Change::Deleted, _) | (Change::Same | Change::Changed, true) => c.deleted += 1,
            _ => {}
        }
    }
    c
}

/// Exclusions and acknowledged hits to remember after an upload.
fn remember(rec: &mut LinkRecord, plan: &Plan, sel: &Selection<'_>, choices: &UploadChoices) {
    for p in &sel.unticked {
        if !plan.is_sample_path(p) && !rec.excluded.iter().any(|x| x == p) {
            rec.excluded.push(p.to_string());
        }
    }
    rec.excluded.sort();
    for a in &choices.allow_hits {
        let found = plan.hits.iter().any(|h| h.overridable && h.path == a.path && h.line_hash == a.line_hash);
        if found && !rec.allowed_hits.contains(a) {
            rec.allowed_hits.push(a.clone());
        }
    }
    rec.allowed_hits.sort();
}

/// Uploads plan `plan_id` (see the module doc). Blocking: runs the GitHub
/// calls on the async runtime and the Git steps on this thread.
pub fn upload_at(env: &UploadEnv<'_>, plan_id: &str, choices: UploadChoices) -> Result<UploadOutcome, NetError> {
    let Some(folder) = env.gh.plans.folder_of(plan_id) else { return Ok(UploadOutcome::PlanExpired) };
    // 1. Lock the folder (and its link, when it has one).
    let mut keys = vec![LockKey::Folder(folder.clone())];
    if let Some(l) = read_links(env.dirs, env.root)?.links.get(&folder).filter(|l| valid_id(&l.link_id)) {
        keys.push(LockKey::Link(l.link_id.clone()));
    }
    let Ok(mut guard) = lock_link(&env.gh.busy, env.dirs, env.root, &keys) else { return Ok(UploadOutcome::Busy) };
    // 2. Take the plan (used once).
    let Ok(plan) = env.gh.plans.take(plan_id, Instant::now()) else { return Ok(UploadOutcome::PlanExpired) };
    let link = read_links(env.dirs, env.root)?.links.get(&plan.folder).cloned();
    let dest = match (&plan.target, link) {
        (PlanTarget::Create { .. }, Some(_)) => return Err(bad_input("this folder is already linked to a repository")),
        (PlanTarget::Create { owner, name, private }, None) => {
            Dest::Create { owner: owner.clone(), name: name.clone(), private: *private }
        }
        // Linking an existing repository always goes through the divergence
        // screen (Task 9B).
        (PlanTarget::Link { .. }, _) => return Err(bad_input("linking an existing repository is not available yet")),
        (PlanTarget::Update, None) => return Err(bad_input("this folder is not linked to a repository")),
        (PlanTarget::Update, Some(l)) => {
            let last = l.last_pushed_commit.as_deref().and_then(|c| Oid::from_str(c).ok());
            if plan.link_id.as_deref() != Some(l.link_id.as_str()) || (plan.base_commit.is_some() && plan.base_commit != last) {
                return Ok(UploadOutcome::PlanStale);
            }
            if l.state == LinkState::RepoCreating {
                return Err(bad_input("the earlier upload of this folder is not finished"));
            }
            if guard.add(env.dirs, env.root, LockKey::Link(l.link_id.clone())).is_err() {
                return Ok(UploadOutcome::Busy);
            }
            Dest::Update(l)
        }
    };

    // 3. Re-hash every file that goes up.
    let sel = select(&plan, &choices);
    let folder_abs = confine(env.root, &plan.folder).map_err(|_| bad_input("not a valid folder path"))?;
    for e in &sel.entries {
        match Oid::hash_file(ObjectType::Blob, file_path(&folder_abs, &e.rel)) {
            Ok(id) if id == e.oid => {}
            _ => return Ok(UploadOutcome::PlanStale),
        }
    }
    // 4. Red items left after the choices block.
    let red = remaining_red(&plan, &sel, &choices);
    if !red.is_empty() {
        return Ok(UploadOutcome::Blocked { red });
    }
    // 5. A public repository needs the typed name.
    if let Dest::Create { name, private: false, .. } = &dest {
        if choices.public_confirm.as_deref() != Some(name.as_str()) {
            return Ok(UploadOutcome::Blocked { red: vec![Red::PublicNotConfirmed] });
        }
    }
    let Some(tok) = token(env.gh, env.store)? else { return Ok(UploadOutcome::NeedsSignIn) };
    let Some(account) = read_doc::<Option<Account>>(env.dirs, None, GithubDoc::Account)? else {
        return Ok(UploadOutcome::NeedsSignIn);
    };
    let sig = signature(&account.login, account.id).map_err(git_error)?;

    let mut warnings = Vec::new();
    let (link_id, owner, name, html_url, branch, parent) = match dest {
        // 6–8. Journal, create, check the visibility.
        Dest::Create { owner, name, private } => {
            (env.progress)(Stage::Creating, 0, 1);
            let link_id = new_id();
            if guard.add(env.dirs, env.root, LockKey::Link(link_id.clone())).is_err() {
                return Ok(UploadOutcome::Busy);
            }
            let description = format!("{} · labnoteO", folder_title(&plan.folder));
            let record = LinkRecord {
                link_id: link_id.clone(),
                owner: owner.clone(),
                name: name.clone(),
                branch: NEW_BRANCH.to_string(),
                private,
                intended_private: Some(private),
                state: LinkState::RepoCreating,
                requested_at: Some(now_ms()),
                sent_description: Some(description.clone()),
                ..LinkRecord::default()
            };
            journal::begin_create(env.dirs, env.root, &plan.folder, record)?;
            env.steps.reached(Point::BeforeCreate);
            let call = if owner.eq_ignore_ascii_case(&account.login) {
                GithubCall::CreateUserRepo
            } else {
                GithubCall::CreateOrgRepo { org: owner.clone() }
            };
            // The whole create body: nothing else is ever sent.
            let body = json!({"name": name, "description": description, "private": private, "auto_init": false, "has_wiki": false});
            // A lost answer keeps `repoCreating` for "마저 하기" (never a second POST).
            let reply = block_on(call_authed(env.ep, env.dirs, env.store, env.net, env.gh, env.request_id, call.clone(), Some(body)))?;
            match classify(&call, &reply) {
                ApiOutcome::Ok => {}
                other => {
                    // GitHub answered and refused: nothing was created.
                    journal::abandon(env.dirs, env.root, &link_id)?;
                    return api_outcome(env.dirs, other, &reply);
                }
            }
            let f = repo_facts(&reply.json).ok_or_else(unexpected)?;
            journal::advance(env.dirs, env.root, &link_id, |r| {
                r.repo_id = f.id;
                r.owner = f.owner.clone();
                r.name = f.name.clone();
                r.html_url = f.html_url.clone();
                r.private = f.private;
                r.state = LinkState::RepoReady;
            })?;
            // Only "private asked, public made" stops: a repository that came
            // out private when public was confirmed is safe to push to.
            if private && !f.private {
                return Ok(UploadOutcome::VisibilityMismatch { html_url: f.html_url });
            }
            (link_id, f.owner, f.name, f.html_url, NEW_BRANCH.to_string(), None)
        }
        // The linked repository: still there, still writable, still private?
        Dest::Update(l) => {
            (env.progress)(Stage::Preparing, 0, 1);
            let call = GithubCall::GetRepo { owner: l.owner.clone(), name: l.name.clone() };
            let reply = block_on(call_authed(env.ep, env.dirs, env.store, env.net, env.gh, env.request_id, call.clone(), None))?;
            match classify(&call, &reply) {
                ApiOutcome::Ok | ApiOutcome::Moved { .. } => {}
                other => return api_outcome(env.dirs, other, &reply),
            }
            let f = repo_facts(&reply.json).ok_or_else(unexpected)?;
            if !f.can_push {
                return Ok(UploadOutcome::ReadOnly);
            }
            let html_url = if f.html_url.is_empty() { l.html_url.clone() } else { f.html_url.clone() };
            // Nothing has been pushed to a repository the app created as
            // private that is public now: the first push waits until it is
            // private again (spec §5.3: verified, never assumed).
            if l.last_pushed_commit.is_none() && l.intended_private == Some(true) && !f.private {
                return Ok(UploadOutcome::VisibilityMismatch { html_url });
            }
            if l.private && !f.private {
                warnings.push(UploadWarning::NowPublic);
            }
            if (f.owner.as_str(), f.name.as_str(), f.private, html_url.as_str()) != (l.owner.as_str(), l.name.as_str(), l.private, l.html_url.as_str()) {
                journal::advance(env.dirs, env.root, &l.link_id, |r| {
                    r.owner = f.owner.clone();
                    r.name = f.name.clone();
                    r.private = f.private;
                    r.html_url = html_url.clone();
                })?;
            }
            let parent = l.last_pushed_commit.as_deref().and_then(|c| Oid::from_str(c).ok());
            let branch = if l.branch.is_empty() { NEW_BRANCH.to_string() } else { l.branch.clone() };
            (l.link_id, f.owner, f.name, html_url, branch, parent)
        }
    };

    // 8. Fetch: the remote must still be where the last upload left it.
    (env.progress)(Stage::Preparing, 0, 1);
    let repo = open_or_init(env.dirs, env.root, &link_id).map_err(git_error)?;
    let remote = remote_url(env.ep, &owner, &name)?;
    let allowed = GitBase::from_endpoints(env.ep);
    env.steps.reached(Point::BeforeFetch);
    let tip = match env.steps.fetch(&repo, &remote, &branch, &tok, &allowed) {
        Ok(t) => t,
        Err(GitError::AuthRejected) => return Ok(UploadOutcome::NeedsSignIn),
        Err(e) => return Err(git_error(e)),
    };
    if tip != parent {
        // Task 9B lists the files (P-R8) and offers "mine" / "separate".
        return Ok(UploadOutcome::Diverged { files: Vec::new() });
    }

    // 9. Commit from the plan, every blob re-hashed as it is written.
    let ids: Vec<(String, Oid)> = sel.entries.iter().map(|e| (e.rel.clone(), e.oid)).collect();
    env.steps.reached(Point::BeforeCommit);
    let read = |rel: &str| File::open(file_path(&folder_abs, rel));
    let commit = match commit_plan(&repo, &branch, &ids, read, &sel.overlays, parent, &sig, &plan.message) {
        Ok(c) => c,
        Err(GitError::PlanStale { .. }) => return Ok(UploadOutcome::PlanStale),
        Err(e) => return Err(git_error(e)),
    };
    if let Some(p) = parent {
        let same = |a: Oid| repo.find_commit(a).map(|c| c.tree_id());
        if same(commit).map_err(|e| git_error(e.into()))? == same(p).map_err(|e| git_error(e.into()))? {
            // Nothing to send: the bare repo's branch goes back to the pushed commit.
            let refname = branch_ref(&branch).map_err(git_error)?;
            repo.reference(&refname, p, true, "labnoteO: nothing changed").map_err(|e| git_error(e.into()))?;
            journal::advance(env.dirs, env.root, &link_id, |r| remember(r, &plan, &sel, &choices))?;
            return Ok(UploadOutcome::NothingChanged);
        }
    }
    journal::advance(env.dirs, env.root, &link_id, |r| {
        r.state = LinkState::Committed;
        r.pending_commit = Some(commit.to_string());
    })?;

    // 10. Push (never forced), then record it.
    let total: u64 = sel.entries.iter().map(|e| e.size).sum::<u64>() + sel.overlays.iter().map(|(_, b)| b.len() as u64).sum::<u64>();
    (env.progress)(Stage::Uploading, 0, total);
    env.steps.reached(Point::BeforePush);
    let mut on_progress = |p: Progress| {
        if let Progress::Sending { bytes, .. } = p {
            (env.progress)(Stage::Uploading, bytes as u64, total);
        }
        true
    };
    match env.steps.push(&repo, &remote, &branch, &tok, &allowed, &mut on_progress).map_err(git_error)? {
        PushResult::Ok => {}
        PushResult::Rejected { kind, lines } => return Ok(UploadOutcome::Rejected { kind, lines }),
        PushResult::AuthRejected => return Ok(UploadOutcome::NeedsSignIn),
        PushResult::Cancelled => return Err(NetError::new(NetErrorKind::Cancelled, "the upload was cancelled")),
    }
    (env.progress)(Stage::Checking, 0, 1);
    let pushed_owner = owner.clone();
    update_links(env.dirs, env.root, |doc| {
        let rec = doc.links.values_mut().find(|r| r.link_id == link_id).ok_or_else(|| bad_input("the link is gone"))?;
        rec.state = LinkState::Pushed;
        rec.last_pushed_commit = Some(commit.to_string());
        rec.pending_commit = None;
        rec.last_pushed_at = Some(now_ms());
        remember(rec, &plan, &sel, &choices);
        doc.default_owner = Some(pushed_owner);
        Ok(())
    })?;
    if let Some(key) = journal::folder_of(env.dirs, env.root, &link_id) {
        let cache: BTreeMap<String, CacheEntry> =
            sel.entries.iter().map(|e| (e.rel.clone(), CacheEntry(e.size, e.mtime_ns, e.oid.to_string()))).collect();
        // Only a cache: a failed write costs a re-hash later.
        let _ = update_status_cache(env.dirs, env.root, |c| {
            c.0.insert(key, FolderCache(cache));
        });
    }
    drop(guard);
    Ok(UploadOutcome::Done {
        html_url,
        full_name: format!("{owner}/{name}"),
        counts: counts(&plan, &sel),
        warnings,
    })
}

/// Uploads a plan the preview showed (see `upload_at`). Progress goes out on
/// `github://progress`.
#[tauri::command]
pub async fn github_upload<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request_id: String,
    plan_id: String,
    choices: UploadChoices,
) -> Result<UploadOutcome, NetError> {
    let no_vault = || NetError::new(NetErrorKind::NotConfigured, "no vault is open");
    let root = app.try_state::<VaultState>().ok_or_else(no_vault)?.root().map_err(|_| no_vault())?;
    tauri::async_runtime::spawn_blocking(move || {
        let missing = || NetError::new(NetErrorKind::NotConfigured, "the app is not ready");
        let dirs = app.try_state::<IntegrationDirs>().ok_or_else(missing)?;
        let secrets = app.try_state::<Secrets>().ok_or_else(missing)?;
        let net = app.try_state::<NetState>().ok_or_else(missing)?;
        let gh = app.try_state::<GithubState>().ok_or_else(missing)?;
        let emit = |stage: Stage, done: u64, total: u64| {
            // A lost progress line is not worth failing the upload for.
            let _ = app.emit(PROGRESS_EVENT, GithubProgress { request_id: request_id.clone(), stage, done, total });
        };
        let ep = endpoints();
        let env = UploadEnv {
            ep: &ep,
            dirs: &dirs.0,
            root: &root,
            store: secrets.0.as_ref(),
            net: &net,
            gh: &gh,
            request_id: Some(&request_id),
            steps: &RealSteps,
            progress: &emit,
        };
        upload_at(&env, &plan_id, choices)
    })
    .await
    .map_err(|e| NetError::new(NetErrorKind::Io, format!("the upload stopped: {e}")))?
}

// ---------------------------------------------------------------------------
// Status (P-R6: never the network), default owner, unlink.

/// What the panel and the menus show for one folder.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderStatus {
    pub linked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private: Option<bool>,
    /// The journal state (`planned` for a folder with no link).
    pub state: LinkState,
    /// Files that differ from the last upload (new, changed or gone).
    pub changed_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_pushed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_url: Option<String>,
    pub folder_missing: bool,
}

/// Files that exist only in the commit (spec §6.2): never "gone" on disk.
fn generated_only(path: &str) -> bool {
    matches!(path, ".gitattributes" | ".gitignore" | "README.md") || path.starts_with(&format!("{SAMPLES_DIR}/"))
}

fn folder_exists(root: &Path, folder: &str) -> bool {
    confine(root, folder).is_ok_and(|p| p.is_dir())
}

/// The status of one folder; `cache` is the vault's status cache (updated).
fn status_of(dirs: &Path, root: &Path, folder: &str, link: Option<&LinkRecord>, cache: &mut super::walk::StatusCache) -> FolderStatus {
    let Some(link) = link else {
        return FolderStatus {
            linked: false,
            private: None,
            state: LinkState::Planned,
            changed_count: 0,
            last_pushed_at: None,
            full_name: None,
            html_url: None,
            folder_missing: !folder_exists(root, folder),
        };
    };
    let mut st = FolderStatus {
        linked: true,
        private: Some(link.private),
        state: link.state,
        changed_count: 0,
        last_pushed_at: link.last_pushed_at,
        full_name: (!link.owner.is_empty() && !link.name.is_empty()).then(|| format!("{}/{}", link.owner, link.name)),
        html_url: (!link.html_url.is_empty()).then(|| link.html_url.clone()),
        folder_missing: false,
    };
    let w = match walk(root, folder, &link.excluded, &Limits::DEFAULT) {
        Ok(w) => w,
        Err(WalkError::NotFound | WalkError::NotAFolder | WalkError::Link | WalkError::BadFolder) => {
            st.folder_missing = true;
            cache.0.remove(folder);
            return st;
        }
        Err(WalkError::Io { .. }) => return st,
    };
    let fc = cache.0.entry(folder.to_string()).or_default();
    let ids = status_hash(fc, &w, |rel| std::fs::read(file_path(&w.folder_abs, rel)));
    let base = base_tree(dirs, root, link).map(|(_, m)| m).unwrap_or_default();
    let mut changed = 0u32;
    for f in &w.files {
        let same = matches!((ids.get(&f.rel), base.get(&f.rel)), (Some(a), Some((b, _))) if a == b);
        if !same {
            changed += 1;
        }
    }
    let on_disk: HashSet<&str> = w.files.iter().map(|f| f.rel.as_str()).collect();
    changed += base.keys().filter(|p| !on_disk.contains(p.as_str()) && !generated_only(p)).count() as u32;
    st.changed_count = changed;
    st
}

/// The status of `folder`. Never the network.
pub fn folder_status_at(dirs: &Path, root: &Path, folder: &str) -> Result<FolderStatus, NetError> {
    let links = read_links(dirs, root)?;
    let link = links.links.get(folder);
    if link.is_none() {
        return Ok(status_of(dirs, root, folder, None, &mut Default::default()));
    }
    let mut cache = read_status_cache(dirs, root);
    let st = status_of(dirs, root, folder, link, &mut cache);
    let _ = update_status_cache(dirs, root, |c| match cache.0.remove(folder) {
        Some(fc) => {
            c.0.insert(folder.to_string(), fc);
        }
        None => {
            c.0.remove(folder);
        }
    });
    Ok(st)
}

/// Every linked folder's status. Never the network.
pub fn statuses_at(dirs: &Path, root: &Path) -> Result<BTreeMap<String, FolderStatus>, NetError> {
    let links = read_links(dirs, root)?;
    let mut cache = read_status_cache(dirs, root);
    let out: BTreeMap<String, FolderStatus> =
        links.links.iter().map(|(folder, l)| (folder.clone(), status_of(dirs, root, folder, Some(l), &mut cache))).collect();
    cache.0.retain(|k, _| links.links.contains_key(k));
    let _ = update_status_cache(dirs, root, |c| *c = cache);
    Ok(out)
}

/// The owner picked last time (`None` before the first upload).
pub fn default_owner_get_at(dirs: &Path, root: &Path) -> Result<Option<String>, NetError> {
    Ok(read_links(dirs, root)?.default_owner.filter(|o| valid_segment(o)))
}

/// Remembers the owner to preselect. Only a plain GitHub name.
pub fn default_owner_set_at(dirs: &Path, root: &Path, owner: &str) -> Result<(), NetError> {
    if !valid_segment(owner) {
        return Err(bad_input("not a valid GitHub owner"));
    }
    update_links(dirs, root, |doc| {
        doc.default_owner = Some(owner.to_string());
        Ok(())
    })
}

/// "GitHub 연결 끊기": forgets the link and moves the app's own bare repo to
/// the Recycle Bin through `delete` (`trash::delete` in the app). The GitHub
/// repository is left alone: no network call is made. A folder with no link
/// is fine.
pub fn unlink_at(
    dirs: &Path,
    root: &Path,
    busy: &BusySet,
    folder: &str,
    delete: impl FnOnce(&Path) -> Result<(), trash::Error>,
) -> Result<(), NetError> {
    let Some(link) = read_links(dirs, root)?.links.get(folder).cloned() else { return Ok(()) };
    let mut keys = vec![LockKey::Folder(folder.to_string())];
    if valid_id(&link.link_id) {
        keys.push(LockKey::Link(link.link_id.clone()));
    }
    let guard = lock_link(busy, dirs, root, &keys)
        .map_err(|_| bad_input("this experiment is being uploaded in another window"))?;
    if let Some(path) = bare_repo_path(dirs, root, &link.link_id) {
        if std::fs::symlink_metadata(&path).is_ok() && !path.starts_with(root) {
            delete(&path).map_err(|_| NetError::new(NetErrorKind::Io, "the app's copy could not be moved to the Recycle Bin"))?;
        }
    }
    update_links(dirs, root, |doc| {
        doc.links.retain(|_, r| r.link_id != link.link_id);
        Ok(())
    })?;
    let _ = update_status_cache(dirs, root, |c| {
        c.0.remove(folder);
    });
    drop(guard);
    if let Some(path) = bare_repo_path(dirs, root, &link.link_id) {
        let _ = std::fs::remove_file(path.with_extension("lock"));
    }
    Ok(())
}

fn vault_root(vault: &VaultState) -> Result<PathBuf, NetError> {
    vault.root().map_err(|_| NetError::new(NetErrorKind::NotConfigured, "no vault is open"))
}

fn join_error(e: impl std::fmt::Display) -> NetError {
    NetError::new(NetErrorKind::Io, format!("the request stopped: {e}"))
}

/// One folder's GitHub status. Offline.
#[tauri::command]
pub async fn github_folder_status(
    dirs: State<'_, IntegrationDirs>,
    vault: State<'_, VaultState>,
    folder: String,
) -> Result<FolderStatus, NetError> {
    let (dirs, root) = (dirs.0.clone(), vault_root(&vault)?);
    tauri::async_runtime::spawn_blocking(move || folder_status_at(&dirs, &root, &folder)).await.map_err(join_error)?
}

/// Every linked folder's status, for the Experiments tab. Offline.
#[tauri::command]
pub async fn github_statuses(
    dirs: State<'_, IntegrationDirs>,
    vault: State<'_, VaultState>,
) -> Result<BTreeMap<String, FolderStatus>, NetError> {
    let (dirs, root) = (dirs.0.clone(), vault_root(&vault)?);
    tauri::async_runtime::spawn_blocking(move || statuses_at(&dirs, &root)).await.map_err(join_error)?
}

/// The owner to preselect. Offline.
#[tauri::command]
pub fn github_default_owner_get(dirs: State<'_, IntegrationDirs>, vault: State<'_, VaultState>) -> Result<Option<String>, NetError> {
    default_owner_get_at(&dirs.0, &vault_root(&vault)?)
}

/// Remembers the owner to preselect. Offline.
#[tauri::command]
pub fn github_default_owner_set(
    dirs: State<'_, IntegrationDirs>,
    vault: State<'_, VaultState>,
    owner: String,
) -> Result<(), NetError> {
    default_owner_set_at(&dirs.0, &vault_root(&vault)?, &owner)
}

/// Forgets a folder's link (see `unlink_at`). Offline; async so a large bare
/// repo going to the Recycle Bin never freezes the window.
#[tauri::command]
pub async fn github_unlink<R: tauri::Runtime>(app: tauri::AppHandle<R>, folder: String) -> Result<(), NetError> {
    let no_vault = || NetError::new(NetErrorKind::NotConfigured, "no vault is open");
    let root = app.try_state::<VaultState>().ok_or_else(no_vault)?.root().map_err(|_| no_vault())?;
    tauri::async_runtime::spawn_blocking(move || {
        let missing = || NetError::new(NetErrorKind::NotConfigured, "the app is not ready");
        let dirs = app.try_state::<IntegrationDirs>().ok_or_else(missing)?;
        let gh = app.try_state::<GithubState>().ok_or_else(missing)?;
        unlink_at(&dirs.0, &root, &gh.busy, &folder, |p| trash::delete(p))
    })
    .await
    .map_err(join_error)?
}

#[cfg(test)]
#[path = "upload_tests.rs"]
mod tests;
