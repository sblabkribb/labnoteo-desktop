//! Where an upload goes (spec §4 "Destination", §5.3): the owner list, the
//! repository-name check and "link an existing repo by URL".
//!
//! - Every call is an allow-listed `GithubCall` through `call_authed`; the
//!   token never leaves Rust and nothing here writes anything.
//! - Names are checked before anything is sent: owner and repo segments are
//!   `^[A-Za-z0-9._-]{1,100}$`, not `.`/`..`, and a repo name never ends in
//!   `.git` (P-R5). A bad name or URL answers `invalidName` / `invalidUrl`
//!   with no request.
//! - Org pages follow `Link: rel="next"` by asking for the next page number
//!   of the same allow-listed call (never the server's URL), at most 10 pages.
//! - A renamed or transferred repo (one 301/307, followed by `call_with`) is
//!   answered with the final owner and name.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use super::api::{classify, valid_segment, ApiOutcome, ApiReply, GithubCall};
use super::auth::{call_authed, token, Account, GithubState};
use super::{endpoints, GithubEndpoints};
use crate::gitsync::state::{read_doc, GithubDoc};
use crate::net::config::{origin, Url};
use crate::net::secrets::{SecretStore, Secrets};
use crate::net::{IntegrationDirs, NetError, NetErrorKind, NetState};

/// The most org pages read (100 orgs a page).
pub const MAX_ORG_PAGES: u32 = 10;

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OwnerKind {
    User,
    Org,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    pub login: String,
    pub kind: OwnerKind,
}

/// `github_owners`: the user's own login first, then the orgs.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum OwnersOutcome {
    /// `orgsListed` is false when a fine-grained token listed no org (such a
    /// token cannot list them; the user types the org instead).
    #[serde(rename_all = "camelCase")]
    Ok { owners: Vec<Owner>, orgs_listed: bool },
    #[serde(untagged)]
    Api(ApiOutcome),
}

/// `github_name_check`.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum NameCheck {
    Free,
    #[serde(rename_all = "camelCase")]
    Taken { repo_id: u64, empty: bool, private: bool, can_push: bool },
    InvalidName,
    #[serde(untagged)]
    Api(ApiOutcome),
}

/// `github_resolve_repo`.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum ResolveOutcome {
    #[serde(rename_all = "camelCase")]
    Ok {
        owner: String,
        name: String,
        repo_id: u64,
        private: bool,
        empty: bool,
        can_push: bool,
        default_branch: String,
    },
    InvalidUrl,
    #[serde(untagged)]
    Api(ApiOutcome),
}

/// A repo name GitHub accepts: a valid segment that does not end in `.git`.
pub fn valid_repo_name(s: &str) -> bool {
    valid_segment(s) && !s.to_ascii_lowercase().ends_with(".git")
}

/// `owner/name` from two path segments (a trailing `.git` on the name is
/// dropped), when both are names GitHub accepts.
fn owner_name(owner: &str, name: &str) -> Option<(String, String)> {
    let name = if name.to_ascii_lowercase().ends_with(".git") { &name[..name.len() - 4] } else { name };
    (valid_segment(owner) && valid_repo_name(name)).then(|| (owner.to_string(), name.to_string()))
}

/// The first two non-empty segments of a URL path (more are allowed: a
/// pasted `…/tree/main/data` still names the repo).
fn leading_pair(path: &str) -> Option<(String, String)> {
    let mut segs = path.split('/').filter(|s| !s.is_empty());
    owner_name(segs.next()?, segs.next()?)
}

/// Exactly `owner/name`.
fn exact_pair(path: &str) -> Option<(String, String)> {
    let (owner, name) = path.split_once('/')?;
    if name.contains('/') {
        return None;
    }
    owner_name(owner, name)
}

