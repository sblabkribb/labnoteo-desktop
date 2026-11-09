//! Integration keys, kept only in Windows Credential Manager (D6).
//!
//! Each key lives under service `kr.sblab.labnoteo`, account
//! `"<slot>|<origin>"`, where `origin` is the normalized origin of the URL the
//! open vault's settings name for that slot. A key is therefore bound to the
//! server it was entered for: after the URL changes, the key reads "not set".
//! `bfwDesktop` uses the fixed origin `loopback` (its port changes per launch).
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
        }
    }

    /// The URL the slot's key is bound to (`None` for `BfwDesktop`).
    fn url(self, cfg: &ServiceConfig) -> Option<&Url> {
        match self {
            Slot::PartbankDesktop => cfg.partbank_desktop.as_ref(),
            Slot::PartbankWeb => cfg.partbank_web.as_ref(),
            Slot::LlmOpenai => cfg.llm_openai.as_ref(),
            Slot::BfwServer => cfg.bfw_url.as_ref(),
            Slot::BfwDesktop => None,
        }
    }
}

/// `"<slotName>|<origin>"`, or `"bfwDesktop|loopback"`. A slot whose URL is
/// missing or invalid is `notConfigured`.
pub fn account(slot: Slot, cfg: &ServiceConfig) -> Result<String, NetError> {
    if slot == Slot::BfwDesktop {
        return Ok(format!("{}|loopback", slot.name()));
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

/// Validates and stores the slot's key, then bumps its epoch.
pub fn store_secret(store: &dyn SecretStore, slot: Slot, cfg: &ServiceConfig, value: &str) -> Result<(), NetError> {
    store_at_account(store, &account(slot, cfg)?, value)
}

/// Validates and stores a key under an account built by `account` (or the
/// same `"<slot>|<origin>"` shape), then bumps `"epoch|<account>"`. Used by the
/// plugin LLM key import, whose origin comes from `data.json` (D9).
pub fn store_at_account(store: &dyn SecretStore, account: &str, value: &str) -> Result<(), NetError> {
    let key = validate_secret(value)?;
    store.set(account, &key)?;
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
}

impl<T> SlotValues<T> {
    fn from_fn(mut f: impl FnMut(Slot) -> T) -> Self {
        SlotValues {
            partbank_desktop: f(Slot::PartbankDesktop),
            partbank_web: f(Slot::PartbankWeb),
            llm_openai: f(Slot::LlmOpenai),
            bfw_server: f(Slot::BfwServer),
            bfw_desktop: f(Slot::BfwDesktop),
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
            "set": {"partbankDesktop":false,"partbankWeb":false,"llmOpenai":false,"bfwServer":false,"bfwDesktop":false},
            "epoch": {"partbankDesktop":0,"partbankWeb":0,"llmOpenai":0,"bfwServer":0,"bfwDesktop":0}}));
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
    #[test] #[ignore = "touches the real Credential Manager; run by hand"] fn keyring_roundtrip() {
        let s = KeyringStore; let acc = "test|labnoteo-sp6";
        s.set(acc, "v").unwrap(); assert_eq!(s.get(acc).unwrap().as_deref(), Some("v"));
        s.delete(acc).unwrap(); assert_eq!(s.get(acc).unwrap(), None);
    }
}
