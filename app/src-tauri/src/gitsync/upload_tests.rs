//! `gitsync::upload` tests: a fake GitHub API on `127.0.0.1`
//! (`net::testserver`) and `file://` bare remotes in temp dirs. No test
//! reaches a real server, and the token is a fixed fake.

use super::*;
use crate::gitsync::links::LinksDoc;
use crate::gitsync::overlay::LocalTime;
use crate::gitsync::plan::{build_plan, PlanEnv, PlanOutcome, PlanRequest};
use crate::gitsync::repo::blob_at;
use crate::gitsync::repo::tests::snapshot;
use crate::gitsync::state::{read_doc, write_doc};
use crate::net::github::auth::Account;
use crate::net::config::tests::scratch_dir;
use crate::net::config::ServiceConfig;
use crate::net::secrets::{store_secret, MemoryStore, Slot};
use crate::net::testserver::{serve, Canned, TestServer};
use serde_json::Value;
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex};

const FAKE: &str = "gho_FAKEupload00000000000000000000000000";
const FOLDER: &str = "labnote/001_단백질 발현";
const NAME: &str = "001_danbaekjil_balhyeon";
const NOW: LocalTime = LocalTime { year: 2026, month: 11, day: 10, hour: 14, minute: 32 };

/// Counts the Git steps; optionally pauses at `BeforeCreate` until released.
#[derive(Default)]
struct TestSteps {
    fetches: AtomicUsize,
    pushes: AtomicUsize,
    gate: Option<(mpsc::Sender<()>, Mutex<mpsc::Receiver<()>>)>,
}

impl Steps for TestSteps {
    fn reached(&self, point: Point) {
        if let (Point::BeforeCreate, Some((reached, release))) = (point, &self.gate) {
            reached.send(()).unwrap();
            release.lock().unwrap().recv().unwrap();
        }
    }

    fn fetch(&self, repo: &Repository, remote: &Url, branch: &str, token: &Zeroizing<String>, allowed: &GitBase) -> Result<Option<Oid>, GitError> {
        self.fetches.fetch_add(1, Ordering::SeqCst);
        git_push::fetch(repo, remote, branch, token, allowed)
    }

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
        self.pushes.fetch_add(1, Ordering::SeqCst);
        git_push::push(repo, remote, branch, target, token, allowed, progress, &[])
    }
}

struct Fx {
    base: PathBuf,
    root: PathBuf,
    dirs: PathBuf,
    remotes: PathBuf,
    store: MemoryStore,
    net: NetState,
    gh: GithubState,
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

impl Fx {
    fn new(tag: &str) -> Fx {
        let base = scratch_dir(tag);
        let root = base.join("vault");
        // A Korean Windows user folder above the app data.
        let dirs = base.join("사용자").join("integrations");
        let remotes = base.join("remotes");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&dirs).unwrap();
        fs::create_dir_all(remotes.join("kim-lab")).unwrap();
        let store = MemoryStore::default();
        store_secret(&store, Slot::Github, &ServiceConfig::from_settings_json("{}"), FAKE).unwrap();
        let account = Account { login: "kim-lab".into(), id: 4242, avatar_url: String::new() };
        write_doc(&dirs, None, GithubDoc::Account, &Some(account)).unwrap();
        let fx = Fx { base, root, dirs, remotes, store, net: NetState::default(), gh: GithubState::default() };
        fx.put("README.labnote.md", "# 개요\n".as_bytes());
        fx.put("workflows/002_PCR.labnote.md", b"PCR\n");
        fx.put("data/plate.csv", b"well,od\r\nA1,0.5\r\n");
        fx.put(".env", b"SECRET=1\n");
        fx
    }

    fn put(&self, rel: &str, bytes: &[u8]) {
        let p = self.root.join(FOLDER).join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    fn plan_full(&self, target: PlanTarget) -> (PlanOutcome, String) {
        let env = PlanEnv { dirs: &self.dirs, root: &self.root, settings_json: "{}", saved: &[], limits: Limits::DEFAULT, now: NOW };
        let req = PlanRequest { folder: FOLDER.into(), target, sample_ids: vec![], info_findings: vec![] };
        let (outcome, plan) = build_plan(&env, req).unwrap();
        let id = self.gh.plans.insert(plan.expect("a plan"), Instant::now());
        (outcome, id)
    }

    fn plan(&self, target: PlanTarget) -> String {
        self.plan_full(target).1
    }

    fn create(&self, private: bool) -> String {
        self.plan(PlanTarget::Create { owner: "kim-lab".into(), name: NAME.into(), private })
    }

    /// The bare remote the fake GitHub "created".
    fn remote(&self, owner: &str, name: &str) -> Repository {
        Repository::init_bare(self.remotes.join(owner).join(format!("{name}.git"))).unwrap()
    }

    fn ep(&self, s: &TestServer) -> GithubEndpoints {
        let base = Url::parse(&format!("{}/", s.url)).unwrap();
        GithubEndpoints { api: base.clone(), web: base, git: Url::from_directory_path(&self.remotes).unwrap() }
    }

    fn upload_with(&self, s: &TestServer, steps: &dyn Steps, id: &str, choices: UploadChoices) -> UploadOutcome {
        let ep = self.ep(s);
        let progress = |_: Stage, _: u64, _: u64| {};
        let env = UploadEnv {
            ep: &ep,
            dirs: &self.dirs,
            root: &self.root,
            store: &self.store,
            net: &self.net,
            gh: &self.gh,
            request_id: Some("up-1"),
            steps,
            progress: &progress,
            now: NOW,
        };
        upload_at(&env, id, choices).unwrap()
    }

    fn upload(&self, s: &TestServer, id: &str, choices: UploadChoices) -> UploadOutcome {
        self.upload_with(s, &RealSteps, id, choices)
    }

    fn links(&self) -> LinksDoc {
        read_links(&self.dirs, &self.root).unwrap()
    }

    fn link(&self) -> LinkRecord {
        self.links().links[FOLDER].clone()
    }

    /// Nothing under the app data holds the fake token.
    fn no_token(&self) {
        let mut stack = vec![self.base.clone()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    let b = fs::read(&p).unwrap();
                    assert!(!b.windows(FAKE.len()).any(|w| w == FAKE.as_bytes()), "token in {p:?}");
                }
            }
        }
    }
}

fn repo_json(name: &str, private: bool) -> String {
    json!({
        "id": 99, "name": name, "full_name": format!("kim-lab/{name}"), "owner": {"login": "kim-lab"},
        "private": private, "html_url": format!("https://github.com/kim-lab/{name}"), "size": 0,
        "default_branch": "main", "permissions": {"admin": true, "push": true, "pull": true}
    })
    .to_string()
}

fn created(name: &str, private: bool) -> Canned {
    Canned::status(201).header("Content-Type", "application/json").body(repo_json(name, private))
}

fn got(name: &str, private: bool) -> Canned {
    Canned::ok(&repo_json(name, private))
}

fn quiet_count(s: &TestServer) -> usize {
    std::thread::sleep(std::time::Duration::from_millis(50));
    s.request_count()
}

fn choices(json: Value) -> UploadChoices {
    serde_json::from_value(json).unwrap()
}

/// Creates and pushes the fixture folder; answers the remote.
fn first_upload(fx: &Fx) -> Repository {
    let remote = fx.remote("kim-lab", NAME);
    let s = serve(vec![created(NAME, true)]);
    let out = fx.upload(&s, &fx.create(true), UploadChoices::default());
    assert!(matches!(out, UploadOutcome::Done { .. }), "{out:?}");
    remote
}

