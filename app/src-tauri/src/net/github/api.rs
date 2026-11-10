//! The allow-listed GitHub REST client (spec §7.2), shaped like `slack.rs`.
//!
//! - `GithubCall` is the whole list of what the app may ask GitHub. There is
//!   no delete call and no visibility-change call. Every owner, repo or org
//!   name in a path is checked against `^[A-Za-z0-9._-]{1,100}$` (and is not
//!   `.` or `..`) before anything is sent.
//! - Requests go through `http::send_answer`, so every status comes back with
//!   the kept headers and `classify` can map 401/403/404/422/429/451/3xx.
//! - The token is only ever sent to the API base (`Authorization: Bearer`),
//!   never to the web base (device flow), and is redacted from every answer.
//! - One 301/307 is followed, only for a `GET` and only when `Location` has
//!   the API base's origin. Anything else is `Other{status}`; a POST is never
//!   sent twice.

use std::time::Duration;

use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
use zeroize::Zeroizing;

use super::GithubEndpoints;
use crate::net::config::{origin, Url};
use crate::net::error::{redact_text, NetError, NetErrorKind};
use crate::net::http::{send_answer, IncomingRaw, Outgoing, MAX_BODY};
use crate::net::NetState;

/// How long one GitHub call may take.
pub const GITHUB_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// `X-GitHub-Api-Version` on every API call.
pub const GITHUB_API_VERSION: &str = "2022-11-28";

/// Which base a call is built on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Base {
    /// `github.com` (the device flow): `Accept: application/json`, never a token.
    Web,
    /// `api.github.com`: the GitHub media type, the API version and the token.
    Api,
}

/// Everything the app may ask GitHub (spec §7.2). No delete, no visibility change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GithubCall {
    /// `POST login/device/code`
    DeviceCode,
    /// `POST login/oauth/access_token`
    AccessToken,
    /// `GET user`
    User,
    /// `GET user/orgs?per_page=100&page=<page>` (pages start at 1)
    UserOrgs { page: u32 },
    /// `GET repos/<owner>/<name>`
    GetRepo { owner: String, name: String },
    /// `POST user/repos`
    CreateUserRepo,
    /// `POST orgs/<org>/repos`
    CreateOrgRepo { org: String },
}

/// `^[A-Za-z0-9._-]{1,100}$`, and not `.` or `..`.
pub fn valid_segment(s: &str) -> bool {
    (1..=100).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && s != "."
        && s != ".."
}

impl GithubCall {
    /// The path (and query) relative to the call's base.
    pub fn path(&self) -> String {
        match self {
            GithubCall::DeviceCode => "login/device/code".to_string(),
            GithubCall::AccessToken => "login/oauth/access_token".to_string(),
            GithubCall::User => "user".to_string(),
            GithubCall::UserOrgs { page } => format!("user/orgs?per_page=100&page={page}"),
            GithubCall::GetRepo { owner, name } => format!("repos/{owner}/{name}"),
            GithubCall::CreateUserRepo => "user/repos".to_string(),
            GithubCall::CreateOrgRepo { org } => format!("orgs/{org}/repos"),
        }
    }

    pub fn method(&self) -> Method {
        match self {
            GithubCall::DeviceCode
            | GithubCall::AccessToken
            | GithubCall::CreateUserRepo
            | GithubCall::CreateOrgRepo { .. } => Method::POST,
            GithubCall::User | GithubCall::UserOrgs { .. } | GithubCall::GetRepo { .. } => Method::GET,
        }
    }

    pub fn base(&self) -> Base {
        match self {
            GithubCall::DeviceCode | GithubCall::AccessToken => Base::Web,
            _ => Base::Api,
        }
    }

    /// `badInput` when a name in the path is not a plain GitHub name (or the
    /// page is 0). The name itself is never echoed.
    pub fn validate(&self) -> Result<(), NetError> {
        let ok = match self {
            GithubCall::UserOrgs { page } => *page >= 1,
            GithubCall::GetRepo { owner, name } => valid_segment(owner) && valid_segment(name),
            GithubCall::CreateOrgRepo { org } => valid_segment(org),
            _ => true,
        };
        if ok {
            Ok(())
        } else {
            Err(NetError::new(NetErrorKind::BadInput, "not a valid GitHub name"))
        }
    }

