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
//! - A remote that moved since the last upload, or a non-empty repository
//!   being linked, answers `diverged` with the files the upload would replace
//!   or remove (P-R8); nothing is pulled into the vault and nothing is ever
//!   forced. "mine" (every listed file ticked) commits on top of GitHub's tip,
//!   a fast-forward; "separate" pushes to a new `labnoteo/<YYYYMMDD-HHMM>`
//!   branch and leaves the link where it was. An empty list asks nothing.
//! - The plan is given back when the answer may reuse it: `diverged`,
//!   `divergedNotAcknowledged` and `publicNotConfirmed`. Every other answer
//!   (`readOnly`, other red items, errors) used it up: plan again.
//! - Status, default owner and unlink never reach the network.
//! - "마저 하기" (`github_retry`) finishes an interrupted upload from its
//!   journal state (spec §8.4), under the same lock: a lost create answer is
//!   adopted only when all four conditions hold (never a second POST), a
//!   committed upload pushes the same commit again, and a push that landed
//!   before its journal write is only recorded.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::Instant;

use git2::{ObjectType, Oid, Repository, TreeWalkMode, TreeWalkResult};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Emitter, Manager, State};
use zeroize::Zeroizing;

use super::journal::{self, now_ms};
use super::links::{
    bare_repo_path, lock_link, read_links, read_status_cache, update_links, update_status_cache, valid_id, AllowedHit,
    BusySet, LinkRecord, LinkState, LockKey,
};
use super::overlay::{folder_title, local_now, Counts, LocalTime, SAMPLES_DIR};
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
    /// The repository became public since the last upload. Said on the
    /// first upload that sends something after that (`done` or
    /// `pushedSeparately`); until then the link keeps `publicUnwarned`.
    NowPublic,
}

/// One file that changed on GitHub and that the upload would replace or
/// remove (the divergence screen, P-R8).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DivergedFile {
    pub path: String,
    /// What happened to it on GitHub since the last upload (`new` for every
    /// file of a repository being linked).
    pub change: Change,
    /// Not in the folder: the upload removes it on GitHub
    /// ("내 폴더에 없음 → GitHub에서 지워짐").
    pub gone_here: bool,
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
    /// `warnings` says now what a later `done` will say again (the
    /// divergence screen is where the user decides to push).
    Diverged { files: Vec<DivergedFile>, warnings: Vec<UploadWarning> },
    #[serde(rename_all = "camelCase")]
    PushedSeparately { compare_url: String, warnings: Vec<UploadWarning> },
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
    /// `github_retry` only: the repository is ready and nothing is waiting to
    /// be pushed; the upload goes on through a new plan (`update`) and its
    /// preview (spec §8.4, `repoReady`).
    #[serde(rename_all = "camelCase")]
    NeedsPreview { full_name: String, html_url: String },
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
/// Only the Git network steps can be replaced. The create request is faulted
/// through the fake server (an answer that never comes), and a crash after
/// the push and before its journal write is a `push` that pushes and then
/// fails.
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

    /// Pushes the bare repo's `branch` to the remote's `target` (never forced).
    #[allow(clippy::too_many_arguments)]
    fn push(
        &self,
        repo: &Repository,
        remote: &Url,
        branch: &str,
        target: &str,
        token: &Zeroizing<String>,
        allowed: &GitBase,
        progress: &mut dyn FnMut(Progress) -> bool,
    ) -> Result<PushResult, GitError> {
        git_push::push(repo, remote, branch, target, token, allowed, progress, &[])
    }

    /// The remote's `refs/heads/<branch>`, without downloading anything.
    fn remote_tip(
        &self,
        repo: &Repository,
        remote: &Url,
        branch: &str,
        token: &Zeroizing<String>,
        allowed: &GitBase,
    ) -> Result<Option<Oid>, GitError> {
        git_push::ls_remote_tip(repo, remote, branch, token, allowed)
    }

    /// Every branch of the remote (the adoption check: a repository with no
    /// branch).
    fn remote_heads(
        &self,
        repo: &Repository,
        remote: &Url,
        token: &Zeroizing<String>,
        allowed: &GitBase,
    ) -> Result<Vec<(String, Oid)>, GitError> {
        git_push::ls_remote_heads(repo, remote, token, allowed)
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
    /// The local time that names a separate upload's branch.
    pub now: LocalTime,
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
    Link { owner: String, name: String },
    /// The linked repository. With `Some(owner, name)`, a link plan answering
    /// the divergence screen whose typed name GitHub redirected (a renamed or
    /// transferred repository): that name is asked for, and it must be the
    /// linked repository (same id).
    Update(LinkRecord, Option<(String, String)>),
}

