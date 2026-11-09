//! Per-vault app settings, kept in the app config dir (never inside the vault).
//!
//! Each vault's settings live in `<config>/vaults/<key>.json`, where `<config>`
//! is the folder of the managed `SettingsFile` and `key` is the 16-hex FNV-1a of
//! the lowercased, stripped canonical vault root. The file holds
//! `{"root": "<stripped root>", "settings": <the frontend's settings JSON>}`;
//! `root` is only there for diagnosis.
//!
//! `settings_import_plugin` reads exactly one file inside `.obsidian/`:
//! `.obsidian/plugins/labnoteo/data.json`, the Obsidian plugin's settings. It
//! takes no path and only reads. What it returns has every key-like top-level
//! field removed (D9). An LLM key found there is only *offered*:
//! `settings_plugin_llm_key` says whether there is one to store, and
//! `settings_import_llm_key` re-reads `data.json` and stores it in Windows
//! Credential Manager, so the value never crosses IPC. `data.json` is never
//! modified.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::fs::FsError;
use super::path::strip_verbatim;
use super::{SettingsFile, VaultState};
use crate::net::config::{origin, parse_llm_endpoint, DEFAULT_LLM_OPENAI};
use crate::net::error::{NetError, NetErrorKind};
use crate::net::secrets::{store_at_account, SecretStore, Secrets, Slot};

/// The one file inside `.obsidian/` that labnoteO ever reads.
const PLUGIN_DATA: [&str; 4] = [".obsidian", "plugins", "labnoteo", "data.json"];

/// Stable per-vault key: FNV-1a over the lowercased stripped root (NTFS is
/// case-insensitive, and `DefaultHasher` is not stable across Rust versions).
pub fn vault_key(root: &Path) -> String {
    let folded = strip_verbatim(root).to_lowercase();
    let mut h: u64 = 0xcbf29ce484222325;
    for b in folded.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Where `root`'s settings are stored, next to the app's `settings.json`.
pub fn store_path(settings_file: &Path, root: &Path) -> PathBuf {
    let dir = settings_file.parent().unwrap_or_else(|| Path::new("."));
    dir.join("vaults").join(format!("{}.json", vault_key(root)))
}

/// The stored `settings` value as a JSON string. Missing, unreadable, not JSON
/// or without `settings` all mean `None`: the frontend then starts over.
pub fn read_at(settings_file: &Path, root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(store_path(settings_file, root)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let settings = value.get("settings")?;
    Some(settings.to_string())
}

/// Store `content` (JSON) as `root`'s settings. Invalid JSON is refused as an
/// `io` error and nothing is written. Write-then-rename, so a crash cannot leave
/// a half-written file.
pub fn write_at(settings_file: &Path, root: &Path, content: &str) -> Result<(), FsError> {
    let settings: serde_json::Value = serde_json::from_str(content)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let target = store_path(settings_file, root);
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::json!({ "root": strip_verbatim(root), "settings": settings });
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, body.to_string())?;
    std::fs::rename(&tmp, &target).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

/// The Obsidian plugin's `data.json` under `root`, read once for the import.
/// Only that fixed path; missing or unreadable is `None`.
pub fn import_at(root: &Path) -> Option<String> {
    let path = PLUGIN_DATA.iter().fold(root.to_path_buf(), |p, c| p.join(c));
    std::fs::read_to_string(path).ok()
}

/// Whether a top-level settings key names a secret: `(?i)(api_?key|token|secret|password)`.
fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["apikey", "api_key", "token", "secret", "password"].iter().any(|n| k.contains(n))
}

/// `raw` (the plugin's `data.json`) with every key-like top-level field
/// removed, re-serialized. `None` when `raw` is not a JSON object.
pub fn sanitize_import(raw: &str) -> Option<String> {
    let mut value: Value = serde_json::from_str(raw).ok()?;
    let map = value.as_object_mut()?;
    map.retain(|k, _| !is_secret_key(k));
    Some(value.to_string())
}

/// A string setting that is present and not blank.
fn non_blank<'a>(data: &'a Value, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty())
}