    /// The org the call is about, for the org-restriction mapping.
    fn org(&self) -> Option<&str> {
        match self {
            GithubCall::CreateOrgRepo { org } => Some(org),
            GithubCall::GetRepo { owner, .. } => Some(owner),
            _ => None,
        }
    }
}

/// The kept response headers (names lower-case; see `http::KEPT_HEADERS`,
/// plus `location` on a 3xx). Never `authorization` or a cookie.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeptHeaders(pub Vec<(String, String)>);

impl KeptHeaders {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// One GitHub answer, any status. `json` has the token redacted (`null` for
/// an empty body, or for a non-2xx body that is not JSON). `moved_to` is the
/// followed `Location` when a 301/307 was followed.
pub struct ApiReply {
    pub status: u16,
    pub json: Value,
    pub headers: KeptHeaders,
    pub moved_to: Option<String>,
}

/// Never prints the body: an access-token answer holds the new token.
impl std::fmt::Debug for ApiReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiReply")
            .field("status", &self.status)
            .field("json", &"...")
            .field("headers", &self.headers)
            .field("moved_to", &self.moved_to)
            .finish()
    }
}

/// What an answer means (spec §7.2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum ApiOutcome {
    Ok,
    NeedsSignIn,
    OrgRestricted { org: String },
    SsoRequired { url: String },
    CannotCreateInOrg { org: String },
    RateLimited { seconds: u64 },
    NameTaken,
    NotFoundOrNoAccess,
    /// A 2xx reached through one followed redirect (a renamed or transferred
    /// repo): the caller updates the link from the answer's JSON.
    Moved { location: String },
    LegalBlock { message: String },
    Other { status: u16 },
}

fn invalid_url() -> NetError {
    NetError::new(NetErrorKind::InvalidUrl, "the address is not valid")
}

/// The first URL of `call` on `ep`.
fn url_of(ep: &GithubEndpoints, call: &GithubCall) -> Result<Url, NetError> {
    call.validate()?;
    let base = match call.base() {
        Base::Web => &ep.web,
        Base::Api => &ep.api,
    };
    base.join(&call.path()).map_err(|_| invalid_url())
}

/// The request for `call` at `url`. The token goes only on an API call, and
/// a body only on a POST (`badInput` otherwise).
pub(crate) fn build(
    call: &GithubCall,
    url: Url,
    token: Option<&Zeroizing<String>>,
    body: Option<Value>,
) -> Result<Outgoing, NetError> {
    let method = call.method();
    if method == Method::GET && body.is_some() {
        return Err(NetError::new(NetErrorKind::BadInput, "a GitHub read has no body"));
    }
    let (headers, secret) = match call.base() {
        Base::Web => (vec![("Accept", "application/json".to_string())], None),
        Base::Api => {
            let mut headers = vec![
                ("Accept", "application/vnd.github+json".to_string()),
                ("X-GitHub-Api-Version", GITHUB_API_VERSION.to_string()),
            ];
            let secret = token.map(|t| t.as_str().to_string());
            if let Some(t) = &secret {
                headers.push(("Authorization", format!("Bearer {t}")));
            }
            (headers, secret)
        }
    };
    Ok(Outgoing {
        method,
        url,
        headers,
        json: body,
        timeout: Some(GITHUB_CALL_TIMEOUT),
        max_body: MAX_BODY,
        secret,
        allow_http: false,
    })
}

/// The target of a 3xx when the rules allow one follow: a 301/307 answer to
/// a `GET` API call whose `Location` (resolved against `url`) has exactly the
/// API base's origin.
fn follow_target(ep: &GithubEndpoints, call: &GithubCall, url: &Url, raw: &IncomingRaw) -> Option<Url> {
    if call.method() != Method::GET || call.base() != Base::Api || !matches!(raw.status, 301 | 307) {
        return None;
    }
    let loc = raw.headers.iter().find(|(k, _)| k == "location").map(|(_, v)| v.as_str())?;
    let target = url.join(loc).ok()?;
    (matches!(target.scheme(), "http" | "https") && origin(&target) == origin(&ep.api)).then_some(target)
}

