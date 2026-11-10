//! GitHub sign-in (spec §7.1): the device flow, the pasted-token fallback,
//! the account record, sign-out and "sign out when the app closes".
//!
//! - The token never leaves Rust. Only `{userCode, verificationUri,
//!   expiresIn}` and, at the end, `{login, id, avatarUrl}` cross IPC.
//! - The device code, the token and the refresh token are held in
//!   `Zeroizing` buffers; `GithubState` and `DeviceSession` print `***`.
//! - The access token is stored last, only after `GET /user` and the scope
//!   check pass, so a refused sign-in leaves nothing in the keychain.
//! - With the app-wide `forgetOnExit` on, the token lives only in
//!   `GithubState` memory and the exit hook zeroizes it.
//! - Polling never goes faster than `interval` (at least 5 s) and each
//!   `slow_down` adds 5 s. Nothing here ever starts a sign-in by itself: a
//!   failed refresh only answers "sign in again".

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use zeroize::Zeroizing;

use super::api::{call_with, classify, ApiOutcome, ApiReply, GithubCall, KeptHeaders};
use super::{endpoints, GithubEndpoints};
use crate::gitsync::state::{github_client_id, read_doc, remove_doc, write_doc, GithubAppSettings, GithubDoc};
use crate::net::config::ServiceConfig;
use crate::net::http::Registration;
use crate::net::secrets::{clear_secret, key_for, store_secret, validate_secret_for, SecretStore, Secrets, Slot};
use crate::net::{IntegrationDirs, NetError, NetErrorKind, NetState};

/// The scopes the device flow asks for (spec R1).
pub const SCOPES: &str = "repo read:org";

/// Where the user enters the code; the only `verificationUri` passed on
/// (besides the test base's own page).
pub const VERIFICATION_URI: &str = "https://github.com/login/device";

/// The grant type of a device-flow poll.
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// The slowest GitHub may make us poll at the start, and the step of `slow_down`.
const MIN_INTERVAL: Duration = Duration::from_secs(5);
const SLOW_DOWN_STEP: Duration = Duration::from_secs(5);

/// A device code lives at most this long here, whatever the server says.
const MAX_EXPIRES: u64 = 3600;

/// The GitHub slots have a fixed origin: no vault config plays a part.
fn fixed_cfg() -> ServiceConfig {
    ServiceConfig::from_settings_json("{}")
}

/// A started device flow. Never leaves Rust and never prints its code.
pub struct DeviceSession {
    client_id: String,
    device_code: Zeroizing<String>,
    interval: Duration,
    deadline: Instant,
}

impl std::fmt::Debug for DeviceSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceSession")
            .field("device_code", &"***")
            .field("interval", &self.interval)
            .finish_non_exhaustive()
    }
}

/// The app's GitHub sign-in state (managed once). The memory token is the
/// `forgetOnExit` token; with the flag off, the token is in the keychain.
#[derive(Default)]
pub struct GithubState {
    device: Mutex<Option<DeviceSession>>,
    memory_token: Mutex<Option<Zeroizing<String>>>,
    memory_refresh: Mutex<Option<Zeroizing<String>>>,
}

impl std::fmt::Debug for GithubState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let shown = |set: bool| if set { "***" } else { "none" };
        f.debug_struct("GithubState")
            .field("device", &shown(lock(&self.device).is_some()))
            .field("memory_token", &shown(lock(&self.memory_token).is_some()))
            .field("memory_refresh", &shown(lock(&self.memory_refresh).is_some()))
            .finish()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl GithubState {
    /// Zeroizes the in-memory tokens (the exit hook, sign-out).
    pub fn forget_memory_token(&self) {
        *lock(&self.memory_token) = None;
        *lock(&self.memory_refresh) = None;
    }

    /// True when a `forgetOnExit` token is held in memory.
    pub fn has_memory_token(&self) -> bool {
        lock(&self.memory_token).is_some()
    }

    /// Copies of the in-memory tokens (access, then refresh), for the
    /// exact-match secret scan only. Zeroized when dropped.
    pub(crate) fn memory_secrets(&self) -> Vec<Zeroizing<String>> {
        [lock(&self.memory_token).clone(), lock(&self.memory_refresh).clone()].into_iter().flatten().collect()
    }

    fn set_memory(&self, token: Zeroizing<String>, refresh: Option<Zeroizing<String>>) {
        *lock(&self.memory_token) = Some(token);
        *lock(&self.memory_refresh) = refresh;
    }

    fn set_device(&self, session: DeviceSession) {
        *lock(&self.device) = Some(session);
    }

    fn take_device(&self) -> Option<DeviceSession> {
        lock(&self.device).take()
    }

    /// The exit hook: zeroizes the memory token and, when `forgetOnExit` is
    /// on, forgets the account record too (the next start is signed out).
    pub fn on_exit(&self, dirs: Option<&Path>) {
        self.forget_memory_token();
        *lock(&self.device) = None;
        if let Some(dirs) = dirs {
            let app: GithubAppSettings = read_doc(dirs, None, GithubDoc::App).unwrap_or_default();
            if app.forget_on_exit {
                let _ = remove_doc(dirs, None, GithubDoc::Account);
            }
        }
    }

    /// Signs out everywhere: the device session, the memory tokens, both
    /// keychain slots and the account record.
    pub fn sign_out(&self, dirs: &Path, store: &dyn SecretStore) -> Result<(), NetError> {
        *lock(&self.device) = None;
        self.forget_memory_token();
        crate::gitsync::state::sign_out_stored(dirs, store)
    }

    /// Turning `forgetOnExit` on while signed in: the keychain tokens move
    /// into memory and the keychain entries are deleted.
    pub(crate) fn move_to_memory(&self, store: &dyn SecretStore) -> Result<(), NetError> {
        let cfg = fixed_cfg();
        let Some(token) = key_for(store, Slot::Github, &cfg)?.map(Zeroizing::new) else { return Ok(()) };
        let refresh = key_for(store, Slot::GithubRefresh, &cfg)?.map(Zeroizing::new);
        self.set_memory(token, refresh);
        clear_secret(store, Slot::Github, &cfg)?;
        clear_secret(store, Slot::GithubRefresh, &cfg)
    }
}