/// `owner/name` of a pasted repo reference, or `None` (spec §5.3):
/// `https://github.com/o/r(.git)` (also `www.`, a trailing path, query or
/// fragment, or no scheme), `git@github.com:o/r(.git)`, or `o/r`. Any other
/// host, scheme, port or userinfo is refused. In a test build the test web
/// base stands in for `https://github.com/`.
pub fn parse_repo_ref(input: &str, ep: &GithubEndpoints) -> Option<(String, String)> {
    let s = input.trim();
    if s.is_empty() || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    if let Some(rest) = s.strip_prefix("git@github.com:") {
        return exact_pair(rest);
    }
    if s.contains("://") {
        let url = Url::parse(s).ok()?;
        if !url.username().is_empty() || url.password().is_some() {
            return None;
        }
        let github = url.scheme() == "https"
            && url.port().is_none()
            && matches!(url.host_str(), Some("github.com" | "www.github.com"));
        if github {
            return leading_pair(url.path());
        }
        let base = ep.web.path();
        if origin(&url) == origin(&ep.web) && url.path().starts_with(base) {
            return leading_pair(&url.path()[base.len()..]);
        }
        return None;
    }
    if let Some(rest) = s.strip_prefix("github.com/").or_else(|| s.strip_prefix("www.github.com/")) {
        let path = rest.split(['?', '#']).next().unwrap_or("");
        return leading_pair(path);
    }
    exact_pair(s)
}

/// An answer that is not the shape GitHub documents.
fn unexpected_shape() -> NetError {
    NetError::new(NetErrorKind::NotJson, "GitHub's answer is not what was expected")
}

/// `Ok(None)` for a 2xx (also after one followed redirect); `Ok(Some(_))` for
/// an answer the UI explains; anything else is a generic `NetError`.
fn outcome_of(call: &GithubCall, reply: &ApiReply) -> Result<Option<ApiOutcome>, NetError> {
    match classify(call, reply) {
        ApiOutcome::Ok | ApiOutcome::Moved { .. } => Ok(None),
        ApiOutcome::Other { status } => {
            let body = if reply.json.is_null() { String::new() } else { reply.json.to_string() };
            Err(NetError::status(status, &body, None))
        }
        other => Ok(Some(other)),
    }
}

/// `true` when a `Link` header has a `rel="next"` entry. Only the fact is
/// used; the URL in it is never requested.
fn has_next(reply: &ApiReply) -> bool {
    reply.headers.get("link").is_some_and(|link| {
        link.split(',').any(|entry| {
            entry.split(';').skip(1).any(|p| {
                let p = p.trim();
                p.eq_ignore_ascii_case("rel=\"next\"") || p.eq_ignore_ascii_case("rel=next")
            })
        })
    })
}

/// What a `GET repos/{o}/{r}` answer says about the repo.
struct RepoFacts {
    owner: String,
    name: String,
    id: u64,
    private: bool,
    empty: bool,
    can_push: bool,
    default_branch: String,
}

/// `None` unless the answer has an id, a visibility and a valid owner and
/// name: "private" is never guessed.
fn repo_facts(j: &Value) -> Option<RepoFacts> {
    let owner = j["owner"]["login"].as_str().filter(|s| valid_segment(s))?;
    let name = j["name"].as_str().filter(|s| valid_segment(s))?;
    let branch = j["default_branch"]
        .as_str()
        .filter(|b| !b.is_empty() && b.len() <= 255 && !b.chars().any(char::is_control))
        .unwrap_or("main");
    Some(RepoFacts {
        owner: owner.to_string(),
        name: name.to_string(),
        id: j["id"].as_u64()?,
        private: j["private"].as_bool()?,
        empty: j["size"].as_u64() == Some(0),
        can_push: j["permissions"]["push"].as_bool().unwrap_or(false),
        default_branch: branch.to_string(),
    })
}