/// The reply of a raw answer: the token redacted from the body and the kept
/// headers. A 2xx body that is not JSON is `notJson`.
fn reply_of(raw: IncomingRaw, secret: Option<&str>, moved_to: Option<String>) -> Result<ApiReply, NetError> {
    let text = redact_text(&String::from_utf8_lossy(&raw.bytes), secret);
    let json = if text.trim().is_empty() {
        Value::Null
    } else {
        match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) if !(200..300).contains(&raw.status) => Value::Null,
            Err(_) => return Err(NetError::new(NetErrorKind::NotJson, "GitHub's answer is not JSON")),
        }
    };
    let headers = raw.headers.into_iter().map(|(k, v)| (k, redact_text(&v, secret))).collect();
    Ok(ApiReply { status: raw.status, json, headers: KeptHeaders(headers), moved_to })
}

/// One allow-listed call. `token` is sent only on API calls; `body` only on a
/// POST. A bad name is `badInput` before anything is sent.
pub async fn call_with(
    ep: &GithubEndpoints,
    net: &NetState,
    request_id: Option<&str>,
    token: Option<&Zeroizing<String>>,
    call: GithubCall,
    body: Option<Value>,
) -> Result<ApiReply, NetError> {
    let url = url_of(ep, &call)?;
    let out = build(&call, url.clone(), token, body)?;
    let secret: Option<Zeroizing<String>> = out.secret.clone().map(Zeroizing::new);
    let secret = secret.as_ref().map(|s| s.as_str());
    let raw = send_answer(net, request_id, out).await?;
    let Some(target) = follow_target(ep, &call, &url, &raw) else {
        return reply_of(raw, secret, None);
    };
    let moved_to = redact_text(target.as_str(), secret);
    let out = build(&call, target, token, None)?;
    let raw = send_answer(net, request_id, out).await?;
    reply_of(raw, secret, Some(moved_to))
}

/// The seconds until the API may be asked again: `Retry-After`, or
/// `x-ratelimit-reset - now` when `x-ratelimit-remaining` is 0 (at least 1 s;
/// 60 s when the reset is missing).
fn rate_limit_seconds(reply: &ApiReply, now: u64) -> Option<u64> {
    if let Some(s) = reply.headers.get("retry-after").and_then(|v| v.trim().parse::<u64>().ok()) {
        return Some(s);
    }
    if reply.headers.get("x-ratelimit-remaining").map(str::trim) == Some("0") {
        let reset = reply.headers.get("x-ratelimit-reset").and_then(|v| v.trim().parse::<u64>().ok());
        return Some(reset.map_or(60, |r| r.saturating_sub(now).max(1)));
    }
    None
}

/// The `url=` of an `X-GitHub-SSO: required; url=…` header, only when it is
/// `https` on `github.com` (no other port, no userinfo).
fn sso_url(reply: &ApiReply) -> Option<String> {
    let header = reply.headers.get("x-github-sso")?;
    let raw = header.split(';').map(str::trim).find_map(|part| part.strip_prefix("url="))?;
    let url = Url::parse(raw).ok()?;
    let ok = url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    ok.then(|| url.to_string())
}

fn org_restricted(reply: &ApiReply) -> bool {
    let text = reply.json.to_string();
    text.contains("OAuth App access restrictions") || text.contains("organization has enabled")
}

fn name_taken(reply: &ApiReply) -> bool {
    reply.json["errors"]
        .as_array()
        .is_some_and(|errs| errs.iter().any(|e| e["field"].as_str() == Some("name")))
}

/// `classify_at` with the current time.
pub fn classify(call: &GithubCall, reply: &ApiReply) -> ApiOutcome {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    classify_at(call, reply, now)
}

