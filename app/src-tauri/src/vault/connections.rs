//! App-wide connection settings: the LLM, PartBank and bfworkflow addresses and
//! modes, the LLM tuning keys, the clear-text origins the user allowed and the
//! MCP client server list.
//!
//! They are set once per PC, not per vault. They live in `connections.json`
//! next to `settings.json` in the app config dir (write-then-rename, checked
//! on write and on read), and every vault shows the same values. Before this
//! file existed they were kept in each vault's own settings file
//! (`vaults/<hash>.json`), so a second vault, a moved or re-cased vault folder
//! or a damaged per-vault file showed empty connection settings while the API
//! key (app-wide in Credential Manager) survived.
//!
//! - Migration: while `connections.json` does not exist, the first vault whose
//!   per-vault file holds connection values that differ from the defaults
//!   donates them. A vault that only holds defaults donates nothing, so it
//!   cannot lock out a vault that was really configured. The per-vault file is
//!   never modified or deleted: its old connection keys stay as they were.
//! - A `connections.json` that cannot be read or fails validation is never
//!   replaced by defaults: a copy is kept as `connections.json.bak` (then
//!   `.bak.1`, ... when that name holds other bytes), the open settings report
//!   it as damaged, network calls say so, and only an explicit save with real
//!   values writes a new file.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};

use super::fs::{write_atomic, FsError};
use super::settings;
use crate::net::config::{
    DEFAULT_BFW_URL, DEFAULT_LLM_OLLAMA, DEFAULT_LLM_OPENAI, DEFAULT_PARTBANK_DESKTOP, DEFAULT_PARTBANK_WEB,
};

/// The settings keys stored app-wide. Everything else stays per vault.
pub const KEYS: [&str; 16] = [
    "llmProvider",
    "llmEndpointOllama",
    "llmEndpointOpenai",
    "llmModel",
    "llmContextWindow",
    "llmTemperature",
    "llmThinking",
    "llmMaxOutputTokens",
    "llmServerLimit",
    "partbankDefaultConnection",
    "partbankWebUrl",
    "partbankDesktopUrl",
    "bfwConnection",
    "bfwUrl",
    "allowHttpOrigins",
    "mcpClientServers",
];

/// Longest text value stored, in chars.
const MAX_TEXT: usize = 2048;
/// Most clear-text origins kept.
const MAX_ORIGINS: usize = 64;
/// Most MCP servers kept (`net::config::MAX_MCP_SERVERS`).
const MAX_SERVERS: usize = 16;
/// The plugin's default model name (vendor `DEFAULT_SETTINGS.llmModel`).
const DEFAULT_MODEL: &str = "llama3.1";
const DEFAULT_CONTEXT_WINDOW: i64 = 8192;

/// Serialises every read-modify-write of `connections.json`, so a migration
/// that read "missing" cannot overwrite a file a save just made.
static LOCK: Mutex<()> = Mutex::new(());

/// `connections.json` next to `settings.json`.
pub fn config_path(settings_file: &Path) -> PathBuf {
    settings_file.with_file_name("connections.json")
}

/// Whether `value` is acceptable for the connection key `key`.
fn key_ok(key: &str, value: &Value) -> bool {
    let text = |v: &Value| v.as_str().is_some_and(|s| s.chars().count() <= MAX_TEXT);
    match key {
        "llmProvider" => matches!(value.as_str(), Some("none" | "ollama" | "openai")),
        "partbankDefaultConnection" => matches!(value.as_str(), Some("desktop" | "web")),
        "bfwConnection" => matches!(value.as_str(), Some("server" | "desktop")),
        "llmThinking" => matches!(value.as_str(), Some("auto" | "on" | "off")),
        "llmEndpointOllama" | "llmEndpointOpenai" | "llmModel" | "partbankWebUrl" | "partbankDesktopUrl" | "bfwUrl" => {
            text(value)
        }
        "llmContextWindow" => value.is_number(),
        "llmTemperature" | "llmMaxOutputTokens" => value.is_null() || value.is_number(),
        "llmServerLimit" => value.is_null() || value.is_object(),
        "allowHttpOrigins" => value.as_array().is_some_and(|a| a.len() <= MAX_ORIGINS && a.iter().all(text)),
        "mcpClientServers" => value.as_array().is_some_and(|a| a.len() <= MAX_SERVERS && a.iter().all(Value::is_object)),
        _ => false,
    }
}