/// The access token: the memory token first, then the keychain slot.
pub fn token(state: &GithubState, store: &dyn SecretStore) -> Result<Option<Zeroizing<String>>, NetError> {
    if let Some(t) = lock(&state.memory_token).as_ref() {
        return Ok(Some(t.clone()));
    }
    Ok(key_for(store, Slot::Github, &fixed_cfg())?.map(Zeroizing::new))
}

fn refresh_token(state: &GithubState, store: &dyn SecretStore) -> Result<Option<Zeroizing<String>>, NetError> {
    if lock(&state.memory_token).is_some() {
        return Ok(lock(&state.memory_refresh).clone());
    }
    Ok(key_for(store, Slot::GithubRefresh, &fixed_cfg())?.map(Zeroizing::new))
}

/// Keeps a token GitHub issued (after every check passed): in memory when
/// `forgetOnExit` is on, else in the keychain, the refresh token first and
/// the access token last. A token of the wrong shape stores nothing.
fn keep_token(
    dirs: &Path,
    store: &dyn SecretStore,
    gh: &GithubState,
    access: &str,
    refresh: Option<&str>,
) -> Result<(), NetError> {
    let access = Zeroizing::new(validate_secret_for(Slot::Github, access)?);
    let refresh = match refresh {
        Some(r) => Some(Zeroizing::new(validate_secret_for(Slot::GithubRefresh, r)?)),
        None => None,
    };
    let app: GithubAppSettings = read_doc(dirs, None, GithubDoc::App)?;
    if app.forget_on_exit {
        gh.set_memory(access, refresh);
        return Ok(());
    }
    let cfg = fixed_cfg();
    match &refresh {
        Some(r) => store_secret(store, Slot::GithubRefresh, &cfg, r)?,
        None => clear_secret(store, Slot::GithubRefresh, &cfg)?,
    }
    store_secret(store, Slot::Github, &cfg, &access)?;
    gh.forget_memory_token();
    Ok(())
}

