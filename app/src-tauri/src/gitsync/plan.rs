//! The upload plan (spec §5.4, plan P-R1): Rust walks and scans the folder,
//! keeps the result under a random `planId`, and answers the webview with
//! what it may show. The webview holds only the handle: it can untick paths
//! the plan listed, never add one.
//!
//! - A plan stores `(rel, size, mtime_ns, blob id)` per file and no bytes,
//!   except a small shared cache (64 MiB over every plan, files of 1 MiB or
//!   less). The commit re-reads and re-hashes every file, so correctness never
//!   depends on the cache, and eight plans of a 1.5 GiB upload never sit in
//!   memory.
//! - At most 8 plans are kept (the oldest goes first); a plan expires after
//!   30 minutes.
//! - `github_plan` never reaches the network: it reads the folder, the
//!   vault's link record and the app-owned bare repo.
//! - Findings the webview passes in (`infoFindings`) are display-only: they
//!   never add a path, never unblock anything, and unknown kinds are dropped.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use git2::{ObjectType, Oid, Repository, TreeWalkMode, TreeWalkResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use super::links::{bare_repo_path, read_links, valid_id, LinkRecord};
use super::overlay::{self, commit_message, folder_title, local_now, Counts, LocalTime, OverlayConfig, SampleEntry, SAMPLES_DIR};
use super::scan::{saved_secrets, scan, Hit, SavedSecret, ScanReport};
use super::walk::{walk, ExcludeReason, Limits, SizeWarning, WalkError};
use crate::net::config::ServiceConfig;
use crate::net::github::api::valid_segment;
use crate::net::github::repos::valid_repo_name;
use crate::net::github::GithubState;
use crate::net::secrets::Secrets;
use crate::net::{IntegrationDirs, NetError, NetErrorKind};
use crate::vault::path::confine;
use crate::vault::{SettingsFile, VaultState};

/// The most plans kept at once.
pub const MAX_PLANS: usize = 8;
/// How long a plan stays valid.
pub const PLAN_TTL: Duration = Duration::from_secs(30 * 60);
/// The byte cache over every plan.
pub const CACHE_CAP: usize = 64 * 1024 * 1024;
/// Only files this small are cached.
pub const CACHE_FILE_MAX: u64 = 1024 * 1024;
/// The path the commit message is scanned under.
pub const COMMIT_MESSAGE_PATH: &str = "(commit message)";
/// The Global sample folder when the settings name none.
pub const DEFAULT_GLOBAL_SAMPLE_FOLDER: &str = "resources/labsamples";

const MAX_SAMPLE_IDS: usize = 500;
const MAX_INFO_FINDINGS: usize = 50;
const MAX_INFO_PATHS: usize = 200;
const MAX_INFO_NAMES: usize = 20;
/// The largest sample registry file read.
const MAX_REGISTRY_BYTES: u64 = 10 * 1024 * 1024;

/// Where the upload goes. Names are checked again here (P-R5).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlanTarget {
    /// A new repository.
    Create { owner: String, name: String, private: bool },
    /// An existing repository.
    Link { owner: String, name: String },
    /// The folder's linked repository.
    Update,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlanMode {
    First,
    Update,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Change {
    New,
    Changed,
    Deleted,
    Same,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// One row of the preview.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    pub path: String,
    pub size: u64,
    pub change: Change,
    /// A file made by the app (`.gitattributes`, `.gitignore`, `README.md`).
    #[serde(skip_serializing_if = "is_false")]
    pub generated: bool,
    /// A sample snapshot file (goes up only when the user ticks samples).
    #[serde(skip_serializing_if = "is_false")]
    pub sample: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanExcluded {
    pub path: String,
    pub reason: ExcludeReason,
}

/// What blocks the upload.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Red {
    /// A secret-scan hit (`hit.overridable` says whether "키가 아닙니다" may
    /// wave it through).
    Secret { hit: Hit },
    /// A file at or above the per-file limit, seen for the first time. It is
    /// already left out; unticking it remembers that.
    TooLarge { path: String, size: u64 },
    /// The files together are above the per-upload limit.
    #[serde(rename_all = "camelCase")]
    UploadTooLarge { total: u64, limit: u64 },
    /// Names that are the same once Hangul is composed (NFC vs NFD).
    NfdCollision { paths: Vec<String> },
    /// A file that could not be read (locked, or a cloud file that would not
    /// download).
    Unreadable { path: String },
}

/// The kinds of findings the webview may pass in (P-R4).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InfoKind {
    Author,
    CrossLinks,
    WikiLinks,
    Unused,
    Outside,
}

/// What the user should look at; it does not block.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Yellow {
    Large { path: String, size: u64 },
    RepoLarge { total: u64 },
    Nfd { path: String },
    Gps { paths: Vec<String> },
    Unscanned { paths: Vec<String> },
    VaultIsGit,
    ExcludedLink { path: String },
    /// A display-only finding from the webview, cleaned.
    Info { info: InfoKind, count: u32, paths: Vec<String>, names: Vec<String> },
}

/// A Global sample the folder's notes use.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SampleSummary {
    pub id: String,
    #[serde(rename = "type")]
    pub sample_type: String,
    pub name: String,
}

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    /// Files that go up (folder files and generated ones; not samples).
    pub files: u32,
    pub bytes: u64,
    pub excluded: u32,
    pub new: u32,
    pub changed: u32,
    pub deleted: u32,
}

/// `github_plan`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum PlanOutcome {
    #[serde(rename_all = "camelCase")]
    Ready {
        plan_id: String,
        mode: PlanMode,
        files: Vec<PlanFile>,
        excluded: Vec<PlanExcluded>,
        red: Vec<Red>,
        yellow: Vec<Yellow>,
        samples: Vec<SampleSummary>,
        totals: Totals,
        quick_ok: bool,
    },
    /// The folder has its own `.git`: the app never adopts a repo.
    FolderHasGit,
    /// Not a `labnote/###_…` experiment folder (or it is gone).
    NotExperiment,
    /// `update` for a folder with no link.
    NotLinked,
    /// Names the vault path rules reject.
    BadPath { paths: Vec<String> },
}

/// One planned file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanEntry {
    pub rel: String,
    pub size: u64,
    pub mtime_ns: u64,
    pub oid: Oid,
}

/// A plan held in Rust. It carries no file bytes beyond the shared cache.
pub struct Plan {
    pub id: String,
    pub folder: String,
    pub target: PlanTarget,
    pub created: Instant,
    pub mode: PlanMode,
    pub link_id: Option<String>,
    /// The commit the changes were computed against (`lastPushedCommit`).
    pub base_commit: Option<Oid>,
    pub entries: Vec<PlanEntry>,
    /// Generated files that always go up.
    pub overlays: Vec<(String, Vec<u8>)>,
    /// The sample snapshot, which goes up only when the user ticks it.
    pub sample_overlays: Vec<(String, Vec<u8>)>,
    /// The only paths an upload may leave out.
    pub untickable: HashSet<String>,
    /// Every scan hit, including ones acknowledged earlier.
    pub hits: Vec<Hit>,
    pub red: Vec<Red>,
    pub files: Vec<PlanFile>,
    pub message: String,
    cache: HashMap<String, Arc<[u8]>>,
}

impl std::fmt::Debug for Plan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Plan")
            .field("id", &self.id)
            .field("mode", &self.mode)
            .field("entries", &self.entries.len())
            .field("cached", &self.cache.len())
            .finish_non_exhaustive()
    }
}