fn is_key(key: &str) -> bool {
    KEYS.contains(&key)
}

/// The connection keys of `settings` and the rest, as two maps.
pub fn split(settings: &Map<String, Value>) -> (Map<String, Value>, Map<String, Value>) {
    let mut conn = Map::new();
    let mut rest = Map::new();
    for (k, v) in settings {
        if is_key(k) {
            conn.insert(k.clone(), v.clone());
        } else {
            rest.insert(k.clone(), v.clone());
        }
    }
    (conn, rest)
}

/// `conn` as it is when every value passes, else the first bad key.
fn validate_strict(conn: &Map<String, Value>) -> Result<(), String> {
    match conn.iter().find(|(k, v)| !key_ok(k, v)) {
        Some((k, _)) => Err(k.clone()),
        None => Ok(()),
    }
}

/// `conn` without the entries that fail validation (for a migration).
fn lenient(conn: &Map<String, Value>) -> Map<String, Value> {
    conn.iter().filter(|(k, v)| key_ok(k, v)).map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// Whether `conn` holds a value the user could have set: anything that differs
/// from the plugin's defaults. A map of defaults (what a never-configured
/// vault saves) is not.
pub fn has_user_values(conn: &Map<String, Value>) -> bool {
    let text_differs = |key: &str, default: &str| {
        conn.get(key).and_then(Value::as_str).is_some_and(|s| s.trim().trim_end_matches('/') != default)
    };
    let non_null = |key: &str| conn.get(key).is_some_and(|v| !v.is_null());
    let non_empty = |key: &str| conn.get(key).and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    conn.get("llmProvider").and_then(Value::as_str).is_some_and(|s| s != "none")
        || conn.get("llmModel").and_then(Value::as_str).is_some_and(|s| s != DEFAULT_MODEL)
        || text_differs("llmEndpointOllama", DEFAULT_LLM_OLLAMA)
        || text_differs("llmEndpointOpenai", DEFAULT_LLM_OPENAI)
        || text_differs("partbankWebUrl", DEFAULT_PARTBANK_WEB)
        || text_differs("partbankDesktopUrl", DEFAULT_PARTBANK_DESKTOP)
        || text_differs("bfwUrl", DEFAULT_BFW_URL)
        || conn.get("partbankDefaultConnection").and_then(Value::as_str) == Some("desktop")
        || conn.get("bfwConnection").and_then(Value::as_str) == Some("desktop")
        || conn.get("llmThinking").and_then(Value::as_str).is_some_and(|s| s != "auto")
        || conn.get("llmContextWindow").and_then(Value::as_i64).is_some_and(|n| n != DEFAULT_CONTEXT_WINDOW)
        || non_null("llmTemperature")
        || non_null("llmMaxOutputTokens")
        || non_null("llmServerLimit")
        || non_empty("allowHttpOrigins")
        || non_empty("mcpClientServers")
}

/// What `connections.json` holds right now.
#[derive(Debug, PartialEq)]
pub enum Stored {
    Missing,
    Valid(Map<String, Value>),
    /// Unreadable, not JSON or no `settings` object. (A single value that fails
    /// its check is dropped instead, see `read_state`.)
    Corrupt,
}

pub fn read_state(settings_file: &Path) -> Stored {
    let text = match std::fs::read_to_string(config_path(settings_file)) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Stored::Missing,
        Err(_) => return Stored::Corrupt,
    };
    let Ok(Value::Object(doc)) = serde_json::from_str::<Value>(&text) else { return Stored::Corrupt };
    let Some(Value::Object(settings)) = doc.get("settings") else { return Stored::Corrupt };
    let (conn, _) = split(settings);
    if validate_strict(&conn).is_err() {
        // One bad key (for example a value a newer app version wrote) must not
        // take every connection with it: the good keys stay, the bad ones read
        // as their defaults, and the file as it was is copied once.
        keep_copy(&config_path(settings_file));
        return Stored::Valid(lenient(&conn));
    }
    Stored::Valid(conn)
}