#[test]
fn create_and_first_push() {
    let fx = Fx::new("gh-up-first");
    let before = snapshot(&fx.root);
    let remote = fx.remote("kim-lab", NAME);
    let s = serve(vec![created(NAME, true)]);
    let steps = TestSteps::default();
    let id = fx.create(true);
    let out = fx.upload_with(&s, &steps, &id, UploadChoices::default());
    assert_eq!(
        out,
        UploadOutcome::Done {
            html_url: format!("https://github.com/kim-lab/{NAME}"),
            full_name: format!("kim-lab/{NAME}"),
            counts: Counts { new: 3, changed: 0, deleted: 0 },
            warnings: vec![],
        }
    );
    // Exactly one POST, with exactly the fixed body.
    let reqs = s.requests.lock().unwrap().clone();
    assert_eq!(reqs.len(), 1);
    assert_eq!((reqs[0].method.as_str(), reqs[0].path.as_str()), ("POST", "/user/repos"));
    let body: Value = serde_json::from_str(&reqs[0].body).unwrap();
    assert_eq!(
        body,
        json!({"name": NAME, "description": "단백질 발현 · labnoteO", "private": true, "auto_init": false, "has_wiki": false})
    );
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 1);
    // The journal ends `pushed`, and the commit is on the remote.
    let link = fx.link();
    assert_eq!(link.state, LinkState::Pushed);
    assert_eq!((link.repo_id, link.owner.as_str(), link.name.as_str(), link.private), (99, "kim-lab", NAME, true));
    assert!(link.pending_commit.is_none() && link.last_pushed_at.is_some());
    let commit = Oid::from_str(link.last_pushed_commit.as_deref().unwrap()).unwrap();
    assert_eq!(remote.refname_to_id("refs/heads/main").unwrap(), commit);
    assert_eq!(blob_at(&remote, commit, "data/plate.csv").as_deref(), Some(&b"well,od\r\nA1,0.5\r\n"[..]));
    assert!(blob_at(&remote, commit, ".gitattributes").is_some());
    assert!(blob_at(&remote, commit, ".env").is_none());
    assert_eq!(fx.links().default_owner.as_deref(), Some("kim-lab"));
    // The vault is byte- and mtime-identical; nothing holds the token.
    assert_eq!(snapshot(&fx.root), before);
    fx.no_token();
    // The plan was used: a second upload of it has expired.
    assert_eq!(fx.upload(&s, &id, UploadChoices::default()), UploadOutcome::PlanExpired);
}

#[test]
fn an_update_sends_changes_and_nothing_changed_sends_nothing() {
    let fx = Fx::new("gh-up-update");
    let remote = first_upload(&fx);
    let first = fx.link().last_pushed_commit.unwrap();
    fx.put("data/plate.csv", b"well,od\r\nA1,0.7\r\n");
    let s = serve(vec![got(NAME, true)]);
    let out = fx.upload(&s, &fx.plan(PlanTarget::Update), UploadChoices::default());
    let UploadOutcome::Done { counts, warnings, .. } = out else { panic!("{out:?}") };
    assert_eq!(counts, Counts { new: 0, changed: 1, deleted: 0 });
    assert!(warnings.is_empty());
    let reqs = s.requests.lock().unwrap().clone();
    assert_eq!((reqs.len(), reqs[0].method.as_str()), (1, "GET"), "an update never creates");
    let second = fx.link().last_pushed_commit.unwrap();
    assert_ne!(first, second);
    let tip = remote.refname_to_id("refs/heads/main").unwrap();
    assert_eq!(tip.to_string(), second);
    assert_eq!(remote.find_commit(tip).unwrap().parent_id(0).unwrap().to_string(), first, "a fast-forward");
    // No change: nothing is committed or pushed.
    let steps = TestSteps::default();
    let s = serve(vec![got(NAME, true)]);
    assert_eq!(fx.upload_with(&s, &steps, &fx.plan(PlanTarget::Update), UploadChoices::default()), UploadOutcome::NothingChanged);
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 0);
    assert_eq!(fx.link().last_pushed_commit.unwrap(), second);
    assert_eq!(remote.refname_to_id("refs/heads/main").unwrap(), tip);
    fx.no_token();
}

#[test]
fn untick_only_removes_planned_paths() {
    let fx = Fx::new("gh-up-untick");
    let remote = fx.remote("kim-lab", NAME);
    let s = serve(vec![created(NAME, true)]);
    let c = choices(json!({"untick": [".env", "../outside.txt", "nope.md", "data/plate.csv"]}));
    let out = fx.upload(&s, &fx.create(true), c);
    let UploadOutcome::Done { counts, .. } = out else { panic!("{out:?}") };
    assert_eq!(counts.new, 2);
    let commit = Oid::from_str(fx.link().last_pushed_commit.as_deref().unwrap()).unwrap();
    for absent in [".env", "../outside.txt", "nope.md", "data/plate.csv"] {
        assert!(blob_at(&remote, commit, absent).is_none(), "{absent}");
    }
    assert!(blob_at(&remote, commit, "README.labnote.md").is_some());
    // The exclusion is remembered; unknown paths are not.
    assert_eq!(fx.link().excluded, ["data/plate.csv"]);
}

#[test]
fn a_file_changed_after_the_plan_is_stale_before_anything_is_sent() {
    let fx = Fx::new("gh-up-stale");
    let s = serve(vec![created(NAME, true)]);
    let steps = TestSteps::default();
    let id = fx.create(true);
    fx.put("data/plate.csv", b"edited after the preview\n");
    assert_eq!(fx.upload_with(&s, &steps, &id, UploadChoices::default()), UploadOutcome::PlanStale);
    assert_eq!(quiet_count(&s), 0, "no POST");
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 0);
    assert!(fx.links().links.is_empty());
}

#[test]
fn a_private_key_stays_blocked_whatever_allow_hits_says() {
    let fx = Fx::new("gh-up-pk");
    fx.put("keys.md", b"-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----\n");
    let (outcome, id) = fx.plan_full(PlanTarget::Create { owner: "kim-lab".into(), name: NAME.into(), private: true });
    let PlanOutcome::Ready { red, .. } = outcome else { panic!() };
    let hit = red
        .iter()
        .find_map(|r| match r {
            Red::Secret { hit, .. } if hit.path == "keys.md" => Some(hit.clone()),
            _ => None,
        })
        .unwrap();
    assert!(!hit.overridable);
    let s = serve(vec![created(NAME, true)]);
    let c = choices(json!({"allowHits": [{"path": "keys.md", "lineHash": hit.line_hash}]}));
    let UploadOutcome::Blocked { red } = fx.upload(&s, &id, c) else { panic!() };
    assert!(red.iter().any(|r| matches!(r, Red::Secret { hit, .. } if hit.path == "keys.md")));
    assert_eq!(quiet_count(&s), 0);
    // Leaving the file out is the way through.
    let id = fx.create(true);
    fx.remote("kim-lab", NAME);
    let out = fx.upload(&s, &id, choices(json!({"untick": ["keys.md"]})));
    assert!(matches!(out, UploadOutcome::Done { .. }), "{out:?}");
}

#[test]
fn public_needs_the_typed_name() {
    let fx = Fx::new("gh-up-public");
    let s = serve(vec![created(NAME, false)]);
    let id = fx.create(false);
    let out = fx.upload(&s, &id, choices(json!({"publicConfirm": "001_danbaekjil"})));
    assert_eq!(out, UploadOutcome::Blocked { red: vec![Red::PublicNotConfirmed] });
    assert_eq!(quiet_count(&s), 0);
    fx.remote("kim-lab", NAME);
    // The corrected name answers with the same plan.
    let out = fx.upload(&s, &id, choices(json!({"publicConfirm": NAME})));
    assert!(matches!(out, UploadOutcome::Done { .. }), "{out:?}");
    let body: Value = serde_json::from_str(&s.requests.lock().unwrap()[0].body).unwrap();
    assert_eq!(body["private"], json!(false));
    assert!(!fx.link().private);
}

#[test]
fn a_repo_that_is_not_private_stops_before_any_push() {
    let fx = Fx::new("gh-up-vis");
    fx.remote("kim-lab", NAME);
    let s = serve(vec![created(NAME, false)]);
    let steps = TestSteps::default();
    let out = fx.upload_with(&s, &steps, &fx.create(true), UploadChoices::default());
    assert_eq!(out, UploadOutcome::VisibilityMismatch { html_url: format!("https://github.com/kim-lab/{NAME}") });
    assert_eq!((steps.fetches.load(Ordering::SeqCst), steps.pushes.load(Ordering::SeqCst)), (0, 0));
    let link = fx.link();
    assert_eq!(link.state, LinkState::RepoReady);
    assert_eq!(link.repo_id, 99);
    assert!(link.last_pushed_commit.is_none());
    assert_eq!((link.private, link.intended_private), (false, Some(true)));
    // Trying again (repoReady: re-plan, preview, upload) still pushes nothing
    // while the repository is public, and asks for no typed name instead.
    for confirm in [json!({}), json!({"publicConfirm": NAME})] {
        let s = serve(vec![got(NAME, false)]);
        let out = fx.upload_with(&s, &steps, &fx.plan(PlanTarget::Update), choices(confirm));
        assert_eq!(out, UploadOutcome::VisibilityMismatch { html_url: format!("https://github.com/kim-lab/{NAME}") });
        assert_eq!((steps.fetches.load(Ordering::SeqCst), steps.pushes.load(Ordering::SeqCst)), (0, 0));
        assert_eq!(quiet_count(&s), 1, "only the GET");
    }
    assert!(fx.link().last_pushed_commit.is_none());
    // Made private on GitHub: the upload goes through.
    let s = serve(vec![got(NAME, true)]);
    let out = fx.upload_with(&s, &steps, &fx.plan(PlanTarget::Update), UploadChoices::default());
    let UploadOutcome::Done { warnings, .. } = out else { panic!("{out:?}") };
    assert!(warnings.is_empty());
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 1);
    let link = fx.link();
    assert_eq!((link.state, link.private), (LinkState::Pushed, true));
}