/// The owner list: the signed-in login (from the account record, else
/// `GET user`) and every org from `GET user/orgs`, at most `MAX_ORG_PAGES`
/// pages. No token: `needsSignIn` with nothing sent.
pub async fn owners_at(
    ep: &GithubEndpoints,
    dirs: &Path,
    store: &dyn SecretStore,
    net: &NetState,
    gh: &GithubState,
    request_id: Option<&str>,
) -> Result<OwnersOutcome, NetError> {
    let fine_grained = match token(gh, store)? {
        Some(t) => t.starts_with("github_pat_"),
        None => return Ok(OwnersOutcome::Api(ApiOutcome::NeedsSignIn)),
    };
    let recorded = read_doc::<Option<Account>>(dirs, None, GithubDoc::Account)?.map(|a| a.login);
    let me = match recorded.filter(|l| valid_segment(l)) {
        Some(login) => login,
        None => {
            let reply = call_authed(ep, dirs, store, net, gh, request_id, GithubCall::User, None).await?;
            if let Some(o) = outcome_of(&GithubCall::User, &reply)? {
                return Ok(OwnersOutcome::Api(o));
            }
            reply.json["login"].as_str().filter(|l| valid_segment(l)).ok_or_else(unexpected_shape)?.to_string()
        }
    };
    let mut owners = vec![Owner { login: me, kind: OwnerKind::User }];
    for page in 1..=MAX_ORG_PAGES {
        let call = GithubCall::UserOrgs { page };
        let reply = call_authed(ep, dirs, store, net, gh, request_id, call.clone(), None).await?;
        if let Some(o) = outcome_of(&call, &reply)? {
            return Ok(OwnersOutcome::Api(o));
        }
        let list = reply.json.as_array().ok_or_else(unexpected_shape)?;
        for login in list.iter().filter_map(|o| o["login"].as_str()).filter(|l| valid_segment(l)) {
            if !owners.iter().any(|known| known.login.eq_ignore_ascii_case(login)) {
                owners.push(Owner { login: login.to_string(), kind: OwnerKind::Org });
            }
        }
        if list.is_empty() || !has_next(&reply) {
            break;
        }
    }
    let orgs_listed = !(fine_grained && owners.len() == 1);
    Ok(OwnersOutcome::Ok { owners, orgs_listed })
}

/// Is `owner/name` free? A 404 is free; a repo (also one reached through a
/// redirect) is taken. A bad name is `invalidName` with nothing sent.
pub async fn name_check_at(
    ep: &GithubEndpoints,
    dirs: &Path,
    store: &dyn SecretStore,
    net: &NetState,
    gh: &GithubState,
    owner: &str,
    name: &str,
) -> Result<NameCheck, NetError> {
    if !valid_segment(owner) || !valid_repo_name(name) {
        return Ok(NameCheck::InvalidName);
    }
    let call = GithubCall::GetRepo { owner: owner.to_string(), name: name.to_string() };
    let reply = call_authed(ep, dirs, store, net, gh, None, call.clone(), None).await?;
    match outcome_of(&call, &reply)? {
        Some(ApiOutcome::NotFoundOrNoAccess) => return Ok(NameCheck::Free),
        Some(o) => return Ok(NameCheck::Api(o)),
        None => {}
    }
    let f = repo_facts(&reply.json).ok_or_else(unexpected_shape)?;
    Ok(NameCheck::Taken { repo_id: f.id, empty: f.empty, private: f.private, can_push: f.can_push })
}

/// "Link an existing repo": parses the reference (`invalidUrl` with nothing
/// sent when it is not GitHub), then `GET repos/{o}/{r}`, following one
/// redirect, and answers the final repo's facts.
pub async fn resolve_repo_at(
    ep: &GithubEndpoints,
    dirs: &Path,
    store: &dyn SecretStore,
    net: &NetState,
    gh: &GithubState,
    url: &str,
) -> Result<ResolveOutcome, NetError> {
    let Some((owner, name)) = parse_repo_ref(url, ep) else {
        return Ok(ResolveOutcome::InvalidUrl);
    };
    let call = GithubCall::GetRepo { owner, name };
    let reply = call_authed(ep, dirs, store, net, gh, None, call.clone(), None).await?;
    if let Some(o) = outcome_of(&call, &reply)? {
        return Ok(ResolveOutcome::Api(o));
    }
    let f = repo_facts(&reply.json).ok_or_else(unexpected_shape)?;
    Ok(ResolveOutcome::Ok {
        owner: f.owner,
        name: f.name,
        repo_id: f.id,
        private: f.private,
        empty: f.empty,
        can_push: f.can_push,
        default_branch: f.default_branch,
    })
}