/// Every file (non-tree entry) of `commit`'s tree by path. Names that are not
/// UTF-8 are kept (lossily) so that they are still listed.
fn tree_files(repo: &Repository, commit: Oid) -> Result<BTreeMap<String, Oid>, GitError> {
    let tree = repo.find_commit(commit)?.tree()?;
    let mut map = BTreeMap::new();
    tree.walk(TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() != Some(ObjectType::Tree) {
            map.insert(format!("{dir}{}", String::from_utf8_lossy(entry.name_bytes())), entry.id());
        }
        TreeWalkResult::Ok
    })?;
    Ok(map)
}

/// The divergence list (P-R8): the files that changed on GitHub between
/// `base` (the last pushed commit; the empty tree when linking) and `tip`,
/// and whose content the upload would replace or remove. A base the bare repo
/// cannot read counts as empty, which only lists more.
fn diverged_files(repo: &Repository, base: Option<Oid>, tip: Option<Oid>, sel: &Selection<'_>) -> Result<Vec<DivergedFile>, GitError> {
    let base = base.and_then(|b| tree_files(repo, b).ok()).unwrap_or_default();
    let theirs = match tip {
        Some(t) => tree_files(repo, t)?,
        None => BTreeMap::new(),
    };
    let mine: BTreeMap<&str, Oid> = sel
        .entries
        .iter()
        .map(|e| (e.rel.as_str(), e.oid))
        .chain(
            sel.overlays
                .iter()
                .map(|(p, b)| (p.as_str(), Oid::hash_object(ObjectType::Blob, b).unwrap_or(Oid::ZERO_SHA1))),
        )
        .collect();
    let paths: BTreeSet<&String> = base.keys().chain(theirs.keys()).collect();
    let mut files = Vec::new();
    for path in paths {
        let (was, now) = (base.get(path), theirs.get(path));
        if was == now || mine.get(path.as_str()) == now {
            continue;
        }
        let change = match (was, now) {
            (None, _) => Change::New,
            (_, None) => Change::Deleted,
            _ => Change::Changed,
        };
        files.push(DivergedFile { path: path.clone(), change, gone_here: now.is_some() && !mine.contains_key(path.as_str()) });
    }
    Ok(files)
}

/// `labnoteo/<YYYYMMDD-HHMM>` for the separate upload.
fn separate_branch(now: &LocalTime) -> String {
    format!("labnoteo/{:04}{:02}{:02}-{:02}{:02}", now.year, now.month, now.day, now.hour, now.minute)
}

/// The most `-N` suffixes tried for a separate branch.
const MAX_SEPARATE: u32 = 50;