/// Where a plugin `llmApiKey` would be stored: `("llmOpenai|<origin>", key)`.
/// The origin follows the vendor `migrateSettings` order (D9):
/// `llmEndpointOpenai`, else the legacy `llmEndpoint` when neither split
/// endpoint is present and the provider was `openai`, else the default.
/// `None` when there is no non-blank key or the endpoint is not usable.
pub fn plugin_llm_key_target(raw: &Value) -> Option<(String, String)> {
    let key = non_blank(raw, "llmApiKey")?;
    let endpoint = if let Some(e) = non_blank(raw, "llmEndpointOpenai") {
        e
    } else if raw.get("llmEndpointOpenai").map_or(true, |v| !v.is_string())
        && raw.get("llmEndpointOllama").map_or(true, |v| !v.is_string())
        && raw.get("llmProvider").and_then(Value::as_str) == Some("openai")
        && non_blank(raw, "llmEndpoint").is_some()
    {
        non_blank(raw, "llmEndpoint")?
    } else {
        DEFAULT_LLM_OPENAI
    };
    let url = parse_llm_endpoint(endpoint)?;
    Some((format!("{}|{}", Slot::LlmOpenai.name(), origin(&url)), key.to_string()))
}

/// The plugin LLM key target for `root`, if `data.json` holds one.
fn plugin_llm_target_at(root: &Path) -> Option<(String, String)> {
    let raw: Value = serde_json::from_str(&import_at(root)?).ok()?;
    plugin_llm_key_target(&raw)
}

/// True when `root`'s `data.json` holds an LLM key and its target account is
/// empty. A keychain that cannot be read counts as "nothing to offer".
pub fn plugin_llm_key_pending(store: &dyn SecretStore, root: &Path) -> bool {
    match plugin_llm_target_at(root) {
        Some((account, _)) => matches!(store.get(&account), Ok(None)),
        None => false,
    }
}

/// Re-reads `root`'s `data.json` and stores its LLM key unless the target
/// account already holds one. Returns whether it stored. Errors never name
/// the value.
pub fn import_llm_key_at(store: &dyn SecretStore, root: &Path) -> Result<bool, NetError> {
    let Some((account, key)) = plugin_llm_target_at(root) else {
        return Ok(false);
    };
    if store.get(&account)?.is_some() {
        return Ok(false);
    }
    store_at_account(store, &account, &key)?;
    Ok(true)
}

#[tauri::command]
pub fn settings_vault_read(state: tauri::State<'_, VaultState>, settings: tauri::State<'_, SettingsFile>) -> Option<String> {
    read_at(&settings.0, &state.root().ok()?)
}

#[tauri::command]
pub fn settings_vault_write(
    state: tauri::State<'_, VaultState>,
    settings: tauri::State<'_, SettingsFile>,
    content: String,
) -> Result<(), FsError> {
    write_at(&settings.0, &state.root()?, &content)
}

/// The plugin's `data.json` with every key-like field removed (D9). Stores nothing.
#[tauri::command]
pub fn settings_import_plugin(state: tauri::State<'_, VaultState>) -> Option<String> {
    import_at(&state.root().ok()?).and_then(|raw| sanitize_import(&raw))
}

/// Whether the open vault's plugin `data.json` holds an LLM key whose
/// Credential Manager account is still empty. Never returns the key.
#[tauri::command]
pub fn settings_plugin_llm_key(
    state: tauri::State<'_, VaultState>,
    secrets: tauri::State<'_, Secrets>,
) -> Result<bool, FsError> {
    Ok(plugin_llm_key_pending(secrets.0.as_ref(), &state.root()?))
}