/// Keeps a copy of an unreadable settings file next to it: `<name>.bak`, or
/// `<name>.bak.N` when an earlier copy holds other bytes. The same bytes are
/// never copied twice. Best effort: a failure here never blocks the caller.
pub fn keep_copy(file: &Path) {
    let Ok(bytes) = std::fs::read(file) else { return };
    let Some(name) = file.file_name().map(|n| n.to_string_lossy().into_owned()) else { return };
    for n in 0..20 {
        let bak = if n == 0 { format!("{name}.bak") } else { format!("{name}.bak.{n}") };
        let target = file.with_file_name(bak);
        match std::fs::read(&target) {
            Ok(old) if old == bytes => return,
            Ok(_) => continue,
            Err(_) => {
                let _ = std::fs::write(&target, &bytes);
                return;
            }
        }
    }
}

fn write_map(settings_file: &Path, conn: &Map<String, Value>) -> Result<(), FsError> {
    let body = serde_json::json!({ "version": 1, "settings": conn });
    let text = serde_json::to_string_pretty(&body).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    write_atomic(&config_path(settings_file), &text)
}

fn invalid(key: &str) -> FsError {
    FsError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("the connection setting {key} is not valid")))
}

/// Stores the connection part of a settings save. `conn` is checked first
/// (a bad value refuses the save and writes nothing). With a valid file the
/// keys given replace the stored ones and the others stay. With none (or a
/// damaged one, copied first) a file is created only when `conn` holds values
/// the user set, so a never-configured vault's defaults never take the place a
/// configured vault could still fill, and a whole snapshot of defaults never
/// replaces a damaged file (a save naming only some keys does).
pub fn save(settings_file: &Path, conn: &Map<String, Value>) -> Result<(), FsError> {
    validate_strict(conn).map_err(|k| invalid(&k))?;
    if conn.is_empty() {
        return Ok(());
    }
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match read_state(settings_file) {
        Stored::Valid(mut stored) => {
            stored.extend(conn.clone());
            write_map(settings_file, &stored)
        }
        Stored::Missing => {
            if has_user_values(conn) {
                write_map(settings_file, conn)
            } else {
                Ok(())
            }
        }
        Stored::Corrupt => {
            // A save that names only some keys is an edit the user made on purpose, even
            // when its values are the defaults (a PartBank-web user could otherwise never
            // repair the file). Only a whole-snapshot save of defaults, which a vault's
            // first start sends, never replaces a damaged file.
            if has_user_values(conn) || conn.len() < KEYS.len() {
                keep_copy(&config_path(settings_file));
                write_map(settings_file, conn)
            } else {
                Ok(())
            }
        }
    }
}

/// A vault's settings as the app uses them.
#[derive(Debug, PartialEq)]
pub struct Effective {
    /// The vault has a readable settings file of its own.
    pub vault_found: bool,
    /// The vault's settings with the app-wide connection keys on top.
    pub settings: Map<String, Value>,
    /// `connections.json` is unreadable or invalid (a copy was kept).
    pub damaged: bool,
}

impl Effective {
    pub fn json(&self) -> String {
        Value::Object(self.settings.clone()).to_string()
    }
}