#[test]
fn a_public_create_that_came_out_private_is_pushed() {
    let fx = Fx::new("gh-up-vis-pub");
    fx.remote("kim-lab", NAME);
    let s = serve(vec![created(NAME, true)]);
    let out = fx.upload(&s, &fx.create(false), choices(json!({"publicConfirm": NAME})));
    assert!(matches!(out, UploadOutcome::Done { .. }), "{out:?}");
    let link = fx.link();
    assert_eq!((link.private, link.intended_private, link.state), (true, Some(false), LinkState::Pushed));
}

#[test]
fn a_folder_renamed_after_the_plan_gets_no_record_and_no_post() {
    let fx = Fx::new("gh-up-rename-race");
    let s = serve(vec![created(NAME, true)]);
    let id = fx.create(true);
    fs::rename(fx.root.join(FOLDER), fx.root.join("labnote/001_renamed")).unwrap();
    // Stopped before the journal (re-hash), and begin_create refuses a folder
    // that is gone in any case (journal tests).
    assert_eq!(fx.upload(&s, &id, UploadChoices::default()), UploadOutcome::PlanStale);
    assert_eq!(quiet_count(&s), 0);
    assert!(fx.links().links.is_empty());
}

#[test]
fn two_uploads_of_one_folder_one_is_busy_and_one_post() {
    let fx = Fx::new("gh-up-busy");
    fx.remote("kim-lab", NAME);
    let s = serve(vec![created(NAME, true)]);
    let (reached_tx, reached_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let gated = TestSteps { gate: Some((reached_tx, Mutex::new(release_rx))), ..TestSteps::default() };
    let (a, b) = (fx.create(true), fx.create(true));
    std::thread::scope(|scope| {
        let first = scope.spawn(|| fx.upload_with(&s, &gated, &a, UploadChoices::default()));
        reached_rx.recv().unwrap();
        // The first holds the lock and waits just before its POST.
        assert_eq!(fx.upload(&s, &b, UploadChoices::default()), UploadOutcome::Busy);
        release_tx.send(()).unwrap();
        let out = first.join().unwrap();
        assert!(matches!(out, UploadOutcome::Done { .. }), "{out:?}");
    });
    assert_eq!(quiet_count(&s), 1, "exactly one POST");
}

#[test]
fn an_org_restriction_names_the_approve_page_and_unlinks() {
    let fx = Fx::new("gh-up-org");
    write_doc(&fx.dirs, None, GithubDoc::App, &GithubAppSettings { client_id: Some("Iv1.lab".into()), forget_on_exit: false }).unwrap();
    let body = json!({"message": "Although you appear to have the correct authorization credentials, the `lab-org` organization has enabled OAuth App access restrictions."});
    let s = serve(vec![Canned::status(403).header("Content-Type", "application/json").body(body.to_string())]);
    let id = fx.plan(PlanTarget::Create { owner: "lab-org".into(), name: format!("kim-lab-{NAME}"), private: true });
    let out = fx.upload(&s, &id, UploadChoices::default());
    assert_eq!(
        out,
        UploadOutcome::OrgRestricted {
            org: "lab-org".into(),
            approve_url: "https://github.com/settings/connections/applications/Iv1.lab".into()
        }
    );
    let reqs = s.requests.lock().unwrap().clone();
    assert_eq!((reqs[0].method.as_str(), reqs[0].path.as_str()), ("POST", "/orgs/lab-org/repos"));
    assert!(fx.links().links.is_empty(), "nothing was created, so the folder is not linked");
}

#[test]
fn a_401_needs_sign_in_and_starts_no_device_flow() {
    let fx = Fx::new("gh-up-401");
    first_upload(&fx);
    fx.put("data/plate.csv", b"changed\n");
    let s = serve(vec![Canned::status(401), Canned::status(200)]);
    let steps = TestSteps::default();
    assert_eq!(fx.upload_with(&s, &steps, &fx.plan(PlanTarget::Update), UploadChoices::default()), UploadOutcome::NeedsSignIn);
    assert_eq!(quiet_count(&s), 1, "no device flow, no retry");
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 0);
    assert_eq!(fx.link().state, LinkState::Pushed);
    // A 401 on create: nothing created, so no link stays behind.
    let fx = Fx::new("gh-up-401c");
    let s = serve(vec![Canned::status(401)]);
    assert_eq!(fx.upload(&s, &fx.create(true), UploadChoices::default()), UploadOutcome::NeedsSignIn);
    assert!(fx.links().links.is_empty());
}

#[test]
fn a_repo_made_public_warns_once() {
    let fx = Fx::new("gh-up-nowpublic");
    first_upload(&fx);
    fx.put("data/plate.csv", b"v2\n");
    let s = serve(vec![got(NAME, false)]);
    let UploadOutcome::Done { warnings, .. } = fx.upload(&s, &fx.plan(PlanTarget::Update), UploadChoices::default()) else { panic!() };
    assert_eq!(warnings, [UploadWarning::NowPublic]);
    assert!(!fx.link().private);
    fx.put("data/plate.csv", b"v3\n");
    let s = serve(vec![got(NAME, false)]);
    let UploadOutcome::Done { warnings, .. } = fx.upload(&s, &fx.plan(PlanTarget::Update), UploadChoices::default()) else { panic!() };
    assert!(warnings.is_empty());
}

#[test]
fn no_token_means_sign_in_with_nothing_sent() {
    let fx = Fx::new("gh-up-notoken");
    crate::gitsync::state::sign_out_stored(&fx.dirs, &fx.store).unwrap();
    let s = serve(vec![created(NAME, true)]);
    assert_eq!(fx.upload(&s, &fx.create(true), UploadChoices::default()), UploadOutcome::NeedsSignIn);
    assert_eq!(quiet_count(&s), 0);
    assert!(fx.links().links.is_empty());
}

