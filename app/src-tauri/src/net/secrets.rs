//! Integration keys, kept only in Windows Credential Manager (D6).
//!
//! Each key lives under service `kr.sblab.labnoteo`, account
//! `"<slot>|<origin>"`, where `origin` is the normalized origin of the URL the
//! open vault's settings name for that slot. A key is therefore bound to the
//! server it was entered for: after the URL changes, the key reads "not set".
//! `bfwDesktop` uses the fixed origin `loopback` (its port changes per launch),
//! and `slackBot` the fixed origin `https://slack.com` (only a bot token,
//! `xoxb-…`, is accepted for it). `github` and `githubRefresh` use the fixed
//! origin `https://github.com`; they are written only by the GitHub sign-in
//! (Rust), never through `secret_set` / `secret_clear`.
//!
//! No function here returns a key to the webview, and no error message ever
//! contains one: the webview learns only a `set` flag and an `epoch` counter,
//! kept under the non-secret account `"epoch|<slot>|<origin>"`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::config::{origin, ServiceConfig, Url};
use super::error::{NetError, NetErrorKind};
use crate::vault::{SettingsFile, VaultState};

/// The Credential Manager service every key is stored under.
pub const SERVICE: &str = "kr.sblab.labnoteo";

/// Longest key accepted, in bytes.
const MAX_SECRET: usize = 4096;

/// The fixed origin the Slack bot token is bound to.
const SLACK_ORIGIN: &str = "https://slack.com";

/// The fixed origin the GitHub tokens are bound to.
pub const GITHUB_ORIGIN: &str = "https://github.com";

/// Appended to the GitHub slots' accounts in a build with the cargo feature
/// `github-test-endpoints` (P-R15), so a test build driven against the fakes
/// never reads or overwrites a real GitHub token in the same service. Empty
/// in every other build.
pub const GITHUB_ACCOUNT_SUFFIX: &str = if cfg!(feature = "github-test-endpoints") { "|test-build" } else { "" };

/// Where keys are kept. The app uses `KeyringStore`; tests use `MemoryStore`.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, NetError>;
    fn set(&self, account: &str, value: &str) -> Result<(), NetError>;
    fn delete(&self, account: &str) -> Result<(), NetError>;
}

/// The one message for every keychain failure: the crate's own error text is
/// never passed on, so nothing it might echo can reach the webview.
fn keychain_error() -> NetError {
    NetError::new(NetErrorKind::Keychain, "Windows Credential Manager refused the request")
}

/// Windows Credential Manager through the `keyring` crate.
pub struct KeyringStore;

impl KeyringStore {
    fn entry(account: &str) -> Result<keyring::Entry, NetError> {
        keyring::Entry::new(SERVICE, account).map_err(|_| keychain_error())
    }
}

impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, NetError> {
        match Self::entry(account)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(keychain_error()),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), NetError> {
        Self::entry(account)?.set_password(value).map_err(|_| keychain_error())
    }

    fn delete(&self, account: &str) -> Result<(), NetError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(keychain_error()),
        }
    }
}

/// An in-memory store for tests (never the real Credential Manager).
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, NetError> {
        Ok(self.0.lock().unwrap_or_else(|e| e.into_inner()).get(account).cloned())
    }

    fn set(&self, account: &str, value: &str) -> Result<(), NetError> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), NetError> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(account);
        Ok(())
    }
}

/// The managed store every command uses.
pub struct Secrets(pub Arc<dyn SecretStore>);

impl Secrets {
    pub fn keyring() -> Self {
        Secrets(Arc::new(KeyringStore))
    }

    pub fn memory() -> Self {
        Secrets(Arc::new(MemoryStore::default()))
    }
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Slot {
    PartbankDesktop,
    PartbankWeb,
    LlmOpenai,
    BfwServer,
    BfwDesktop,
    SlackBot,
    /// The GitHub access token (device flow or a pasted token).
    Github,
    /// The GitHub refresh token, when the OAuth App issues expiring tokens.
    GithubRefresh,
}

impl Slot {
    /// The GitHub slots, which only the GitHub sign-in writes.
    pub fn is_github(self) -> bool {
        matches!(self, Slot::Github | Slot::GithubRefresh)
    }