/// "GitHub에서 두 내용을 비교하려면 [열기]".
fn compare_url(html_url: &str, owner: &str, name: &str, branch: &str, separate: &str) -> String {
    let web = if html_url.is_empty() { format!("{GITHUB_WEB}{owner}/{name}") } else { html_url.trim_end_matches('/').to_string() };
    format!("{web}/compare/{branch}...{separate}")
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
            Red::PublicNotConfirmed | Red::DivergedNotAcknowledged { .. } => true,
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

/// The linked repository as GitHub has it now.
struct Linked {
    owner: String,
    name: String,
    html_url: String,
}

/// The branch of a link (`main` when the record has none).
fn link_branch(l: &LinkRecord) -> String {
    if l.branch.is_empty() {
        NEW_BRANCH.to_string()
    } else {
        l.branch.clone()
    }
}

/// Asks GitHub about the linked repository before anything is sent: still
/// there, still writable, and not public when nothing was pushed to a
/// repository meant to be private. Records what changed (name, visibility)
/// and adds the "now public" warning the link still owes. `typed`: a name the
/// user typed for this link, which must answer with the same repository id.
fn check_linked(
    env: &UploadEnv<'_>,
    l: &LinkRecord,
    typed: Option<(String, String)>,
    warnings: &mut Vec<UploadWarning>,
) -> Result<Result<Linked, UploadOutcome>, NetError> {
    let (ask_owner, ask_name) = typed.clone().unwrap_or_else(|| (l.owner.clone(), l.name.clone()));
    let call = GithubCall::GetRepo { owner: ask_owner, name: ask_name };
    let reply = block_on(call_authed(env.ep, env.dirs, env.store, env.net, env.gh, env.request_id, call.clone(), None))?;
    match classify(&call, &reply) {
        ApiOutcome::Ok | ApiOutcome::Moved { .. } => {}
        other => return api_outcome(env.dirs, other, &reply).map(Err),
    }
    let f = repo_facts(&reply.json).ok_or_else(unexpected)?;
    if typed.is_some() && f.id != l.repo_id {
        return Err(bad_input("this folder is already linked to a repository"));
    }
    if !f.can_push {
        return Ok(Err(UploadOutcome::ReadOnly));
    }
    let html_url = if f.html_url.is_empty() { l.html_url.clone() } else { f.html_url.clone() };
    // Nothing has been pushed to a repository the app created as
    // private that is public now: the first push waits until it is
    // private again (spec §5.3: verified, never assumed).
    if l.last_pushed_commit.is_none() && l.intended_private == Some(true) && !f.private {
        return Ok(Err(UploadOutcome::VisibilityMismatch { html_url }));
    }
    // Public now and not said yet: the link keeps that until an
    // upload that sends something has said it.
    let unwarned = !f.private && (l.private || l.public_unwarned);
    if unwarned {
        warnings.push(UploadWarning::NowPublic);
    }
    let now = (f.owner.as_str(), f.name.as_str(), f.private, html_url.as_str(), unwarned);
    if now != (l.owner.as_str(), l.name.as_str(), l.private, l.html_url.as_str(), l.public_unwarned) {
        journal::advance(env.dirs, env.root, &l.link_id, |r| {
            r.owner = f.owner.clone();
            r.name = f.name.clone();
            r.private = f.private;
            r.html_url = html_url.clone();
            r.public_unwarned = unwarned;
        })?;
    }
    Ok(Ok(Linked { owner: f.owner, name: f.name, html_url }))
}

/// Records a push of `commit` to the link's branch: `pushed`, the default
/// owner, and whatever `also` adds.
fn record_pushed(
    env: &UploadEnv<'_>,
    link_id: &str,
    commit: Oid,
    owner: &str,
    also: impl FnOnce(&mut LinkRecord),
) -> Result<(), NetError> {
    update_links(env.dirs, env.root, |doc| {
        let rec = doc.links.values_mut().find(|r| r.link_id == link_id).ok_or_else(|| bad_input("the link is gone"))?;
        rec.state = LinkState::Pushed;
        rec.last_pushed_commit = Some(commit.to_string());
        rec.pending_commit = None;
        rec.last_pushed_at = Some(now_ms());
        rec.public_unwarned = false;
        also(rec);
        doc.default_owner = Some(owner.to_string());
        Ok(())
    })
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
        (PlanTarget::Link { owner, name }, None) => Dest::Link { owner: owner.clone(), name: name.clone() },
        // The link this plan (or an earlier one) made, still with nothing
        // pushed: the answer to the divergence screen continues it.
        // A typed name that differs from the link's is checked by repository
        // id once GitHub answers (it may have been redirected to the link's).
        (PlanTarget::Link { owner, name }, Some(l)) => {
            let same = l.owner.eq_ignore_ascii_case(owner) && l.name.eq_ignore_ascii_case(name);
            if l.state != LinkState::RepoReady
                || l.last_pushed_commit.is_some()
                || !valid_id(&l.link_id)
                || (!same && l.repo_id == 0)
            {
                return Err(bad_input("this folder is already linked to a repository"));
            }
            if guard.add(env.dirs, env.root, LockKey::Link(l.link_id.clone())).is_err() {
                return Ok(UploadOutcome::Busy);
            }
            Dest::Update(l, (!same).then(|| (owner.clone(), name.clone())))
        }
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
            Dest::Update(l, None)
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
            // Nothing was sent: a corrected name reuses the plan.
            env.gh.plans.put_back(plan);
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
        // An existing repository: writable, and public only with the typed
        // name. Nothing is created; the link starts at `repoReady`.
        Dest::Link { owner, name } => {
            (env.progress)(Stage::Preparing, 0, 1);
            let call = GithubCall::GetRepo { owner, name };
            let reply = block_on(call_authed(env.ep, env.dirs, env.store, env.net, env.gh, env.request_id, call.clone(), None))?;
            match classify(&call, &reply) {
                ApiOutcome::Ok | ApiOutcome::Moved { .. } => {}
                other => return api_outcome(env.dirs, other, &reply),
            }
            let f = repo_facts(&reply.json).ok_or_else(unexpected)?;
            if !f.can_push {
                return Ok(UploadOutcome::ReadOnly);
            }
            if !f.private && choices.public_confirm.as_deref() != Some(f.name.as_str()) {
                // Nothing was recorded: a corrected name reuses the plan.
                env.gh.plans.put_back(plan);
                return Ok(UploadOutcome::Blocked { red: vec![Red::PublicNotConfirmed] });
            }
            branch_ref(&f.default_branch).map_err(|_| bad_input("the repository's branch name cannot be used"))?;
            let link_id = new_id();
            if guard.add(env.dirs, env.root, LockKey::Link(link_id.clone())).is_err() {
                return Ok(UploadOutcome::Busy);
            }
            let record = LinkRecord {
                link_id: link_id.clone(),
                repo_id: f.id,
                owner: f.owner.clone(),
                name: f.name.clone(),
                html_url: f.html_url.clone(),
                branch: f.default_branch.clone(),
                private: f.private,
                intended_private: Some(f.private),
                state: LinkState::RepoReady,
                ..LinkRecord::default()
            };
            journal::begin_link(env.dirs, env.root, &plan.folder, record)?;
            (link_id, f.owner, f.name, f.html_url, f.default_branch, None)
        }
        // The linked repository: still there, still writable, still private?
        Dest::Update(l, typed) => {
            (env.progress)(Stage::Preparing, 0, 1);
            let r = match check_linked(env, &l, typed, &mut warnings)? {
                Ok(r) => r,
                Err(outcome) => return Ok(outcome),
            };
            let parent = l.last_pushed_commit.as_deref().and_then(|c| Oid::from_str(c).ok());
            (l.link_id.clone(), r.owner, r.name, r.html_url, link_branch(&l), parent)
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
    // The remote moved (or a non-empty repository is being linked): list
    // what the upload would replace, and go on only with the user's answer.
    // The plan is given back, so the answer reuses it.
    let mut parent = parent;
    let mut separate: Option<String> = None;
    if tip != parent {
        let files = diverged_files(&repo, parent, tip, &sel).map_err(git_error)?;
        // Nothing of GitHub's would be replaced or removed (every change
        // there is in the folder already): nothing to ask, so "mine".
        let answer = match choices.diverged {
            None if files.is_empty() => Some(DivergedChoice::Mine),
            a => a,
        };
        match answer {
            None => {
                env.gh.plans.put_back(plan);
                return Ok(UploadOutcome::Diverged { files, warnings });
            }
            Some(DivergedChoice::Mine) => {
                let acked: HashSet<&str> = choices.ack_files.iter().map(String::as_str).collect();
                let paths: Vec<String> =
                    files.iter().filter(|f| !acked.contains(f.path.as_str())).map(|f| f.path.clone()).collect();
                if !paths.is_empty() {
                    env.gh.plans.put_back(plan);
                    return Ok(UploadOutcome::Blocked { red: vec![Red::DivergedNotAcknowledged { paths }] });
                }
            }
            Some(DivergedChoice::Separate) => {
                let first = separate_branch(&env.now);
                let mut free = None;
                for n in 1..=MAX_SEPARATE {
                    let candidate = if n == 1 { first.clone() } else { format!("{first}-{n}") };
                    match env.steps.remote_tip(&repo, &remote, &candidate, &tok, &allowed) {
                        Ok(None) => {
                            free = Some(candidate);
                            break;
                        }
                        Ok(Some(_)) => {}
                        Err(GitError::AuthRejected) => return Ok(UploadOutcome::NeedsSignIn),
                        Err(e) => return Err(git_error(e)),
                    }
                }
                separate = Some(free.ok_or_else(|| bad_input("too many separate uploads this minute; try again later"))?);
            }
        }
        // Built on GitHub's tip: a fast-forward, and nothing leaves the history.
        parent = tip;
    }
    // The bare repo's branch that is built and pushed.
    let local = separate.clone().unwrap_or_else(|| branch.clone());

    // 9. Commit from the plan, every blob re-hashed as it is written.
    let ids: Vec<(String, Oid)> = sel.entries.iter().map(|e| (e.rel.clone(), e.oid)).collect();
    env.steps.reached(Point::BeforeCommit);
    let read = |rel: &str| File::open(file_path(&folder_abs, rel));
    let commit = match commit_plan(&repo, &local, &ids, read, &sel.overlays, parent, &sig, &plan.message) {
        Ok(c) => c,
        Err(GitError::PlanStale { .. }) => return Ok(UploadOutcome::PlanStale),
        Err(e) => return Err(git_error(e)),
    };
    if let Some(p) = parent {
        let same = |a: Oid| repo.find_commit(a).map(|c| c.tree_id());
        if same(commit).map_err(|e| git_error(e.into()))? == same(p).map_err(|e| git_error(e.into()))? {
            // Nothing to send: the bare repo's branch goes back to `p`.
            let refname = branch_ref(&local).map_err(git_error)?;
            repo.reference(&refname, p, true, "labnoteO: nothing changed").map_err(|e| git_error(e.into()))?;
            if separate.is_none() {
                // GitHub already has exactly this (also when it was GitHub's own tip).
                journal::advance(env.dirs, env.root, &link_id, |r| {
                    remember(r, &plan, &sel, &choices);
                    if r.last_pushed_commit.as_deref() != Some(p.to_string().as_str()) {
                        r.last_pushed_commit = Some(p.to_string());
                        r.pending_commit = None;
                        r.state = LinkState::Pushed;
                    }
                })?;
            }
            return Ok(UploadOutcome::NothingChanged);
        }
    }
    // A separate upload is not journaled: `lastPushedCommit` and the link
    // stay where they were, and "마저 하기" never pushes it to `branch`.
    if separate.is_none() {
        // The choices are remembered with the commit: "마저 하기" finishes
        // the push without the plan.
        journal::advance(env.dirs, env.root, &link_id, |r| {
            r.state = LinkState::Committed;
            r.pending_commit = Some(commit.to_string());
            remember(r, &plan, &sel, &choices);
        })?;
    }

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
    match env.steps.push(&repo, &remote, &local, &local, &tok, &allowed, &mut on_progress).map_err(git_error)? {
        PushResult::Ok => {}
        PushResult::Rejected { kind, lines } => return Ok(UploadOutcome::Rejected { kind, lines }),
        PushResult::AuthRejected => return Ok(UploadOutcome::NeedsSignIn),
        PushResult::Cancelled => return Err(NetError::new(NetErrorKind::Cancelled, "the upload was cancelled")),
    }
    (env.progress)(Stage::Checking, 0, 1);
    if let Some(sep) = separate {
        if !warnings.is_empty() {
            journal::advance(env.dirs, env.root, &link_id, |r| r.public_unwarned = false)?;
        }
        drop(guard);
        let compare_url = compare_url(&html_url, &owner, &name, &branch, &sep);
        return Ok(UploadOutcome::PushedSeparately { compare_url, warnings });
    }
    record_pushed(env, &link_id, commit, &owner, |r| remember(r, &plan, &sel, &choices))?;
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
            now: local_now(),
        };
        upload_at(&env, &plan_id, choices)
    })
    .await
    .map_err(|e| NetError::new(NetErrorKind::Io, format!("the upload stopped: {e}")))?
}