/// Signs out, then imports `FAKE` from a connection file, as the import
/// commands do (offline: no account record is written).
fn import_token(fx: &Fx) {
    crate::gitsync::state::sign_out_stored(&fx.dirs, &fx.store).unwrap();
    let text = format!("GITHUB_TOKEN={FAKE}
");
    let mut out = crate::net::import::import_bytes(&fx.store, "lab.env", text.as_bytes(), &ServiceConfig::from_settings_json("{}"));
    crate::net::import::finish_github_import(&fx.dirs, &fx.store, &fx.gh, &mut out);
    assert!(token(&fx.gh, &fx.store).unwrap().is_some());
    assert_eq!(read_doc::<Option<Account>>(&fx.dirs, None, GithubDoc::Account).unwrap(), None);
}

#[test]
fn an_imported_token_uploads_after_one_account_check() {
    let fx = Fx::new("gh-up-imported");
    import_token(&fx);
    let remote = fx.remote("kim-lab", NAME);
    let s = serve(vec![Canned::ok(r#"{"login":"kim-lab","id":4242,"avatar_url":""}"#), created(NAME, true)]);
    let out = fx.upload(&s, &fx.create(true), UploadChoices::default());
    assert!(matches!(out, UploadOutcome::Done { .. }), "{out:?}");
    let reqs = s.requests.lock().unwrap().clone();
    let calls: Vec<(&str, &str)> = reqs.iter().map(|r| (r.method.as_str(), r.path.as_str())).collect();
    assert_eq!(calls, vec![("GET", "/user"), ("POST", "/user/repos")]);
    // The account is recorded: the next upload asks GitHub no more about it,
    // and the commit is signed with it.
    let account = read_doc::<Option<Account>>(&fx.dirs, None, GithubDoc::Account).unwrap().unwrap();
    assert_eq!((account.login.as_str(), account.id), ("kim-lab", 4242));
    let commit = remote.find_commit(remote.refname_to_id("refs/heads/main").unwrap()).unwrap();
    assert_eq!(commit.author().name().ok(), Some("kim-lab"));
    fx.no_token();
}

#[test]
fn an_imported_token_github_refuses_is_sign_in_with_no_repo_made() {
    let fx = Fx::new("gh-up-imported-401");
    import_token(&fx);
    let s = serve(vec![Canned::status(401).body(r#"{"message":"Bad credentials"}"#), created(NAME, true)]);
    assert_eq!(fx.upload(&s, &fx.create(true), UploadChoices::default()), UploadOutcome::NeedsSignIn);
    assert_eq!(quiet_count(&s), 1);
    assert_eq!(s.requests.lock().unwrap()[0].path, "/user");
    assert!(fx.links().links.is_empty());
    assert_eq!(read_doc::<Option<Account>>(&fx.dirs, None, GithubDoc::Account).unwrap(), None);
}

#[test]
fn status_is_offline_and_counts_changes() {
    let fx = Fx::new("gh-up-status");
    // Unlinked: nothing to count, and no network is even reachable here.
    let st = folder_status_at(&fx.dirs, &fx.root, FOLDER).unwrap();
    assert!(!st.linked && !st.folder_missing && st.changed_count == 0);
    assert_eq!(serde_json::to_value(&st).unwrap(), json!({"linked": false, "state": "planned", "changedCount": 0, "folderMissing": false}));
    first_upload(&fx);
    let st = folder_status_at(&fx.dirs, &fx.root, FOLDER).unwrap();
    assert_eq!((st.linked, st.state, st.changed_count, st.private), (true, LinkState::Pushed, 0, Some(true)));
    assert_eq!(st.full_name.as_deref(), Some(&*format!("kim-lab/{NAME}")));
    fx.put("data/plate.csv", b"changed\n");
    fx.put("new.md", b"new\n");
    fs::remove_file(fx.root.join(FOLDER).join("workflows/002_PCR.labnote.md")).unwrap();
    assert_eq!(folder_status_at(&fx.dirs, &fx.root, FOLDER).unwrap().changed_count, 3);
    let all = statuses_at(&fx.dirs, &fx.root).unwrap();
    assert_eq!(all.keys().collect::<Vec<_>>(), [FOLDER]);
    assert_eq!(all[FOLDER].changed_count, 3);
    // A deleted folder keeps its link and says so.
    fs::remove_dir_all(fx.root.join(FOLDER)).unwrap();
    let st = folder_status_at(&fx.dirs, &fx.root, FOLDER).unwrap();
    assert!(st.linked && st.folder_missing);
}

#[test]
fn default_owner_is_validated() {
    let fx = Fx::new("gh-up-owner");
    assert_eq!(default_owner_get_at(&fx.dirs, &fx.root).unwrap(), None);
    default_owner_set_at(&fx.dirs, &fx.root, "lab-org").unwrap();
    assert_eq!(default_owner_get_at(&fx.dirs, &fx.root).unwrap().as_deref(), Some("lab-org"));
    for bad in ["", "a/b", "..", "x y"] {
        assert_eq!(default_owner_set_at(&fx.dirs, &fx.root, bad).unwrap_err().kind, NetErrorKind::BadInput, "{bad}");
    }
}

#[test]
fn unlink_trashes_the_app_copy_and_sends_nothing() {
    let fx = Fx::new("gh-up-unlink");
    first_upload(&fx);
    let link = fx.link();
    let bare = bare_repo_path(&fx.dirs, &fx.root, &link.link_id).unwrap();
    assert!(bare.is_dir());
    let before = snapshot(&fx.root);
    let trashed = Mutex::new(Vec::new());
    // Held by an upload: refused, nothing touched.
    {
        let _held = lock_link(&fx.gh.busy, &fx.dirs, &fx.root, &[LockKey::Link(link.link_id.clone())]).unwrap();
        assert!(unlink_at(&fx.dirs, &fx.root, &fx.gh.busy, FOLDER, |p| {
            trashed.lock().unwrap().push(p.to_path_buf());
            Ok(())
        })
        .is_err());
        assert!(trashed.lock().unwrap().is_empty());
    }
    unlink_at(&fx.dirs, &fx.root, &fx.gh.busy, FOLDER, |p| {
        trashed.lock().unwrap().push(p.to_path_buf());
        Ok(())
    })
    .unwrap();
    assert_eq!(*trashed.lock().unwrap(), [bare]);
    assert!(fx.links().links.is_empty());
    assert_eq!(snapshot(&fx.root), before, "the vault is untouched");
    // An unlinked folder is fine and trashes nothing.
    unlink_at(&fx.dirs, &fx.root, &fx.gh.busy, FOLDER, |_| panic!("nothing to trash")).unwrap();
    // A failing Recycle Bin keeps the link.
    let fx = Fx::new("gh-up-unlink2");
    first_upload(&fx);
    assert!(unlink_at(&fx.dirs, &fx.root, &fx.gh.busy, FOLDER, |_| Err(trash::Error::Unknown { description: "no".into() })).is_err());
    assert!(fx.links().links.contains_key(FOLDER));
}

#[test]
fn a_renamed_folder_keeps_its_link() {
    let fx = Fx::new("gh-up-rename");
    first_upload(&fx);
    let id = fx.link().link_id;
    let locks = crate::vault::fs::PathLocks::default();
    crate::vault::fs::rename(&locks, &fx.root, FOLDER, "labnote/001_renamed").unwrap();
    crate::gitsync::links::on_rename(&fx.dirs, &fx.root, FOLDER, "labnote/001_renamed").unwrap();
    let links = fx.links();
    assert_eq!(links.links["labnote/001_renamed"].link_id, id);
    let st = folder_status_at(&fx.dirs, &fx.root, "labnote/001_renamed").unwrap();
    assert!(st.linked && !st.folder_missing && st.changed_count == 0, "{st:?}");
}

#[test]
fn the_wire_shapes() {
    let v = serde_json::to_value(UploadOutcome::OrgRestricted { org: "o".into(), approve_url: "u".into() }).unwrap();
    assert_eq!(v, json!({"outcome": "orgRestricted", "org": "o", "approveUrl": "u"}));
    let v = serde_json::to_value(UploadOutcome::Done {
        html_url: "h".into(),
        full_name: "o/r".into(),
        counts: Counts { new: 1, changed: 2, deleted: 3 },
        warnings: vec![UploadWarning::NowPublic],
    })
    .unwrap();
    assert_eq!(
        v,
        json!({"outcome": "done", "htmlUrl": "h", "fullName": "o/r", "counts": {"new": 1, "changed": 2, "deleted": 3}, "warnings": ["nowPublic"]})
    );
    assert_eq!(serde_json::to_value(UploadOutcome::Busy).unwrap(), json!({"outcome": "busy"}));
    let p = GithubProgress { request_id: "r".into(), stage: Stage::Uploading, done: 1, total: 2 };
    assert_eq!(serde_json::to_value(p).unwrap(), json!({"requestId": "r", "stage": "uploading", "done": 1, "total": 2}));
    // Choices refuse anything they do not know (no way to add a path).
    assert!(serde_json::from_value::<UploadChoices>(json!({"add": ["x"]})).is_err());
    let c: UploadChoices = serde_json::from_value(json!({"diverged": "mine", "ackFiles": ["a"]})).unwrap();
    assert_eq!(c.diverged, Some(DivergedChoice::Mine));
    let v = serde_json::to_value(UploadOutcome::Diverged {
        files: vec![DivergedFile { path: "notes.txt".into(), change: Change::New, gone_here: true }],
        warnings: vec![UploadWarning::NowPublic],
    })
    .unwrap();
    assert_eq!(
        v,
        json!({"outcome": "diverged", "files": [{"path": "notes.txt", "change": "new", "goneHere": true}], "warnings": ["nowPublic"]})
    );
    let v = serde_json::to_value(UploadOutcome::PushedSeparately { compare_url: "c".into(), warnings: vec![] }).unwrap();
    assert_eq!(v, json!({"outcome": "pushedSeparately", "compareUrl": "c", "warnings": []}));
    let v = serde_json::to_value(Red::DivergedNotAcknowledged { paths: vec!["a".into()] }).unwrap();
    assert_eq!(v, json!({"kind": "divergedNotAcknowledged", "paths": ["a"]}));
}

// ---------------------------------------------------------------------------
// Divergence and linking an existing repository (Task 9B).

/// A labmate's commit on the remote's `main` (what a second clone pushes):
/// `Some(bytes)` writes a file, `None` removes it. Answers the new tip.
fn advance_remote(remote: &Repository, changes: &[(&str, Option<&[u8]>)]) -> Oid {
    let parent = remote.refname_to_id("refs/heads/main").ok().map(|id| remote.find_commit(id).unwrap());
    let base = match &parent {
        Some(c) => c.tree().unwrap(),
        None => remote.find_tree(remote.treebuilder(None).unwrap().write().unwrap()).unwrap(),
    };
    let mut b = git2::build::TreeUpdateBuilder::new();
    for (path, bytes) in changes {
        match bytes {
            Some(bytes) => {
                let id = remote.blob(bytes).unwrap();
                b.upsert(*path, id, git2::FileMode::Blob);
            }
            None => {
                b.remove(*path);
            }
        }
    }
    let tree = remote.find_tree(b.create_updated(remote, &base).unwrap()).unwrap();
    let sig = git2::Signature::now("labmate", "labmate@example.com").unwrap();
    let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
    remote.commit(Some("refs/heads/main"), &sig, &sig, "edited on GitHub", &tree, &parents).unwrap()
}

fn main_tip(remote: &Repository) -> Oid {
    remote.refname_to_id("refs/heads/main").unwrap()
}

fn diverged_file(path: &str, change: Change, gone_here: bool) -> DivergedFile {
    DivergedFile { path: path.into(), change, gone_here }
}

#[test]
fn a_remote_that_moved_is_diverged_and_mine_fast_forwards() {
    let fx = Fx::new("gh-up-div-mine");
    let remote = first_upload(&fx);
    let first = fx.link().last_pushed_commit.unwrap();
    let theirs = advance_remote(
        &remote,
        &[
            ("README.labnote.md", Some("# GitHub에서 고침\n".as_bytes())),
            ("notes.txt", Some(b"labmate\n")),
            // The same edit was made here too: nothing of theirs is lost, so it is not listed.
            ("data/plate.csv", Some(b"well,od\r\nA1,0.9\r\n")),
        ],
    );
    fx.put("data/plate.csv", b"well,od\r\nA1,0.9\r\n");
    fx.put("workflows/002_PCR.labnote.md", b"PCR v2\n");
    let before = snapshot(&fx.root);
    let id = fx.plan(PlanTarget::Update);
    let steps = TestSteps::default();
    let s = serve(vec![got(NAME, true)]);
    let out = fx.upload_with(&s, &steps, &id, UploadChoices::default());
    assert_eq!(
        out,
        UploadOutcome::Diverged {
            files: vec![diverged_file("README.labnote.md", Change::Changed, false), diverged_file("notes.txt", Change::New, true)],
            warnings: vec![],
        }
    );
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 0);
    assert_eq!(main_tip(&remote), theirs);
    assert_eq!(fx.link().last_pushed_commit.as_deref(), Some(first.as_str()));
    assert_eq!(fx.link().state, LinkState::Pushed, "no journal step was taken");

    // The same plan answers the screen; a file left unticked blocks.
    let s = serve(vec![got(NAME, true)]);
    let out = fx.upload_with(&s, &steps, &id, choices(json!({"diverged": "mine", "ackFiles": ["README.labnote.md"]})));
    assert_eq!(out, UploadOutcome::Blocked { red: vec![Red::DivergedNotAcknowledged { paths: vec!["notes.txt".into()] }] });
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 0);
    assert_eq!(main_tip(&remote), theirs);

    // Every file ticked: a fast-forward on top of GitHub's commit.
    let s = serve(vec![got(NAME, true)]);
    let c = choices(json!({"diverged": "mine", "ackFiles": ["README.labnote.md", "notes.txt", "unrelated.md"]}));
    let out = fx.upload_with(&s, &steps, &id, c);
    assert!(matches!(out, UploadOutcome::Done { .. }), "{out:?}");
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 1);
    let tip = main_tip(&remote);
    assert_eq!(remote.find_commit(tip).unwrap().parent_ids().collect::<Vec<_>>(), [theirs], "parent = GitHub's tip");
    assert!(remote.graph_descendant_of(tip, Oid::from_str(&first).unwrap()).unwrap());
    let link = fx.link();
    assert_eq!((link.state, link.last_pushed_commit.as_deref()), (LinkState::Pushed, Some(&*tip.to_string())));
    assert_eq!(blob_at(&remote, tip, "README.labnote.md").as_deref(), Some("# 개요\n".as_bytes()));
    assert_eq!(blob_at(&remote, tip, "workflows/002_PCR.labnote.md").as_deref(), Some(&b"PCR v2\n"[..]));
    assert!(blob_at(&remote, tip, "notes.txt").is_none());
    // GitHub's version stays in the history.
    assert_eq!(blob_at(&remote, theirs, "notes.txt").as_deref(), Some(&b"labmate\n"[..]));
    assert_eq!(snapshot(&fx.root), before, "the vault is untouched");
    // The plan was used.
    assert_eq!(fx.upload(&s, &id, UploadChoices::default()), UploadOutcome::PlanExpired);

    // The next upload is ordinary again.
    fx.put("data/plate.csv", b"v3\n");
    let s = serve(vec![got(NAME, true)]);
    let out = fx.upload(&s, &fx.plan(PlanTarget::Update), UploadChoices::default());
    assert!(matches!(out, UploadOutcome::Done { .. }), "{out:?}");
    assert_eq!(remote.find_commit(main_tip(&remote)).unwrap().parent_id(0).unwrap(), tip);
    fx.no_token();
}

#[test]
fn separate_leaves_github_and_the_link_where_they_were() {
    let fx = Fx::new("gh-up-div-sep");
    let remote = first_upload(&fx);
    let first = fx.link().last_pushed_commit.unwrap();
    let theirs = advance_remote(&remote, &[("notes.txt", Some(b"labmate\n"))]);
    fx.put("data/plate.csv", b"mine\n");
    let before = snapshot(&fx.root);
    let sep = "labnoteo/20261110-1432";
    let s = serve(vec![got(NAME, true)]);
    let out = fx.upload(&s, &fx.plan(PlanTarget::Update), choices(json!({"diverged": "separate"})));
    assert_eq!(
        out,
        UploadOutcome::PushedSeparately {
            compare_url: format!("https://github.com/kim-lab/{NAME}/compare/main...{sep}"),
            warnings: vec![]
        }
    );
    assert_eq!(main_tip(&remote), theirs, "GitHub's main is untouched");
    let pushed = remote.refname_to_id(&format!("refs/heads/{sep}")).unwrap();
    assert_eq!(remote.find_commit(pushed).unwrap().parent_ids().collect::<Vec<_>>(), [theirs]);
    assert_eq!(blob_at(&remote, pushed, "data/plate.csv").as_deref(), Some(&b"mine\n"[..]));
    let link = fx.link();
    assert_eq!((link.state, link.last_pushed_commit.as_deref()), (LinkState::Pushed, Some(first.as_str())));
    assert!(link.pending_commit.is_none());

    // The name is taken now: the next one gets "-2", then "-3".
    for n in 2..=3 {
        let s = serve(vec![got(NAME, true)]);
        let out = fx.upload(&s, &fx.plan(PlanTarget::Update), choices(json!({"diverged": "separate"})));
        assert_eq!(
            out,
            UploadOutcome::PushedSeparately {
                compare_url: format!("https://github.com/kim-lab/{NAME}/compare/main...{sep}-{n}"),
                warnings: vec![]
            }
        );
        assert!(remote.refname_to_id(&format!("refs/heads/{sep}-{n}")).is_ok());
    }
    assert_eq!(main_tip(&remote), theirs);
    assert_eq!(fx.link().last_pushed_commit.as_deref(), Some(first.as_str()));
    // Still diverged: the next plain upload asks again.
    let s = serve(vec![got(NAME, true)]);
    let out = fx.upload(&s, &fx.plan(PlanTarget::Update), UploadChoices::default());
    assert!(matches!(out, UploadOutcome::Diverged { .. }), "{out:?}");
    assert_eq!(snapshot(&fx.root), before);
    fx.no_token();
}

fn link_target() -> PlanTarget {
    PlanTarget::Link { owner: "kim-lab".into(), name: NAME.into() }
}

#[test]
fn linking_a_non_empty_repo_lists_every_file_the_upload_would_change() {
    let fx = Fx::new("gh-up-link");
    let remote = fx.remote("kim-lab", NAME);
    let theirs = advance_remote(
        &remote,
        &[
            // Identical to the folder: not listed.
            ("README.labnote.md", Some("# 개요\n".as_bytes())),
            ("data/plate.csv", Some(b"other\n")),
            ("notes.txt", Some(b"x\n")),
            ("docs/a.md", Some(b"a\n")),
        ],
    );
    let before = snapshot(&fx.root);
    let steps = TestSteps::default();
    let id = fx.plan(link_target());
    let s = serve(vec![got(NAME, true)]);
    let out = fx.upload_with(&s, &steps, &id, UploadChoices::default());
    assert_eq!(
        out,
        UploadOutcome::Diverged {
            files: vec![
                diverged_file("data/plate.csv", Change::New, false),
                diverged_file("docs/a.md", Change::New, true),
                diverged_file("notes.txt", Change::New, true),
            ],
            warnings: vec![],
        }
    );
    let reqs = s.requests.lock().unwrap().clone();
    assert_eq!(reqs.len(), 1);
    assert_eq!((reqs[0].method.as_str(), reqs[0].path.as_str()), ("GET", &*format!("/repos/kim-lab/{NAME}")));
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 0);
    let link = fx.link();
    assert_eq!((link.state, link.repo_id, link.intended_private), (LinkState::RepoReady, 99, Some(true)));
    assert!(link.last_pushed_commit.is_none() && link.requested_at.is_none());
    assert_eq!(main_tip(&remote), theirs);

    // The answer, with the same plan.
    let s = serve(vec![got(NAME, true)]);
    let c = choices(json!({"diverged": "mine", "ackFiles": ["data/plate.csv", "docs/a.md", "notes.txt"]}));
    let out = fx.upload_with(&s, &steps, &id, c);
    assert!(matches!(out, UploadOutcome::Done { .. }), "{out:?}");
    assert_eq!(quiet_count(&s), 1, "never a POST");
    let tip = main_tip(&remote);
    assert_eq!(remote.find_commit(tip).unwrap().parent_ids().collect::<Vec<_>>(), [theirs]);
    let link = fx.link();
    assert_eq!((link.state, link.last_pushed_commit.as_deref()), (LinkState::Pushed, Some(&*tip.to_string())));
    assert_eq!(blob_at(&remote, tip, "data/plate.csv").as_deref(), Some(&b"well,od\r\nA1,0.5\r\n"[..]));
    assert!(blob_at(&remote, tip, "notes.txt").is_none());
    assert_eq!(snapshot(&fx.root), before);
    fx.no_token();
}

#[test]
fn linking_checks_access_and_visibility_before_anything_is_recorded() {
    let fx = Fx::new("gh-up-link-checks");
    let mut ro: Value = serde_json::from_str(&repo_json(NAME, true)).unwrap();
    ro["permissions"]["push"] = json!(false);
    let s = serve(vec![Canned::ok(&ro.to_string())]);
    assert_eq!(fx.upload(&s, &fx.plan(link_target()), UploadChoices::default()), UploadOutcome::ReadOnly);
    assert!(fx.links().links.is_empty());
    // A public repository needs the typed name.
    let s = serve(vec![got(NAME, false)]);
    let id = fx.plan(link_target());
    let out = fx.upload(&s, &id, choices(json!({"publicConfirm": "wrong"})));
    assert_eq!(out, UploadOutcome::Blocked { red: vec![Red::PublicNotConfirmed] });
    assert!(fx.links().links.is_empty());
    // An empty repository: nothing on GitHub to replace, so it goes straight
    // up (the corrected name answers with the same plan).
    let remote = fx.remote("kim-lab", NAME);
    let s = serve(vec![got(NAME, false)]);
    let out = fx.upload(&s, &id, choices(json!({"publicConfirm": NAME})));
    assert!(matches!(out, UploadOutcome::Done { .. }), "{out:?}");
    let link = fx.link();
    assert_eq!((link.state, link.private, link.intended_private), (LinkState::Pushed, false, Some(false)));
    assert_eq!(main_tip(&remote).to_string(), link.last_pushed_commit.unwrap());
    // A folder that is linked already cannot be linked to another repository.
    let s = serve(vec![got(NAME, true)]);
    let id = fx.plan(PlanTarget::Link { owner: "kim-lab".into(), name: "another".into() });
    let ep = fx.ep(&s);
    let progress = |_: Stage, _: u64, _: u64| {};
    let env = UploadEnv {
        ep: &ep,
        dirs: &fx.dirs,
        root: &fx.root,
        store: &fx.store,
        net: &fx.net,
        gh: &fx.gh,
        request_id: None,
        steps: &RealSteps,
        progress: &progress,
        now: NOW,
    };
    assert_eq!(upload_at(&env, &id, UploadChoices::default()).unwrap_err().kind, NetErrorKind::BadInput);
    assert_eq!(quiet_count(&s), 0);
}

#[test]
fn a_repo_made_public_while_diverged_still_warns_when_mine_is_pushed() {
    let fx = Fx::new("gh-up-div-public");
    let remote = first_upload(&fx);
    // Korean paths: GitHub's tree paths must meet the plan's own.
    fx.put("결과/요약.md", "같음\n".as_bytes());
    fx.put("그림/표.csv", b"mine\n");
    let theirs = advance_remote(
        &remote,
        &[
            ("결과/요약.md", Some("같음\n".as_bytes())),
            ("그림/표.csv", Some(b"theirs\n")),
            ("메모/실험.txt", Some("동료\n".as_bytes())),
        ],
    );
    let id = fx.plan(PlanTarget::Update);
    let before = snapshot(&fx.root);
    // A labmate also made the repository public.
    let s = serve(vec![got(NAME, false)]);
    let out = fx.upload(&s, &id, UploadChoices::default());
    assert_eq!(
        out,
        UploadOutcome::Diverged {
            files: vec![diverged_file("그림/표.csv", Change::New, false), diverged_file("메모/실험.txt", Change::New, true)],
            warnings: vec![UploadWarning::NowPublic],
        }
    );
    let link = fx.link();
    assert!(!link.private && link.public_unwarned, "the visibility is current, the warning still owed");

    let s = serve(vec![got(NAME, false)]);
    let c = choices(json!({"diverged": "mine", "ackFiles": ["그림/표.csv", "메모/실험.txt"]}));
    let UploadOutcome::Done { warnings, .. } = fx.upload(&s, &id, c) else { panic!() };
    assert_eq!(warnings, [UploadWarning::NowPublic]);
    let tip = main_tip(&remote);
    assert_eq!(remote.find_commit(tip).unwrap().parent_ids().collect::<Vec<_>>(), [theirs]);
    assert_eq!(blob_at(&remote, tip, "그림/표.csv").as_deref(), Some(&b"mine\n"[..]));
    assert!(!fx.link().public_unwarned);
    assert_eq!(snapshot(&fx.root), before, "the vault is untouched");

    // Said once.
    fx.put("data/plate.csv", b"v3\n");
    let s = serve(vec![got(NAME, false)]);
    let UploadOutcome::Done { warnings, .. } = fx.upload(&s, &fx.plan(PlanTarget::Update), UploadChoices::default()) else { panic!() };
    assert!(warnings.is_empty());
    fx.no_token();
}

#[test]
fn a_repo_made_public_warns_on_a_separate_upload_and_not_after() {
    let fx = Fx::new("gh-up-sep-public");
    let remote = first_upload(&fx);
    let theirs = advance_remote(&remote, &[("notes.txt", Some(b"labmate\n"))]);
    fx.put("data/plate.csv", b"mine\n");
    let s = serve(vec![got(NAME, false)]);
    let out = fx.upload(&s, &fx.plan(PlanTarget::Update), choices(json!({"diverged": "separate"})));
    let UploadOutcome::PushedSeparately { warnings, .. } = out else { panic!("{out:?}") };
    assert_eq!(warnings, [UploadWarning::NowPublic]);
    assert!(!fx.link().public_unwarned);
    assert_eq!(main_tip(&remote), theirs);
    let s = serve(vec![got(NAME, false)]);
    let out = fx.upload(&s, &fx.plan(PlanTarget::Update), UploadChoices::default());
    let UploadOutcome::Diverged { warnings, .. } = out else { panic!("{out:?}") };
    assert!(warnings.is_empty());
}

#[test]
fn nothing_of_githubs_to_replace_asks_nothing() {
    let fx = Fx::new("gh-up-div-empty");
    let remote = first_upload(&fx);
    // The same edit on GitHub and here.
    let theirs = advance_remote(&remote, &[("data/plate.csv", Some(b"both\n"))]);
    fx.put("data/plate.csv", b"both\n");
    fx.put("workflows/002_PCR.labnote.md", b"PCR v2\n");
    let s = serve(vec![got(NAME, true)]);
    let out = fx.upload(&s, &fx.plan(PlanTarget::Update), UploadChoices::default());
    assert!(matches!(out, UploadOutcome::Done { .. }), "{out:?}");
    let tip = main_tip(&remote);
    assert_eq!(remote.find_commit(tip).unwrap().parent_ids().collect::<Vec<_>>(), [theirs]);

    // GitHub has exactly what the folder has: nothing is sent, and the link
    // catches up with GitHub's tip.
    let theirs = advance_remote(&remote, &[("data/plate.csv", Some(b"again\n"))]);
    fx.put("data/plate.csv", b"again\n");
    let s = serve(vec![got(NAME, true)]);
    assert_eq!(fx.upload(&s, &fx.plan(PlanTarget::Update), UploadChoices::default()), UploadOutcome::NothingChanged);
    assert_eq!(main_tip(&remote), theirs);
    assert_eq!(fx.link().last_pushed_commit, Some(theirs.to_string()));
}

#[test]
fn a_renamed_repo_answers_the_divergence_screen_with_the_same_plan() {
    let fx = Fx::new("gh-up-link-moved");
    let remote = fx.remote("kim-lab", "renamed");
    let theirs = advance_remote(&remote, &[("notes.txt", Some(b"x\n"))]);
    let moved = || vec![Canned::status(301).header("Location", "/repositories/99"), got("renamed", true)];
    // The user typed the old name; GitHub redirects to the renamed repository.
    let id = fx.plan(link_target());
    let s = serve(moved());
    let out = fx.upload(&s, &id, UploadChoices::default());
    assert!(matches!(out, UploadOutcome::Diverged { .. }), "{out:?}");
    assert_eq!((fx.link().owner.as_str(), fx.link().name.as_str()), ("kim-lab", "renamed"));
    let s = serve(moved());
    let out = fx.upload(&s, &id, choices(json!({"diverged": "mine", "ackFiles": ["notes.txt"]})));
    assert!(matches!(out, UploadOutcome::Done { .. }), "{out:?}");
    let reqs = s.requests.lock().unwrap().clone();
    assert_eq!(reqs[0].path, format!("/repos/kim-lab/{NAME}"), "the typed name is asked for");
    let tip = main_tip(&remote);
    assert_eq!(remote.find_commit(tip).unwrap().parent_ids().collect::<Vec<_>>(), [theirs]);
}

#[test]
fn another_repo_cannot_continue_a_link() {
    let fx = Fx::new("gh-up-link-other");
    let remote = fx.remote("kim-lab", NAME);
    advance_remote(&remote, &[("notes.txt", Some(b"x\n"))]);
    let s = serve(vec![got(NAME, true)]);
    let out = fx.upload(&s, &fx.plan(link_target()), UploadChoices::default());
    assert!(matches!(out, UploadOutcome::Diverged { .. }), "{out:?}");
    // A plan for a different repository (another id) is refused, nothing pushed.
    let mut other: Value = serde_json::from_str(&repo_json("another", true)).unwrap();
    other["id"] = json!(7);
    let s = serve(vec![Canned::ok(&other.to_string())]);
    let id = fx.plan(PlanTarget::Link { owner: "kim-lab".into(), name: "another".into() });
    let ep = fx.ep(&s);
    let progress = |_: Stage, _: u64, _: u64| {};
    let env = UploadEnv {
        ep: &ep,
        dirs: &fx.dirs,
        root: &fx.root,
        store: &fx.store,
        net: &fx.net,
        gh: &fx.gh,
        request_id: None,
        steps: &RealSteps,
        progress: &progress,
        now: NOW,
    };
    let c = choices(json!({"diverged": "mine", "ackFiles": ["notes.txt"]}));
    assert_eq!(upload_at(&env, &id, c).unwrap_err().kind, NetErrorKind::BadInput);
    assert_eq!(fx.link().name, NAME);
    assert!(fx.link().last_pushed_commit.is_none());
}

// ---------------------------------------------------------------------------
// Task 9C: "마저 하기" (`retry_at`) from each journal state.

fn env_for<'a>(
    fx: &'a Fx,
    ep: &'a GithubEndpoints,
    steps: &'a dyn Steps,
    progress: &'a (dyn Fn(Stage, u64, u64) + Sync),
) -> UploadEnv<'a> {
    UploadEnv {
        ep,
        dirs: &fx.dirs,
        root: &fx.root,
        store: &fx.store,
        net: &fx.net,
        gh: &fx.gh,
        request_id: Some("retry-1"),
        steps,
        progress,
        now: NOW,
    }
}

fn try_upload(fx: &Fx, s: &TestServer, steps: &dyn Steps, id: &str, c: UploadChoices) -> Result<UploadOutcome, NetError> {
    let ep = fx.ep(s);
    let progress = |_: Stage, _: u64, _: u64| {};
    upload_at(&env_for(fx, &ep, steps, &progress), id, c)
}

fn retry(fx: &Fx, s: &TestServer, steps: &dyn Steps) -> Result<UploadOutcome, NetError> {
    let ep = fx.ep(s);
    let progress = |_: Stage, _: u64, _: u64| {};
    retry_at(&env_for(fx, &ep, steps, &progress), FOLDER)
}

/// `YYYY-MM-DDTHH:MM:00Z` for Unix milliseconds `ms`.
fn github_time(ms: u64) -> String {
    let t = crate::gitsync::overlay::utc_from_unix(ms / 1000);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:00Z", t.year, t.month, t.day, t.hour, t.minute)
}

const DESCRIPTION: &str = "단백질 발현 · labnoteO";

/// `GET repos/kim-lab/<NAME>` for the repository a lost create answer made.
fn found_json(private: bool, description: Option<&str>, created_at: Option<&str>, size: u64) -> Canned {
    let mut j: Value = serde_json::from_str(&repo_json(NAME, private)).unwrap();
    j["description"] = json!(description);
    if let Some(t) = created_at {
        j["created_at"] = json!(t);
    }
    j["size"] = json!(size);
    Canned::ok(&j.to_string())
}

fn found(description: &str, created_at: &str, size: u64) -> Canned {
    found_json(true, Some(description), Some(created_at), size)
}

fn posts(s: &TestServer) -> usize {
    s.requests.lock().unwrap().iter().filter(|r| r.method == "POST").count()
}

/// A push that never reaches the remote (a dropped connection).
struct PushFails;

impl Steps for PushFails {
    fn push(
        &self,
        _: &Repository,
        _: &Url,
        _: &str,
        _: &str,
        _: &Zeroizing<String>,
        _: &GitBase,
        _: &mut dyn FnMut(Progress) -> bool,
    ) -> Result<PushResult, GitError> {
        Err(GitError::Git("the connection was reset".into()))
    }
}

/// The push lands, then the app stops before the journal says so.
struct CrashAfterPush;

impl Steps for CrashAfterPush {
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
        assert_eq!(git_push::push(repo, remote, branch, target, token, allowed, progress, &[]).unwrap(), PushResult::Ok);
        Err(GitError::Git("the app was closed".into()))
    }
}