impl Plan {
    /// The cached bytes of a planned file, if they were kept. Only an
    /// optimisation: the caller still compares the blob id.
    pub fn cached(&self, rel: &str) -> Option<Arc<[u8]>> {
        self.cache.get(rel).cloned()
    }

    fn cache_bytes(&self) -> usize {
        self.cache.values().map(|b| b.len()).sum()
    }
}

/// The plan is gone: expired, evicted, already taken, or never made here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanExpired;

/// The plans of this app run (P-R1).
pub struct PlanStore {
    plans: Mutex<Vec<Plan>>,
    cap: usize,
}

impl Default for PlanStore {
    fn default() -> Self {
        PlanStore::with_cap(CACHE_CAP)
    }
}

impl PlanStore {
    /// A store whose byte cache holds at most `cap` bytes in total.
    pub fn with_cap(cap: usize) -> Self {
        PlanStore { plans: Mutex::new(Vec::new()), cap }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Plan>> {
        self.plans.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Keeps `plan` from `now`, dropping expired plans and the oldest beyond
    /// `MAX_PLANS`, then trims the cache: the new plan keeps its smallest
    /// files up to the cap, and older plans lose theirs first.
    pub fn insert(&self, mut plan: Plan, now: Instant) -> String {
        let mut plans = self.lock();
        plans.retain(|p| now.saturating_duration_since(p.created) < PLAN_TTL);
        while plans.len() >= MAX_PLANS {
            plans.remove(0);
        }
        plan.created = now;
        let mut items: Vec<(String, Arc<[u8]>)> = plan.cache.drain().collect();
        items.sort_by(|a, b| a.1.len().cmp(&b.1.len()).then_with(|| a.0.cmp(&b.0)));
        let mut own = 0usize;
        for (rel, bytes) in items {
            if own + bytes.len() > self.cap {
                break;
            }
            own += bytes.len();
            plan.cache.insert(rel, bytes);
        }
        let mut total = own + plans.iter().map(Plan::cache_bytes).sum::<usize>();
        for p in plans.iter_mut() {
            if total <= self.cap {
                break;
            }
            total -= p.cache_bytes();
            p.cache.clear();
        }
        let id = plan.id.clone();
        plans.push(plan);
        id
    }

    /// Hands the plan over to the upload (it is used once).
    pub fn take(&self, id: &str, now: Instant) -> Result<Plan, PlanExpired> {
        let mut plans = self.lock();
        let at = plans.iter().position(|p| p.id == id).ok_or(PlanExpired)?;
        let plan = plans.remove(at);
        plans.retain(|p| now.saturating_duration_since(p.created) < PLAN_TTL);
        if now.saturating_duration_since(plan.created) >= PLAN_TTL {
            return Err(PlanExpired);
        }
        Ok(plan)
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The bytes cached over every plan.
    pub fn cache_bytes(&self) -> usize {
        self.lock().iter().map(Plan::cache_bytes).sum()
    }
}

/// 16 random bytes in hex.
pub fn new_id() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("the OS random number generator failed");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// True when `folder` is itself an experiment folder: its segment after the
/// last `labnote` segment is `###_…` and is the last one (the app's
/// `getExperimentDir(f) === f`). Only canonical paths count.
pub fn is_experiment_folder(folder: &str) -> bool {
    let parts: Vec<&str> = folder.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") || folder.contains('\\') {
        return false;
    }
    let Some(idx) = parts.iter().rposition(|p| *p == "labnote") else { return false };
    if idx + 2 != parts.len() {
        return false;
    }
    let b = parts[idx + 1].as_bytes();
    b.len() >= 4 && b[..3].iter().all(u8::is_ascii_digit) && b[3] == b'_'
}

/// Composes conjoining Hangul jamo into syllables (the Hangul part of NFC),
/// so an NFD name and its NFC twin compare equal.
pub fn compose_hangul(s: &str) -> String {
    const S_BASE: u32 = 0xAC00;
    const L_BASE: u32 = 0x1100;
    const V_BASE: u32 = 0x1161;
    const T_BASE: u32 = 0x11A7;
    const V_COUNT: u32 = 21;
    const T_COUNT: u32 = 28;
    const S_COUNT: u32 = 19 * V_COUNT * T_COUNT;
    let mut out: Vec<char> = Vec::with_capacity(s.len());
    for c in s.chars() {
        let cp = c as u32;
        if let Some(&last) = out.last() {
            let lp = last as u32;
            if (L_BASE..L_BASE + 19).contains(&lp) && (V_BASE..V_BASE + V_COUNT).contains(&cp) {
                let syl = S_BASE + ((lp - L_BASE) * V_COUNT + (cp - V_BASE)) * T_COUNT;
                *out.last_mut().unwrap() = char::from_u32(syl).unwrap_or(last);
                continue;
            }
            if (S_BASE..S_BASE + S_COUNT).contains(&lp)
                && (lp - S_BASE) % T_COUNT == 0
                && (T_BASE + 1..T_BASE + T_COUNT).contains(&cp)
            {
                *out.last_mut().unwrap() = char::from_u32(lp + (cp - T_BASE)).unwrap_or(last);
                continue;
            }
        }
        out.push(c);
    }
    out.into_iter().collect()
}

/// A vault-relative path as the webview may name it in a finding.
fn sane_rel(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 1024
        && !p.starts_with('/')
        && !p.contains('\\')
        && !p.chars().any(char::is_control)
        && p.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

fn inside(folder: &str, p: &str) -> bool {
    p.strip_prefix(folder).is_some_and(|rest| rest.starts_with('/'))
}

/// Cleans the webview's display-only findings: known kinds only, sane
/// paths, `outside` paths that really are outside the folder and `unused`
/// ones inside it. Nothing here ever reaches the plan's files.
pub fn clean_info_findings(raw: &[Value], folder: &str) -> Vec<Yellow> {
    let mut out = Vec::new();
    for v in raw.iter().take(MAX_INFO_FINDINGS) {
        let info = match v.get("kind").and_then(Value::as_str) {
            Some("author") => InfoKind::Author,
            Some("crossLinks") => InfoKind::CrossLinks,
            Some("wikiLinks") => InfoKind::WikiLinks,
            Some("unused") => InfoKind::Unused,
            Some("outside") => InfoKind::Outside,
            _ => continue,
        };
        let strings = |key: &str, max: usize| -> Vec<String> {
            v.get(key)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).take(max).map(str::to_string).collect())
                .unwrap_or_default()
        };
        let mut paths: Vec<String> = strings("paths", MAX_INFO_PATHS).into_iter().filter(|p| sane_rel(p)).collect();
        match info {
            InfoKind::Outside => paths.retain(|p| !inside(folder, p) && p != folder),
            InfoKind::Unused => paths.retain(|p| inside(folder, p)),
            _ => {}
        }
        paths.sort();
        paths.dedup();
        let names: Vec<String> = if info == InfoKind::Author {
            strings("names", MAX_INFO_NAMES)
                .iter()
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty() && n.chars().count() <= 100 && !n.chars().any(char::is_control))
                .collect()
        } else {
            Vec::new()
        };
        let given = v.get("count").and_then(Value::as_u64).map(|c| c.min(u64::from(u32::MAX)) as u32);
        let count = match info {
            InfoKind::Author => names.len() as u32,
            InfoKind::Unused | InfoKind::Outside => paths.len() as u32,
            InfoKind::CrossLinks | InfoKind::WikiLinks => given.unwrap_or(paths.len() as u32),
        };
        if count == 0 {
            continue;
        }
        out.push(Yellow::Info { info, count, paths, names });
    }
    out
}