/// How the device flow waits: real time in the app, a virtual clock in tests.
pub trait Pace: Send + Sync {
    fn now(&self) -> Instant;
    fn sleep(&self, d: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

/// Real time.
pub struct RealPace;

impl Pace for RealPace {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, d: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(tokio::time::sleep(d))
    }
}

/// The signed-in identity (non-secret; `GithubDoc::Account`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub login: String,
    pub id: u64,
    pub avatar_url: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum SignInStart {
    #[serde(rename_all = "camelCase")]
    Started { user_code: String, verification_uri: String, expires_in: u64 },
    NotConfigured,
    AppMisconfigured,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum SignInOutcome {
    #[serde(rename_all = "camelCase")]
    SignedIn { login: String, id: u64, avatar_url: String },
    Expired,
    Denied,
    AppMisconfigured,
    ScopeMissing,
    Cancelled,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum TokenOutcome {
    /// Stored. A fine-grained token lists no orgs (pick one by name).
    #[serde(rename_all = "camelCase")]
    Saved { login: String, fine_grained: bool },
    /// Not a GitHub token (nothing was sent).
    BadToken,
    /// GitHub refused the token (401).
    NeedsSignIn,
    /// A classic token without the `repo` scope.
    ScopeMissing,
}

/// A string field of an answer, if it is a short single line.
fn field(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().filter(|s| !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control)).map(str::to_string)
}

/// Takes a string field out of an answer into a zeroized buffer.
fn take_secret(v: &mut Value, key: &str) -> Option<Zeroizing<String>> {
    match v.get_mut(key).map(Value::take) {
        Some(Value::String(s)) if !s.is_empty() => Some(Zeroizing::new(s)),
        Some(Value::String(s)) => {
            drop(Zeroizing::new(s));
            None
        }
        _ => None,
    }
}

/// The error of an answer that maps to no outcome (the token redacted).
fn unexpected(reply: &ApiReply, secret: Option<&str>) -> NetError {
    let body = if reply.json.is_null() { String::new() } else { reply.json.to_string() };
    NetError::status(reply.status, &body, secret)
}

/// The `verificationUri` passed on: GitHub's page, or the test base's own
/// `login/device`; anything else is replaced by GitHub's page.
fn verification_uri(ep: &GithubEndpoints, given: Option<String>) -> String {
    let test_page = ep.web.join("login/device").ok().map(|u| u.to_string());
    match given {
        Some(g) if g == VERIFICATION_URI || Some(&g) == test_page.as_ref() => g,
        _ => VERIFICATION_URI.to_string(),
    }
}

/// `POST login/device/code`. No client ID: `notConfigured` and nothing sent.
pub async fn sign_in_start_at(
    ep: &GithubEndpoints,
    dirs: &Path,
    net: &NetState,
    gh: &GithubState,
    pace: &dyn Pace,
) -> Result<SignInStart, NetError> {
    let app: GithubAppSettings = read_doc(dirs, None, GithubDoc::App)?;
    let Some(client_id) = github_client_id(&app) else { return Ok(SignInStart::NotConfigured) };
    let body = json!({"client_id": client_id, "scope": SCOPES});
    let mut reply = call_with(ep, net, None, None, GithubCall::DeviceCode, Some(body)).await?;
    if reply.json.get("error").is_some() || matches!(reply.status, 400 | 401 | 403 | 404 | 422) {
        return Ok(SignInStart::AppMisconfigured);
    }
    if !(200..300).contains(&reply.status) {
        return Err(unexpected(&reply, None));
    }
    let user_code = field(&reply.json, "user_code").filter(|c| c.len() <= 64);
    let device_code = take_secret(&mut reply.json, "device_code");
    let (Some(user_code), Some(device_code)) = (user_code, device_code) else {
        return Ok(SignInStart::AppMisconfigured);
    };
    let expires_in = reply.json["expires_in"].as_u64().unwrap_or(900).clamp(1, MAX_EXPIRES);
    let interval = Duration::from_secs(reply.json["interval"].as_u64().unwrap_or(5)).max(MIN_INTERVAL);
    let verification_uri = verification_uri(ep, field(&reply.json, "verification_uri"));
    gh.set_device(DeviceSession {
        client_id,
        device_code,
        interval,
        deadline: pace.now() + Duration::from_secs(expires_in),
    });
    Ok(SignInStart::Started { user_code, verification_uri, expires_in })
}

/// The `x-oauth-scopes` check: absent (fine-grained or GitHub App tokens) is
/// accepted; present, it must list `repo`.
fn has_repo_scope(headers: &KeptHeaders) -> bool {
    headers.get("x-oauth-scopes").map_or(true, |s| s.split(',').any(|x| x.trim() == "repo"))
}

/// The identity in a `GET /user` answer.
fn account_of(reply: &ApiReply) -> Option<Account> {
    let login = field(&reply.json, "login").filter(|l| super::api::valid_segment(l))?;
    let id = reply.json["id"].as_u64()?;
    let avatar_url = field(&reply.json, "avatar_url").filter(|u| u.starts_with("https://")).unwrap_or_default();
    Some(Account { login, id, avatar_url })
}

enum UserCheck {
    Ok(Account),
    Unauthorized,
    ScopeMissing,
}

/// `GET /user` with `token`, then the scope check.
async fn check_user(ep: &GithubEndpoints, net: &NetState, token: &Zeroizing<String>) -> Result<UserCheck, NetError> {
    let reply = call_with(ep, net, None, Some(token), GithubCall::User, None).await?;
    match classify(&GithubCall::User, &reply) {
        ApiOutcome::Ok => {}
        ApiOutcome::NeedsSignIn => return Ok(UserCheck::Unauthorized),
        _ => return Err(unexpected(&reply, Some(token))),
    }
    if !has_repo_scope(&reply.headers) {
        return Ok(UserCheck::ScopeMissing);
    }
    account_of(&reply)
        .map(UserCheck::Ok)
        .ok_or_else(|| NetError::new(NetErrorKind::BadInput, "GitHub's account answer is incomplete"))
}

/// Polls until GitHub answers, then checks and keeps the token.
async fn poll_and_finish(
    ep: &GithubEndpoints,
    dirs: &Path,
    store: &dyn SecretStore,
    net: &NetState,
    gh: &GithubState,
    session: DeviceSession,
    pace: &dyn Pace,
) -> Result<SignInOutcome, NetError> {
    let mut interval = session.interval.max(MIN_INTERVAL);
    let (access, refresh) = loop {
        pace.sleep(interval).await;
        if pace.now() >= session.deadline {
            return Ok(SignInOutcome::Expired);
        }
        let body = json!({
            "client_id": session.client_id,
            "device_code": session.device_code.as_str(),
            "grant_type": DEVICE_GRANT,
        });
        let mut reply = call_with(ep, net, None, None, GithubCall::AccessToken, Some(body)).await?;
        if let Some(access) = take_secret(&mut reply.json, "access_token") {
            break (access, take_secret(&mut reply.json, "refresh_token"));
        }
        match reply.json["error"].as_str() {
            Some("authorization_pending") => {}
            Some("slow_down") => {
                let asked = reply.json["interval"].as_u64().map_or(Duration::ZERO, Duration::from_secs);
                interval = (interval + SLOW_DOWN_STEP).max(asked);
            }
            Some("expired_token") | Some("incorrect_device_code") => return Ok(SignInOutcome::Expired),
            Some("access_denied") => return Ok(SignInOutcome::Denied),
            Some(_) => return Ok(SignInOutcome::AppMisconfigured),
            None if (400..500).contains(&reply.status) => return Ok(SignInOutcome::AppMisconfigured),
            None => return Err(unexpected(&reply, None)),
        }
    };
    let account = match check_user(ep, net, &access).await? {
        UserCheck::Ok(a) => a,
        UserCheck::ScopeMissing => return Ok(SignInOutcome::ScopeMissing),
        UserCheck::Unauthorized => return Ok(SignInOutcome::AppMisconfigured),
    };
    keep_token(dirs, store, gh, &access, refresh.as_deref().map(String::as_str))?;
    write_doc(dirs, None, GithubDoc::Account, &account)?;
    Ok(SignInOutcome::SignedIn { login: account.login, id: account.id, avatar_url: account.avatar_url })
}

/// Waits for the started device flow. `net_cancel(request_id)` ends it with
/// `cancelled` and nothing stored. No started flow: `expired` (get a new code).
pub async fn sign_in_wait_at(
    ep: &GithubEndpoints,
    dirs: &Path,
    store: &dyn SecretStore,
    net: &NetState,
    gh: &GithubState,
    request_id: Option<&str>,
    pace: &dyn Pace,
) -> Result<SignInOutcome, NetError> {
    let Some(session) = gh.take_device() else { return Ok(SignInOutcome::Expired) };
    let work = poll_and_finish(ep, dirs, store, net, gh, session, pace);
    let Some(id) = request_id else { return work.await };
    let notify = match net.register(id) {
        Ok(n) => n,
        Err(e) if e.kind == NetErrorKind::Cancelled => return Ok(SignInOutcome::Cancelled),
        Err(e) => return Err(e),
    };
    let _registration = Registration { net, id };
    tokio::select! {
        result = work => result,
        _ = notify.notified() => Ok(SignInOutcome::Cancelled),
    }
}

/// The pasted-token fallback: the shape is checked (nothing sent if wrong),
/// then `GET /user`, then the token is kept.
pub async fn set_token_at(
    ep: &GithubEndpoints,
    dirs: &Path,
    store: &dyn SecretStore,
    net: &NetState,
    gh: &GithubState,
    value: &str,
) -> Result<TokenOutcome, NetError> {
    let Ok(token) = validate_secret_for(Slot::Github, value).map(Zeroizing::new) else {
        return Ok(TokenOutcome::BadToken);
    };
    let account = match check_user(ep, net, &token).await? {
        UserCheck::Ok(a) => a,
        UserCheck::Unauthorized => return Ok(TokenOutcome::NeedsSignIn),
        UserCheck::ScopeMissing => return Ok(TokenOutcome::ScopeMissing),
    };
    keep_token(dirs, store, gh, &token, None)?;
    write_doc(dirs, None, GithubDoc::Account, &account)?;
    Ok(TokenOutcome::Saved { login: account.login, fine_grained: token.starts_with("github_pat_") })
}

/// The account, only while a token is held (a `forgetOnExit` record left by
/// a crash is not a sign-in).
pub fn account_at(dirs: &Path, store: &dyn SecretStore, gh: &GithubState) -> Result<Option<Account>, NetError> {
    if token(gh, store)?.is_none() {
        return Ok(None);
    }
    read_doc::<Option<Account>>(dirs, None, GithubDoc::Account)
}

/// Uses the refresh token once. `true` when a new token was kept; `false`
/// when there is no refresh token or GitHub refused it (the dead refresh
/// token is then forgotten). Never starts a sign-in.
pub async fn refresh_once(
    ep: &GithubEndpoints,
    dirs: &Path,
    store: &dyn SecretStore,
    net: &NetState,
    gh: &GithubState,
) -> Result<bool, NetError> {
    let Some(refresh) = refresh_token(gh, store)? else { return Ok(false) };
    let app: GithubAppSettings = read_doc(dirs, None, GithubDoc::App)?;
    let Some(client_id) = github_client_id(&app) else { return Ok(false) };
    let body = json!({"client_id": client_id, "grant_type": "refresh_token", "refresh_token": refresh.as_str()});
    let mut reply = call_with(ep, net, None, None, GithubCall::AccessToken, Some(body)).await?;
    let Some(access) = take_secret(&mut reply.json, "access_token") else {
        if gh.has_memory_token() {
            *lock(&gh.memory_refresh) = None;
        } else {
            clear_secret(store, Slot::GithubRefresh, &fixed_cfg())?;
        }
        return Ok(false);
    };
    let next = take_secret(&mut reply.json, "refresh_token");
    keep_token(dirs, store, gh, &access, next.as_deref().map(String::as_str))?;
    Ok(true)
}

/// An API call with the stored token. A 401 with a refresh token set tries
/// one refresh, then the call once more; otherwise the 401 is the answer
/// (`needsSignIn`). No token at all: a 401 answer and nothing sent.
pub async fn call_authed(
    ep: &GithubEndpoints,
    dirs: &Path,
    store: &dyn SecretStore,
    net: &NetState,
    gh: &GithubState,
    request_id: Option<&str>,
    call: GithubCall,
    body: Option<Value>,
) -> Result<ApiReply, NetError> {
    let Some(tok) = token(gh, store)? else {
        return Ok(ApiReply { status: 401, json: Value::Null, headers: KeptHeaders::default(), moved_to: None });
    };
    let reply = call_with(ep, net, request_id, Some(&tok), call.clone(), body.clone()).await?;
    if reply.status != 401 || refresh_token(gh, store)?.is_none() {
        return Ok(reply);
    }
    if !refresh_once(ep, dirs, store, net, gh).await? {
        return Ok(reply);
    }
    let Some(tok) = token(gh, store)? else { return Ok(reply) };
    call_with(ep, net, request_id, Some(&tok), call, body).await
}

/// Starts the device flow. Offline-safe: no client ID answers `notConfigured`.
#[tauri::command]
pub async fn github_sign_in_start(
    dirs: State<'_, IntegrationDirs>,
    net: State<'_, NetState>,
    github: State<'_, GithubState>,
) -> Result<SignInStart, NetError> {
    sign_in_start_at(&endpoints(), &dirs.0, &net, &github, &RealPace).await
}

/// Waits for the user to enter the code (cancel with `net_cancel`).
#[tauri::command]
pub async fn github_sign_in_wait(
    dirs: State<'_, IntegrationDirs>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    github: State<'_, GithubState>,
    request_id: String,
) -> Result<SignInOutcome, NetError> {
    sign_in_wait_at(&endpoints(), &dirs.0, secrets.0.as_ref(), &net, &github, Some(&request_id), &RealPace).await
}

/// The signed-in account, or `null`. Offline.
#[tauri::command]
pub fn github_account(
    dirs: State<'_, IntegrationDirs>,
    secrets: State<'_, Secrets>,
    github: State<'_, GithubState>,
) -> Result<Option<Account>, NetError> {
    account_at(&dirs.0, secrets.0.as_ref(), &github)
}

/// Signs out: both slots, the memory token and the account. Offline.
#[tauri::command]
pub fn github_sign_out(
    dirs: State<'_, IntegrationDirs>,
    secrets: State<'_, Secrets>,
    github: State<'_, GithubState>,
) -> Result<(), NetError> {
    github.sign_out(&dirs.0, secrets.0.as_ref())
}

/// The pasted-token fallback; the only IPC path that hands Rust a token.
#[tauri::command]
pub async fn github_set_token(
    dirs: State<'_, IntegrationDirs>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    github: State<'_, GithubState>,
    value: String,
) -> Result<TokenOutcome, NetError> {
    let value = Zeroizing::new(value);
    set_token_at(&endpoints(), &dirs.0, secrets.0.as_ref(), &net, &github, &value).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitsync::state::{app_settings_set_at, GithubAppSettingsPatch};
    use crate::net::config::tests::scratch_dir;
    use crate::net::config::Url;
    use crate::net::secrets::{status_of, MemoryStore};
    use crate::net::testserver::{serve, silent, Canned, TestServer};
    use tauri::async_runtime::block_on;

    /// Made-up tokens of GitHub's shapes; never real ones.
    const GHO: &str = "gho_FAKEdevice000000000000000000000000000";
    const GHO2: &str = "gho_FAKErefreshed0000000000000000000000";
    const GHR: &str = "ghr_FAKErefresh00000000000000000000000000";
    const GHR2: &str = "ghr_FAKErefresh2222222222222222222222222";
    const PAT: &str = "github_pat_FAKE000000000000000000000000000000";
    const GHP: &str = "ghp_FAKEclassic0000000000000000000000000";
    const DEVICE_CODE: &str = "devFAKE3584d83530557fdd1f46af8289938c8ef79f9dc5";

    /// A virtual clock: `sleep` advances it (after `real`, so a cancel can land).
    struct FakePace {
        start: Instant,
        offset: Mutex<Duration>,
        slept: Mutex<Vec<Duration>>,
        real: Duration,
    }

    impl FakePace {
        fn new(real: Duration) -> Self {
            FakePace { start: Instant::now(), offset: Mutex::new(Duration::ZERO), slept: Mutex::new(Vec::new()), real }
        }

        fn slept(&self) -> Vec<u64> {
            lock(&self.slept).iter().map(Duration::as_secs).collect()
        }
    }

    impl Pace for FakePace {
        fn now(&self) -> Instant {
            self.start + *lock(&self.offset)
        }

        fn sleep(&self, d: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            Box::pin(async move {
                if !self.real.is_zero() {
                    tokio::time::sleep(self.real).await;
                }
                *lock(&self.offset) += d;
                lock(&self.slept).push(d);
            })
        }
    }

    fn ep(s: &TestServer) -> GithubEndpoints {
        let base = Url::parse(&format!("{}/", s.url)).unwrap();
        GithubEndpoints { api: base.clone(), web: base.clone(), git: base }
    }

    /// A scratch app-data dir with a client ID set.
    fn dirs(tag: &str) -> std::path::PathBuf {
        let dir = scratch_dir(tag);
        let app = GithubAppSettings { client_id: Some("Iv1.test".into()), forget_on_exit: false };
        write_doc(&dir, None, GithubDoc::App, &app).unwrap();
        dir
    }

    fn set_forget(dir: &Path, on: bool) {
        let mut app: GithubAppSettings = read_doc(dir, None, GithubDoc::App).unwrap();
        app.forget_on_exit = on;
        write_doc(dir, None, GithubDoc::App, &app).unwrap();
    }

    fn device_code(interval: u64) -> Canned {
        Canned::ok(&format!(
            "{{\"device_code\":\"{DEVICE_CODE}\",\"user_code\":\"WDJB-MJHT\",\"verification_uri\":\"https://github.com/login/device\",\"expires_in\":900,\"interval\":{interval}}}"
        ))
    }

    fn poll(error: &str) -> Canned {
        Canned::ok(&format!("{{\"error\":\"{error}\",\"error_description\":\"x\"}}"))
    }

    fn token_answer(access: &str, refresh: Option<&str>) -> Canned {
        let refresh = refresh.map(|r| format!(",\"refresh_token\":\"{r}\",\"expires_in\":28800")).unwrap_or_default();
        Canned::ok(&format!("{{\"access_token\":\"{access}\",\"token_type\":\"bearer\",\"scope\":\"repo,read:org\"{refresh}}}"))
    }

    fn user(scopes: Option<&str>) -> Canned {
        let c = Canned::ok("{\"login\":\"kim-lab\",\"id\":4242,\"avatar_url\":\"https://avatars.githubusercontent.com/u/4242\"}");
        match scopes {
            Some(s) => c.header("X-OAuth-Scopes", s),
            None => c,
        }
    }

    /// No GitHub key and no epoch was ever written.
    fn assert_untouched(store: &MemoryStore) {
        let st = status_of(store, &fixed_cfg());
        assert!(!st.set.github && !st.set.github_refresh, "the keychain was written");
        assert_eq!((st.epoch.github, st.epoch.github_refresh), (0, 0), "the keychain was written");
    }

    fn stored(store: &MemoryStore, slot: Slot) -> Option<String> {
        key_for(store, slot, &fixed_cfg()).unwrap()
    }

    /// Starts and waits against `answers` (the device-code answer first).
    fn sign_in(dir: &Path, store: &MemoryStore, gh: &GithubState, answers: Vec<Canned>) -> (SignInOutcome, TestServer, FakePace) {
        let s = serve(answers);
        let net = NetState::default();
        let pace = FakePace::new(Duration::ZERO);
        let started = block_on(sign_in_start_at(&ep(&s), dir, &net, gh, &pace)).unwrap();
        assert!(matches!(started, SignInStart::Started { .. }), "{started:?}");
        let out = block_on(sign_in_wait_at(&ep(&s), dir, store, &net, gh, Some("w1"), &pace)).unwrap();
        (out, s, pace)
    }

    #[test]
    fn the_poll_honours_interval_and_slow_down_and_stores_the_token_last() {
        let dir = dirs("gh-auth-poll");
        let store = MemoryStore::default();
        let gh = GithubState::default();
        let (out, s, pace) = sign_in(
            &dir,
            &store,
            &gh,
            vec![
                device_code(5),
                poll("authorization_pending"),
                poll("slow_down"),
                poll("authorization_pending"),
                token_answer(GHO, None),
                user(Some("repo, read:org")),
            ],
        );
        assert_eq!(
            out,
            SignInOutcome::SignedIn {
                login: "kim-lab".into(),
                id: 4242,
                avatar_url: "https://avatars.githubusercontent.com/u/4242".into()
            }
        );
        // Requests are 5 s, then 10 s, then 10 s apart (5 s before the first poll).
        assert_eq!(pace.slept(), vec![5, 5, 10, 10]);
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs.len(), 6);
        assert_eq!(reqs[0].path, "/login/device/code");
        assert!(reqs[0].body.contains("\"scope\":\"repo read:org\"") && reqs[0].body.contains("Iv1.test"));
        for r in &reqs[1..5] {
            assert_eq!(r.path, "/login/oauth/access_token");
            assert!(r.body.contains(DEVICE_CODE) && r.body.contains(DEVICE_GRANT));
            assert_eq!(r.header("authorization"), None);
        }
        assert_eq!(reqs[5].path, "/user");
        let bearer = format!("Bearer {GHO}");
        assert_eq!(reqs[5].header("authorization"), Some(bearer.as_str()));
        assert_eq!(stored(&store, Slot::Github).as_deref(), Some(GHO));
        assert_eq!(stored(&store, Slot::GithubRefresh), None);
        assert!(!gh.has_memory_token());
        let shown = serde_json::to_string(&out).unwrap();
        assert!(!shown.contains("gho_") && !shown.contains(DEVICE_CODE), "{shown}");
        assert_eq!(serde_json::to_value(&out).unwrap()["outcome"], "signedIn");
        assert_eq!(serde_json::to_value(&out).unwrap()["avatarUrl"], "https://avatars.githubusercontent.com/u/4242");
        let account = std::fs::read_to_string(dir.join("github").join("account.json")).unwrap();
        assert!(account.contains("kim-lab") && !account.contains("gho_"), "{account}");
        assert_eq!(account_at(&dir, &store, &gh).unwrap().unwrap().login, "kim-lab");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_start_answer_holds_only_the_user_code() {
        let dir = dirs("gh-auth-start");
        let s = serve(vec![device_code(7)]);
        let gh = GithubState::default();
        let pace = FakePace::new(Duration::ZERO);
        let out = block_on(sign_in_start_at(&ep(&s), &dir, &NetState::default(), &gh, &pace)).unwrap();
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            json!({"outcome": "started", "userCode": "WDJB-MJHT", "verificationUri": VERIFICATION_URI, "expiresIn": 900})
        );
        assert_eq!(lock(&gh.device).as_ref().unwrap().interval, Duration::from_secs(7));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn poll_errors_map_to_outcomes_and_store_nothing() {
        for (error, want) in [
            ("expired_token", SignInOutcome::Expired),
            ("access_denied", SignInOutcome::Denied),
            ("device_flow_disabled", SignInOutcome::AppMisconfigured),
            ("incorrect_client_credentials", SignInOutcome::AppMisconfigured),
        ] {
            let dir = dirs("gh-auth-err");
            let store = MemoryStore::default();
            let gh = GithubState::default();
            let (out, s, _) = sign_in(&dir, &store, &gh, vec![device_code(5), poll(error)]);
            assert_eq!(out, want, "{error}");
            assert_eq!(s.request_count(), 2);
            assert_eq!(stored(&store, Slot::Github), None);
            assert!(!dir.join("github").join("account.json").exists());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_start_error_is_app_misconfigured() {
        let dir = dirs("gh-auth-start-err");
        for canned in [poll("device_flow_disabled"), Canned::status(404).body("{\"error\":\"Not Found\"}")] {
            let s = serve(vec![canned]);
            let pace = FakePace::new(Duration::ZERO);
            let out = block_on(sign_in_start_at(&ep(&s), &dir, &NetState::default(), &GithubState::default(), &pace));
            assert_eq!(out.unwrap(), SignInStart::AppMisconfigured);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_code_expires_locally_without_another_request() {
        let dir = dirs("gh-auth-deadline");
        let s = serve(vec![Canned::ok(&format!(
            "{{\"device_code\":\"{DEVICE_CODE}\",\"user_code\":\"A-B\",\"verification_uri\":\"{VERIFICATION_URI}\",\"expires_in\":12,\"interval\":5}}"
        )), poll("authorization_pending"), poll("authorization_pending")]);
        let (net, gh, store, pace) = (NetState::default(), GithubState::default(), MemoryStore::default(), FakePace::new(Duration::ZERO));
        block_on(sign_in_start_at(&ep(&s), &dir, &net, &gh, &pace)).unwrap();
        let out = block_on(sign_in_wait_at(&ep(&s), &dir, &store, &net, &gh, None, &pace)).unwrap();
        assert_eq!(out, SignInOutcome::Expired);
        assert_eq!(s.request_count(), 3, "the code, two polls (at 5 s and 10 s), none at 15 s");
        // The session is used up: waiting again is `expired`, with nothing sent.
        assert_eq!(block_on(sign_in_wait_at(&ep(&s), &dir, &store, &net, &gh, None, &pace)).unwrap(), SignInOutcome::Expired);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn session() -> DeviceSession {
        DeviceSession {
            client_id: "Iv1.test".into(),
            device_code: Zeroizing::new(DEVICE_CODE.into()),
            interval: Duration::from_secs(5),
            deadline: Instant::now() + Duration::from_secs(900),
        }
    }

    #[test]
    fn cancel_mid_request_and_mid_sleep_stores_nothing() {
        // Mid-request: the poll never gets an answer.
        let dir = dirs("gh-auth-cancel");
        let s = silent();
        let (net, gh, store) = (NetState::default(), GithubState::default(), MemoryStore::default());
        for real in [Duration::ZERO, Duration::from_secs(20)] {
            gh.set_device(session());
            let pace = FakePace::new(real);
            let out = std::thread::scope(|sc| {
                let h = sc.spawn(|| block_on(sign_in_wait_at(&ep(&s), &dir, &store, &net, &gh, Some("c1"), &pace)));
                std::thread::sleep(Duration::from_millis(300));
                assert!(net.cancel("c1"));
                h.join().unwrap()
            });
            assert_eq!(out.unwrap(), SignInOutcome::Cancelled);
            assert_eq!(stored(&store, Slot::Github), None);
            assert!(!gh.has_memory_token());
        }
        // A cancel that arrives first: nothing is sent at all.
        gh.set_device(session());
        assert!(!net.cancel("c2"));
        let pace = FakePace::new(Duration::ZERO);
        let before = s.request_count();
        let out = block_on(sign_in_wait_at(&ep(&s), &dir, &store, &net, &gh, Some("c2"), &pace)).unwrap();
        assert_eq!(out, SignInOutcome::Cancelled);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(s.request_count(), before);
        assert!(!dir.join("github").join("account.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_token_without_repo_scope_is_not_stored() {
        let dir = dirs("gh-auth-scope");
        let store = MemoryStore::default();
        let gh = GithubState::default();
        let answers = vec![device_code(5), token_answer(GHO, Some(GHR)), user(Some("read:org"))];
        let (out, _, _) = sign_in(&dir, &store, &gh, answers);
        assert_eq!(out, SignInOutcome::ScopeMissing);
        assert_eq!(stored(&store, Slot::Github), None);
        assert_eq!(stored(&store, Slot::GithubRefresh), None);
        assert!(!gh.has_memory_token());
        assert!(!dir.join("github").join("account.json").exists());
        assert!(has_repo_scope(&KeptHeaders(vec![("x-oauth-scopes".into(), "read:org,repo".into())])));
        assert!(!has_repo_scope(&KeptHeaders(vec![("x-oauth-scopes".into(), "public_repo".into())])));
        assert!(!has_repo_scope(&KeptHeaders(vec![("x-oauth-scopes".into(), "".into())])));
        assert!(has_repo_scope(&KeptHeaders::default()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_refresh_token_is_stored_with_the_token() {
        let dir = dirs("gh-auth-refresh-store");
        let store = MemoryStore::default();
        let gh = GithubState::default();
        let answers = vec![device_code(5), token_answer(GHO, Some(GHR)), user(None)];
        let (out, _, _) = sign_in(&dir, &store, &gh, answers);
        assert!(matches!(out, SignInOutcome::SignedIn { .. }));
        assert_eq!(stored(&store, Slot::Github).as_deref(), Some(GHO));
        assert_eq!(stored(&store, Slot::GithubRefresh).as_deref(), Some(GHR));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forget_on_exit_keeps_the_token_in_memory_only() {
        let dir = dirs("gh-auth-forget");
        set_forget(&dir, true);
        let store = MemoryStore::default();
        let gh = GithubState::default();
        let (out, _, _) = sign_in(&dir, &store, &gh, vec![device_code(5), token_answer(GHO, Some(GHR)), user(Some("repo"))]);
        assert!(matches!(out, SignInOutcome::SignedIn { .. }));
        // The keychain is untouched (not even an epoch).
        assert_untouched(&store);
        assert_eq!(token(&gh, &store).unwrap().as_deref().map(String::as_str), Some(GHO));
        assert_eq!(refresh_token(&gh, &store).unwrap().as_deref().map(String::as_str), Some(GHR));
        assert_eq!(account_at(&dir, &store, &gh).unwrap().unwrap().login, "kim-lab");
        // The exit hook zeroizes it and forgets the account.
        gh.on_exit(Some(&dir));
        assert!(!gh.has_memory_token());
        assert_eq!(token(&gh, &store).unwrap(), None);
        assert_eq!(account_at(&dir, &store, &gh).unwrap(), None);
        assert!(!dir.join("github").join("account.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn turning_forget_on_exit_on_moves_the_keychain_token_into_memory() {
        let dir = dirs("gh-auth-move");
        let store = MemoryStore::default();
        let gh = GithubState::default();
        let cfg = fixed_cfg();
        store_secret(&store, Slot::Github, &cfg, GHP).unwrap();
        store_secret(&store, Slot::GithubRefresh, &cfg, GHR).unwrap();
        let patch: GithubAppSettingsPatch = serde_json::from_str(r#"{"forgetOnExit":true}"#).unwrap();
        app_settings_set_at(&dir, &store, &gh, patch).unwrap();
        assert_eq!(stored(&store, Slot::Github), None);
        assert_eq!(stored(&store, Slot::GithubRefresh), None);
        assert_eq!(token(&gh, &store).unwrap().as_deref().map(String::as_str), Some(GHP));
        // Turning it off keeps the memory token (until the next sign-in).
        let patch: GithubAppSettingsPatch = serde_json::from_str(r#"{"forgetOnExit":false}"#).unwrap();
        app_settings_set_at(&dir, &store, &gh, patch).unwrap();
        assert_eq!(token(&gh, &store).unwrap().as_deref().map(String::as_str), Some(GHP));
        assert_eq!(stored(&store, Slot::Github), None);
        gh.on_exit(Some(&dir));
        assert_eq!(token(&gh, &store).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn debug_never_shows_a_token_or_the_device_code() {
        let gh = GithubState::default();
        gh.set_device(session());
        gh.set_memory(Zeroizing::new(GHO.into()), Some(Zeroizing::new(GHR.into())));
        let shown = format!("{gh:?} {:?}", session());
        for secret in [GHO, GHR, DEVICE_CODE] {
            assert!(!shown.contains(secret), "{shown}");
        }
        assert!(shown.contains("***"), "{shown}");
    }

    #[test]
    fn no_client_id_is_not_configured_and_sends_nothing() {
        if github_client_id(&GithubAppSettings::default()).is_some() {
            return; // a build with a built-in client ID has no unconfigured state
        }
        let dir = scratch_dir("gh-auth-noid");
        let s = serve(vec![device_code(5)]);
        let pace = FakePace::new(Duration::ZERO);
        let out = block_on(sign_in_start_at(&ep(&s), &dir, &NetState::default(), &GithubState::default(), &pace));
        assert_eq!(out.unwrap(), SignInStart::NotConfigured);
        assert_eq!(serde_json::to_value(SignInStart::NotConfigured).unwrap(), json!({"outcome": "notConfigured"}));
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(s.request_count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_foreign_verification_uri_is_replaced() {
        let dir = dirs("gh-auth-uri");
        for (given, want) in [
            ("https://evil.example/login/device", VERIFICATION_URI.to_string()),
            ("https://github.com/login/device?x=1", VERIFICATION_URI.to_string()),
            ("javascript:alert(1)", VERIFICATION_URI.to_string()),
        ] {
            let s = serve(vec![Canned::ok(&format!(
                "{{\"device_code\":\"d\",\"user_code\":\"A-B\",\"verification_uri\":\"{given}\",\"expires_in\":900,\"interval\":5}}"
            ))]);
            let pace = FakePace::new(Duration::ZERO);
            let out = block_on(sign_in_start_at(&ep(&s), &dir, &NetState::default(), &GithubState::default(), &pace)).unwrap();
            let SignInStart::Started { verification_uri, .. } = out else { panic!("{out:?}") };
            assert_eq!(verification_uri, want, "{given}");
        }
        // The test base's own page is kept (the fake device-flow server).
        let s = serve(vec![]);
        let page = format!("{}/login/device", s.url);
        assert_eq!(verification_uri(&ep(&s), Some(page.clone())), page);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sign_out_clears_everything() {
        let dir = dirs("gh-auth-signout");
        let store = MemoryStore::default();
        let gh = GithubState::default();
        let cfg = fixed_cfg();
        store_secret(&store, Slot::Github, &cfg, GHP).unwrap();
        store_secret(&store, Slot::GithubRefresh, &cfg, GHR).unwrap();
        gh.set_memory(Zeroizing::new(GHO.into()), None);
        gh.set_device(session());
        write_doc(&dir, None, GithubDoc::Account, &Account { login: "kim-lab".into(), id: 1, avatar_url: String::new() }).unwrap();
        gh.sign_out(&dir, &store).unwrap();
        let st = status_of(&store, &cfg);
        assert!(!st.set.github && !st.set.github_refresh);
        assert!(!gh.has_memory_token() && lock(&gh.device).is_none());
        assert!(!dir.join("github").join("account.json").exists());
        assert_eq!(account_at(&dir, &store, &gh).unwrap(), None);
        // The app settings stay.
        assert!(dir.join("github").join("app.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pasted_token_of_the_wrong_shape_sends_nothing() {
        let dir = dirs("gh-auth-pat-bad");
        let s = serve(vec![user(Some("repo"))]);
        let (net, gh, store) = (NetState::default(), GithubState::default(), MemoryStore::default());
        for bad in ["xyz", "", "ghr_FAKE", "ghs_FAKEinstallation"] {
            assert_eq!(block_on(set_token_at(&ep(&s), &dir, &store, &net, &gh, bad)).unwrap(), TokenOutcome::BadToken);
        }
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(s.request_count(), 0);
        assert_untouched(&store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pasted_tokens_are_checked_with_github_before_storing() {
        let dir = dirs("gh-auth-pat");
        let (net, gh, store) = (NetState::default(), GithubState::default(), MemoryStore::default());
        // Fine-grained: no scopes header.
        let s = serve(vec![user(None)]);
        let out = block_on(set_token_at(&ep(&s), &dir, &store, &net, &gh, &format!("  {PAT} "))).unwrap();
        assert_eq!(out, TokenOutcome::Saved { login: "kim-lab".into(), fine_grained: true });
        assert_eq!(serde_json::to_value(&out).unwrap(), json!({"outcome": "saved", "login": "kim-lab", "fineGrained": true}));
        assert_eq!(stored(&store, Slot::Github).as_deref(), Some(PAT));
        let bearer = format!("Bearer {PAT}");
        assert_eq!(s.requests.lock().unwrap()[0].header("authorization"), Some(bearer.as_str()));
        // A classic token with repo.
        let s = serve(vec![user(Some("repo, read:org"))]);
        let out = block_on(set_token_at(&ep(&s), &dir, &store, &net, &gh, GHP)).unwrap();
        assert_eq!(out, TokenOutcome::Saved { login: "kim-lab".into(), fine_grained: false });
        assert_eq!(stored(&store, Slot::Github).as_deref(), Some(GHP));
        // GitHub refuses it, or it lacks repo: the stored token stays as it was.
        let s = serve(vec![Canned::status(401).body("{\"message\":\"Bad credentials\"}"), user(Some("gist"))]);
        let other = "ghp_FAKEother000000000000000000000000000";
        assert_eq!(block_on(set_token_at(&ep(&s), &dir, &store, &net, &gh, other)).unwrap(), TokenOutcome::NeedsSignIn);
        assert_eq!(block_on(set_token_at(&ep(&s), &dir, &store, &net, &gh, other)).unwrap(), TokenOutcome::ScopeMissing);
        assert_eq!(stored(&store, Slot::Github).as_deref(), Some(GHP));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_401_with_a_refresh_token_refreshes_once_then_retries() {
        let dir = dirs("gh-auth-401");
        let (net, gh, store) = (NetState::default(), GithubState::default(), MemoryStore::default());
        let cfg = fixed_cfg();
        store_secret(&store, Slot::Github, &cfg, GHO).unwrap();
        store_secret(&store, Slot::GithubRefresh, &cfg, GHR).unwrap();
        let s = serve(vec![Canned::status(401), token_answer(GHO2, Some(GHR2)), user(Some("repo"))]);
        let reply = block_on(call_authed(&ep(&s), &dir, &store, &net, &gh, None, GithubCall::User, None)).unwrap();
        assert_eq!(classify(&GithubCall::User, &reply), ApiOutcome::Ok);
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs.len(), 3);
        assert_eq!(reqs[1].path, "/login/oauth/access_token");
        assert!(reqs[1].body.contains("\"grant_type\":\"refresh_token\"") && reqs[1].body.contains(GHR));
        let bearer = format!("Bearer {GHO2}");
        assert_eq!(reqs[2].header("authorization"), Some(bearer.as_str()));
        assert_eq!(stored(&store, Slot::Github).as_deref(), Some(GHO2));
        assert_eq!(stored(&store, Slot::GithubRefresh).as_deref(), Some(GHR2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_refresh_is_needs_sign_in_and_never_a_new_device_flow() {
        let dir = dirs("gh-auth-badrefresh");
        let (net, gh, store) = (NetState::default(), GithubState::default(), MemoryStore::default());
        let cfg = fixed_cfg();
        store_secret(&store, Slot::Github, &cfg, GHO).unwrap();
        store_secret(&store, Slot::GithubRefresh, &cfg, GHR).unwrap();
        let s = serve(vec![Canned::status(401), poll("bad_refresh_token"), device_code(5)]);
        let reply = block_on(call_authed(&ep(&s), &dir, &store, &net, &gh, None, GithubCall::User, None)).unwrap();
        assert_eq!(classify(&GithubCall::User, &reply), ApiOutcome::NeedsSignIn);
        std::thread::sleep(Duration::from_millis(50));
        let reqs = s.requests.lock().unwrap();
        assert_eq!(reqs.len(), 2);
        assert!(reqs.iter().all(|r| r.path != "/login/device/code"));
        // The dead refresh token is forgotten; the access token is left alone.
        assert_eq!(stored(&store, Slot::GithubRefresh), None);
        assert_eq!(stored(&store, Slot::Github).as_deref(), Some(GHO));
        drop(reqs);
        // Without a refresh token a 401 is simply the answer (one request).
        let s = serve(vec![Canned::status(401), device_code(5)]);
        let reply = block_on(call_authed(&ep(&s), &dir, &store, &net, &gh, None, GithubCall::User, None)).unwrap();
        assert_eq!(classify(&GithubCall::User, &reply), ApiOutcome::NeedsSignIn);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(s.request_count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_token_at_all_is_needs_sign_in_with_nothing_sent() {
        let dir = dirs("gh-auth-none");
        let s = serve(vec![user(Some("repo"))]);
        let (net, gh, store) = (NetState::default(), GithubState::default(), MemoryStore::default());
        let reply = block_on(call_authed(&ep(&s), &dir, &store, &net, &gh, None, GithubCall::User, None)).unwrap();
        assert_eq!(classify(&GithubCall::User, &reply), ApiOutcome::NeedsSignIn);
        assert_eq!(account_at(&dir, &store, &gh).unwrap(), None);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(s.request_count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