/// The owners the user can upload to (cancel with `net_cancel`).
#[tauri::command]
pub async fn github_owners(
    dirs: State<'_, IntegrationDirs>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    github: State<'_, GithubState>,
    request_id: String,
) -> Result<OwnersOutcome, NetError> {
    owners_at(&endpoints(), &dirs.0, secrets.0.as_ref(), &net, &github, Some(&request_id)).await
}

/// Whether `owner/name` is free (a bad name answers with nothing sent).
#[tauri::command]
pub async fn github_name_check(
    dirs: State<'_, IntegrationDirs>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    github: State<'_, GithubState>,
    owner: String,
    name: String,
) -> Result<NameCheck, NetError> {
    name_check_at(&endpoints(), &dirs.0, secrets.0.as_ref(), &net, &github, &owner, &name).await
}

/// Resolves a pasted repo reference (a non-GitHub URL answers with nothing sent).
#[tauri::command]
pub async fn github_resolve_repo(
    dirs: State<'_, IntegrationDirs>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    github: State<'_, GithubState>,
    url: String,
) -> Result<ResolveOutcome, NetError> {
    resolve_repo_at(&endpoints(), &dirs.0, secrets.0.as_ref(), &net, &github, &url).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitsync::state::write_doc;
    use crate::net::config::tests::scratch_dir;
    use crate::net::config::ServiceConfig;
    use crate::net::secrets::{store_secret, MemoryStore, Slot};
    use crate::net::testserver::{serve, Canned, TestServer};
    use serde_json::json;
    use tauri::async_runtime::block_on;

    /// Made-up tokens of GitHub's shapes; never real ones.
    const GHP: &str = "ghp_FAKEclassic0000000000000000000000000";
    const PAT: &str = "github_pat_FAKE000000000000000000000000000000";

    fn ep(s: &TestServer) -> GithubEndpoints {
        let base = Url::parse(&format!("{}/", s.url)).unwrap();
        GithubEndpoints { api: base.clone(), web: base.clone(), git: base }
    }

    struct Fx {
        dir: std::path::PathBuf,
        store: MemoryStore,
        net: NetState,
        gh: GithubState,
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A scratch app-data dir; `tok` stored in the keychain stand-in and,
    /// with `account`, the signed-in account record.
    fn fx(tag: &str, tok: Option<&str>, account: bool) -> Fx {
        let dir = scratch_dir(tag);
        let store = MemoryStore::default();
        if let Some(t) = tok {
            store_secret(&store, Slot::Github, &ServiceConfig::from_settings_json("{}"), t).unwrap();
        }
        if account {
            let a = Account { login: "kim-lab".into(), id: 4242, avatar_url: String::new() };
            write_doc(&dir, None, GithubDoc::Account, &Some(a)).unwrap();
        }
        Fx { dir, store, net: NetState::default(), gh: GithubState::default() }
    }

    fn owners(f: &Fx, s: &TestServer) -> OwnersOutcome {
        block_on(owners_at(&ep(s), &f.dir, &f.store, &f.net, &f.gh, Some("o1"))).unwrap()
    }

    fn check(f: &Fx, s: &TestServer, owner: &str, name: &str) -> Result<NameCheck, NetError> {
        block_on(name_check_at(&ep(s), &f.dir, &f.store, &f.net, &f.gh, owner, name))
    }

    fn resolve(f: &Fx, s: &TestServer, url: &str) -> ResolveOutcome {
        block_on(resolve_repo_at(&ep(s), &f.dir, &f.store, &f.net, &f.gh, url)).unwrap()
    }

    fn orgs(names: &[&str]) -> String {
        let list: Vec<Value> = names.iter().map(|n| json!({"login": n, "id": 1})).collect();
        Value::Array(list).to_string()
    }

    fn repo(id: u64, owner: &str, name: &str, private: bool, size: u64, push: bool) -> Canned {
        Canned::ok(
            &json!({
                "id": id, "name": name, "full_name": format!("{owner}/{name}"),
                "owner": {"login": owner}, "private": private, "size": size,
                "default_branch": "main", "permissions": {"admin": false, "push": push, "pull": true}
            })
            .to_string(),
        )
    }

    fn user(o: &str) -> Owner {
        Owner { login: o.into(), kind: OwnerKind::User }
    }

    fn org(o: &str) -> Owner {
        Owner { login: o.into(), kind: OwnerKind::Org }
    }

    fn quiet_count(s: &TestServer) -> usize {
        std::thread::sleep(std::time::Duration::from_millis(50));
        s.request_count()
    }

    fn to_json<T: Serialize>(v: &T) -> String {
        serde_json::to_string(v).unwrap()
    }

    #[test]
    fn owners_follow_link_next_over_three_pages() {
        let f = fx("gh-repos-pages", Some(GHP), true);
        // The server's own `next` URL is never used: only the page number moves on.
        let s = serve(vec![
            Canned::ok(&orgs(&["lab-a", "lab-b"])).header("Link", "<https://evil.example/x?page=2>; rel=\"next\""),
            Canned::ok(&orgs(&["lab-c", "lab-a"])).header("Link", "<https://evil.example/x?page=3>; rel=\"next\""),
            Canned::ok(&orgs(&["lab-d", "bad/name"])).header("Link", "<https://evil.example/x?page=1>; rel=\"first\""),
        ]);
        let out = owners(&f, &s);
        assert_eq!(
            out,
            OwnersOutcome::Ok {
                owners: vec![user("kim-lab"), org("lab-a"), org("lab-b"), org("lab-c"), org("lab-d")],
                orgs_listed: true
            }
        );
        let reqs = s.requests.lock().unwrap();
        let paths: Vec<&str> = reqs.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(
            paths,
            ["/user/orgs?per_page=100&page=1", "/user/orgs?per_page=100&page=2", "/user/orgs?per_page=100&page=3"]
        );
        let bearer = format!("Bearer {GHP}");
        assert!(reqs.iter().all(|r| r.header("authorization") == Some(bearer.as_str())));
    }

    #[test]
    fn owners_stop_after_ten_pages() {
        let f = fx("gh-repos-ten", Some(GHP), true);
        let answers: Vec<Canned> = (0..12)
            .map(|i| Canned::ok(&orgs(&[&format!("lab-{i}")])).header("Link", "<x>; rel=\"next\""))
            .collect();
        let s = serve(answers);
        let OwnersOutcome::Ok { owners: list, .. } = owners(&f, &s) else { panic!("not ok") };
        assert_eq!(list.len(), 1 + MAX_ORG_PAGES as usize);
        assert_eq!(s.request_count(), MAX_ORG_PAGES as usize);
    }

    #[test]
    fn an_empty_org_list_is_not_listed_only_for_a_fine_grained_token() {
        let f = fx("gh-repos-fine", Some(PAT), true);
        let s = serve(vec![Canned::ok("[]")]);
        assert_eq!(owners(&f, &s), OwnersOutcome::Ok { owners: vec![user("kim-lab")], orgs_listed: false });
        let f = fx("gh-repos-classic", Some(GHP), true);
        let s = serve(vec![Canned::ok("[]")]);
        assert_eq!(owners(&f, &s), OwnersOutcome::Ok { owners: vec![user("kim-lab")], orgs_listed: true });
        let f = fx("gh-repos-fine2", Some(PAT), true);
        let s = serve(vec![Canned::ok(&orgs(&["lab"]))]);
        assert_eq!(
            owners(&f, &s),
            OwnersOutcome::Ok { owners: vec![user("kim-lab"), org("lab")], orgs_listed: true }
        );
    }

    #[test]
    fn owners_without_an_account_record_ask_for_the_user_first() {
        let f = fx("gh-repos-noacct", Some(GHP), false);
        let s = serve(vec![
            Canned::ok("{\"login\":\"park\",\"id\":7,\"avatar_url\":\"\"}"),
            Canned::ok(&orgs(&["lab"])),
        ]);
        assert_eq!(owners(&f, &s), OwnersOutcome::Ok { owners: vec![user("park"), org("lab")], orgs_listed: true });
        assert_eq!(s.requests.lock().unwrap()[0].path, "/user");
    }

    #[test]
    fn owner_errors_are_outcomes() {
        // No token: needsSignIn and nothing sent.
        let f = fx("gh-repos-none", None, true);
        let s = serve(vec![Canned::ok("[]")]);
        assert_eq!(owners(&f, &s), OwnersOutcome::Api(ApiOutcome::NeedsSignIn));
        assert_eq!(quiet_count(&s), 0);
        let f = fx("gh-repos-401", Some(GHP), true);
        let s = serve(vec![Canned::status(401)]);
        assert_eq!(owners(&f, &s), OwnersOutcome::Api(ApiOutcome::NeedsSignIn));
        let s = serve(vec![Canned::status(429).header("Retry-After", "30")]);
        assert_eq!(owners(&f, &s), OwnersOutcome::Api(ApiOutcome::RateLimited { seconds: 30 }));
        let s = serve(vec![Canned::status(500).body("boom")]);
        let e = block_on(owners_at(&ep(&s), &f.dir, &f.store, &f.net, &f.gh, None)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::Status);
        // A page that is not a list is an error, not an empty org list.
        let s = serve(vec![Canned::ok("{\"message\":\"?\"}")]);
        assert!(block_on(owners_at(&ep(&s), &f.dir, &f.store, &f.net, &f.gh, None)).is_err());
    }

    #[test]
    fn name_check_free_and_taken() {
        let f = fx("gh-repos-name", Some(GHP), true);
        let s = serve(vec![Canned::status(404)]);
        assert_eq!(check(&f, &s, "kim-lab", "001_danbaekjil_balhyeon").unwrap(), NameCheck::Free);
        assert_eq!(s.requests.lock().unwrap()[0].path, "/repos/kim-lab/001_danbaekjil_balhyeon");
        let s = serve(vec![repo(42, "kim-lab", "exp", true, 0, false)]);
        assert_eq!(
            check(&f, &s, "kim-lab", "exp").unwrap(),
            NameCheck::Taken { repo_id: 42, empty: true, private: true, can_push: false }
        );
        let s = serve(vec![repo(43, "lab", "exp", false, 120, true)]);
        assert_eq!(
            check(&f, &s, "lab", "exp").unwrap(),
            NameCheck::Taken { repo_id: 43, empty: false, private: false, can_push: true }
        );
        // A moved repo still means the name leads somewhere: taken.
        let s = serve(vec![
            Canned::status(301).header("Location", "/repositories/44"),
            repo(44, "lab", "exp-2", true, 3, true),
        ]);
        assert_eq!(
            check(&f, &s, "lab", "exp").unwrap(),
            NameCheck::Taken { repo_id: 44, empty: false, private: true, can_push: true }
        );
        let s = serve(vec![Canned::status(403).header("X-GitHub-SSO", "required; url=https://github.com/orgs/lab/sso?x=1")]);
        assert!(matches!(check(&f, &s, "lab", "exp").unwrap(), NameCheck::Api(ApiOutcome::SsoRequired { .. })));
        let s = serve(vec![Canned::status(500)]);
        assert_eq!(check(&f, &s, "lab", "exp").unwrap_err().kind, NetErrorKind::Status);
        // A 200 that is not a repo is an error, never "taken" with made-up facts.
        let s = serve(vec![Canned::ok("{\"message\":\"?\"}")]);
        assert!(check(&f, &s, "lab", "exp").is_err());
    }

    #[test]
    fn a_bad_name_is_invalid_with_nothing_sent() {
        let f = fx("gh-repos-badname", Some(GHP), true);
        let s = serve(vec![Canned::status(404)]);
        let long = "a".repeat(101);
        for (owner, name) in [
            ("kim-lab", ".."),
            ("kim-lab", "."),
            ("kim-lab", ""),
            ("kim-lab", "x.git"),
            ("kim-lab", "X.GIT"),
            ("kim-lab", "a/b"),
            ("kim-lab", "단백질"),
            ("kim-lab", long.as_str()),
            ("../x", "exp"),
            ("", "exp"),
        ] {
            assert_eq!(check(&f, &s, owner, name).unwrap(), NameCheck::InvalidName, "{owner}/{name}");
        }
        assert_eq!(quiet_count(&s), 0);
    }

    #[test]
    fn repo_references_parse() {
        let s = serve(vec![]);
        let e = ep(&s);
        let some = |o: &str, n: &str| Some((o.to_string(), n.to_string()));
        assert_eq!(parse_repo_ref("https://github.com/lab/exp", &e), some("lab", "exp"));
        assert_eq!(parse_repo_ref("https://github.com/lab/exp.git", &e), some("lab", "exp"));
        assert_eq!(parse_repo_ref("  https://github.com/lab/exp/  ", &e), some("lab", "exp"));
        assert_eq!(parse_repo_ref("https://www.github.com/lab/exp", &e), some("lab", "exp"));
        assert_eq!(parse_repo_ref("https://github.com/lab/exp/tree/main/data", &e), some("lab", "exp"));
        assert_eq!(parse_repo_ref("https://github.com/lab/exp?tab=readme#x", &e), some("lab", "exp"));
        assert_eq!(parse_repo_ref("github.com/lab/exp", &e), some("lab", "exp"));
        assert_eq!(parse_repo_ref("git@github.com:lab/exp.git", &e), some("lab", "exp"));
        assert_eq!(parse_repo_ref("git@github.com:lab/exp", &e), some("lab", "exp"));
        assert_eq!(parse_repo_ref("lab/exp", &e), some("lab", "exp"));
        assert_eq!(parse_repo_ref("lab/exp.git", &e), some("lab", "exp"));
        // The test base stands in for github.com in a test build.
        assert_eq!(parse_repo_ref(&format!("{}/lab/exp", s.url), &e), some("lab", "exp"));
        for bad in [
            "https://gitlab.com/lab/exp",
            "https://github.com.evil.example/lab/exp",
            "https://evil.example/github.com/lab/exp",
            "http://github.com/lab/exp",
            "https://user:pw@github.com/lab/exp",
            "https://github.com:8443/lab/exp",
            "git@gitlab.com:lab/exp.git",
            "ssh://git@github.com/lab/exp.git",
            "https://github.com/lab",
            "https://github.com/",
            "lab",
            "lab/exp/more",
            "../exp",
            "lab/..",
            "lab/.git",
            "lab/exp name",
            "",
            "file:///C:/lab/exp",
        ] {
            assert_eq!(parse_repo_ref(bad, &e), None, "{bad}");
        }
    }

    #[test]
    fn resolve_follows_one_redirect_and_answers_the_final_repo() {
        let f = fx("gh-repos-resolve", Some(GHP), true);
        let s = serve(vec![
            Canned::status(301).header("Location", "/repositories/42"),
            repo(42, "new-lab", "exp-2", true, 0, true),
        ]);
        assert_eq!(
            resolve(&f, &s, "https://github.com/old-lab/exp.git"),
            ResolveOutcome::Ok {
                owner: "new-lab".into(),
                name: "exp-2".into(),
                repo_id: 42,
                private: true,
                empty: true,
                can_push: true,
                default_branch: "main".into()
            }
        );
        assert_eq!(s.request_count(), 2);
        assert_eq!(s.requests.lock().unwrap()[0].path, "/repos/old-lab/exp");
        let s = serve(vec![Canned::status(404)]);
        assert_eq!(resolve(&f, &s, "lab/exp"), ResolveOutcome::Api(ApiOutcome::NotFoundOrNoAccess));
        let s = serve(vec![repo(9, "lab", "exp", false, 5, false)]);
        let ResolveOutcome::Ok { can_push, private, .. } = resolve(&f, &s, "git@github.com:lab/exp.git") else {
            panic!("not ok")
        };
        assert!(!can_push && !private);
    }

    #[test]
    fn a_foreign_url_is_invalid_with_nothing_sent() {
        let f = fx("gh-repos-gitlab", Some(GHP), true);
        let s = serve(vec![repo(1, "o", "r", true, 0, true)]);
        assert_eq!(resolve(&f, &s, "https://gitlab.com/o/r"), ResolveOutcome::InvalidUrl);
        assert_eq!(resolve(&f, &s, "o/.."), ResolveOutcome::InvalidUrl);
        assert_eq!(quiet_count(&s), 0);
    }

    #[test]
    fn outcomes_serialize_tagged_camel_case() {
        assert_eq!(
            to_json(&OwnersOutcome::Ok { owners: vec![user("me"), org("lab")], orgs_listed: false }),
            r#"{"outcome":"ok","owners":[{"login":"me","kind":"user"},{"login":"lab","kind":"org"}],"orgsListed":false}"#
        );
        assert_eq!(to_json(&OwnersOutcome::Api(ApiOutcome::NeedsSignIn)), r#"{"outcome":"needsSignIn"}"#);
        assert_eq!(
            to_json(&OwnersOutcome::Api(ApiOutcome::OrgRestricted { org: "lab".into() })),
            r#"{"outcome":"orgRestricted","org":"lab"}"#
        );
        assert_eq!(to_json(&NameCheck::Free), r#"{"outcome":"free"}"#);
        assert_eq!(to_json(&NameCheck::InvalidName), r#"{"outcome":"invalidName"}"#);
        assert_eq!(
            to_json(&NameCheck::Taken { repo_id: 1, empty: true, private: true, can_push: false }),
            r#"{"outcome":"taken","repoId":1,"empty":true,"private":true,"canPush":false}"#
        );
        assert_eq!(
            to_json(&NameCheck::Api(ApiOutcome::RateLimited { seconds: 3 })),
            r#"{"outcome":"rateLimited","seconds":3}"#
        );
        assert_eq!(to_json(&ResolveOutcome::InvalidUrl), r#"{"outcome":"invalidUrl"}"#);
        let ok = to_json(&ResolveOutcome::Ok {
            owner: "o".into(),
            name: "r".into(),
            repo_id: 2,
            private: true,
            empty: false,
            can_push: true,
            default_branch: "main".into(),
        });
        assert_eq!(
            ok,
            r#"{"outcome":"ok","owner":"o","name":"r","repoId":2,"private":true,"empty":false,"canPush":true,"defaultBranch":"main"}"#
        );
    }

    #[test]
    fn no_answer_holds_the_token() {
        let f = fx("gh-repos-redact", Some(GHP), true);
        // A server that echoes the token back in a repo field.
        let s = serve(vec![Canned::ok(
            &json!({"id": 5, "name": "exp", "owner": {"login": "lab"}, "private": true, "size": 0,
                    "default_branch": GHP, "permissions": {"push": true}})
            .to_string(),
        )]);
        let out = to_json(&resolve(&f, &s, "lab/exp"));
        assert!(!out.contains(GHP), "{out}");
    }
}