/// Creates the repository and stops the upload at `committed` with `steps`.
fn committed_with(fx: &Fx, steps: &dyn Steps, c: UploadChoices) -> (Repository, Oid) {
    let remote = fx.remote("kim-lab", NAME);
    let s = serve(vec![created(NAME, true)]);
    assert!(try_upload(fx, &s, steps, &fx.create(true), c).is_err());
    let link = fx.link();
    assert_eq!(link.state, LinkState::Committed);
    (remote, Oid::from_str(link.pending_commit.as_deref().unwrap()).unwrap())
}

#[test]
fn a_lost_create_answer_is_adopted_with_one_post_in_total() {
    let fx = Fx::new("gh-retry-adopt");
    let before = snapshot(&fx.root);
    let remote = fx.remote("kim-lab", NAME);
    let s = serve(vec![Canned::drop_connection(), found(DESCRIPTION, &github_time(journal::now_ms()), 0)]);
    let err = try_upload(&fx, &s, &RealSteps, &fx.create(true), UploadChoices::default()).unwrap_err();
    assert_ne!(err.kind, NetErrorKind::BadInput, "{err:?}");
    let link = fx.link();
    assert_eq!(link.state, LinkState::RepoCreating);
    // "마저 하기": GET only, adopted, then the preview.
    let steps = TestSteps::default();
    let out = retry(&fx, &s, &steps).unwrap();
    assert_eq!(
        out,
        UploadOutcome::NeedsPreview {
            full_name: format!("kim-lab/{NAME}"),
            html_url: format!("https://github.com/kim-lab/{NAME}"),
        }
    );
    let reqs = s.requests.lock().unwrap().clone();
    assert_eq!(reqs.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(), ["POST", "GET"]);
    assert_eq!(reqs[1].path, format!("/repos/kim-lab/{NAME}"));
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 0);
    let adopted = fx.link();
    assert_eq!((adopted.state, adopted.repo_id, adopted.link_id.as_str()), (LinkState::RepoReady, 99, link.link_id.as_str()));
    // The preview's upload finishes it: no create.
    let s2 = serve(vec![got(NAME, true)]);
    let out = fx.upload(&s2, &fx.plan(PlanTarget::Update), UploadChoices::default());
    let UploadOutcome::Done { counts, .. } = out else { panic!("{out:?}") };
    assert_eq!(counts, Counts { new: 3, changed: 0, deleted: 0 });
    assert_eq!(posts(&s) + posts(&s2), 1, "exactly one POST in total");
    let pushed = fx.link().last_pushed_commit.unwrap();
    assert_eq!(main_tip(&remote).to_string(), pushed);
    assert_eq!(snapshot(&fx.root), before);
    fx.no_token();
}