/// The sample IDs worth looking up: no path-like or control text.
fn clean_sample_ids(ids: &[String]) -> BTreeSet<String> {
    ids.iter()
        .map(|s| s.trim())
        .filter(|s| {
            !s.is_empty()
                && s.chars().count() <= 128
                && !s.contains('/')
                && !s.contains('\\')
                && !s.contains("..")
                && !s.chars().any(char::is_control)
        })
        .take(MAX_SAMPLE_IDS)
        .map(str::to_lowercase)
        .collect()
}

/// The Global sample entries whose ID (any case) is in `ids`, read in Rust
/// from `<globalSampleFolder>/<Type>.json` (P-R3). Records whose `type` is
/// not the file's type (catalogs, foreign files) are skipped; anything
/// unreadable is no samples.
pub fn global_samples(root: &Path, settings_json: &str, ids: &[String]) -> Vec<SampleEntry> {
    let wanted = clean_sample_ids(ids);
    if wanted.is_empty() {
        return Vec::new();
    }
    let settings: Value = serde_json::from_str(settings_json).unwrap_or(Value::Null);
    let folder = match settings.get("globalSampleFolder") {
        Some(Value::String(s)) => s.trim().trim_matches('/').to_string(),
        _ => DEFAULT_GLOBAL_SAMPLE_FOLDER.to_string(),
    };
    if folder.is_empty() {
        return Vec::new();
    }
    let Ok(dir) = confine(root, &folder) else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut names: Vec<String> = rd.flatten().filter_map(|e| e.file_name().into_string().ok()).collect();
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let Some(stem) = name.strip_suffix(".json").or_else(|| name.strip_suffix(".JSON")) else { continue };
        let path = dir.join(&name);
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if !meta.is_file() || meta.len() > MAX_REGISTRY_BYTES {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(Value::Object(records)) = serde_json::from_str::<Value>(&text) else { continue };
        for (id, record) in records {
            if !wanted.contains(&id.to_lowercase()) || !record.is_object() {
                continue;
            }
            let ty = record.get("type").and_then(Value::as_str).unwrap_or(stem);
            if !ty.eq_ignore_ascii_case(stem) {
                continue;
            }
            out.push(SampleEntry { id, sample_type: stem.to_string(), record });
        }
    }
    out
}

/// The blobs of the last pushed commit, read from the app-owned bare repo.
/// `None` when there is none or it cannot be read (every file is then new).
fn base_tree(dirs: &Path, root: &Path, link: &LinkRecord) -> Option<(Oid, BTreeMap<String, (Oid, u64)>)> {
    let commit = Oid::from_str(link.last_pushed_commit.as_deref()?).ok()?;
    let path = bare_repo_path(dirs, root, &link.link_id)?;
    if !path.is_dir() {
        return None;
    }
    let repo = Repository::open_bare(&path).ok()?;
    let tree = repo.find_commit(commit).ok()?.tree().ok()?;
    let odb = repo.odb().ok()?;
    let mut map = BTreeMap::new();
    tree.walk(TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() == Some(ObjectType::Blob) {
            if let Ok(name) = entry.name() {
                let size = odb.read_header(entry.id()).map(|(s, _)| s as u64).unwrap_or(0);
                map.insert(format!("{dir}{name}"), (entry.id(), size));
            }
        }
        TreeWalkResult::Ok
    })
    .ok()?;
    Some((commit, map))
}

/// What a plan is made for.
pub struct PlanRequest {
    pub folder: String,
    pub target: PlanTarget,
    pub sample_ids: Vec<String>,
    pub info_findings: Vec<Value>,
}

/// What a plan is made with.
pub struct PlanEnv<'a> {
    pub dirs: &'a Path,
    pub root: &'a Path,
    /// The vault's settings JSON (`globalSampleFolder`, `githubReadmeOverlay`).
    pub settings_json: &'a str,
    pub saved: &'a [SavedSecret],
    pub limits: Limits,
    pub now: LocalTime,
}

fn bad_input(msg: &str) -> NetError {
    NetError::new(NetErrorKind::BadInput, msg)
}

fn check_target(t: &PlanTarget) -> Result<(), NetError> {
    match t {
        PlanTarget::Create { owner, name, .. } | PlanTarget::Link { owner, name }
            if !valid_segment(owner) || !valid_repo_name(name) =>
        {
            Err(bad_input("not a valid GitHub owner or repository name"))
        }
        _ => Ok(()),
    }
}

fn merge(into: &mut ScanReport, r: ScanReport) {
    into.hits.extend(r.hits);
    into.unscanned.extend(r.unscanned);
    into.gps.extend(r.gps);
}