/// Maps an answer to its outcome (spec §7.2); `now` is the Unix time in
/// seconds (injected by tests). Nothing here retries.
pub fn classify_at(call: &GithubCall, reply: &ApiReply, now: u64) -> ApiOutcome {
    let status = reply.status;
    match status {
        200..=299 => match &reply.moved_to {
            Some(location) => ApiOutcome::Moved { location: location.clone() },
            None => ApiOutcome::Ok,
        },
        401 => ApiOutcome::NeedsSignIn,
        429 => ApiOutcome::RateLimited { seconds: rate_limit_seconds(reply, now).unwrap_or(60) },
        403 => {
            if let Some(seconds) = rate_limit_seconds(reply, now) {
                return ApiOutcome::RateLimited { seconds };
            }
            if let Some(url) = sso_url(reply) {
                return ApiOutcome::SsoRequired { url };
            }
            if let Some(org) = call.org() {
                if org_restricted(reply) {
                    return ApiOutcome::OrgRestricted { org: org.to_string() };
                }
            }
            match call {
                GithubCall::CreateOrgRepo { org } => ApiOutcome::CannotCreateInOrg { org: org.clone() },
                _ => ApiOutcome::Other { status },
            }
        }
        404 => ApiOutcome::NotFoundOrNoAccess,
        422 if name_taken(reply) => ApiOutcome::NameTaken,
        451 => ApiOutcome::LegalBlock { message: reply.json["message"].as_str().unwrap_or("").to_string() },
        _ => ApiOutcome::Other { status },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::testserver::{serve, Canned, TestServer};
    use serde_json::json;
    use tauri::async_runtime::block_on;

    /// A made-up token of the classic shape; never a real one.
    const FAKE: &str = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000";

    fn ep(s: &TestServer) -> GithubEndpoints {
        let base = Url::parse(&format!("{}/", s.url)).unwrap();
        GithubEndpoints { api: base.clone(), web: base.clone(), git: base }
    }

    fn token() -> Zeroizing<String> {
        Zeroizing::new(FAKE.to_string())
    }

    fn run(s: &TestServer, call: GithubCall, body: Option<Value>) -> Result<ApiReply, NetError> {
        let t = token();
        block_on(call_with(&ep(s), &NetState::default(), None, Some(&t), call, body))
    }

    fn outcome(canned: Canned, call: GithubCall) -> ApiOutcome {
        let s = serve(vec![canned]);
        let body = (call.method() == Method::POST).then(|| json!({}));
        let reply = run(&s, call.clone(), body).unwrap();
        classify_at(&call, &reply, 1_000)
    }

    fn org(o: &str) -> GithubCall {
        GithubCall::CreateOrgRepo { org: o.to_string() }
    }

    fn get_repo() -> GithubCall {
        GithubCall::GetRepo { owner: "lab".into(), name: "exp-1".into() }
    }

    fn json403(body: &str) -> Canned {
        Canned::status(403).header("Content-Type", "application/json").body(body)
    }

    #[test]
    fn calls_have_fixed_paths_methods_and_bases() {
        assert_eq!(GithubCall::DeviceCode.path(), "login/device/code");
        assert_eq!(GithubCall::AccessToken.path(), "login/oauth/access_token");
        assert_eq!(GithubCall::UserOrgs { page: 2 }.path(), "user/orgs?per_page=100&page=2");
        assert_eq!(get_repo().path(), "repos/lab/exp-1");
        assert_eq!(GithubCall::CreateUserRepo.path(), "user/repos");
        assert_eq!(org("lab").path(), "orgs/lab/repos");
        assert_eq!(GithubCall::DeviceCode.base(), Base::Web);
        assert_eq!(GithubCall::AccessToken.base(), Base::Web);
        assert_eq!(GithubCall::User.base(), Base::Api);
        assert_eq!(GithubCall::CreateUserRepo.method(), Method::POST);
        assert_eq!(get_repo().method(), Method::GET);
    }

    #[test]
    fn a_bad_path_segment_is_refused_before_any_request() {
        let s = serve(vec![Canned::ok("{}")]);
        for (owner, name) in [("../x", "r"), ("lab", ".."), ("lab", "."), ("", "r"), ("a b", "r"), ("lab", "x/y"), ("lab", "%2e")] {
            let call = GithubCall::GetRepo { owner: owner.into(), name: name.into() };
            assert_eq!(run(&s, call, None).unwrap_err().kind, NetErrorKind::BadInput, "{owner}/{name}");
        }
        assert_eq!(run(&s, org("../x"), Some(json!({}))).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(run(&s, org(&"a".repeat(101)), Some(json!({}))).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(run(&s, GithubCall::UserOrgs { page: 0 }, None).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(run(&s, GithubCall::User, Some(json!({}))).unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(s.request_count(), 0);
        assert!(valid_segment("Lab.Notes_2026-x") && valid_segment(&"a".repeat(100)) && !valid_segment("한글"));
    }

    #[test]
    fn the_token_goes_only_to_api_calls() {
        let s = serve(vec![Canned::ok("{\"login\":\"me\"}"), Canned::ok("{\"device_code\":\"d\"}")]);
        run(&s, GithubCall::User, None).unwrap();
        run(&s, GithubCall::DeviceCode, Some(json!({"client_id": "Iv1.x", "scope": "repo read:org"}))).unwrap();
        let reqs = s.requests.lock().unwrap();
        let bearer = format!("Bearer {FAKE}");
        assert_eq!(reqs[0].path, "/user");
        assert_eq!(reqs[0].header("authorization"), Some(bearer.as_str()));
        assert_eq!(reqs[0].header("accept"), Some("application/vnd.github+json"));
        assert_eq!(reqs[0].header("x-github-api-version"), Some("2022-11-28"));
        assert_eq!(reqs[1].method, "POST");
        assert_eq!(reqs[1].path, "/login/device/code");
        assert_eq!(reqs[1].header("authorization"), None);
        assert_eq!(reqs[1].header("accept"), Some("application/json"));
        assert_eq!(reqs[1].header("x-github-api-version"), None);
        assert!(reqs[1].body.contains("\"client_id\":\"Iv1.x\""));
        assert!(!reqs[1].body.contains(FAKE));
    }

    #[test]
    fn debug_output_never_holds_the_token() {
        let t = token();
        let url = Url::parse("https://api.github.com/user").unwrap();
        let out = build(&GithubCall::User, url, Some(&t), None).unwrap();
        assert_eq!(out.secret.as_deref(), Some(FAKE));
        assert!(!format!("{out:?}").contains(FAKE));
        let reply = ApiReply {
            status: 200,
            json: json!({"access_token": FAKE}),
            headers: KeptHeaders::default(),
            moved_to: None,
        };
        assert!(!format!("{reply:?}").contains(FAKE));
        // A web call never carries the token, even when one is passed.
        let url = Url::parse("https://github.com/login/device/code").unwrap();
        let out = build(&GithubCall::DeviceCode, url, Some(&t), Some(json!({}))).unwrap();
        assert!(out.secret.is_none());
        assert!(!out.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("authorization") || v.contains(FAKE)));
    }

    #[test]
    fn the_token_is_redacted_from_every_answer() {
        let body = format!("{{\"message\":\"bad token {FAKE}\"}}");
        let s = serve(vec![Canned::status(401).header("Content-Type", "application/json").body(body)]);
        let reply = run(&s, GithubCall::User, None).unwrap();
        assert!(!reply.json.to_string().contains(FAKE));
        assert_eq!(reply.json["message"], "bad token ***");
        assert_eq!(classify_at(&GithubCall::User, &reply, 0), ApiOutcome::NeedsSignIn);
    }

    #[test]
    fn a_2xx_that_is_not_json_is_not_json_but_an_error_page_is_classified() {
        let s = serve(vec![Canned::status(200).body("<html>portal</html>"), Canned::status(502).body("<html>x</html>")]);
        assert_eq!(run(&s, GithubCall::User, None).unwrap_err().kind, NetErrorKind::NotJson);
        let reply = run(&s, GithubCall::User, None).unwrap();
        assert_eq!((reply.status, &reply.json), (502, &Value::Null));
        assert_eq!(classify(&GithubCall::User, &reply), ApiOutcome::Other { status: 502 });
    }

    #[test]
    fn ok_and_plain_statuses() {
        assert_eq!(outcome(Canned::ok("{}"), GithubCall::User), ApiOutcome::Ok);
        assert_eq!(outcome(Canned::status(201).body("{}"), GithubCall::CreateUserRepo), ApiOutcome::Ok);
        assert_eq!(outcome(Canned::status(401), GithubCall::User), ApiOutcome::NeedsSignIn);
        assert_eq!(outcome(Canned::status(404), get_repo()), ApiOutcome::NotFoundOrNoAccess);
        assert_eq!(outcome(Canned::status(500), get_repo()), ApiOutcome::Other { status: 500 });
        assert_eq!(
            outcome(Canned::status(451).body("{\"message\":\"Repository access blocked\"}"), get_repo()),
            ApiOutcome::LegalBlock { message: "Repository access blocked".into() }
        );
    }

    #[test]
    fn org_restrictions_and_sso() {
        let restricted = json403(
            "{\"message\":\"Although you appear to have the correct authorization credentials, the `lab` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.\"}",
        );
        assert_eq!(outcome(restricted, org("lab")), ApiOutcome::OrgRestricted { org: "lab".into() });
        let sso = json403("{\"message\":\"Resource protected by organization SAML enforcement.\"}")
            .header("X-GitHub-SSO", "required; url=https://github.com/orgs/lab/sso?authorization_request=x");
        assert_eq!(
            outcome(sso, org("lab")),
            ApiOutcome::SsoRequired { url: "https://github.com/orgs/lab/sso?authorization_request=x".into() }
        );
        for bad in [
            "required; url=https://evil.example/orgs/lab/sso?x",
            "required; url=http://github.com/orgs/lab/sso",
            "required; url=https://github.com:8443/orgs/lab/sso",
            "required; url=https://user@github.com/orgs/lab/sso",
            "partial-results; organizations=1,2",
        ] {
            let c = json403("{\"message\":\"no\"}").header("X-GitHub-SSO", bad);
            assert_eq!(outcome(c, org("lab")), ApiOutcome::CannotCreateInOrg { org: "lab".into() }, "{bad}");
        }
        assert_eq!(
            outcome(json403("{\"message\":\"Must have admin rights\"}"), org("lab")),
            ApiOutcome::CannotCreateInOrg { org: "lab".into() }
        );
        assert_eq!(outcome(json403("{\"message\":\"Forbidden\"}"), GithubCall::User), ApiOutcome::Other { status: 403 });
    }

    #[test]
    fn rate_limits() {
        let limited = json403("{\"message\":\"API rate limit exceeded\"}")
            .header("x-ratelimit-remaining", "0")
            .header("x-ratelimit-reset", "1090");
        assert_eq!(outcome(limited, GithubCall::User), ApiOutcome::RateLimited { seconds: 90 });
        // A reset in the past still waits a second, never zero.
        let past = json403("{}").header("x-ratelimit-remaining", "0").header("x-ratelimit-reset", "10");
        assert_eq!(outcome(past, org("lab")), ApiOutcome::RateLimited { seconds: 1 });
        assert_eq!(
            outcome(Canned::status(429).header("Retry-After", "30"), GithubCall::User),
            ApiOutcome::RateLimited { seconds: 30 }
        );
        assert_eq!(outcome(json403("{}").header("Retry-After", "45"), get_repo()), ApiOutcome::RateLimited { seconds: 45 });
        assert_eq!(outcome(Canned::status(429), GithubCall::User), ApiOutcome::RateLimited { seconds: 60 });
        // Remaining not 0 is not a rate limit.
        let fine = json403("{}").header("x-ratelimit-remaining", "12").header("x-ratelimit-reset", "1090");
        assert_eq!(outcome(fine, org("lab")), ApiOutcome::CannotCreateInOrg { org: "lab".into() });
    }

    #[test]
    fn name_taken_only_on_the_name_field() {
        let taken = Canned::status(422).body(
            "{\"message\":\"Repository creation failed.\",\"errors\":[{\"resource\":\"Repository\",\"code\":\"custom\",\"field\":\"name\",\"message\":\"name already exists on this account\"}]}",
        );
        assert_eq!(outcome(taken, GithubCall::CreateUserRepo), ApiOutcome::NameTaken);
        let other = Canned::status(422).body("{\"errors\":[{\"field\":\"description\"}]}");
        assert_eq!(outcome(other, GithubCall::CreateUserRepo), ApiOutcome::Other { status: 422 });
    }

    #[test]
    fn one_same_origin_redirect_is_followed_on_a_get() {
        let s = serve(vec![
            Canned::status(301).header("Location", "/repositories/42"),
            Canned::ok("{\"full_name\":\"lab/exp-2\"}"),
        ]);
        let reply = run(&s, get_repo(), None).unwrap();
        assert_eq!(s.request_count(), 2);
        assert_eq!(reply.status, 200);
        assert_eq!(reply.json["full_name"], "lab/exp-2");
        let followed = format!("{}/repositories/42", s.url);
        assert_eq!(classify(&get_repo(), &reply), ApiOutcome::Moved { location: followed });
        let reqs = s.requests.lock().unwrap();
        let bearer = format!("Bearer {FAKE}");
        assert_eq!(reqs[1].method, "GET");
        assert_eq!(reqs[1].path, "/repositories/42");
        assert_eq!(reqs[1].header("authorization"), Some(bearer.as_str()));
    }

    #[test]
    fn a_307_is_followed_too_and_a_404_after_it_is_classified() {
        let s = serve(vec![Canned::status(307).header("Location", "/repositories/7"), Canned::status(404)]);
        let reply = run(&s, get_repo(), None).unwrap();
        assert_eq!(s.request_count(), 2);
        assert_eq!(classify(&get_repo(), &reply), ApiOutcome::NotFoundOrNoAccess);
    }

    #[test]
    fn a_second_redirect_is_not_followed() {
        let s = serve(vec![
            Canned::status(301).header("Location", "/repositories/1"),
            Canned::status(301).header("Location", "/repositories/2"),
            Canned::ok("{}"),
        ]);
        let reply = run(&s, get_repo(), None).unwrap();
        assert_eq!(s.request_count(), 2);
        assert_eq!(classify(&get_repo(), &reply), ApiOutcome::Other { status: 301 });
    }

    #[test]
    fn a_cross_origin_redirect_is_not_followed() {
        for loc in ["https://api.github.com/repositories/1", "http://127.0.0.2:1/repositories/1", "//evil.example/x"] {
            let s = serve(vec![Canned::status(301).header("Location", loc), Canned::ok("{}")]);
            let reply = run(&s, get_repo(), None).unwrap();
            assert_eq!(s.request_count(), 1, "{loc}");
            assert_eq!(classify(&get_repo(), &reply), ApiOutcome::Other { status: 301 });
        }
    }

    #[test]
    fn a_post_is_never_redirected() {
        let s = serve(vec![Canned::status(301).header("Location", "/user/repos2"), Canned::status(201).body("{}")]);
        let reply = run(&s, GithubCall::CreateUserRepo, Some(json!({"name": "x", "private": true}))).unwrap();
        assert_eq!(s.request_count(), 1);
        assert_eq!(classify(&GithubCall::CreateUserRepo, &reply), ApiOutcome::Other { status: 301 });
        // A 302 on a GET is not one of the followed statuses either.
        let s = serve(vec![Canned::status(302).header("Location", "/repositories/1"), Canned::ok("{}")]);
        let reply = run(&s, get_repo(), None).unwrap();
        assert_eq!(s.request_count(), 1);
        assert_eq!(classify(&get_repo(), &reply), ApiOutcome::Other { status: 302 });
    }

    #[test]
    fn kept_headers_reach_the_reply_and_never_authorization() {
        let s = serve(vec![Canned::ok("[]")
            .header("Link", "<https://api.github.com/user/orgs?page=2>; rel=\"next\"")
            .header("X-OAuth-Scopes", "repo, read:org")
            .header("Authorization", "Bearer leaked")
            .header("Set-Cookie", "a=b")]);
        let reply = run(&s, GithubCall::UserOrgs { page: 1 }, None).unwrap();
        assert!(reply.headers.get("link").unwrap().contains("rel=\"next\""));
        assert_eq!(reply.headers.get("x-oauth-scopes"), Some("repo, read:org"));
        assert_eq!(reply.headers.get("authorization"), None);
        assert_eq!(reply.headers.get("set-cookie"), None);
        assert_eq!(s.requests.lock().unwrap()[0].path, "/user/orgs?per_page=100&page=1");
    }

    #[test]
    fn outcomes_serialize_tagged_camel_case() {
        assert_eq!(serde_json::to_value(ApiOutcome::NameTaken).unwrap(), json!({"outcome": "nameTaken"}));
        assert_eq!(
            serde_json::to_value(ApiOutcome::RateLimited { seconds: 3 }).unwrap(),
            json!({"outcome": "rateLimited", "seconds": 3})
        );
    }

    #[test]
    fn the_allow_list_has_only_reads_and_creates() {
        // No DELETE, PATCH or PUT anywhere (no delete, no visibility change).
        let calls = [
            GithubCall::DeviceCode,
            GithubCall::AccessToken,
            GithubCall::User,
            GithubCall::UserOrgs { page: 1 },
            get_repo(),
            GithubCall::CreateUserRepo,
            org("lab"),
        ];
        for c in calls {
            assert!(c.method() == Method::GET || c.method() == Method::POST, "{c:?}");
        }
    }
}
