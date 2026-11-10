//! Integration keys, kept only in Windows Credential Manager (D6).
//!
//! Each key lives under service `kr.sblab.labnoteo`, account
//! `"<slot>|<origin>"`, where `origin` is the normalized origin of the URL the
//! open vault's settings name for that slot. A key is therefore bound to the
//! server it was entered for: after the URL changes, the key reads "not set".
//! `bfwDesktop` uses the fixed origin `loopback` (its port changes per launch),
//! and `slackBot` the fixed origin `https://slack.com` (only a bot token,
//! `xoxb-…`, is accepted for it).
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
pub struct MemoryStore {
    map: Mutex<HashMap<String, String>>,
    /// When set, a value longer than this many chars is refused like the
    /// Credential Manager refuses one (1,280 chars through `keyring`).
    limit: Option<usize>,
}

impl MemoryStore {
    /// A store that refuses values over `chars` chars, so the tests exercise
    /// the chunking of long tokens.
    pub fn with_entry_limit(chars: usize) -> Self {
        MemoryStore { map: Mutex::default(), limit: Some(chars) }
    }

    /// The accounts stored, sorted (tests check what is left behind).
    pub fn accounts(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.map.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect();
        keys.sort();
        keys
    }
}

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, NetError> {
        Ok(self.map.lock().unwrap_or_else(|e| e.into_inner()).get(account).cloned())
    }

    fn set(&self, account: &str, value: &str) -> Result<(), NetError> {
        if self.limit.is_some_and(|max| value.chars().count() > max) {
            return Err(keychain_error());
        }
        self.map.lock().unwrap_or_else(|e| e.into_inner()).insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), NetError> {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(account);
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
}

impl Slot {
    /// The camelCase name, as the webview spells it.
    pub fn name(self) -> &'static str {
        match self {
            Slot::PartbankDesktop => "partbankDesktop",
            Slot::PartbankWeb => "partbankWeb",
            Slot::LlmOpenai => "llmOpenai",
            Slot::BfwServer => "bfwServer",
            Slot::BfwDesktop => "bfwDesktop",
            Slot::SlackBot => "slackBot",
        }
    }

    /// The URL the slot's key is bound to (`None` for the fixed-origin slots
    /// `BfwDesktop` and `SlackBot`).
    fn url(self, cfg: &ServiceConfig) -> Option<&Url> {
        match self {
            Slot::PartbankDesktop => cfg.partbank_desktop.as_ref(),
            Slot::PartbankWeb => cfg.partbank_web.as_ref(),
            Slot::LlmOpenai => cfg.llm_openai.as_ref(),
            Slot::BfwServer => cfg.bfw_url.as_ref(),
            Slot::BfwDesktop | Slot::SlackBot => None,
        }
    }
}