#[test]
fn a_repo_that_is_not_the_lost_one_is_never_adopted_or_posted_again() {
    let now = github_time(journal::now_ms());
    let old = github_time(journal::now_ms() - 60 * 60 * 1000);
    let cases: Vec<(&str, Canned, bool)> = vec![
        ("description", found("another lab's · labnoteO", &now, 0), false),
        ("no description", found_json(true, None, Some(&now), 0), false),
        ("not empty", found(DESCRIPTION, &now, 12), false),
        ("has a branch", found(DESCRIPTION, &now, 0), true),
        ("older", found(DESCRIPTION, &old, 0), false),
        ("no time", found_json(true, Some(DESCRIPTION), None, 0), false),
    ];
    for (case, answer, branch) in cases {
        let fx = Fx::new("gh-retry-taken");
        let remote = fx.remote("kim-lab", NAME);
        if branch {
            advance_remote(&remote, &[("notes.txt", Some(b"x\n"))]);
        }
        let s = serve(vec![Canned::drop_connection(), answer]);
        assert!(try_upload(&fx, &s, &RealSteps, &fx.create(true), UploadChoices::default()).is_err(), "{case}");
        let steps = TestSteps::default();
        assert_eq!(retry(&fx, &s, &steps).unwrap(), UploadOutcome::NameTaken, "{case}");
        assert_eq!(posts(&s), 1, "{case}: no second POST");
        assert_eq!(quiet_count(&s), 2, "{case}");
        assert_eq!(steps.pushes.load(Ordering::SeqCst), 0, "{case}");
        // The record is gone: the folder goes back to the first-upload form.
        assert!(fx.links().links.is_empty(), "{case}");
        fx.no_token();
    }
    // No such repository: nothing was made, and the record is gone too.
    let fx = Fx::new("gh-retry-404");
    let s = serve(vec![Canned::drop_connection(), Canned::status(404)]);
    assert!(try_upload(&fx, &s, &RealSteps, &fx.create(true), UploadChoices::default()).is_err());
    assert_eq!(retry(&fx, &s, &RealSteps).unwrap(), UploadOutcome::NotFoundOrNoAccess);
    assert_eq!(posts(&s), 1);
    assert!(fx.links().links.is_empty());
}