/// `root`'s settings with the app-wide connection keys on top. While
/// `connections.json` is missing, the vault's own connection values (when they
/// are not just defaults) are first copied into it (the migration).
pub fn effective_at(settings_file: &Path, root: &Path) -> Effective {
    let own = settings::read_at(settings_file, root)
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        });
    if own.is_none() {
        let file = settings::store_path(settings_file, root);
        if file.exists() {
            keep_copy(&file);
        }
    }
    let vault_found = own.is_some();
    let mut settings = own.unwrap_or_default();
    let mut damaged = false;
    match read_state(settings_file) {
        Stored::Valid(conn) => settings.extend(conn),
        Stored::Missing => {
            let (legacy, _) = split(&settings);
            let legacy = lenient(&legacy);
            if has_user_values(&legacy) {
                let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
                // Another call may have created the file meanwhile: that one wins.
                match read_state(settings_file) {
                    Stored::Missing => {
                        let _ = write_map(settings_file, &legacy);
                    }
                    Stored::Valid(conn) => settings.extend(conn),
                    Stored::Corrupt => damaged = true,
                }
            }
        }
        Stored::Corrupt => {
            keep_copy(&config_path(settings_file));
            damaged = true;
        }
    }
    Effective { vault_found, settings, damaged }
}

/// What the webview learns about the app-wide file.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsStatus {
    /// The stored connection values as JSON, when the file is valid.
    pub values: Option<String>,
    /// The file is unreadable or invalid: a copy was kept and the values shown
    /// are the vault's old ones (or defaults).
    pub damaged: bool,
}