/// `"<slotName>|<origin>"`, `"bfwDesktop|loopback"` or
/// `"slackBot|https://slack.com"` (whatever the config is). A slot whose URL is
/// missing or invalid is `notConfigured`.
pub fn account(slot: Slot, cfg: &ServiceConfig) -> Result<String, NetError> {
    match slot {
        Slot::BfwDesktop => return Ok(format!("{}|loopback", slot.name())),
        Slot::SlackBot => return Ok(format!("{}|{SLACK_ORIGIN}", slot.name())),
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

/// `validate_secret`, plus the slot's own rule: the Slack bot slot only takes a
/// bot token (`xoxb-…`). The error message never includes the value.
pub fn validate_secret_for(slot: Slot, value: &str) -> Result<String, NetError> {
    let key = validate_secret(value)?;
    if slot == Slot::SlackBot && !key.starts_with("xoxb-") {
        return Err(NetError::new(
            NetErrorKind::BadInput,
            "the Slack token must be a bot token starting with xoxb-",
        ));
    }
    Ok(key)
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
    if matches!(slot, Slot::BfwDesktop | Slot::SlackBot) {
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

// ---------------------------------------------------------------------------
// MCP client tokens (spec §5.2): long values, stored in chunks.
// ---------------------------------------------------------------------------

/// Longest MCP token accepted, in chars.
pub const MAX_LONG_SECRET: usize = 8192;
/// Chars per keychain entry of a long token (one entry holds at most 1,280).
pub const LONG_CHUNK: usize = 1200;
/// Most entries one long token can take (8,192 / 1,200, rounded up).
pub const MAX_LONG_CHUNKS: usize = MAX_LONG_SECRET.div_ceil(LONG_CHUNK);

/// `"mcpClient:<id>|<origin>"`: the account an MCP server's token is kept
/// under, bound to the origin it was saved for.
pub fn mcp_account(id: &str, origin: &str) -> String {
    format!("mcpClient:{id}|{origin}")
}

/// The epoch counter of any account (`0` when none is stored).
pub fn epoch_of(store: &dyn SecretStore, account: &str) -> u64 {
    read_epoch(store, &format!("epoch|{account}"))
}

fn bump_epoch_at(store: &dyn SecretStore, account: &str) -> Result<(), NetError> {
    let acc = format!("epoch|{account}");
    let next = read_epoch(store, &acc).saturating_add(1);
    store.set(&acc, &next.to_string())
}

/// The token as it will be stored: blanks and a leading `Bearer ` (any case)
/// stripped, 1..=8,192 chars, no control chars, not a placeholder. No error
/// message ever contains the value.
pub fn validate_long(value: &str) -> Result<String, NetError> {
    use super::mcp_client::placeholder::{is_placeholder, strip_bearer};
    let t = strip_bearer(value);
    if t.chars().count() > MAX_LONG_SECRET {
        return Err(NetError::new(NetErrorKind::BadInput, "the token is too long (at most 8192 characters)"));
    }
    if t.is_empty() || t.chars().any(char::is_control) {
        return Err(NetError::new(NetErrorKind::BadInput, "the token must be 1 to 8192 characters with no control characters"));
    }
    if is_placeholder(t) {
        return Err(NetError::new(NetErrorKind::BadInput, "this is a placeholder, not a token"));
    }
    Ok(t.to_string())
}

fn chunk_account(account: &str, n: usize) -> String {
    format!("{account}#{n}")
}

/// Validates the token (`validate_long`) and stores it in chunks of at most
/// 1,200 chars: the first at `account` as `c<n>:<chunk>`, the rest at
/// `account#2` … `#n`; then the epoch is bumped. The header is written last,
/// so a save cut short reads as "not set" rather than as a mixed token.
pub fn store_long(store: &dyn SecretStore, account: &str, value: &str) -> Result<(), NetError> {
    let token = validate_long(value)?;
    let chars: Vec<char> = token.chars().collect();
    let chunks: Vec<String> = chars.chunks(LONG_CHUNK).map(|c| c.iter().collect()).collect();
    store.delete(account)?;
    for (i, chunk) in chunks.iter().enumerate().skip(1) {
        store.set(&chunk_account(account, i + 1), chunk)?;
    }
    for n in chunks.len() + 1..=MAX_LONG_CHUNKS {
        store.delete(&chunk_account(account, n))?;
    }
    store.set(account, &format!("c{}:{}", chunks.len(), chunks[0]))?;
    bump_epoch_at(store, account)
}

/// The stored token, or `None` when it is missing, malformed, or any chunk
/// is missing.
pub fn get_long(store: &dyn SecretStore, account: &str) -> Result<Option<String>, NetError> {
    let Some(head) = store.get(account)? else { return Ok(None) };
    let Some((count, first)) = head.strip_prefix('c').and_then(|h| h.split_once(':')) else {
        return Ok(None);
    };
    let Ok(n) = count.parse::<usize>() else { return Ok(None) };
    if !(1..=MAX_LONG_CHUNKS).contains(&n) {
        return Ok(None);
    }
    let mut token = first.to_string();
    for i in 2..=n {
        match store.get(&chunk_account(account, i))? {
            Some(chunk) => token.push_str(&chunk),
            None => return Ok(None),
        }
    }
    Ok(Some(token))
}

/// Deletes every chunk of the token (whatever is stored), then bumps the epoch.
pub fn delete_long(store: &dyn SecretStore, account: &str) -> Result<(), NetError> {
    store.delete(account)?;
    for n in 2..=MAX_LONG_CHUNKS {
        store.delete(&chunk_account(account, n))?;
    }
    bump_epoch_at(store, account)
}

/// The open vault's service config, or `notConfigured` with no vault open.
fn current_config(vault: &VaultState, settings: &SettingsFile) -> Result<ServiceConfig, NetError> {
    ServiceConfig::load(&settings.0, vault.root().ok().as_deref())
}

#[tauri::command]
pub fn secret_set(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    slot: Slot,
    value: String,
) -> Result<(), NetError> {
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
            "set": {"partbankDesktop":false,"partbankWeb":false,"llmOpenai":false,"bfwServer":false,"bfwDesktop":false,"slackBot":false},
            "epoch": {"partbankDesktop":0,"partbankWeb":0,"llmOpenai":0,"bfwServer":0,"bfwDesktop":0,"slackBot":0}}));
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
    const ACC: &str = "mcpClient:0a1b2c3d|https://rapid.kbiofoundry.kr";

    #[test] fn mcp_account_names_id_and_origin() {
        assert_eq!(mcp_account("0a1b2c3d", "https://rapid.kbiofoundry.kr"), ACC);
        assert_eq!(MAX_LONG_CHUNKS, 7);
    }
    #[test] fn memory_store_limit_refuses_long_entries() {
        let s = MemoryStore::with_entry_limit(1280);
        assert!(s.set("a", &"x".repeat(1280)).is_ok());
        assert_eq!(s.set("b", &"x".repeat(1281)).unwrap_err().kind, NetErrorKind::Keychain);
    }
    #[test] fn long_token_strips_bearer_and_round_trips() {
        let s = MemoryStore::with_entry_limit(1280);
        store_long(&s, ACC, "  Bearer test-token-123 ").unwrap();
        assert_eq!(get_long(&s, ACC).unwrap().as_deref(), Some("test-token-123"));
        assert_eq!(epoch_of(&s, ACC), 1);
        assert_eq!(s.get(ACC).unwrap().as_deref(), Some("c1:test-token-123"));
    }
    #[test] fn a_3000_char_token_takes_three_chunks() {
        let s = MemoryStore::with_entry_limit(1280);
        let token: String = (0..3000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        store_long(&s, ACC, &token).unwrap();
        assert_eq!(get_long(&s, ACC).unwrap().as_deref(), Some(token.as_str()));
        assert_eq!(s.accounts(), vec![format!("epoch|{ACC}"), ACC.to_string(), format!("{ACC}#2"), format!("{ACC}#3")]);
        // A shorter token later leaves no stale chunk behind.
        store_long(&s, ACC, "test-token-123").unwrap();
        assert_eq!(s.accounts(), vec![format!("epoch|{ACC}"), ACC.to_string()]);
        assert_eq!(get_long(&s, ACC).unwrap().as_deref(), Some("test-token-123"));
        assert_eq!(epoch_of(&s, ACC), 2);
    }
    #[test] fn a_missing_chunk_reads_as_not_set() {
        let s = MemoryStore::with_entry_limit(1280);
        store_long(&s, ACC, &"k1".repeat(1500)).unwrap();
        s.delete(&format!("{ACC}#2")).unwrap();
        assert_eq!(get_long(&s, ACC).unwrap(), None);
        s.set(ACC, "garbage").unwrap();
        assert_eq!(get_long(&s, ACC).unwrap(), None);
        s.set(ACC, "c9:x").unwrap();
        assert_eq!(get_long(&s, ACC).unwrap(), None);
    }
    #[test] fn delete_removes_every_chunk_and_bumps_the_epoch() {
        let s = MemoryStore::with_entry_limit(1280);
        store_long(&s, ACC, &"k2".repeat(4000)).unwrap();
        assert_eq!(s.accounts().len(), 8, "7 chunks and the epoch");
        delete_long(&s, ACC).unwrap();
        assert_eq!(s.accounts(), vec![format!("epoch|{ACC}")]);
        assert_eq!(get_long(&s, ACC).unwrap(), None);
        assert_eq!(epoch_of(&s, ACC), 2);
    }
    #[test] fn too_long_bad_and_placeholder_tokens_are_refused_without_echo() {
        let s = MemoryStore::with_entry_limit(1280);
        let long = "t".repeat(8193);
        let e = store_long(&s, ACC, &long).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::BadInput);
        assert!(!e.message.contains("tttttttt"));
        assert!(store_long(&s, ACC, &"t".repeat(8192)).is_ok());
        for bad in ["", "Bearer ", "<YOUR_TOKEN>", "<KBF_SSO_ACCESS_TOKEN>", "test\u{7}token"] {
            let e = store_long(&s, ACC, bad).unwrap_err();
            assert_eq!(e.kind, NetErrorKind::BadInput, "{bad:?}");
            if !bad.is_empty() {
                assert!(!e.message.contains(bad.trim()), "{bad:?}");
            }
        }
        assert_eq!(epoch_of(&s, ACC), 1, "a refused token stores nothing");
    }
    #[test] #[ignore = "touches the real Credential Manager; run by hand"] fn keyring_roundtrip() {
        let s = KeyringStore; let acc = "test|labnoteo-sp6";
        s.set(acc, "v").unwrap(); assert_eq!(s.get(acc).unwrap().as_deref(), Some("v"));
        s.delete(acc).unwrap(); assert_eq!(s.get(acc).unwrap(), None);
    }
}