#[test]
fn an_adopted_repo_that_came_out_public_is_not_pushed_to() {
    let fx = Fx::new("gh-retry-public");
    fx.remote("kim-lab", NAME);
    let s = serve(vec![
        Canned::drop_connection(),
        found_json(false, Some(DESCRIPTION), Some(&github_time(journal::now_ms())), 0),
    ]);
    assert!(try_upload(&fx, &s, &RealSteps, &fx.create(true), UploadChoices::default()).is_err());
    let out = retry(&fx, &s, &RealSteps).unwrap();
    assert_eq!(out, UploadOutcome::VisibilityMismatch { html_url: format!("https://github.com/kim-lab/{NAME}") });
    assert_eq!(fx.link().state, LinkState::RepoReady);
}

#[test]
fn a_failed_push_after_committed_pushes_the_same_commit_again() {
    let fx = Fx::new("gh-retry-push");
    let before = snapshot(&fx.root);
    let (remote, pending) = committed_with(&fx, &PushFails, choices(json!({"untick": ["data/plate.csv"]})));
    assert!(remote.refname_to_id("refs/heads/main").is_err(), "nothing reached GitHub");
    // The choices are kept with the commit.
    assert_eq!(fx.link().excluded, ["data/plate.csv"]);
    let s = serve(vec![got(NAME, true)]);
    let steps = TestSteps::default();
    let out = retry(&fx, &s, &steps).unwrap();
    assert_eq!(
        out,
        UploadOutcome::Done {
            html_url: format!("https://github.com/kim-lab/{NAME}"),
            full_name: format!("kim-lab/{NAME}"),
            counts: Counts { new: 2, changed: 0, deleted: 0 },
            warnings: vec![],
        }
    );
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 1);
    assert_eq!(main_tip(&remote), pending, "the same commit id");
    let link = fx.link();
    assert_eq!(link.state, LinkState::Pushed);
    assert_eq!(link.last_pushed_commit.as_deref(), Some(pending.to_string().as_str()));
    assert!(link.pending_commit.is_none() && link.last_pushed_at.is_some());
    assert_eq!(link.excluded, ["data/plate.csv"]);
    assert_eq!(fx.links().default_owner.as_deref(), Some("kim-lab"));
    let reqs = s.requests.lock().unwrap().clone();
    assert_eq!((reqs.len(), reqs[0].method.as_str()), (1, "GET"));
    // Finished: a second "마저 하기" sends nothing.
    let s = serve(vec![]);
    assert_eq!(retry(&fx, &s, &steps).unwrap(), UploadOutcome::NothingChanged);
    assert_eq!(quiet_count(&s), 0);
    assert_eq!(snapshot(&fx.root), before);
    fx.no_token();
}