    /// The camelCase name, as the webview spells it.
    pub fn name(self) -> &'static str {
        match self {
            Slot::PartbankDesktop => "partbankDesktop",
            Slot::PartbankWeb => "partbankWeb",
            Slot::LlmOpenai => "llmOpenai",
            Slot::BfwServer => "bfwServer",
            Slot::BfwDesktop => "bfwDesktop",
            Slot::SlackBot => "slackBot",
            Slot::Github => "github",
            Slot::GithubRefresh => "githubRefresh",
        }
    }

    /// The URL the slot's key is bound to (`None` for the fixed-origin slots
    /// `BfwDesktop`, `SlackBot`, `Github` and `GithubRefresh`).
    fn url(self, cfg: &ServiceConfig) -> Option<&Url> {
        match self {
            Slot::PartbankDesktop => cfg.partbank_desktop.as_ref(),
            Slot::PartbankWeb => cfg.partbank_web.as_ref(),
            Slot::LlmOpenai => cfg.llm_openai.as_ref(),
            Slot::BfwServer => cfg.bfw_url.as_ref(),
            Slot::BfwDesktop | Slot::SlackBot | Slot::Github | Slot::GithubRefresh => None,
        }
    }
}

/// `"<slotName>|<origin>"`, `"bfwDesktop|loopback"`,
/// `"slackBot|https://slack.com"`, `"github|https://github.com"` or
/// `"githubRefresh|https://github.com"` (whatever the config is; a build with
/// `github-test-endpoints` appends `|test-build` to the GitHub ones). A slot whose URL is
/// missing or invalid is `notConfigured`.
pub fn account(slot: Slot, cfg: &ServiceConfig) -> Result<String, NetError> {
    match slot {
        Slot::BfwDesktop => return Ok(format!("{}|loopback", slot.name())),
        Slot::SlackBot => return Ok(format!("{}|{SLACK_ORIGIN}", slot.name())),
        Slot::Github | Slot::GithubRefresh => {
            return Ok(format!("{}|{GITHUB_ORIGIN}{GITHUB_ACCOUNT_SUFFIX}", slot.name()))
        }
        _ => {}
    }
    let url = slot.url(cfg).ok_or_else(|| {
        NetError::new(NetErrorKind::NotConfigured, format!("no valid address is set for {}", slot.name()))
    })?;
    Ok(format!("{}|{}", slot.name(), origin(url)))
}

/// `"epoch|" + account(slot, cfg)`: a non-secret counter bumped on every save
/// or removal of the slot's key.
pub fn epoch_account(slot: Slot, cfg: &ServiceConfig) -> Result<String, NetError> {
    Ok(format!("epoch|{}", account(slot, cfg)?))
}

/// The trimmed key: 1..=4096 bytes with no control chars. The error message
/// never includes the value.
pub fn validate_secret(value: &str) -> Result<String, NetError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_SECRET || trimmed.chars().any(char::is_control) {
        return Err(NetError::new(
            NetErrorKind::BadInput,
            "the key must be 1 to 4096 bytes long with no control characters",
        ));
    }
    Ok(trimmed.to_string())
}

/// The token prefixes the GitHub access-token slot takes: classic and
/// fine-grained personal tokens, OAuth and GitHub App user tokens.
const GITHUB_TOKEN_PREFIXES: [&str; 4] = ["ghp_", "github_pat_", "gho_", "ghu_"];

/// `validate_secret`, plus the slot's own rule: the Slack bot slot only takes a
/// bot token (`xoxb-…`), the GitHub slot a `ghp_` / `github_pat_` / `gho_` /
/// `ghu_` token and the GitHub refresh slot a `ghr_` token. The error message
/// never includes the value.
pub fn validate_secret_for(slot: Slot, value: &str) -> Result<String, NetError> {
    let key = validate_secret(value)?;
    let refused = |msg: &str| Err(NetError::new(NetErrorKind::BadInput, msg));
    match slot {
        Slot::SlackBot if !key.starts_with("xoxb-") => {
            refused("the Slack token must be a bot token starting with xoxb-")
        }
        Slot::Github if !GITHUB_TOKEN_PREFIXES.iter().any(|p| key.starts_with(p)) => {
            refused("this is not a GitHub token (it starts with ghp_, github_pat_, gho_ or ghu_)")
        }
        Slot::GithubRefresh if !key.starts_with("ghr_") => refused("this is not a GitHub refresh token"),
        _ => Ok(key),
    }
}