pub fn status_at(settings_file: &Path, root: &Path) -> ConnectionsStatus {
    let eff = effective_at(settings_file, root);
    match read_state(settings_file) {
        Stored::Valid(conn) => ConnectionsStatus { values: Some(Value::Object(conn).to_string()), damaged: false },
        Stored::Missing => ConnectionsStatus { values: None, damaged: false },
        Stored::Corrupt => ConnectionsStatus { values: None, damaged: eff.damaged },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-conn-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
        fn vault(&self, name: &str) -> PathBuf {
            std::fs::create_dir_all(self.0.join(name)).unwrap();
            std::fs::canonicalize(self.0.join(name)).unwrap()
        }
        fn settings(&self) -> PathBuf {
            self.0.join("config").join("settings.json")
        }
        /// A per-vault file written the way an older app version did: every
        /// key, including the connection ones.
        fn legacy(&self, root: &Path, json: &str) {
            let file = settings::store_path(&self.settings(), root);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            let body = json!({ "root": "x", "settings": serde_json::from_str::<Value>(json).unwrap() });
            std::fs::write(file, body.to_string()).unwrap();
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const LLM: &str = r#"{"llmProvider":"openai","llmModel":"gpt-x","llmEndpointOpenai":"https://gw.lab.kr/openai","autoSyncUnitOpToc":false}"#;

    fn stored(s: &Scratch) -> Map<String, Value> {
        match read_state(&s.settings()) {
            Stored::Valid(m) => m,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn set_once_in_one_vault_and_every_vault_shows_it() {
        let s = Scratch::new();
        let (a, b) = (s.vault("a"), s.vault("b"));
        settings::write_at(&s.settings(), &a, LLM).unwrap();
        // A second vault with a settings file of its own and nothing configured.
        settings::write_at(&s.settings(), &b, r#"{"customSampleTypes":["Strain"]}"#).unwrap();
        for root in [&a, &b] {
            let eff = effective_at(&s.settings(), root);
            assert_eq!(eff.settings["llmProvider"], "openai");
            assert_eq!(eff.settings["llmModel"], "gpt-x");
            assert!(!eff.damaged);
        }
        // What is really per vault stays per vault.
        let eff_b = effective_at(&s.settings(), &b);
        assert_eq!(eff_b.settings["customSampleTypes"], json!(["Strain"]));
        assert_eq!(effective_at(&s.settings(), &a).settings["autoSyncUnitOpToc"], false);
        assert!(effective_at(&s.settings(), &a).settings.get("customSampleTypes").is_none());
        // The per-vault files hold no connection keys written by the new app.
        let raw: Value = serde_json::from_str(&settings::read_at(&s.settings(), &a).unwrap()).unwrap();
        assert!(raw.get("llmProvider").is_none() && raw.get("autoSyncUnitOpToc").is_some());
    }

    #[test]
    fn two_vaults_edit_the_same_connection_settings() {
        let s = Scratch::new();
        let (a, b) = (s.vault("a"), s.vault("b"));
        settings::write_at(&s.settings(), &a, LLM).unwrap();
        settings::write_at(&s.settings(), &b, r#"{"llmProvider":"ollama","llmModel":"qwen","llmEndpointOllama":"http://localhost:11434"}"#).unwrap();
        // The last save wins for the whole PC, in both vaults.
        for root in [&a, &b] {
            let eff = effective_at(&s.settings(), root);
            assert_eq!((eff.settings["llmProvider"].as_str(), eff.settings["llmModel"].as_str()), (Some("ollama"), Some("qwen")));
        }
    }

    #[test]
    fn a_save_without_connection_keys_keeps_the_stored_ones() {
        let s = Scratch::new();
        let a = s.vault("a");
        settings::write_at(&s.settings(), &a, LLM).unwrap();
        settings::write_at(&s.settings(), &a, r#"{"autoSyncUnitOpToc":true}"#).unwrap();
        assert_eq!(stored(&s)["llmModel"], "gpt-x");
    }

    #[test]
    fn migration_takes_the_first_configured_vault_and_leaves_its_file_alone() {
        let s = Scratch::new();
        let (a, b) = (s.vault("a"), s.vault("b"));
        s.legacy(&a, LLM);
        let before = std::fs::read_to_string(settings::store_path(&s.settings(), &a)).unwrap();
        s.legacy(&b, r#"{"llmProvider":"ollama","llmModel":"other","llmEndpointOllama":"http://localhost:11434"}"#);
        assert_eq!(read_state(&s.settings()), Stored::Missing);
        let eff = effective_at(&s.settings(), &a);
        assert_eq!(eff.settings["llmModel"], "gpt-x");
        assert_eq!(stored(&s)["llmEndpointOpenai"], "https://gw.lab.kr/openai");
        // The per-vault data is untouched and never overwrites the app-wide file again.
        assert_eq!(std::fs::read_to_string(settings::store_path(&s.settings(), &a)).unwrap(), before);
        let eff_b = effective_at(&s.settings(), &b);
        assert_eq!(eff_b.settings["llmModel"], "gpt-x");
        assert_eq!(stored(&s)["llmModel"], "gpt-x");
        // Per-vault keys that are not connection ones are not migrated.
        assert!(stored(&s).get("autoSyncUnitOpToc").is_none());
    }

    #[test]
    fn a_vault_with_only_defaults_does_not_lock_out_a_configured_one() {
        let s = Scratch::new();
        let (a, b) = (s.vault("a"), s.vault("b"));
        s.legacy(&a, r#"{"llmProvider":"none","llmModel":"llama3.1","llmEndpointOllama":"http://localhost:11434","llmEndpointOpenai":"https://api.openai.com","partbankWebUrl":"https://partbank.kbiofoundry.kr","bfwConnection":"server","allowHttpOrigins":[],"mcpClientServers":[]}"#);
        s.legacy(&b, LLM);
        let eff_a = effective_at(&s.settings(), &a);
        assert!(eff_a.settings["llmProvider"] == "none");
        assert_eq!(read_state(&s.settings()), Stored::Missing);
        // Saving defaults from a fresh vault does not create the file either.
        settings::write_at(&s.settings(), &a, r#"{"llmProvider":"none","llmModel":"llama3.1"}"#).unwrap();
        assert_eq!(read_state(&s.settings()), Stored::Missing);
        assert_eq!(effective_at(&s.settings(), &b).settings["llmProvider"], "openai");
        assert_eq!(effective_at(&s.settings(), &a).settings["llmProvider"], "openai");
    }

    #[test]
    fn a_damaged_file_is_copied_and_never_replaced_by_defaults() {
        let s = Scratch::new();
        let a = s.vault("a");
        settings::write_at(&s.settings(), &a, LLM).unwrap();
        let file = config_path(&s.settings());
        for junk in ["{", "[]", r#"{"settings":[]}"#] {
            std::fs::write(&file, junk).unwrap();
            let eff = effective_at(&s.settings(), &a);
            assert!(eff.damaged, "{junk}");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), junk, "read never rewrites the file");
            // The same damage is copied once, not once per call.
            effective_at(&s.settings(), &a);
            assert!(file.with_file_name("connections.json.bak").exists());
            let _ = std::fs::remove_file(file.with_file_name("connections.json.bak"));
            let _ = std::fs::remove_file(file.with_file_name("connections.json.bak.1"));
        }
        // A whole snapshot of defaults (a vault's first start) does not replace it.
        std::fs::write(&file, "{").unwrap();
        let all_defaults: Map<String, Value> = KEYS
            .iter()
            .map(|k| {
                let v = match *k {
                    "llmProvider" => json!("none"),
                    "llmModel" => json!("llama3.1"),
                    "llmContextWindow" => json!(8192),
                    "llmThinking" => json!("auto"),
                    "llmEndpointOllama" => json!(DEFAULT_LLM_OLLAMA),
                    "llmEndpointOpenai" => json!(DEFAULT_LLM_OPENAI),
                    "partbankDefaultConnection" => json!("web"),
                    "bfwConnection" => json!("server"),
                    "partbankWebUrl" => json!(DEFAULT_PARTBANK_WEB),
                    "partbankDesktopUrl" => json!(DEFAULT_PARTBANK_DESKTOP),
                    "bfwUrl" => json!(DEFAULT_BFW_URL),
                    "allowHttpOrigins" | "mcpClientServers" => json!([]),
                    _ => Value::Null,
                };
                (k.to_string(), v)
            })
            .collect();
        assert!(!has_user_values(&all_defaults));
        settings::write_at(&s.settings(), &a, &Value::Object(all_defaults).to_string()).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{");
        // An edit that names only some keys replaces it even with default values, and the old bytes stay in the copy.
        settings::write_at(&s.settings(), &a, r#"{"partbankDefaultConnection":"web"}"#).unwrap();
        assert_eq!(stored(&s)["partbankDefaultConnection"], "web");
        assert_eq!(std::fs::read_to_string(file.with_file_name("connections.json.bak")).unwrap(), "{");
        std::fs::write(&file, "{").unwrap();
        // A save with real values replaces it, and the old bytes stay in the copy.
        settings::write_at(&s.settings(), &a, LLM).unwrap();
        assert_eq!(stored(&s)["llmModel"], "gpt-x");
        assert_eq!(std::fs::read_to_string(file.with_file_name("connections.json.bak")).unwrap(), "{");
        assert!(!effective_at(&s.settings(), &a).damaged);
    }

    #[test]
    fn one_bad_key_drops_only_that_key_and_keeps_a_copy() {
        let s = Scratch::new();
        let a = s.vault("a");
        let file = config_path(&s.settings());
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let raw = r#"{"version":1,"settings":{"llmProvider":"bogus","llmModel":"gpt-x","partbankWebUrl":"https://pb.lab.example"}}"#;
        std::fs::write(&file, raw).unwrap();
        let eff = effective_at(&s.settings(), &a);
        assert!(!eff.damaged);
        assert_eq!(eff.settings["llmModel"], "gpt-x");
        assert_eq!(eff.settings["partbankWebUrl"], "https://pb.lab.example");
        assert!(eff.settings.get("llmProvider").is_none(), "the bad key reads as its default");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), raw, "read never rewrites the file");
        assert_eq!(std::fs::read_to_string(file.with_file_name("connections.json.bak")).unwrap(), raw);
        // Too many origins (older or newer app) is one bad key as well.
        let origins: Vec<String> = (0..65).map(|i| format!("http://10.0.0.{i}:80")).collect();
        let doc = json!({"version":1,"settings":{"allowHttpOrigins":origins,"llmModel":"m"}});
        std::fs::write(&file, doc.to_string()).unwrap();
        assert!(!effective_at(&s.settings(), &a).damaged);
        assert_eq!(effective_at(&s.settings(), &a).settings["llmModel"], "m");
        // A later save of one key keeps the good ones.
        settings::write_at(&s.settings(), &a, r#"{"llmModel":"n"}"#).unwrap();
        assert_eq!(stored(&s)["llmModel"], "n");
        assert!(!stored(&s).contains_key("allowHttpOrigins"));
    }

    #[test]
    fn a_second_kind_of_damage_gets_its_own_copy() {
        let s = Scratch::new();
        let a = s.vault("a");
        let file = config_path(&s.settings());
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "{").unwrap();
        effective_at(&s.settings(), &a);
        std::fs::write(&file, "[").unwrap();
        effective_at(&s.settings(), &a);
        assert_eq!(std::fs::read_to_string(file.with_file_name("connections.json.bak")).unwrap(), "{");
        assert_eq!(std::fs::read_to_string(file.with_file_name("connections.json.bak.1")).unwrap(), "[");
    }

    #[test]
    fn a_damaged_vault_file_is_copied_and_the_connections_survive() {
        let s = Scratch::new();
        let a = s.vault("a");
        settings::write_at(&s.settings(), &a, LLM).unwrap();
        let file = settings::store_path(&s.settings(), &a);
        std::fs::write(&file, "{ torn").unwrap();
        let eff = effective_at(&s.settings(), &a);
        assert!(!eff.vault_found);
        assert_eq!(eff.settings["llmModel"], "gpt-x");
        assert_eq!(std::fs::read_to_string(file.with_file_name(format!("{}.bak", file.file_name().unwrap().to_string_lossy()))).unwrap(), "{ torn");
    }

    #[test]
    fn a_save_with_a_bad_connection_value_writes_nothing() {
        let s = Scratch::new();
        let a = s.vault("a");
        settings::write_at(&s.settings(), &a, LLM).unwrap();
        for bad in [
            r#"{"llmProvider":"skynet"}"#,
            r#"{"llmModel":7}"#,
            r#"{"allowHttpOrigins":"x"}"#,
            r#"{"mcpClientServers":[1]}"#,
            r#"{"llmEndpointOpenai":null}"#,
        ] {
            assert!(settings::write_at(&s.settings(), &a, bad).is_err(), "{bad}");
        }
        assert_eq!(stored(&s)["llmModel"], "gpt-x");
    }

    #[test]
    fn unknown_and_per_vault_keys_never_enter_the_app_wide_file() {
        let s = Scratch::new();
        let a = s.vault("a");
        settings::write_at(&s.settings(), &a, r#"{"llmProvider":"openai","customSampleTypes":["X"],"ncbiEmail":"a@b.c","whatever":1}"#).unwrap();
        let keys: Vec<_> = stored(&s).keys().cloned().collect();
        assert_eq!(keys, vec!["llmProvider".to_string()]);
    }

    #[test]
    fn the_defaults_check_knows_every_stored_default() {
        assert!(!has_user_values(&Map::new()));
        let defaults = json!({"llmProvider":"none","llmModel":"llama3.1","llmEndpointOllama":"http://localhost:11434/","llmEndpointOpenai":"https://api.openai.com","partbankDesktopUrl":"http://127.0.0.1:47830","partbankWebUrl":"https://partbank.kbiofoundry.kr","partbankDefaultConnection":"web","bfwUrl":"https://workflow.kbiofoundry.kr","bfwConnection":"server","allowHttpOrigins":[],"mcpClientServers":[],"llmContextWindow":8192,"llmTemperature":null,"llmThinking":"auto","llmMaxOutputTokens":null,"llmServerLimit":null});
        assert!(!has_user_values(defaults.as_object().unwrap()));
        for (k, v) in [("llmTemperature", json!(0.2)), ("llmContextWindow", json!(16384)), ("llmThinking", json!("off")), ("bfwUrl", json!("https://wf.lab.kr")), ("mcpClientServers", json!([{"id":"x"}]))] {
            let mut m = defaults.as_object().unwrap().clone();
            m.insert(k.to_string(), v);
            assert!(has_user_values(&m), "{k}");
        }
    }
}