#[test]
fn a_push_that_landed_before_its_journal_write_is_only_recorded() {
    let fx = Fx::new("gh-retry-landed");
    let (remote, pending) = committed_with(&fx, &CrashAfterPush, UploadChoices::default());
    assert_eq!(main_tip(&remote), pending);
    let s = serve(vec![got(NAME, true)]);
    let steps = TestSteps::default();
    let out = retry(&fx, &s, &steps).unwrap();
    let UploadOutcome::Done { counts, .. } = out else { panic!("{out:?}") };
    assert_eq!(counts, Counts { new: 3, changed: 0, deleted: 0 });
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 0, "ls-remote equal: no push");
    let link = fx.link();
    assert_eq!((link.state, link.last_pushed_commit.as_deref()), (LinkState::Pushed, Some(pending.to_string().as_str())));
    fx.no_token();
}

#[test]
fn a_remote_that_moved_since_the_commit_goes_through_a_new_preview() {
    let fx = Fx::new("gh-retry-moved");
    let (remote, _) = committed_with(&fx, &PushFails, UploadChoices::default());
    let theirs = advance_remote(&remote, &[("notes.txt", Some(b"x\n"))]);
    let s = serve(vec![got(NAME, true)]);
    let steps = TestSteps::default();
    let out = retry(&fx, &s, &steps).unwrap();
    assert!(matches!(out, UploadOutcome::NeedsPreview { .. }), "{out:?}");
    assert_eq!(steps.pushes.load(Ordering::SeqCst), 0);
    assert_eq!(main_tip(&remote), theirs);
    assert_eq!(fx.link().state, LinkState::Committed);
}

#[test]
fn a_retry_while_another_upload_holds_the_lock_is_busy() {
    let fx = Fx::new("gh-retry-busy");
    committed_with(&fx, &PushFails, UploadChoices::default());
    let link = fx.link();
    let s = serve(vec![got(NAME, true)]);
    {
        let _held = lock_link(&fx.gh.busy, &fx.dirs, &fx.root, &[LockKey::Link(link.link_id.clone())]).unwrap();
        assert_eq!(retry(&fx, &s, &RealSteps).unwrap(), UploadOutcome::Busy);
    }
    assert_eq!(quiet_count(&s), 0);
    assert_eq!(fx.link(), link);
    // A folder with no link is refused before anything is sent.
    let fx = Fx::new("gh-retry-none");
    let s = serve(vec![]);
    assert_eq!(retry(&fx, &s, &RealSteps).unwrap_err().kind, NetErrorKind::BadInput);
    assert_eq!(quiet_count(&s), 0);
}

#[test]
fn needs_preview_wire_shape() {
    assert_eq!(
        serde_json::to_value(UploadOutcome::NeedsPreview { full_name: "a/b".into(), html_url: "https://github.com/a/b".into() })
            .unwrap(),
        json!({"outcome": "needsPreview", "fullName": "a/b", "htmlUrl": "https://github.com/a/b"})
    );
}