// ---------------------------------------------------------------------------
// "마저 하기": finishing an interrupted upload from its journal (spec §8.4).

/// How long before the create request GitHub's `created_at` may lie (clock
/// skew between this PC and GitHub).
const ADOPT_SKEW_MS: u64 = 2 * 60 * 1000;

/// The user-facing counts of `commit` against `parent` (files that exist
/// only in the commit left out).
fn commit_counts(repo: &Repository, parent: Option<Oid>, commit: Oid) -> Counts {
    let old = parent.and_then(|p| tree_files(repo, p).ok()).unwrap_or_default();
    let new = tree_files(repo, commit).unwrap_or_default();
    let mut c = Counts::default();
    for (path, id) in new.iter().filter(|(p, _)| !generated_only(p)) {
        match old.get(path) {
            None => c.new += 1,
            Some(o) if o != id => c.changed += 1,
            _ => {}
        }
    }
    c.deleted = old.keys().filter(|p| !generated_only(p) && !new.contains_key(*p)).count() as _;
    c
}

fn needs_preview(l: &LinkRecord) -> UploadOutcome {
    UploadOutcome::NeedsPreview { full_name: format!("{}/{}", l.owner, l.name), html_url: l.html_url.clone() }
}

/// Finishes the upload of `folder` from its journal state:
/// - `repoCreating` (the create answer was lost): `GET repos/{owner}/{name}`,
///   adopted only when the owner and name match, the repository is empty
///   (`size == 0` and no branch), `created_at` is no earlier than the request
///   (less two minutes) and the description is the one sent. Anything else
///   forgets the record and answers `nameTaken` (`notFoundOrNoAccess` when
///   there is no such repository): never a second POST from here.
/// - `repoReady`: `needsPreview` (plan, preview, upload).
/// - `committed`: the remote already at `pendingCommit` is only recorded;
///   the remote still at the commit's parent gets the same commit pushed
///   again; a remote that moved goes through a new plan (`needsPreview`).
/// - `pushed`: `nothingChanged`.
pub fn retry_at(env: &UploadEnv<'_>, folder: &str) -> Result<UploadOutcome, NetError> {
    let not_linked = || bad_input("this folder is not linked to a repository");
    let link = read_links(env.dirs, env.root)?.links.get(folder).cloned().ok_or_else(not_linked)?;
    if !valid_id(&link.link_id) {
        return Err(bad_input("the folder's GitHub link is damaged; disconnect it and upload again"));
    }
    let keys = [LockKey::Folder(folder.to_string()), LockKey::Link(link.link_id.clone())];
    let Ok(guard) = lock_link(&env.gh.busy, env.dirs, env.root, &keys) else { return Ok(UploadOutcome::Busy) };
    // Read again under the lock: an upload that just finished moved it on.
    let link = read_links(env.dirs, env.root)?
        .links
        .get(folder)
        .filter(|l| l.link_id == link.link_id)
        .cloned()
        .ok_or_else(not_linked)?;
    match link.state {
        LinkState::Pushed => return Ok(UploadOutcome::NothingChanged),
        LinkState::Planned | LinkState::RepoReady => return Ok(needs_preview(&link)),
        LinkState::RepoCreating | LinkState::Committed => {}
    }
    let Some(tok) = token(env.gh, env.store)? else { return Ok(UploadOutcome::NeedsSignIn) };
    let outcome = match link.state {
        LinkState::RepoCreating => adopt(env, &link, &tok),
        _ => finish_push(env, &link, &tok),
    };
    drop(guard);
    outcome
}