/// Stores the plugin's LLM key in Credential Manager, read again here so the
/// value never crosses IPC. `false` when there is none or one is already set.
#[tauri::command]
pub fn settings_import_llm_key(
    state: tauri::State<'_, VaultState>,
    secrets: tauri::State<'_, Secrets>,
) -> Result<bool, NetError> {
    let root = state
        .root()
        .map_err(|_| NetError::new(NetErrorKind::NotConfigured, "no vault is open"))?;
    import_llm_key_at(secrets.0.as_ref(), &root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// Scratch dir holding a `vault/` and a `config/settings.json` path next to it.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-settings-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(p.join("vault")).unwrap();
            Scratch(p)
        }
        fn vault(&self) -> PathBuf {
            std::fs::canonicalize(self.0.join("vault")).unwrap()
        }
        fn settings(&self) -> PathBuf {
            self.0.join("config").join("settings.json")
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn key_is_case_insensitive_and_stable() {
        let a = vault_key(Path::new(r"D:\Lab\Notes"));
        assert_eq!(a, vault_key(Path::new(r"d:\lab\NOTES")));
        // The verbatim prefix does not change the key.
        assert_eq!(a, vault_key(Path::new(r"\\?\D:\Lab\Notes")));
        assert_ne!(a, vault_key(Path::new(r"D:\Lab\Other")));
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        // Pinned: FNV-1a of the folded root never changes across releases.
        assert_eq!(vault_key(Path::new("")), "cbf29ce484222325");
        assert_eq!(vault_key(Path::new("a")), "af63dc4c8601ec8c");
    }

    #[test]
    fn write_then_read_round_trips_and_returns_only_settings() {
        let s = Scratch::new();
        let root = s.vault();
        write_at(&s.settings(), &root, r#"{"autoSyncUnitOpToc":false,"customSampleTypes":["Strain"]}"#).unwrap();
        let file = store_path(&s.settings(), &root);
        assert!(file.starts_with(s.0.join("config").join("vaults")), "{}", file.display());
        assert!(!file.starts_with(&root), "never inside the vault");
        let stored: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(stored["root"], strip_verbatim(&root));
        assert_eq!(stored["settings"]["autoSyncUnitOpToc"], false);
        let read: serde_json::Value = serde_json::from_str(&read_at(&s.settings(), &root).unwrap()).unwrap();
        assert_eq!(read, serde_json::json!({"autoSyncUnitOpToc": false, "customSampleTypes": ["Strain"]}));
        // Another vault has its own file.
        assert_eq!(read_at(&s.settings(), &s.0), None);
        // Nothing was written into the vault.
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn write_refuses_invalid_json_and_keeps_the_old_file() {
        let s = Scratch::new();
        let root = s.vault();
        write_at(&s.settings(), &root, r#"{"a":1}"#).unwrap();
        let err = write_at(&s.settings(), &root, "{not json").unwrap_err();
        assert_eq!(serde_json::to_value(&err).unwrap()["kind"], "io");
        assert_eq!(read_at(&s.settings(), &root).unwrap(), r#"{"a":1}"#);
        // A first write that is invalid creates nothing.
        let other = Scratch::new();
        assert!(write_at(&other.settings(), &other.vault(), "").is_err());
        assert!(!store_path(&other.settings(), &other.vault()).exists());
    }

    #[test]
    fn read_of_an_unusable_file_is_none() {
        let s = Scratch::new();
        let root = s.vault();
        let file = store_path(&s.settings(), &root);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        for junk in ["", "{", "[]", "null", r#"{"root":"x"}"#] {
            std::fs::write(&file, junk).unwrap();
            assert_eq!(read_at(&s.settings(), &root), None, "{junk:?}");
        }
    }

    #[test]
    fn import_reads_only_the_fixed_plugin_path() {
        let s = Scratch::new();
        let root = s.vault();
        std::fs::write(root.join("data.json"), "{\"root\":1}").unwrap();
        let other = root.join(".obsidian").join("plugins").join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("data.json"), "{\"other\":1}").unwrap();
        std::fs::write(root.join(".obsidian").join("data.json"), "{\"top\":1}").unwrap();
        assert_eq!(import_at(&root), None);
        let ours = root.join(".obsidian").join("plugins").join("labnoteo");
        std::fs::create_dir_all(&ours).unwrap();
        std::fs::write(ours.join("data.json"), "{\"autoSyncUnitOpToc\":false}").unwrap();
        assert_eq!(import_at(&root).as_deref(), Some("{\"autoSyncUnitOpToc\":false}"));
        // Reading never writes: the plugin file is unchanged.
        assert_eq!(std::fs::read_to_string(ours.join("data.json")).unwrap(), "{\"autoSyncUnitOpToc\":false}");
    }

    #[test]
    fn import_missing_is_none() {
        let s = Scratch::new();
        assert_eq!(import_at(&s.vault()), None);
        // A folder where the file should be is unreadable: also None.
        let p = s.vault().join(".obsidian").join("plugins").join("labnoteo").join("data.json");
        std::fs::create_dir_all(&p).unwrap();
        assert_eq!(import_at(&s.vault()), None);
    }

    #[test]
    fn import_strips_secrets_and_stores_nothing() {
        let out = sanitize_import(r#"{"llmApiKey":"sk-x","mcpToken":"t","llmEndpointOpenai":"https://api.example.com","partbank_api_key":"p","autoSyncUnitOpToc":false}"#).unwrap();
        for s in ["sk-x", "llmApiKey", "mcpToken", "partbank_api_key"] {
            assert!(!out.contains(s), "{s}");
        }
        assert!(out.contains("autoSyncUnitOpToc"));
        assert!(out.contains("llmEndpointOpenai"));
        for k in ["apiKey", "API_KEY", "clientSecret", "password", "refreshToken"] {
            let out = sanitize_import(&format!(r#"{{"{k}":"v-secret","keep":1}}"#)).unwrap();
            assert!(!out.contains("v-secret"), "{k}");
            assert!(out.contains("keep"), "{k}");
        }
    }

    #[test]
    fn llm_key_target_follows_the_vendor_order() {
        let t = |j: &str| plugin_llm_key_target(&serde_json::from_str(j).unwrap()).map(|(a, _)| a);
        assert_eq!(t(r#"{"llmEndpointOpenai":"https://api.example.com","llmApiKey":"sk-x"}"#).as_deref(), Some("llmOpenai|https://api.example.com"));
        assert_eq!(t(r#"{"llmProvider":"ollama","llmEndpoint":"http://x:1","llmApiKey":"sk-x"}"#).as_deref(), Some("llmOpenai|https://api.openai.com"));
        assert_eq!(t(r#"{"llmProvider":"openai","llmEndpoint":"https://gw","llmEndpointOllama":"http://o","llmApiKey":"sk"}"#).as_deref(), Some("llmOpenai|https://api.openai.com"));
        assert_eq!(t(r#"{"llmApiKey":""}"#), None);
        assert_eq!(t(r#"{"llmApiKey":"   "}"#), None);
        assert_eq!(t(r#"{"llmEndpointOpenai":"https://a.example"}"#), None);
        assert_eq!(t(r#"{"llmApiKey":7}"#), None);
        assert_eq!(t(r#"{"llmApiKey":"sk-x"}"#).as_deref(), Some("llmOpenai|https://api.openai.com"));
    }

    #[test]
    fn import_uses_legacy_llm_endpoint_origin() {
        let t = plugin_llm_key_target(&serde_json::json!({"llmProvider":"openai","llmEndpoint":"https://gw.lab.kr","llmApiKey":"sk-x"})).unwrap();
        assert_eq!(t, ("llmOpenai|https://gw.lab.kr".to_string(), "sk-x".to_string()));
    }

    #[test]
    fn import_of_non_object_is_none() {
        for raw in ["", "{", "[]", "null", "\"text\"", "7", "[{\"llmApiKey\":\"sk\"}]"] {
            assert_eq!(sanitize_import(raw), None, "{raw:?}");
        }
        assert_eq!(plugin_llm_key_target(&serde_json::json!(["sk"])), None);
        assert_eq!(sanitize_import("{}").as_deref(), Some("{}"));
    }

    #[test]
    fn import_llm_key_stores_once_and_keeps_an_existing_key() {
        use crate::net::secrets::{MemoryStore, SecretStore};
        let s = Scratch::new();
        let root = s.vault();
        let store = MemoryStore::default();
        assert!(!plugin_llm_key_pending(&store, &root));
        assert!(!import_llm_key_at(&store, &root).unwrap());
        let ours = root.join(".obsidian").join("plugins").join("labnoteo");
        std::fs::create_dir_all(&ours).unwrap();
        std::fs::write(ours.join("data.json"), r#"{"llmApiKey":"sk-imp"}"#).unwrap();
        assert!(plugin_llm_key_pending(&store, &root));
        assert!(import_llm_key_at(&store, &root).unwrap());
        assert_eq!(store.get("llmOpenai|https://api.openai.com").unwrap().as_deref(), Some("sk-imp"));
        assert_eq!(store.get("epoch|llmOpenai|https://api.openai.com").unwrap().as_deref(), Some("1"));
        assert!(!plugin_llm_key_pending(&store, &root));
        // A second import keeps the stored key, even when data.json changed.
        std::fs::write(ours.join("data.json"), r#"{"llmApiKey":"sk-other"}"#).unwrap();
        assert!(!import_llm_key_at(&store, &root).unwrap());
        assert_eq!(store.get("llmOpenai|https://api.openai.com").unwrap().as_deref(), Some("sk-imp"));
        // data.json is never modified.
        assert_eq!(std::fs::read_to_string(ours.join("data.json")).unwrap(), r#"{"llmApiKey":"sk-other"}"#);
    }

    #[test]
    fn import_llm_key_refuses_a_bad_value_without_naming_it() {
        use crate::net::secrets::MemoryStore;
        let s = Scratch::new();
        let root = s.vault();
        let ours = root.join(".obsidian").join("plugins").join("labnoteo");
        std::fs::create_dir_all(&ours).unwrap();
        std::fs::write(ours.join("data.json"), r#"{"llmApiKey":"sk-bad\u0007"}"#).unwrap();
        let store = MemoryStore::default();
        let err = import_llm_key_at(&store, &root).unwrap_err();
        let text = serde_json::to_string(&err).unwrap();
        assert!(!text.contains("sk-bad"), "{text}");
    }
}