/// The slot's key for the configured origin, if one is stored.
pub fn key_for(store: &dyn SecretStore, slot: Slot, cfg: &ServiceConfig) -> Result<Option<String>, NetError> {
    store.get(&account(slot, cfg)?)
}

fn read_epoch(store: &dyn SecretStore, epoch_acc: &str) -> u64 {
    store.get(epoch_acc).ok().flatten().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

fn bump_epoch(store: &dyn SecretStore, slot: Slot, cfg: &ServiceConfig) -> Result<(), NetError> {
    let acc = epoch_account(slot, cfg)?;
    let next = read_epoch(store, &acc).saturating_add(1);
    store.set(&acc, &next.to_string())
}

/// Validates the key with the slot's rule (`validate_secret_for`) and stores
/// it, then bumps its epoch. A refused key stores nothing.
pub fn store_secret(store: &dyn SecretStore, slot: Slot, cfg: &ServiceConfig, value: &str) -> Result<(), NetError> {
    let account = account(slot, cfg)?;
    let key = validate_secret_for(slot, value)?;
    store_valid(store, &account, &key)
}

/// Validates and stores a key under an account built by `account` (or the
/// same `"<slot>|<origin>"` shape), then bumps `"epoch|<account>"`. Used by the
/// plugin LLM key import, whose origin comes from `data.json` (D9).
pub fn store_at_account(store: &dyn SecretStore, account: &str, value: &str) -> Result<(), NetError> {
    let key = validate_secret(value)?;
    store_valid(store, account, &key)
}

/// Validates the key with the slot's rule and stores it under the origin of
/// `url` (not the origin the stored settings name), then bumps its epoch.
/// Used by the connection-file import, which saves the URL and the key
/// together. Only for slots bound to a URL; the fixed-origin slots are
/// `badInput`. A refused key stores nothing, and no error names the value.
pub fn store_secret_at_url(store: &dyn SecretStore, slot: Slot, url: &Url, value: &str) -> Result<(), NetError> {
    if matches!(slot, Slot::BfwDesktop | Slot::SlackBot | Slot::Github | Slot::GithubRefresh) {
        return Err(NetError::new(NetErrorKind::BadInput, "this slot is not bound to a URL"));
    }
    let key = validate_secret_for(slot, value)?;
    store_valid(store, &format!("{}|{}", slot.name(), origin(url)), &key)
}

/// Stores an already validated key, then bumps `"epoch|<account>"`.
fn store_valid(store: &dyn SecretStore, account: &str, key: &str) -> Result<(), NetError> {
    store.set(account, key)?;
    let epoch_acc = format!("epoch|{account}");
    let next = read_epoch(store, &epoch_acc).saturating_add(1);
    store.set(&epoch_acc, &next.to_string())
}

/// Deletes the slot's key (a missing key is fine), then bumps its epoch.
pub fn clear_secret(store: &dyn SecretStore, slot: Slot, cfg: &ServiceConfig) -> Result<(), NetError> {
    store.delete(&account(slot, cfg)?)?;
    bump_epoch(store, slot, cfg)
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlotValues<T> {
    pub partbank_desktop: T,
    pub partbank_web: T,
    pub llm_openai: T,
    pub bfw_server: T,
    pub bfw_desktop: T,
    pub slack_bot: T,
    pub github: T,
    pub github_refresh: T,
}

impl<T> SlotValues<T> {
    fn from_fn(mut f: impl FnMut(Slot) -> T) -> Self {
        SlotValues {
            partbank_desktop: f(Slot::PartbankDesktop),
            partbank_web: f(Slot::PartbankWeb),
            llm_openai: f(Slot::LlmOpenai),
            bfw_server: f(Slot::BfwServer),
            bfw_desktop: f(Slot::BfwDesktop),
            slack_bot: f(Slot::SlackBot),
            github: f(Slot::Github),
            github_refresh: f(Slot::GithubRefresh),
        }
    }
}

/// What the webview may know about the keys: whether each is set, and its epoch.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct SecretStatus {
    pub set: SlotValues<bool>,
    pub epoch: SlotValues<u64>,
}

/// The status for the configured origins. A `notConfigured` slot (or one the
/// keychain cannot read) reads `false` and epoch `0`.
pub fn status_of(store: &dyn SecretStore, cfg: &ServiceConfig) -> SecretStatus {
    SecretStatus {
        set: SlotValues::from_fn(|slot| matches!(key_for(store, slot, cfg), Ok(Some(_)))),
        epoch: SlotValues::from_fn(|slot| epoch_account(slot, cfg).map_or(0, |acc| read_epoch(store, &acc))),
    }
}

/// The open vault's service config, or `notConfigured` with no vault open.
fn current_config(vault: &VaultState, settings: &SettingsFile) -> Result<ServiceConfig, NetError> {
    ServiceConfig::load(&settings.0, vault.root().ok().as_deref())
}

/// The webview's key commands never write the GitHub slots: only the GitHub
/// sign-in (Rust) does, after checking the token with GitHub.
fn refuse_github(slot: Slot) -> Result<(), NetError> {
    if slot.is_github() {
        return Err(NetError::new(NetErrorKind::BadInput, "GitHub keys are managed by the GitHub settings"));
    }
    Ok(())
}

#[tauri::command]
pub fn secret_set(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    slot: Slot,
    value: String,
) -> Result<(), NetError> {
    refuse_github(slot)?;
    let cfg = current_config(&vault, &settings)?;
    store_secret(secrets.0.as_ref(), slot, &cfg, &value)
}

#[tauri::command]
pub fn secret_clear(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    slot: Slot,
) -> Result<(), NetError> {
    refuse_github(slot)?;
    let cfg = current_config(&vault, &settings)?;
    clear_secret(secrets.0.as_ref(), slot, &cfg)
}

#[tauri::command]
pub fn secret_status(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
) -> Result<SecretStatus, NetError> {
    let cfg = current_config(&vault, &settings)?;
    Ok(status_of(secrets.0.as_ref(), &cfg))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(json: &str) -> ServiceConfig { ServiceConfig::from_settings_json(json) }

    #[test] fn account_names_slot_and_origin() {
        let c = cfg(r#"{"partbankWebUrl":"https://PB.example/"}"#);
        assert_eq!(account(Slot::PartbankWeb, &c).unwrap(), "partbankWeb|https://pb.example");
        assert_eq!(account(Slot::BfwDesktop, &c).unwrap(), "bfwDesktop|loopback");
    }
    #[test] fn key_is_bound_to_origin() {
        let store = MemoryStore::default();
        let a = cfg(r#"{"partbankWebUrl":"https://a.example"}"#);
        store.set(&account(Slot::PartbankWeb, &a).unwrap(), "pbk_1").unwrap();
        assert!(status_of(&store, &a).set.partbank_web);
        let b = cfg(r#"{"partbankWebUrl":"https://b.example"}"#);
        assert!(!status_of(&store, &b).set.partbank_web);
        assert_eq!(key_for(&store, Slot::PartbankWeb, &b).unwrap(), None);
    }
    #[test] fn validate_secret_rules() {
        assert_eq!(validate_secret("  pbk_x \n").unwrap(), "pbk_x");
        assert_eq!(validate_secret("").unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(validate_secret(&"a".repeat(4097)).unwrap_err().kind, NetErrorKind::BadInput);
        let e = validate_secret("a\u{0007}b").unwrap_err();
        assert!(!e.message.contains("a\u{0007}b"));
    }
    #[test] fn status_serializes_flags_and_epochs_only() {
        let v = serde_json::to_value(status_of(&MemoryStore::default(), &cfg("{}"))).unwrap();
        assert_eq!(v, serde_json::json!({
            "set": {"partbankDesktop":false,"partbankWeb":false,"llmOpenai":false,"bfwServer":false,"bfwDesktop":false,"slackBot":false,"github":false,"githubRefresh":false},
            "epoch": {"partbankDesktop":0,"partbankWeb":0,"llmOpenai":0,"bfwServer":0,"bfwDesktop":0,"slackBot":0,"github":0,"githubRefresh":0}}));
    }
    #[test] fn slack_slot_has_fixed_origin() {
        assert_eq!(account(Slot::SlackBot, &cfg("{}")).unwrap(), "slackBot|https://slack.com");
        let c = cfg(r#"{"partbankWebUrl":"https://a.example","llmBaseUrl":"https://b.example"}"#);
        assert_eq!(account(Slot::SlackBot, &c).unwrap(), "slackBot|https://slack.com");
        assert_eq!(Slot::SlackBot.name(), "slackBot");
        let slot: Slot = serde_json::from_str("\"slackBot\"").unwrap();
        assert_eq!(slot, Slot::SlackBot);
    }
    #[test] fn slack_token_needs_xoxb() {
        assert_eq!(validate_secret_for(Slot::SlackBot, "xoxp-1").unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(validate_secret_for(Slot::SlackBot, " xoxb-1 ").unwrap(), "xoxb-1");
        assert_eq!(validate_secret_for(Slot::LlmOpenai, "xoxp-1").unwrap(), "xoxp-1");
        let e = validate_secret_for(Slot::SlackBot, "xoxp-secretvalue").unwrap_err();
        assert!(!e.message.contains("xoxp-secretvalue"));
        assert_eq!(validate_secret_for(Slot::SlackBot, "").unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(validate_secret_for(Slot::SlackBot, "xoxb-\u{7}").unwrap_err().kind, NetErrorKind::BadInput);
    }
    #[test] fn store_secret_refuses_a_non_bot_slack_token_and_stores_nothing() {
        let store = MemoryStore::default();
        assert_eq!(store_secret(&store, Slot::SlackBot, &cfg("{}"), "xoxp-1").unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(store.get("slackBot|https://slack.com").unwrap(), None);
        assert_eq!(store.get("epoch|slackBot|https://slack.com").unwrap(), None);
        store_secret(&store, Slot::SlackBot, &cfg("{}"), " xoxb-ok ").unwrap();
        assert_eq!(store.get("slackBot|https://slack.com").unwrap().as_deref(), Some("xoxb-ok"));
        let st = status_of(&store, &cfg("{}"));
        assert_eq!((st.set.slack_bot, st.epoch.slack_bot), (true, 1));
    }
    #[test] fn saving_a_key_bumps_the_epoch() {
        let store = MemoryStore::default(); let c = cfg(r#"{"partbankWebUrl":"https://a.example"}"#);
        store_secret(&store, Slot::PartbankWeb, &c, "pbk_a").unwrap();
        store_secret(&store, Slot::PartbankWeb, &c, "pbk_b").unwrap();
        assert_eq!(status_of(&store, &c).epoch.partbank_web, 2);
        clear_secret(&store, Slot::PartbankWeb, &c).unwrap();
        let st = status_of(&store, &c);
        assert_eq!((st.set.partbank_web, st.epoch.partbank_web), (false, 3));
        assert_eq!(store.get("epoch|partbankWeb|https://a.example").unwrap().as_deref(), Some("3"));
    }
    #[test] fn store_secret_at_url_binds_the_key_to_that_url() {
        let store = MemoryStore::default();
        let url = super::super::config::parse_origin_url("https://PB.example/").unwrap();
        store_secret_at_url(&store, Slot::PartbankWeb, &url, " pbk_u ").unwrap();
        assert_eq!(store.get("partbankWeb|https://pb.example").unwrap().as_deref(), Some("pbk_u"));
        assert_eq!(store.get("epoch|partbankWeb|https://pb.example").unwrap().as_deref(), Some("1"));
        assert_eq!(store_secret_at_url(&store, Slot::SlackBot, &url, "xoxb-1").unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(store_secret_at_url(&store, Slot::PartbankWeb, &url, "").unwrap_err().kind, NetErrorKind::BadInput);
    }
    /// The account of a GitHub slot in this build.
    fn gh(slot: &str) -> String {
        format!("{slot}|https://github.com{GITHUB_ACCOUNT_SUFFIX}")
    }
    #[test] fn github_accounts_end_in_test_build_only_with_the_test_feature() {
        let c = cfg("{}");
        if cfg!(feature = "github-test-endpoints") {
            assert_eq!(account(Slot::Github, &c).unwrap(), "github|https://github.com|test-build");
            assert_eq!(account(Slot::GithubRefresh, &c).unwrap(), "githubRefresh|https://github.com|test-build");
            assert_eq!(epoch_account(Slot::Github, &c).unwrap(), "epoch|github|https://github.com|test-build");
        } else {
            assert_eq!(account(Slot::Github, &c).unwrap(), "github|https://github.com");
            assert_eq!(account(Slot::GithubRefresh, &c).unwrap(), "githubRefresh|https://github.com");
            assert_eq!(epoch_account(Slot::Github, &c).unwrap(), "epoch|github|https://github.com");
        }
        // The suffix never touches another slot.
        assert_eq!(account(Slot::SlackBot, &c).unwrap(), "slackBot|https://slack.com");
    }
    #[test] fn github_slots_have_the_fixed_github_origin() {
        // Even with no vault URL configured, and whatever the vault names.
        assert_eq!(account(Slot::Github, &cfg("{}")).unwrap(), gh("github"));
        assert_eq!(account(Slot::GithubRefresh, &cfg("{}")).unwrap(), gh("githubRefresh"));
        let c = cfg(r#"{"partbankWebUrl":"https://a.example","llmEndpointOpenai":"bogus"}"#);
        assert_eq!(account(Slot::Github, &c).unwrap(), gh("github"));
        assert_eq!(Slot::Github.name(), "github");
        assert_eq!(Slot::GithubRefresh.name(), "githubRefresh");
        assert!(Slot::Github.url(&c).is_none() && Slot::GithubRefresh.url(&c).is_none());
        assert_eq!(serde_json::from_str::<Slot>("\"github\"").unwrap(), Slot::Github);
        assert_eq!(serde_json::from_str::<Slot>("\"githubRefresh\"").unwrap(), Slot::GithubRefresh);
        assert!(Slot::Github.is_github() && Slot::GithubRefresh.is_github() && !Slot::SlackBot.is_github());
    }
    #[test] fn github_token_prefixes() {
        for ok in ["ghp_x", "github_pat_x", "gho_x", "ghu_x"] {
            assert_eq!(validate_secret_for(Slot::Github, ok).unwrap(), ok);
        }
        for bad in ["abc", "ghr_x", "ghs_x", "xoxb-1", ""] {
            assert_eq!(validate_secret_for(Slot::Github, bad).unwrap_err().kind, NetErrorKind::BadInput, "{bad}");
        }
        assert_eq!(validate_secret_for(Slot::GithubRefresh, "ghr_x").unwrap(), "ghr_x");
        assert_eq!(validate_secret_for(Slot::GithubRefresh, "ghp_x").unwrap_err().kind, NetErrorKind::BadInput);
        let e = validate_secret_for(Slot::Github, "secretvalue123").unwrap_err();
        assert!(!e.message.contains("secretvalue123"));
    }
    #[test] fn store_secret_keeps_a_github_token_and_bumps_its_epoch() {
        let store = MemoryStore::default();
        store_secret(&store, Slot::Github, &cfg("{}"), " ghp_xFAKE ").unwrap();
        assert_eq!(store.get(&gh("github")).unwrap().as_deref(), Some("ghp_xFAKE"));
        let st = status_of(&store, &cfg("{}"));
        assert_eq!((st.set.github, st.epoch.github, st.set.github_refresh), (true, 1, false));
        assert_eq!(store_secret(&store, Slot::GithubRefresh, &cfg("{}"), "ghp_x").unwrap_err().kind, NetErrorKind::BadInput);
        assert_eq!(store.get(&gh("githubRefresh")).unwrap(), None);
    }
    #[test] fn store_secret_at_url_refuses_the_github_slots() {
        let store = MemoryStore::default();
        let url = super::super::config::parse_origin_url("https://github.com").unwrap();
        for slot in [Slot::Github, Slot::GithubRefresh] {
            assert_eq!(store_secret_at_url(&store, slot, &url, "ghp_x").unwrap_err().kind, NetErrorKind::BadInput);
        }
        assert_eq!(store.get(&gh("github")).unwrap(), None);
    }
    #[test] fn webview_secret_commands_refuse_the_github_slots() {
        for slot in [Slot::Github, Slot::GithubRefresh] {
            let e = refuse_github(slot).unwrap_err();
            assert_eq!(e.kind, NetErrorKind::BadInput);
            assert_eq!(e.message, "GitHub keys are managed by the GitHub settings");
        }
        assert!(refuse_github(Slot::SlackBot).is_ok());
    }
    #[test] #[ignore = "touches the real Credential Manager; run by hand"] fn keyring_roundtrip() {
        let s = KeyringStore; let acc = "test|labnoteo-sp6";
        s.set(acc, "v").unwrap(); assert_eq!(s.get(acc).unwrap().as_deref(), Some("v"));
        s.delete(acc).unwrap(); assert_eq!(s.get(acc).unwrap(), None);
    }
}