/// `repoCreating`: adopt the repository the lost answer made, or forget the
/// record (see `retry_at`).
fn adopt(env: &UploadEnv<'_>, link: &LinkRecord, tok: &Zeroizing<String>) -> Result<UploadOutcome, NetError> {
    (env.progress)(Stage::Creating, 0, 1);
    let call = GithubCall::GetRepo { owner: link.owner.clone(), name: link.name.clone() };
    let reply = block_on(call_authed(env.ep, env.dirs, env.store, env.net, env.gh, env.request_id, call.clone(), None))?;
    let forget = |outcome: UploadOutcome| -> Result<UploadOutcome, NetError> {
        journal::abandon(env.dirs, env.root, &link.link_id)?;
        Ok(outcome)
    };
    match classify(&call, &reply) {
        ApiOutcome::Ok => {}
        // The name answers for another repository now (renamed or transferred).
        ApiOutcome::Moved { .. } => return forget(UploadOutcome::NameTaken),
        ApiOutcome::NotFoundOrNoAccess => return forget(UploadOutcome::NotFoundOrNoAccess),
        other => return api_outcome(env.dirs, other, &reply),
    }
    let f = repo_facts(&reply.json).ok_or_else(unexpected)?;
    let same_name = f.owner.eq_ignore_ascii_case(&link.owner) && f.name.eq_ignore_ascii_case(&link.name);
    let recent = match (f.created_at_ms, link.requested_at) {
        (Some(created), Some(requested)) => created >= requested.saturating_sub(ADOPT_SKEW_MS),
        _ => false,
    };
    let same_description = link.sent_description.is_some() && f.description == link.sent_description;
    if !(same_name && f.empty && recent && same_description) {
        return forget(UploadOutcome::NameTaken);
    }
    // `size` can lag behind a push on GitHub: the repository must also have
    // no branch at all.
    let repo = open_or_init(env.dirs, env.root, &link.link_id).map_err(git_error)?;
    let remote = remote_url(env.ep, &f.owner, &f.name)?;
    match env.steps.remote_heads(&repo, &remote, tok, &GitBase::from_endpoints(env.ep)) {
        Ok(heads) if heads.is_empty() => {}
        Ok(_) => return forget(UploadOutcome::NameTaken),
        Err(GitError::AuthRejected) => return Ok(UploadOutcome::NeedsSignIn),
        Err(e) => return Err(git_error(e)),
    }
    journal::advance(env.dirs, env.root, &link.link_id, |r| {
        r.repo_id = f.id;
        r.owner = f.owner.clone();
        r.name = f.name.clone();
        r.html_url = f.html_url.clone();
        r.private = f.private;
        r.state = LinkState::RepoReady;
    })?;
    if link.intended_private == Some(true) && !f.private {
        return Ok(UploadOutcome::VisibilityMismatch { html_url: f.html_url });
    }
    Ok(UploadOutcome::NeedsPreview { full_name: format!("{}/{}", f.owner, f.name), html_url: f.html_url })
}