/// Builds a plan. `Ok((Ready, Some(plan)))` when the folder can go up;
/// every other outcome carries no plan. Never touches the network and never
/// writes anything.
pub fn build_plan(env: &PlanEnv<'_>, req: PlanRequest) -> Result<(PlanOutcome, Option<Plan>), NetError> {
    check_target(&req.target)?;
    let folder = req.folder;
    if !is_experiment_folder(&folder) {
        return Ok((PlanOutcome::NotExperiment, None));
    }
    let links = read_links(env.dirs, env.root)?;
    let link = links.links.get(&folder);
    if req.target == PlanTarget::Update && link.is_none() {
        return Ok((PlanOutcome::NotLinked, None));
    }
    let user_excluded: &[String] = link.map(|l| l.excluded.as_slice()).unwrap_or(&[]);
    let w = match walk(env.root, &folder, user_excluded, &env.limits) {
        Ok(w) => w,
        Err(WalkError::BadFolder) => return Ok((PlanOutcome::BadPath { paths: vec![folder] }, None)),
        Err(WalkError::NotFound | WalkError::NotAFolder | WalkError::Link) => return Ok((PlanOutcome::NotExperiment, None)),
        Err(e @ WalkError::Io { .. }) => return Err(NetError::new(NetErrorKind::Io, e.to_string())),
    };
    if w.folder_has_git {
        return Ok((PlanOutcome::FolderHasGit, None));
    }
    if !w.bad_paths.is_empty() {
        return Ok((PlanOutcome::BadPath { paths: w.bad_paths }, None));
    }

    let base = match (&req.target, link) {
        (PlanTarget::Update, Some(l)) => base_tree(env.dirs, env.root, l),
        _ => None,
    };
    let mode = if base.is_some() { PlanMode::Update } else { PlanMode::First };

    let mut report = ScanReport::default();
    let mut red: Vec<Red> = Vec::new();
    let mut untickable: HashSet<String> = HashSet::new();
    let mut entries: Vec<PlanEntry> = Vec::with_capacity(w.files.len());
    let mut cache: HashMap<String, Arc<[u8]>> = HashMap::new();
    let mut cached = 0usize;
    for f in &w.files {
        untickable.insert(f.rel.clone());
        let path = f.rel.split('/').fold(w.folder_abs.clone(), |p, c| p.join(c));
        let bytes: Arc<[u8]> = match std::fs::read(&path) {
            Ok(b) => Arc::from(b),
            Err(_) => {
                red.push(Red::Unreadable { path: f.rel.clone() });
                continue;
            }
        };
        let Ok(oid) = Oid::hash_object(ObjectType::Blob, &bytes) else {
            red.push(Red::Unreadable { path: f.rel.clone() });
            continue;
        };
        merge(&mut report, scan(&[(f.rel.clone(), Arc::clone(&bytes))], &[], env.saved, &env.limits));
        let size = bytes.len() as u64;
        if size <= CACHE_FILE_MAX && cached + bytes.len() <= CACHE_CAP {
            cached += bytes.len();
            cache.insert(f.rel.clone(), bytes);
        }
        entries.push(PlanEntry { rel: f.rel.clone(), size, mtime_ns: f.mtime_ns, oid });
    }

    // Generated files. A real file at the same path wins.
    let real: HashSet<&str> = w.files.iter().map(|f| f.rel.as_str()).collect();
    let notes: Vec<String> = w.files.iter().filter(|f| f.rel.to_lowercase().ends_with(".md")).map(|f| f.rel.clone()).collect();
    let has_readme_md = w.files.iter().any(|f| f.rel.eq_ignore_ascii_case("README.md"));
    let settings: Value = serde_json::from_str(env.settings_json).unwrap_or(Value::Null);
    let cfg = OverlayConfig { readme: settings.get("githubReadmeOverlay").and_then(Value::as_bool).unwrap_or(true) };
    let sample_entries = global_samples(env.root, env.settings_json, &req.sample_ids);
    let all = overlay::overlays(&cfg, &folder_title(&folder), &notes, has_readme_md, Some(&sample_entries));
    let (sample_overlays, overlays): (Vec<_>, Vec<_>) = all
        .into_iter()
        .filter(|(p, _)| !real.contains(p.as_str()))
        .partition(|(p, _)| p.starts_with(&format!("{SAMPLES_DIR}/")));
    for (p, b) in overlays.iter().chain(sample_overlays.iter()) {
        merge(&mut report, scan(&[(p.clone(), Arc::from(b.as_slice()))], &[], env.saved, &env.limits));
    }
    for (p, _) in &sample_overlays {
        untickable.insert(p.clone());
    }

    // Changes against the last pushed tree.
    let base_map = base.as_ref().map(|(_, m)| m);
    let change_of = |path: &str, oid: Oid| match base_map.and_then(|m| m.get(path)) {
        None => Change::New,
        Some((old, _)) if *old == oid => Change::Same,
        Some(_) => Change::Changed,
    };
    let mut files: Vec<PlanFile> = Vec::new();
    for e in &entries {
        files.push(PlanFile { path: e.rel.clone(), size: e.size, change: change_of(&e.rel, e.oid), generated: false, sample: false });
    }
    for (list, sample) in [(&overlays, false), (&sample_overlays, true)] {
        for (p, b) in list.iter() {
            let oid = Oid::hash_object(ObjectType::Blob, b).map_err(|e| NetError::new(NetErrorKind::Io, e.to_string()))?;
            files.push(PlanFile { path: p.clone(), size: b.len() as u64, change: change_of(p, oid), generated: !sample, sample });
        }
    }
    if let Some(m) = base_map {
        let planned: HashSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
        let gone: Vec<PlanFile> = m
            .iter()
            .filter(|(p, _)| !planned.contains(p.as_str()))
            .map(|(p, (_, size))| PlanFile {
                path: p.clone(),
                size: *size,
                change: Change::Deleted,
                generated: false,
                sample: p.starts_with(&format!("{SAMPLES_DIR}/")),
            })
            .collect();
        files.extend(gone);
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let mut totals = Totals { excluded: w.excluded.len() as u32, ..Totals::default() };
    for f in files.iter().filter(|f| !f.sample) {
        match f.change {
            Change::New => totals.new += 1,
            Change::Changed => totals.changed += 1,
            Change::Deleted => totals.deleted += 1,
            Change::Same => {}
        }
        if f.change != Change::Deleted {
            totals.files += 1;
            totals.bytes += f.size;
        }
    }
    let message = commit_message(
        &env.now,
        &Counts { new: totals.new, changed: totals.changed, deleted: totals.deleted },
    );
    merge(&mut report, scan(&[(COMMIT_MESSAGE_PATH.to_string(), Arc::from(message.as_bytes()))], &[], env.saved, &env.limits));

    // Red: hits not acknowledged before, first-seen big files, the upload
    // limit, NFD twins, unreadable files.
    let allowed: HashSet<(&str, &str)> = link
        .map(|l| l.allowed_hits.iter().map(|a| (a.path.as_str(), a.line_hash.as_str())).collect())
        .unwrap_or_default();
    for hit in &report.hits {
        if hit.overridable && allowed.contains(&(hit.path.as_str(), hit.line_hash.as_str())) {
            continue;
        }
        red.push(Red::Secret { hit: hit.clone() });
    }
    for x in w.excluded.iter().filter(|x| x.reason == ExcludeReason::TooLarge) {
        let path = x.rel.split('/').fold(w.folder_abs.clone(), |p, c| p.join(c));
        let size = std::fs::symlink_metadata(&path).map(|m| m.len()).unwrap_or(0);
        untickable.insert(x.rel.clone());
        red.push(Red::TooLarge { path: x.rel.clone(), size });
    }
    let mut yellow: Vec<Yellow> = Vec::new();
    for warning in &w.warnings {
        match warning {
            SizeWarning::UploadTooLarge { total, limit } => red.push(Red::UploadTooLarge { total: *total, limit: *limit }),
            SizeWarning::Large { rel, size } => yellow.push(Yellow::Large { path: rel.clone(), size: *size }),
            SizeWarning::RepoLarge { total } => yellow.push(Yellow::RepoLarge { total: *total }),
            SizeWarning::Nfd { rel } => yellow.push(Yellow::Nfd { path: rel.clone() }),
        }
    }
    let mut twins: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for f in files.iter().filter(|f| f.change != Change::Deleted) {
        twins.entry(compose_hangul(&f.path)).or_default().push(f.path.clone());
    }
    for (_, paths) in twins.into_iter().filter(|(_, v)| v.len() > 1) {
        red.push(Red::NfdCollision { paths });
    }

    if !report.gps.is_empty() {
        yellow.push(Yellow::Gps { paths: report.gps.clone() });
    }
    if !report.unscanned.is_empty() {
        yellow.push(Yellow::Unscanned { paths: report.unscanned.clone() });
    }
    if w.vault_is_git {
        yellow.push(Yellow::VaultIsGit);
    }
    for x in w.excluded.iter().filter(|x| x.reason == ExcludeReason::Link) {
        yellow.push(Yellow::ExcludedLink { path: x.rel.clone() });
    }
    yellow.extend(clean_info_findings(&req.info_findings, &folder));

    let samples: Vec<SampleSummary> = sample_entries
        .iter()
        .filter(|s| sample_overlays.iter().any(|(p, _)| p == &format!("{SAMPLES_DIR}/{}.json", s.sample_type)))
        .map(|s| SampleSummary {
            id: s.id.clone(),
            sample_type: s.sample_type.clone(),
            name: s.record.get("alias").and_then(Value::as_str).unwrap_or("").to_string(),
        })
        .collect();
    let samples_in_base = base_map.is_some_and(|m| m.keys().any(|p| p.starts_with(&format!("{SAMPLES_DIR}/"))));
    let quick_ok = mode == PlanMode::Update
        && red.is_empty()
        && yellow.is_empty()
        && totals.new == 0
        && totals.deleted == 0
        && samples.is_empty()
        && !samples_in_base;

    let id = new_id();
    let excluded: Vec<PlanExcluded> =
        w.excluded.iter().map(|x| PlanExcluded { path: x.rel.clone(), reason: x.reason }).collect();
    let outcome = PlanOutcome::Ready {
        plan_id: id.clone(),
        mode,
        files: files.clone(),
        excluded,
        red: red.clone(),
        yellow,
        samples,
        totals,
        quick_ok,
    };
    let plan = Plan {
        id,
        folder,
        target: req.target,
        created: Instant::now(),
        mode,
        link_id: link.map(|l| l.link_id.clone()).filter(|id| valid_id(id)),
        base_commit: base.map(|(c, _)| c),
        entries,
        overlays,
        sample_overlays,
        untickable,
        hits: report.hits,
        red,
        files,
        message,
        cache,
    };
    Ok((outcome, Some(plan)))
}

/// Makes an upload plan for one experiment folder. Local only: it walks and
/// scans the folder and compares with the app-owned bare repo; it never
/// reaches the network. The answer holds no file bytes and no secret value.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn github_plan(
    dirs: State<'_, IntegrationDirs>,
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    github: State<'_, GithubState>,
    folder: String,
    target: PlanTarget,
    sample_ids: Vec<String>,
    info_findings: Vec<Value>,
) -> Result<PlanOutcome, NetError> {
    let root = vault.root().map_err(|_| NetError::new(NetErrorKind::NotConfigured, "no vault is open"))?;
    let settings_json = crate::vault::settings::read_at(&settings.0, &root).unwrap_or_else(|| "{}".to_string());
    let cfg = ServiceConfig::from_settings_json(&settings_json);
    let saved = saved_secrets(secrets.0.as_ref(), &cfg, &github);
    let dirs = dirs.0.clone();
    let req = PlanRequest { folder, target, sample_ids, info_findings };
    let (outcome, plan) = tauri::async_runtime::spawn_blocking(move || {
        let env = PlanEnv {
            dirs: &dirs,
            root: &root,
            settings_json: &settings_json,
            saved: &saved,
            limits: Limits::DEFAULT,
            now: local_now(),
        };
        build_plan(&env, req)
    })
    .await
    .map_err(|e| NetError::new(NetErrorKind::Io, format!("the plan stopped: {e}")))??;
    if let Some(plan) = plan {
        github.plans.insert(plan, Instant::now());
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitsync::links::{AllowedHit, LinksDoc};
    use crate::gitsync::state::{write_doc, GithubDoc};
    use crate::net::config::tests::scratch_dir;
    use git2::{Signature, Time};
    use std::fs;
    use std::path::PathBuf;
    use zeroize::Zeroizing;

    const FOLDER: &str = "labnote/001_단백질 발현";
    const LINK_ID: &str = "0123456789abcdef0123456789abcdef";
    const NOW: LocalTime = LocalTime { year: 2026, month: 11, day: 10, hour: 14, minute: 32 };

    /// A scratch vault plus app data, removed on drop.
    struct Fx {
        base: PathBuf,
        root: PathBuf,
        dirs: PathBuf,
    }

    impl Fx {
        fn new() -> Self {
            let base = scratch_dir("gh-plan");
            let root = base.join("vault");
            let dirs = base.join("integrations");
            fs::create_dir_all(&root).unwrap();
            fs::create_dir_all(&dirs).unwrap();
            let fx = Fx { base, root, dirs };
            fx.put("README.labnote.md", b"# overview\n");
            fx.put("workflows/002_PCR.labnote.md", b"PCR with DNA-1\n");
            fx.put("data/plate.csv", b"well,od\nA1,0.5\n");
            fx.put(".env", b"SECRET=1\n");
            fx
        }
        fn put(&self, rel: &str, bytes: &[u8]) {
            let p = self.root.join(FOLDER).join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, bytes).unwrap();
        }
        fn env<'a>(&'a self, settings: &'a str, saved: &'a [SavedSecret], limits: Limits) -> PlanEnv<'a> {
            PlanEnv { dirs: &self.dirs, root: &self.root, settings_json: settings, saved, limits, now: NOW }
        }
        fn plan(&self, target: PlanTarget) -> (PlanOutcome, Option<Plan>) {
            self.plan_with(target, vec![], vec![])
        }
        fn plan_with(&self, target: PlanTarget, sample_ids: Vec<String>, info: Vec<Value>) -> (PlanOutcome, Option<Plan>) {
            let req = PlanRequest { folder: FOLDER.into(), target, sample_ids, info_findings: info };
            build_plan(&self.env("{}", &[], Limits::DEFAULT), req).unwrap()
        }
        fn link(&self, record: LinkRecord) {
            let mut doc = LinksDoc::default();
            doc.links.insert(FOLDER.into(), record);
            write_doc(&self.dirs, Some(&self.root), GithubDoc::Links, &doc).unwrap();
        }
        /// Commits `files` into the link's bare repo and returns the commit.
        fn commit(&self, files: &[(String, Vec<u8>)]) -> Oid {
            let path = bare_repo_path(&self.dirs, &self.root, LINK_ID).unwrap();
            let repo = Repository::init_bare(&path).unwrap();
            let tree = tree_of(&repo, files.iter().map(|(p, b)| (p.as_str(), b.as_slice())).collect());
            let sig = Signature::new("t", "t@example.invalid", &Time::new(0, 0)).unwrap();
            let tree = repo.find_tree(tree).unwrap();
            repo.commit(None, &sig, &sig, "base", &tree, &[]).unwrap()
        }
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn tree_of(repo: &Repository, files: Vec<(&str, &[u8])>) -> Oid {
        let mut here: Vec<(&str, &[u8])> = Vec::new();
        let mut sub: BTreeMap<&str, Vec<(&str, &[u8])>> = BTreeMap::new();
        for (p, b) in files {
            match p.split_once('/') {
                Some((d, rest)) => sub.entry(d).or_default().push((rest, b)),
                None => here.push((p, b)),
            }
        }
        let mut tb = repo.treebuilder(None).unwrap();
        for (name, b) in here {
            tb.insert(name, repo.blob(b).unwrap(), 0o100644).unwrap();
        }
        for (d, inner) in sub {
            tb.insert(d, tree_of(repo, inner), 0o040000).unwrap();
        }
        tb.write().unwrap()
    }

    fn ready(o: &PlanOutcome) -> (&Vec<PlanFile>, &Vec<PlanExcluded>, &Vec<Red>, &Vec<Yellow>, bool, PlanMode) {
        match o {
            PlanOutcome::Ready { files, excluded, red, yellow, quick_ok, mode, .. } => (files, excluded, red, yellow, *quick_ok, *mode),
            other => panic!("not ready: {other:?}"),
        }
    }

    /// The bytes the plan would commit: the folder's files plus the overlays.
    fn committed(fx: &Fx, plan: &Plan) -> Vec<(String, Vec<u8>)> {
        let mut out: Vec<(String, Vec<u8>)> =
            plan.entries.iter().map(|e| (e.rel.clone(), fs::read(fx.root.join(FOLDER).join(&e.rel)).unwrap())).collect();
        out.extend(plan.overlays.iter().cloned());
        out
    }

    fn linked(fx: &Fx, commit: Option<Oid>) -> LinkRecord {
        let r = LinkRecord {
            link_id: LINK_ID.into(),
            owner: "kim".into(),
            name: "exp".into(),
            branch: "main".into(),
            private: true,
            last_pushed_commit: commit.map(|c| c.to_string()),
            ..LinkRecord::default()
        };
        fx.link(r.clone());
        r
    }

    fn create() -> PlanTarget {
        PlanTarget::Create { owner: "kim".into(), name: "exp".into(), private: true }
    }

    #[test]
    fn a_plan_lists_files_excludes_and_overlays() {
        let fx = Fx::new();
        let (o, plan) = fx.plan(create());
        let (files, excluded, red, _, quick, mode) = ready(&o);
        assert_eq!(mode, PlanMode::First);
        assert!(!quick);
        assert!(red.is_empty(), "{red:?}");
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            [".gitattributes", ".gitignore", "README.labnote.md", "README.md", "data/plate.csv", "workflows/002_PCR.labnote.md"]
        );
        assert!(files.iter().all(|f| f.change == Change::New));
        assert!(files.iter().find(|f| f.path == "README.md").unwrap().generated);
        assert_eq!(excluded, &vec![PlanExcluded { path: ".env".into(), reason: ExcludeReason::Hard }]);
        let plan = plan.unwrap();
        assert_eq!(plan.entries.len(), 3);
        assert!(plan.untickable.contains("data/plate.csv") && !plan.untickable.contains(".env"));
        assert_eq!(plan.message, "labnoteO: 2026-11-10 14:32 — 새 파일 6");
        // Each entry's blob id is the id of the bytes on disk.
        for e in &plan.entries {
            let bytes = fs::read(fx.root.join(FOLDER).join(&e.rel)).unwrap();
            assert_eq!(e.oid, Oid::hash_object(ObjectType::Blob, &bytes).unwrap());
            assert_eq!(e.size, bytes.len() as u64);
        }
        let ignore = String::from_utf8(plan.overlays.iter().find(|(p, _)| p == ".gitignore").unwrap().1.clone()).unwrap();
        assert!(ignore.lines().any(|l| l == ".env*"));
    }

    #[test]
    fn the_plan_id_is_32_hex() {
        let fx = Fx::new();
        let (o, plan) = fx.plan(create());
        let PlanOutcome::Ready { plan_id, .. } = &o else { panic!() };
        assert!(valid_id(plan_id), "{plan_id}");
        assert_eq!(&plan.unwrap().id, plan_id);
        assert_ne!(new_id(), new_id());
    }

    #[test]
    fn other_outcomes() {
        let fx = Fx::new();
        let req = |folder: &str, target: PlanTarget| PlanRequest { folder: folder.into(), target, sample_ids: vec![], info_findings: vec![] };
        let env = fx.env("{}", &[], Limits::DEFAULT);
        for f in ["notes", "labnote", "labnote/001_단백질 발현/workflows", "labnote/x", "labnote/002_gone", "../labnote/001_a", "labnote//001_a"] {
            assert_eq!(build_plan(&env, req(f, create())).unwrap().0, PlanOutcome::NotExperiment, "{f}");
        }
        assert_eq!(build_plan(&env, req(FOLDER, PlanTarget::Update)).unwrap().0, PlanOutcome::NotLinked);
        let bad = PlanTarget::Create { owner: "kim".into(), name: "x.git".into(), private: true };
        assert_eq!(build_plan(&env, req(FOLDER, bad)).unwrap_err().kind, NetErrorKind::BadInput);
        // A trailing dot is a name only the `\\?\` form can create.
        let plain = fx.root.join(FOLDER).join("trail.").display().to_string().replace('/', "\\");
        let verbatim = PathBuf::from(format!(r"\\?\{plain}"));
        fs::write(&verbatim, b"x").unwrap();
        let (o, p) = build_plan(&env, req(FOLDER, create())).unwrap();
        assert_eq!(o, PlanOutcome::BadPath { paths: vec!["trail.".into()] });
        assert!(p.is_none());
        fs::remove_file(&verbatim).unwrap();
        fs::create_dir_all(fx.root.join(FOLDER).join(".git")).unwrap();
        assert_eq!(build_plan(&env, req(FOLDER, create())).unwrap().0, PlanOutcome::FolderHasGit);
    }

    fn dummy_plan(id: &str, cache: Vec<(&str, usize)>) -> Plan {
        Plan {
            id: id.into(),
            folder: FOLDER.into(),
            target: PlanTarget::Update,
            created: Instant::now(),
            mode: PlanMode::First,
            link_id: None,
            base_commit: None,
            entries: vec![],
            overlays: vec![],
            sample_overlays: vec![],
            untickable: HashSet::new(),
            hits: vec![],
            red: vec![],
            files: vec![],
            message: String::new(),
            cache: cache.into_iter().map(|(p, n)| (p.to_string(), Arc::from(vec![7u8; n]))).collect(),
        }
    }

    #[test]
    fn the_ninth_plan_evicts_the_oldest() {
        let store = PlanStore::default();
        let t0 = Instant::now();
        let ids: Vec<String> = (0..9).map(|i| format!("{i:032x}")).collect();
        for (i, id) in ids.iter().enumerate() {
            store.insert(dummy_plan(id, vec![]), t0 + Duration::from_secs(i as u64));
        }
        assert_eq!(store.len(), MAX_PLANS);
        let now = t0 + Duration::from_secs(10);
        assert_eq!(store.take(&ids[0], now).unwrap_err(), PlanExpired);
        assert_eq!(store.take(&ids[8], now).unwrap().id, ids[8]);
        assert_eq!(store.take(&ids[8], now).unwrap_err(), PlanExpired, "a plan is used once");
        assert_eq!(store.take(&ids[1], now).unwrap().id, ids[1]);
    }

    #[test]
    fn an_expired_plan_is_refused() {
        let store = PlanStore::default();
        let t0 = Instant::now();
        let id = store.insert(dummy_plan(&new_id(), vec![]), t0);
        assert_eq!(store.take(&id, t0 + Duration::from_secs(31 * 60)).unwrap_err(), PlanExpired);
        let id = store.insert(dummy_plan(&new_id(), vec![]), t0);
        assert!(store.take(&id, t0 + Duration::from_secs(29 * 60)).is_ok());
        // Inserting later drops expired ones.
        store.insert(dummy_plan(&new_id(), vec![]), t0);
        store.insert(dummy_plan(&new_id(), vec![]), t0 + Duration::from_secs(40 * 60));
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn the_cache_stays_under_its_cap() {
        let store = PlanStore::with_cap(1000);
        let t0 = Instant::now();
        store.insert(dummy_plan(&new_id(), vec![("a", 400), ("b", 300)]), t0);
        assert_eq!(store.cache_bytes(), 700);
        // The new plan keeps its small files; the older one gives way.
        store.insert(dummy_plan(&new_id(), vec![("c", 600), ("d", 100), ("e", 900)]), t0);
        assert!(store.cache_bytes() <= 1000, "{}", store.cache_bytes());
        assert_eq!(store.cache_bytes(), 700);
    }

    #[test]
    fn nine_plans_over_a_big_file_keep_the_cache_capped() {
        let fx = Fx::new();
        let big = vec![b'A'; 40 * 1024 * 1024];
        fx.put("images/big.raw", &big);
        fx.put("small1.txt", &[b'x'; 300 * 1024]);
        fx.put("small2.txt", &[b'y'; 600 * 1024]);
        let cap = 1024 * 1024;
        let store = PlanStore::with_cap(cap);
        for _ in 0..9 {
            let (_, plan) = fx.plan(create());
            let plan = plan.unwrap();
            assert!(plan.cached("images/big.raw").is_none());
            store.insert(plan, Instant::now());
            assert!(store.cache_bytes() <= cap, "{}", store.cache_bytes());
        }
        assert_eq!(store.len(), MAX_PLANS);
    }

    #[test]
    fn samples_are_only_the_referenced_global_entries() {
        let fx = Fx::new();
        let global = fx.root.join("resources").join("labsamples");
        fs::create_dir_all(&global).unwrap();
        fs::write(
            global.join("DNA.json"),
            r#"{"DNA-1":{"type":"DNA","alias":"pUC19-GFP","descriptions":[]},"DNA-2":{"type":"DNA","alias":"b"},"DNA-3":{"type":"DNA","alias":"c"}}"#,
        )
        .unwrap();
        fs::write(global.join("DNA_partbank-web.json"), r#"{"DNA-1":{"type":"DNA","alias":"catalog"}}"#).unwrap();
        let (o, plan) = fx.plan_with(create(), vec!["DNA-1".into(), "../x".into(), "nope".into()], vec![]);
        let PlanOutcome::Ready { samples, files, totals, .. } = &o else { panic!("{o:?}") };
        assert_eq!(samples, &vec![SampleSummary { id: "DNA-1".into(), sample_type: "DNA".into(), name: "pUC19-GFP".into() }]);
        let f = files.iter().find(|f| f.path == "_labnoteo/samples/DNA.json").unwrap();
        assert!(f.sample && !f.generated);
        assert_eq!(totals.files, 6, "samples are not counted as files");
        let plan = plan.unwrap();
        let (_, bytes) = &plan.sample_overlays[0];
        let snap: Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(snap.as_object().unwrap().keys().collect::<Vec<_>>(), ["DNA-1"]);
        assert_eq!(snap["DNA-1"]["alias"], "pUC19-GFP");
        assert!(plan.untickable.contains("_labnoteo/samples/DNA.json"));
        // A path-like ID alone finds nothing, and so does a folder outside the vault.
        let (o, _) = fx.plan_with(create(), vec!["../x".into()], vec![]);
        let PlanOutcome::Ready { samples, .. } = &o else { panic!() };
        assert!(samples.is_empty());
        assert!(global_samples(&fx.root, r#"{"globalSampleFolder":"../outside"}"#, &["DNA-1".into()]).is_empty());
        assert_eq!(global_samples(&fx.root, r#"{"globalSampleFolder":"resources/labsamples/"}"#, &["dna-1".into()]).len(), 1);
    }

    #[test]
    fn info_findings_are_cleaned() {
        let fx = Fx::new();
        let info = vec![
            serde_json::json!({"kind": "author", "names": ["홍길동", " ", "x\u{0007}"]}),
            serde_json::json!({"kind": "weird", "paths": ["a"]}),
            serde_json::json!({"kind": "wikiLinks", "count": 3}),
            serde_json::json!({"kind": "outside", "paths": ["resources/plasmid_map.png", format!("{FOLDER}/images/in.png"), "../escape.png"]}),
            serde_json::json!({"kind": "outside", "paths": [format!("{FOLDER}/a.png")]}),
            serde_json::json!({"kind": "unused", "paths": [format!("{FOLDER}/images/u.png"), "other/u.png"]}),
            serde_json::json!("garbage"),
        ];
        let (o, plan) = fx.plan_with(create(), vec![], info);
        let (files, _, _, yellow, _, _) = ready(&o);
        let infos: Vec<&Yellow> = yellow.iter().filter(|y| matches!(y, Yellow::Info { .. })).collect();
        assert_eq!(
            infos,
            vec![
                &Yellow::Info { info: InfoKind::Author, count: 1, paths: vec![], names: vec!["홍길동".into()] },
                &Yellow::Info { info: InfoKind::WikiLinks, count: 3, paths: vec![], names: vec![] },
                &Yellow::Info { info: InfoKind::Outside, count: 1, paths: vec!["resources/plasmid_map.png".into()], names: vec![] },
                &Yellow::Info { info: InfoKind::Unused, count: 1, paths: vec![format!("{FOLDER}/images/u.png")], names: vec![] },
            ]
        );
        // An outside file is shown, never added.
        assert!(files.iter().all(|f| !f.path.contains("plasmid_map")));
        assert!(plan.unwrap().entries.iter().all(|e| !e.rel.contains("plasmid_map")));
    }

    #[test]
    fn a_secret_in_the_generated_readme_is_reported() {
        let fx = Fx::new();
        // No `_` in it: the title reads `_` as a space.
        let token = format!("sk-{}", "a1".repeat(20));
        let folder = format!("labnote/001_{token}");
        let dir = fx.root.join(&folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("note.md"), "hello\n").unwrap();
        let req = PlanRequest { folder, target: create(), sample_ids: vec![], info_findings: vec![] };
        let (o, plan) = build_plan(&fx.env("{}", &[], Limits::DEFAULT), req).unwrap();
        let (_, _, red, _, _, _) = ready(&o);
        assert!(
            red.iter().any(|r| matches!(r, Red::Secret { hit } if hit.path == "README.md")),
            "{red:?}"
        );
        // The answer and the plan's debug output never hold the raw token.
        assert!(!serde_json::to_string(&o).unwrap().contains(&token));
        assert!(!format!("{:?}", plan.unwrap()).contains(&token));
    }

    #[test]
    fn a_folder_readme_wins_over_the_generated_one() {
        let fx = Fx::new();
        fx.put("readme.md", b"# mine\n");
        let (o, plan) = fx.plan(create());
        let (files, ..) = ready(&o);
        assert!(files.iter().all(|f| !(f.path == "README.md" && f.generated)));
        assert!(plan.unwrap().overlays.iter().all(|(p, _)| p != "README.md"));
        let off = r#"{"githubReadmeOverlay": false}"#;
        let fx2 = Fx::new();
        let req = PlanRequest { folder: FOLDER.into(), target: create(), sample_ids: vec![], info_findings: vec![] };
        let (_, plan) = build_plan(&fx2.env(off, &[], Limits::DEFAULT), req).unwrap();
        assert!(plan.unwrap().overlays.iter().all(|(p, _)| p != "README.md"));
    }

    #[test]
    fn quick_ok_for_a_changed_only_update() {
        let fx = Fx::new();
        linked(&fx, None);
        let (o, plan) = fx.plan(PlanTarget::Update);
        assert_eq!(ready(&o).5, PlanMode::First, "no pushed commit yet");
        let commit = fx.commit(&committed(&fx, &plan.unwrap()));
        linked(&fx, Some(commit));
        // Nothing changed.
        let (o, plan) = fx.plan(PlanTarget::Update);
        let (files, _, red, yellow, quick, mode) = ready(&o);
        assert_eq!(mode, PlanMode::Update);
        assert!(files.iter().all(|f| f.change == Change::Same), "{files:?}");
        assert!(red.is_empty() && yellow.is_empty() && quick);
        assert_eq!(plan.unwrap().base_commit, Some(commit));
        // One changed file: still quick.
        fx.put("data/plate.csv", b"well,od\nA1,0.7\n");
        let (o, plan) = fx.plan(PlanTarget::Update);
        let (files, _, _, _, quick, _) = ready(&o);
        assert!(quick);
        assert_eq!(files.iter().find(|f| f.path == "data/plate.csv").unwrap().change, Change::Changed);
        assert_eq!(plan.unwrap().message, "labnoteO: 2026-11-10 14:32 — 바뀜 1");
        // One new file: the full preview.
        fx.put("images/gel2.png", b"not really a png");
        let (o, _) = fx.plan(PlanTarget::Update);
        let (files, _, _, _, quick, _) = ready(&o);
        assert!(!quick);
        assert_eq!(files.iter().find(|f| f.path == "images/gel2.png").unwrap().change, Change::New);
        // A deleted file: the full preview, listed as deleted.
        fs::remove_file(fx.root.join(FOLDER).join("images/gel2.png")).unwrap();
        fs::remove_file(fx.root.join(FOLDER).join("workflows/002_PCR.labnote.md")).unwrap();
        let (o, _) = fx.plan(PlanTarget::Update);
        let PlanOutcome::Ready { files, quick_ok, totals, .. } = &o else { panic!() };
        assert!(!quick_ok);
        let gone = files.iter().find(|f| f.path == "workflows/002_PCR.labnote.md").unwrap();
        assert_eq!((gone.change, gone.size), (Change::Deleted, 15));
        assert_eq!(totals.deleted, 1);
    }

    #[test]
    fn the_answer_never_holds_file_bytes() {
        let fx = Fx::new();
        fx.put("data/marker.txt", b"UNIQUE-CONTENT-MARKER-12345");
        let (o, plan) = fx.plan(create());
        let json = serde_json::to_string(&o).unwrap();
        assert!(!json.contains("UNIQUE-CONTENT-MARKER"), "{json}");
        assert!(!json.contains("well,od"));
        assert!(!json.contains("* -text"), "overlay bytes stay in Rust");
        assert!(!format!("{:?}", plan.unwrap()).contains("UNIQUE-CONTENT-MARKER"));
    }

    #[test]
    fn hits_saved_keys_and_acknowledgements() {
        let fx = Fx::new();
        fx.put("notes.md", b"intro\npassword: hunter22\n");
        let saved = [SavedSecret { label: crate::gitsync::scan::SavedLabel::Llm, value: Zeroizing::new("abc123SAVEDkey".into()) }];
        fx.put("keys.txt", b"llm abc123SAVEDkey\n");
        let req = || PlanRequest { folder: FOLDER.into(), target: PlanTarget::Update, sample_ids: vec![], info_findings: vec![] };
        let mut rec = linked(&fx, None);
        let (o, _) = build_plan(&fx.env("{}", &saved, Limits::DEFAULT), req()).unwrap();
        let (_, _, red, ..) = ready(&o);
        let secrets: Vec<&Hit> = red.iter().filter_map(|r| if let Red::Secret { hit } = r { Some(hit) } else { None }).collect();
        assert_eq!(secrets.len(), 2, "{red:?}");
        let pw = secrets.iter().find(|h| h.path == "notes.md").unwrap();
        let key = secrets.iter().find(|h| h.path == "keys.txt").unwrap();
        assert!(pw.overridable && !key.overridable);
        assert!(!serde_json::to_string(&o).unwrap().contains("abc123SAVEDkey"));
        // An acknowledged pattern hit no longer blocks; a saved key always does.
        rec.allowed_hits = vec![
            AllowedHit { path: "notes.md".into(), line_hash: pw.line_hash.clone() },
            AllowedHit { path: "keys.txt".into(), line_hash: key.line_hash.clone() },
        ];
        fx.link(rec);
        let (o, plan) = build_plan(&fx.env("{}", &saved, Limits::DEFAULT), req()).unwrap();
        let (_, _, red, ..) = ready(&o);
        assert_eq!(red.len(), 1);
        assert!(matches!(&red[0], Red::Secret { hit } if hit.path == "keys.txt"));
        assert_eq!(plan.unwrap().hits.len(), 2, "the plan keeps every hit");
    }

    #[test]
    fn too_large_files_and_limits() {
        let fx = Fx::new();
        fx.put("raw/gel_raw.czi", &[1u8; 300]);
        fx.put("raw/mid.tif", &[2u8; 150]);
        let limits = Limits { file_block: 200, file_warn: 100, upload_block: 180, repo_warn: 170, scan_max: 1000 };
        let req = PlanRequest { folder: FOLDER.into(), target: create(), sample_ids: vec![], info_findings: vec![] };
        let (o, plan) = build_plan(&fx.env("{}", &[], limits), req).unwrap();
        let (files, excluded, red, yellow, ..) = ready(&o);
        assert!(red.contains(&Red::TooLarge { path: "raw/gel_raw.czi".into(), size: 300 }), "{red:?}");
        assert!(red.iter().any(|r| matches!(r, Red::UploadTooLarge { limit: 180, .. })));
        assert!(excluded.contains(&PlanExcluded { path: "raw/gel_raw.czi".into(), reason: ExcludeReason::TooLarge }));
        assert!(files.iter().all(|f| f.path != "raw/gel_raw.czi"));
        assert!(yellow.contains(&Yellow::Large { path: "raw/mid.tif".into(), size: 150 }));
        assert!(yellow.iter().any(|y| matches!(y, Yellow::RepoLarge { .. })));
        let plan = plan.unwrap();
        assert!(plan.untickable.contains("raw/gel_raw.czi"));
        assert!(plan.entries.iter().all(|e| e.rel != "raw/gel_raw.czi"));
        // Once the user left it out, it is only listed.
        linked(&fx, None);
        let mut rec = linked(&fx, None);
        rec.excluded = vec!["raw/gel_raw.czi".into()];
        fx.link(rec);
        let req = PlanRequest { folder: FOLDER.into(), target: PlanTarget::Update, sample_ids: vec![], info_findings: vec![] };
        let (o, _) = build_plan(&fx.env("{}", &[], limits), req).unwrap();
        let (_, excluded, red, ..) = ready(&o);
        assert!(red.iter().all(|r| !matches!(r, Red::TooLarge { .. })));
        assert!(excluded.contains(&PlanExcluded { path: "raw/gel_raw.czi".into(), reason: ExcludeReason::User }));
    }

    #[test]
    fn nfd_twins_are_red_and_gps_vault_git_are_yellow() {
        let fx = Fx::new();
        fx.put("단백질.txt", b"nfc");
        fx.put("\u{1103}\u{1161}\u{11ab}\u{1107}\u{1162}\u{11a8}\u{110c}\u{1175}\u{11af}.txt", b"nfd");
        fs::create_dir_all(fx.root.join(".git")).unwrap();
        let (o, _) = fx.plan(create());
        let (_, _, red, yellow, ..) = ready(&o);
        assert!(red.iter().any(|r| matches!(r, Red::NfdCollision { paths } if paths.len() == 2)), "{red:?}");
        assert!(yellow.contains(&Yellow::VaultIsGit));
        assert!(yellow.iter().any(|y| matches!(y, Yellow::Nfd { .. })));
        assert_eq!(compose_hangul("\u{1103}\u{1161}\u{11ab}"), "단");
        assert_eq!(compose_hangul("가\u{11a8}"), "각");
        assert_eq!(compose_hangul("abc 단백질"), "abc 단백질");
    }

    #[test]
    fn experiment_folders() {
        for ok in ["labnote/001_a", "x/labnote/123_단백질 발현", "labnote/labnote/001_a"] {
            assert!(is_experiment_folder(ok), "{ok}");
        }
        for bad in ["labnote/01_a", "labnote/001a", "labnote/001_a/b", "labnote", "labnote/001_a/", "lab/001_a", "labnote\\001_a"] {
            assert!(!is_experiment_folder(bad), "{bad}");
        }
    }
}