/// `committed`: push `pendingCommit` again, or only record it when the
/// remote already has it (see `retry_at`).
fn finish_push(env: &UploadEnv<'_>, link: &LinkRecord, tok: &Zeroizing<String>) -> Result<UploadOutcome, NetError> {
    (env.progress)(Stage::Preparing, 0, 1);
    let Some(pending) = link.pending_commit.as_deref().and_then(|c| Oid::from_str(c).ok()) else {
        return Ok(needs_preview(link));
    };
    let mut warnings = Vec::new();
    let r = match check_linked(env, link, None, &mut warnings)? {
        Ok(r) => r,
        Err(outcome) => return Ok(outcome),
    };
    let repo = open_or_init(env.dirs, env.root, &link.link_id).map_err(git_error)?;
    // The app's copy lost the commit: build it again from a new plan.
    let Ok(commit) = repo.find_commit(pending) else { return Ok(needs_preview(link)) };
    let parent = commit.parent_id(0).ok();
    let branch = link_branch(link);
    let remote = remote_url(env.ep, &r.owner, &r.name)?;
    let allowed = GitBase::from_endpoints(env.ep);
    let tip = match env.steps.remote_tip(&repo, &remote, &branch, tok, &allowed) {
        Ok(t) => t,
        Err(GitError::AuthRejected) => return Ok(UploadOutcome::NeedsSignIn),
        Err(e) => return Err(git_error(e)),
    };
    if tip != Some(pending) {
        if tip != parent {
            // GitHub moved since the commit was made: a new plan shows what
            // changed there (the divergence screen).
            return Ok(needs_preview(link));
        }
        // The same commit again. A half push left only unreferenced objects.
        let refname = branch_ref(&branch).map_err(git_error)?;
        repo.reference(&refname, pending, true, "labnoteO: finish the upload").map_err(|e| git_error(e.into()))?;
        (env.progress)(Stage::Uploading, 0, 0);
        env.steps.reached(Point::BeforePush);
        let mut on_progress = |p: Progress| {
            if let Progress::Sending { bytes, .. } = p {
                (env.progress)(Stage::Uploading, bytes as u64, 0);
            }
            true
        };
        match env.steps.push(&repo, &remote, &branch, &branch, tok, &allowed, &mut on_progress).map_err(git_error)? {
            PushResult::Ok => {}
            PushResult::Rejected { kind, lines } => return Ok(UploadOutcome::Rejected { kind, lines }),
            PushResult::AuthRejected => return Ok(UploadOutcome::NeedsSignIn),
            PushResult::Cancelled => return Err(NetError::new(NetErrorKind::Cancelled, "the upload was cancelled")),
        }
    }
    (env.progress)(Stage::Checking, 0, 1);
    record_pushed(env, &link.link_id, pending, &r.owner, |_| {})?;
    Ok(UploadOutcome::Done {
        html_url: r.html_url,
        full_name: format!("{}/{}", r.owner, r.name),
        counts: commit_counts(&repo, parent, pending),
        warnings,
    })
}

/// "마저 하기" for `folder` (see `retry_at`). Progress goes out on
/// `github://progress`.
#[tauri::command]
pub async fn github_retry<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request_id: String,
    folder: String,
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
            now: local_now(),
        };
        retry_at(&env, &folder)
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
