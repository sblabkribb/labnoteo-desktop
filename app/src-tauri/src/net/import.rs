//! "Import from file…" in the Integration settings dialog: LLM, PartBank and
//! bfworkflow connection settings and keys, read from one file the user picks.
//!
//! The webview only names the path. Rust reads the file (at most
//! `MAX_IMPORT_BYTES`, UTF-8 with or without a BOM), refuses one inside the open
//! vault (a vault may be synced or shared), parses it as JSON
//!
//! ```json
//! {"llm": {"provider": "openai", "baseUrl": "…", "model": "…", "apiKey": "…"},
//!  "partbank": {"connection": "web", "url": "…", "apiKey": "…"},
//!  "bfworkflow": {"url": "…", "apiKey": "…"}}
//! ```
//!
//! or as `.env` lines (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_PROVIDER`,
//! `PARTBANK_URL`, `PARTBANK_API_KEY`, `PARTBANK_CONNECTION`, `BFWORKFLOW_URL`,
//! `BFWORKFLOW_API_KEY`), and checks every field with the same parsers and key
//! rules the dialog uses. Unknown keys are ignored.
//!
//! Each part is all or nothing: one invalid field skips the whole part, so a
//! key is never stored for an address that was not saved. Keys go to Windows
//! Credential Manager bound to the origin of the URL being saved (or of the
//! stored URL when the file names none), with their epochs bumped. The
//! non-secret fields go back to the webview, which saves them through the
//! dialog's own settings flow (the one source of truth for settings). The
//! answer is a summary of codes: it never holds a key, and nothing in it is
//! copied from the file.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;

use super::config::{parse_llm_endpoint, parse_origin_url, ServiceConfig, Url};
use super::error::{NetError, NetErrorKind};
use super::secrets::{store_secret_at_url, validate_secret_for, SecretStore, Secrets, Slot};
use super::NetState;
use crate::vault::{SettingsFile, VaultState};

/// Largest file read, in bytes.
pub const MAX_IMPORT_BYTES: u64 = 64 * 1024;

/// Longest model name accepted, in chars.
const MAX_MODEL: usize = 256;

/// Why a whole file was refused. Codes only: the webview words them.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Refusal {
    /// The file is inside the open vault.
    InsideVault,
    /// Over `MAX_IMPORT_BYTES`.
    TooLarge,
    /// Missing, a folder, or unreadable.
    Unreadable,
    /// Not UTF-8 text.
    NotText,
    /// Neither JSON nor `.env` with any known setting.
    Unrecognized,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Part {
    Llm,
    Partbank,
    Bfworkflow,
}

/// Why a field was refused.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Problem {
    BadUrl,
    BadKey,
    BadModel,
    BadProvider,
    BadConnection,
    /// A field that is not a string.
    NotText,
    /// A key with no usable address, in the file or in the stored settings.
    NoUrl,
    /// An API key for Ollama, which never takes one.
    KeyNotUsed,
    /// Credential Manager refused the key.
    Keychain,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub part: Part,
    pub key_saved: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Invalid {
    pub part: Part,
    /// The file's field name (`baseUrl`, `url`, `apiKey`, `model`, `provider`, `connection`).
    pub field: &'static str,
    pub reason: Problem,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ImportOutcome {
    Refused {
        reason: Refusal,
    },
    Done {
        imported: Vec<Imported>,
        invalid: Vec<Invalid>,
        /// The non-secret settings to save, keyed like the frontend's settings.
        settings: Map<String, Value>,
    },
}

/// One field as found in the file. Blank counts as absent.
#[derive(Debug, Clone, PartialEq, Default)]
enum Field {
    #[default]
    Absent,
    Text(String),
    NotText,
}

impl Field {
    fn of_json(v: Option<&Value>) -> Field {
        match v {
            None | Some(Value::Null) => Field::Absent,
            Some(Value::String(s)) if s.trim().is_empty() => Field::Absent,
            Some(Value::String(s)) => Field::Text(s.trim().to_string()),
            Some(_) => Field::NotText,
        }
    }

    fn of_text(s: &str) -> Field {
        if s.trim().is_empty() {
            Field::Absent
        } else {
            Field::Text(s.trim().to_string())
        }
    }

    fn is_absent(&self) -> bool {
        *self == Field::Absent
    }
}

#[derive(Debug, Default, PartialEq)]
struct LlmFields {
    provider: Field,
    base_url: Field,
    model: Field,
    api_key: Field,
}

#[derive(Debug, Default, PartialEq)]
struct PartbankFields {
    connection: Field,
    url: Field,
    api_key: Field,
}

#[derive(Debug, Default, PartialEq)]
struct BfwFields {
    url: Field,
    api_key: Field,
}

#[derive(Debug, Default, PartialEq)]
struct Parsed {
    llm: LlmFields,
    partbank: PartbankFields,
    bfw: BfwFields,
}

impl Parsed {
    fn is_empty(&self) -> bool {
        *self == Parsed::default()
    }
}

/// JSON text (an object) or `.env` lines. `None` when it is neither, or holds
/// no known setting. Never keeps an error that could quote the text.
fn parse(text: &str) -> Option<Parsed> {
    let parsed = if text.trim_start().starts_with('{') { parse_json(text)? } else { parse_env(text) };
    (!parsed.is_empty()).then_some(parsed)
}

fn parse_json(text: &str) -> Option<Parsed> {
    let value: Value = serde_json::from_str(text).ok()?;
    let root = value.as_object()?;
    let part = |name: &str| root.get(name).and_then(Value::as_object);
    let mut p = Parsed::default();
    if let Some(o) = part("llm") {
        p.llm = LlmFields {
            provider: Field::of_json(o.get("provider")),
            base_url: Field::of_json(o.get("baseUrl")),
            model: Field::of_json(o.get("model")),
            api_key: Field::of_json(o.get("apiKey")),
        };
    }
    if let Some(o) = part("partbank") {
        p.partbank = PartbankFields {
            connection: Field::of_json(o.get("connection")),
            url: Field::of_json(o.get("url")),
            api_key: Field::of_json(o.get("apiKey")),
        };
    }
    if let Some(o) = part("bfworkflow") {
        p.bfw = BfwFields { url: Field::of_json(o.get("url")), api_key: Field::of_json(o.get("apiKey")) };
    }
    Some(p)
}

/// `KEY=VALUE` lines; blank lines, `#` comments and unknown keys are skipped,
/// an `export ` prefix is allowed, and one pair of matching quotes is removed.
fn parse_env(text: &str) -> Parsed {
    let mut p = Parsed::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        let value = ['"', '\'']
            .iter()
            .find_map(|q| value.strip_prefix(*q).and_then(|v| v.strip_suffix(*q)))
            .unwrap_or(value);
        let field = Field::of_text(value);
        match key.trim() {
            "LLM_PROVIDER" => p.llm.provider = field,
            "LLM_BASE_URL" => p.llm.base_url = field,
            "LLM_MODEL" => p.llm.model = field,
            "LLM_API_KEY" => p.llm.api_key = field,
            "PARTBANK_CONNECTION" => p.partbank.connection = field,
            "PARTBANK_URL" => p.partbank.url = field,
            "PARTBANK_API_KEY" => p.partbank.api_key = field,
            "BFWORKFLOW_URL" => p.bfw.url = field,
            "BFWORKFLOW_API_KEY" => p.bfw.api_key = field,
            _ => {}
        }
    }
    p
}

/// The string the frontend stores for a parsed URL: no trailing `/`.
fn url_setting(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

/// A field's text; `None` when absent or not text (then the problem is noted).
fn text_of<'a>(f: &'a Field, part: Part, name: &'static str, bad: &mut Vec<Invalid>) -> Option<&'a str> {
    match f {
        Field::Absent => None,
        Field::Text(s) => Some(s),
        Field::NotText => {
            bad.push(Invalid { part, field: name, reason: Problem::NotText });
            None
        }
    }
}

/// A key checked by the slot's rule, or the problem noted.
fn checked_key(f: &Field, slot: Slot, part: Part, bad: &mut Vec<Invalid>) -> Option<String> {
    let raw = text_of(f, part, "apiKey", bad)?;
    match validate_secret_for(slot, raw) {
        Ok(k) => Some(k),
        Err(_) => {
            bad.push(Invalid { part, field: "apiKey", reason: Problem::BadKey });
            None
        }
    }
}

/// What one valid part changes: settings and, maybe, a key for a URL.
struct Plan {
    settings: Vec<(&'static str, Value)>,
    key: Option<(Slot, Url, String)>,
}

fn plan_llm(f: &LlmFields, cfg: &ServiceConfig, bad: &mut Vec<Invalid>) -> Option<Plan> {
    let part = Part::Llm;
    let before = bad.len();
    let ollama = match text_of(&f.provider, part, "provider", bad).map(str::to_ascii_lowercase).as_deref() {
        None => false,
        Some("openai") => false,
        Some("ollama") => true,
        Some(_) => {
            bad.push(Invalid { part, field: "provider", reason: Problem::BadProvider });
            false
        }
    };
    let url = text_of(&f.base_url, part, "baseUrl", bad).and_then(|raw| {
        let u = parse_llm_endpoint(raw);
        if u.is_none() {
            bad.push(Invalid { part, field: "baseUrl", reason: Problem::BadUrl });
        }
        u
    });
    let model = text_of(&f.model, part, "model", bad).and_then(|m| {
        let ok = m.chars().count() <= MAX_MODEL && !m.chars().any(char::is_control);
        if !ok {
            bad.push(Invalid { part, field: "model", reason: Problem::BadModel });
        }
        ok.then(|| m.to_string())
    });
    let key = if ollama && !f.api_key.is_absent() {
        bad.push(Invalid { part, field: "apiKey", reason: Problem::KeyNotUsed });
        None
    } else {
        checked_key(&f.api_key, Slot::LlmOpenai, part, bad)
    };
    if bad.len() > before {
        return None;
    }
    let key = match key {
        Some(k) => match url.clone().or_else(|| cfg.llm_openai.clone()) {
            Some(u) => Some((Slot::LlmOpenai, u, k)),
            None => {
                bad.push(Invalid { part, field: "apiKey", reason: Problem::NoUrl });
                return None;
            }
        },
        None => None,
    };
    let mut settings = vec![("llmProvider", Value::from(if ollama { "ollama" } else { "openai" }))];
    if let Some(u) = &url {
        settings.push((if ollama { "llmEndpointOllama" } else { "llmEndpointOpenai" }, Value::from(url_setting(u))));
    }
    if let Some(m) = model {
        settings.push(("llmModel", Value::from(m)));
    }
    Some(Plan { settings, key })
}

fn plan_partbank(f: &PartbankFields, cfg: &ServiceConfig, bad: &mut Vec<Invalid>) -> Option<Plan> {
    let part = Part::Partbank;
    let before = bad.len();
    let connection = text_of(&f.connection, part, "connection", bad).map(str::to_ascii_lowercase);
    let desktop = match connection.as_deref() {
        None | Some("web") => false,
        Some("desktop") => true,
        Some(_) => {
            bad.push(Invalid { part, field: "connection", reason: Problem::BadConnection });
            false
        }
    };
    let url = text_of(&f.url, part, "url", bad).and_then(|raw| {
        let u = parse_origin_url(raw);
        if u.is_none() {
            bad.push(Invalid { part, field: "url", reason: Problem::BadUrl });
        }
        u
    });
    let slot = if desktop { Slot::PartbankDesktop } else { Slot::PartbankWeb };
    let key = checked_key(&f.api_key, slot, part, bad);
    if bad.len() > before {
        return None;
    }
    let stored = if desktop { cfg.partbank_desktop.clone() } else { cfg.partbank_web.clone() };
    let key = match key {
        Some(k) => match url.clone().or(stored) {
            Some(u) => Some((slot, u, k)),
            None => {
                bad.push(Invalid { part, field: "apiKey", reason: Problem::NoUrl });
                return None;
            }
        },
        None => None,
    };
    let mut settings = Vec::new();
    if connection.is_some() {
        settings.push(("partbankDefaultConnection", Value::from(if desktop { "desktop" } else { "web" })));
    }
    if let Some(u) = &url {
        settings.push((if desktop { "partbankDesktopUrl" } else { "partbankWebUrl" }, Value::from(url_setting(u))));
    }
    Some(Plan { settings, key })
}

fn plan_bfw(f: &BfwFields, cfg: &ServiceConfig, bad: &mut Vec<Invalid>) -> Option<Plan> {
    let part = Part::Bfworkflow;
    let before = bad.len();
    let url = text_of(&f.url, part, "url", bad).and_then(|raw| {
        let u = parse_origin_url(raw);
        if u.is_none() {
            bad.push(Invalid { part, field: "url", reason: Problem::BadUrl });
        }
        u
    });
    let key = checked_key(&f.api_key, Slot::BfwServer, part, bad);
    if bad.len() > before {
        return None;
    }
    let key = match key {
        Some(k) => match url.clone().or_else(|| cfg.bfw_url.clone()) {
            Some(u) => Some((Slot::BfwServer, u, k)),
            None => {
                bad.push(Invalid { part, field: "apiKey", reason: Problem::NoUrl });
                return None;
            }
        },
        None => None,
    };
    // The file names the server: the key is the server slot's.
    let mut settings = vec![("bfwConnection", Value::from("server"))];
    if let Some(u) = &url {
        settings.push(("bfwUrl", Value::from(url_setting(u))));
    }
    Some(Plan { settings, key })
}

/// Parses `text` and stores its keys (the settings are only returned). `cfg`
/// is the open vault's stored config: the address a key binds to when the
/// file names none.
pub fn apply_import(store: &dyn SecretStore, text: &str, cfg: &ServiceConfig) -> ImportOutcome {
    let Some(parsed) = parse(text) else {
        return ImportOutcome::Refused { reason: Refusal::Unrecognized };
    };
    let mut imported = Vec::new();
    let mut invalid = Vec::new();
    let mut settings = Map::new();
    let parts = [
        (Part::Llm, parsed.llm == LlmFields::default()),
        (Part::Partbank, parsed.partbank == PartbankFields::default()),
        (Part::Bfworkflow, parsed.bfw == BfwFields::default()),
    ];
    for (part, empty) in parts {
        if empty {
            continue;
        }
        let plan = match part {
            Part::Llm => plan_llm(&parsed.llm, cfg, &mut invalid),
            Part::Partbank => plan_partbank(&parsed.partbank, cfg, &mut invalid),
            Part::Bfworkflow => plan_bfw(&parsed.bfw, cfg, &mut invalid),
        };
        let Some(plan) = plan else { continue };
        // The key first: if Credential Manager refuses it, the part's settings are not saved either.
        let key_saved = match &plan.key {
            Some((slot, url, key)) => {
                if store_secret_at_url(store, *slot, url, key).is_err() {
                    invalid.push(Invalid { part, field: "apiKey", reason: Problem::Keychain });
                    continue;
                }
                true
            }
            None => false,
        };
        for (k, v) in plan.settings {
            settings.insert(k.to_string(), v);
        }
        imported.push(Imported { part, key_saved });
    }
    ImportOutcome::Done { imported, invalid, settings }
}

/// Reads the file at `path` for the import: a regular file outside `vault_root`
/// (both canonicalized, so a link into the vault counts as inside), at most
/// `MAX_IMPORT_BYTES`, UTF-8 with an optional BOM. Returns the canonical path
/// and the text without the BOM.
pub fn read_import_file(path: &Path, vault_root: &Path) -> Result<(PathBuf, String), Refusal> {
    let file = std::fs::canonicalize(path).map_err(|_| Refusal::Unreadable)?;
    let root = std::fs::canonicalize(vault_root).unwrap_or_else(|_| vault_root.to_path_buf());
    if file.starts_with(&root) {
        return Err(Refusal::InsideVault);
    }
    let meta = std::fs::metadata(&file).map_err(|_| Refusal::Unreadable)?;
    if !meta.is_file() {
        return Err(Refusal::Unreadable);
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(Refusal::TooLarge);
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&file)
        .and_then(|f| f.take(MAX_IMPORT_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| Refusal::Unreadable)?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(Refusal::TooLarge);
    }
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let text = std::str::from_utf8(body).map_err(|_| Refusal::NotText)?;
    Ok((file, text.to_string()))
}

/// Reads, checks and imports the file; see the module doc.
pub fn import_file(
    store: &dyn SecretStore,
    path: &Path,
    vault_root: &Path,
    cfg: &ServiceConfig,
) -> (ImportOutcome, Option<PathBuf>) {
    match read_import_file(path, vault_root) {
        Err(reason) => (ImportOutcome::Refused { reason }, None),
        Ok((file, text)) => {
            let outcome = apply_import(store, &text, cfg);
            let any = matches!(&outcome, ImportOutcome::Done { imported, .. } if !imported.is_empty());
            (outcome, any.then_some(file))
        }
    }
}

#[tauri::command]
pub fn integration_import_file(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    path: String,
) -> Result<ImportOutcome, NetError> {
    let root = vault.root().map_err(|_| NetError::new(NetErrorKind::NotConfigured, "no vault is open"))?;
    let cfg = ServiceConfig::load(&settings.0, Some(&root))?;
    let (outcome, file) = import_file(secrets.0.as_ref(), Path::new(&path), &root, &cfg);
    if let Some(file) = file {
        *net.last_import.lock().unwrap_or_else(|e| e.into_inner()) = Some(file);
    }
    Ok(outcome)
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeleteOutcome {
    /// Moved to the Recycle Bin.
    Trashed,
    /// The Recycle Bin refused it; nothing was deleted (ask before deleting for good).
    TrashUnavailable,
    /// Deleted for good.
    Deleted,
    /// It was already gone.
    Gone,
}

/// Deletes `file`: to the Recycle Bin, or for good when `permanent`.
pub fn delete_import_with(
    file: &Path,
    permanent: bool,
    trash: impl FnOnce(&Path) -> Result<(), trash::Error>,
) -> Result<DeleteOutcome, NetError> {
    if std::fs::symlink_metadata(file).is_err() {
        return Ok(DeleteOutcome::Gone);
    }
    if permanent {
        std::fs::remove_file(file).map_err(|_| NetError::new(NetErrorKind::Io, "the file could not be deleted"))?;
        return Ok(DeleteOutcome::Deleted);
    }
    Ok(match trash(file) {
        Ok(()) => DeleteOutcome::Trashed,
        Err(_) => DeleteOutcome::TrashUnavailable,
    })
}

/// Deletes the file last imported, and no other: the webview names none.
#[tauri::command]
pub async fn integration_import_delete(net: State<'_, NetState>, permanent: bool) -> Result<DeleteOutcome, NetError> {
    let file = net
        .last_import
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| NetError::new(NetErrorKind::BadInput, "no imported file to delete"))?;
    let run = file.clone();
    let out = tauri::async_runtime::spawn_blocking(move || delete_import_with(&run, permanent, |p| trash::delete(p)))
        .await
        .map_err(|_| NetError::new(NetErrorKind::Io, "the file could not be deleted"))??;
    if out != DeleteOutcome::TrashUnavailable {
        let mut last = net.last_import.lock().unwrap_or_else(|e| e.into_inner());
        if last.as_deref() == Some(file.as_path()) {
            *last = None;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::config::tests::scratch_dir;
    use crate::net::secrets::{status_of, MemoryStore};

    fn cfg(json: &str) -> ServiceConfig {
        ServiceConfig::from_settings_json(json)
    }

    fn done(o: &ImportOutcome) -> (&Vec<Imported>, &Vec<Invalid>, &Map<String, Value>) {
        match o {
            ImportOutcome::Done { imported, invalid, settings } => (imported, invalid, settings),
            other => panic!("expected done, got {other:?}"),
        }
    }

    const FULL_JSON: &str = r#"{
        "llm": {"provider": "openai", "baseUrl": "https://gw.lab.example/v1", "model": "gpt-x", "apiKey": "sk-test-llm"},
        "partbank": {"connection": "web", "url": "https://pb.lab.example/", "apiKey": "pbk_test_pb"},
        "bfworkflow": {"url": "https://wf.lab.example", "apiKey": "bfw_test_wf"},
        "slack": {"token": "xoxb-ignored"}, "extra": 1
    }"#;

    #[test]
    fn json_imports_every_part_binding_keys_to_the_new_origins() {
        let store = MemoryStore::default();
        let out = apply_import(&store, FULL_JSON, &cfg("{}"));
        let (imported, invalid, settings) = done(&out);
        assert!(invalid.is_empty(), "{invalid:?}");
        assert_eq!(
            imported,
            &vec![
                Imported { part: Part::Llm, key_saved: true },
                Imported { part: Part::Partbank, key_saved: true },
                Imported { part: Part::Bfworkflow, key_saved: true },
            ]
        );
        assert_eq!(
            Value::Object(settings.clone()),
            serde_json::json!({
                "llmProvider": "openai", "llmEndpointOpenai": "https://gw.lab.example/v1", "llmModel": "gpt-x",
                "partbankDefaultConnection": "web", "partbankWebUrl": "https://pb.lab.example",
                "bfwConnection": "server", "bfwUrl": "https://wf.lab.example"
            })
        );
        assert_eq!(store.get("llmOpenai|https://gw.lab.example").unwrap().as_deref(), Some("sk-test-llm"));
        assert_eq!(store.get("partbankWeb|https://pb.lab.example").unwrap().as_deref(), Some("pbk_test_pb"));
        assert_eq!(store.get("bfwServer|https://wf.lab.example").unwrap().as_deref(), Some("bfw_test_wf"));
        // Epochs are bumped, and once the settings are saved the status reads "set".
        let saved = cfg(&Value::Object(settings.clone()).to_string());
        let st = status_of(&store, &saved);
        assert_eq!((st.set.llm_openai, st.set.partbank_web, st.set.bfw_server), (true, true, true));
        assert_eq!((st.epoch.llm_openai, st.epoch.partbank_web, st.epoch.bfw_server), (1, 1, 1));
        // Unknown parts (slack) are ignored: nothing else was stored.
        assert_eq!(store.get("slackBot|https://slack.com").unwrap(), None);
        // The summary carries no key.
        let text = serde_json::to_string(&out).unwrap();
        for k in ["sk-test-llm", "pbk_test_pb", "bfw_test_wf", "xoxb-ignored"] {
            assert!(!text.contains(k), "{text}");
        }
    }

    #[test]
    fn env_lines_with_bom_crlf_comments_quotes_and_unknown_keys() {
        let store = MemoryStore::default();
        let text = "# connections\r\nexport LLM_PROVIDER=ollama\r\nLLM_BASE_URL='http://localhost:11434'\r\nLLM_MODEL=\"llama3\"\r\n\r\nPARTBANK_URL=https://pb.lab.example\r\nPARTBANK_API_KEY=pbk_env\r\nPARTBANK_CONNECTION=desktop\r\nSOMETHING_ELSE=x\r\nnot a pair\r\nBFWORKFLOW_API_KEY = bfw_env \r\n";
        let dir = scratch_dir("import-env");
        std::fs::create_dir_all(dir.join("vault")).unwrap();
        let file = dir.join("conn.env");
        let mut bytes = b"\xEF\xBB\xBF".to_vec();
        bytes.extend_from_slice(text.as_bytes());
        std::fs::write(&file, bytes).unwrap();
        let (out, kept) = import_file(&store, &file, &dir.join("vault"), &cfg(r#"{"bfwUrl":"https://wf.stored.example"}"#));
        let (imported, invalid, settings) = done(&out);
        assert!(invalid.is_empty(), "{invalid:?}");
        assert_eq!(imported.len(), 3);
        assert_eq!(settings["llmProvider"], "ollama");
        assert_eq!(settings["llmEndpointOllama"], "http://localhost:11434");
        assert_eq!(settings["llmModel"], "llama3");
        assert_eq!(settings["partbankDesktopUrl"], "https://pb.lab.example");
        assert_eq!(settings["partbankDefaultConnection"], "desktop");
        assert!(!settings.contains_key("bfwUrl"));
        assert_eq!(store.get("partbankDesktop|https://pb.lab.example").unwrap().as_deref(), Some("pbk_env"));
        // A key with no URL in the file binds to the stored URL.
        assert_eq!(store.get("bfwServer|https://wf.stored.example").unwrap().as_deref(), Some("bfw_env"));
        assert_eq!(kept, Some(std::fs::canonicalize(&file).unwrap()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_invalid_field_skips_its_whole_part_and_stores_nothing_for_it() {
        let store = MemoryStore::default();
        let out = apply_import(
            &store,
            r#"{"llm":{"baseUrl":"ftp://x","apiKey":"sk-should-not-store"},
                "partbank":{"url":"https://pb.lab.example","apiKey":"pbk_bad\u0007"},
                "bfworkflow":{"url":"https://wf.lab.example/path","apiKey":"bfw_x"}}"#,
            &cfg("{}"),
        );
        let (imported, invalid, settings) = done(&out);
        assert!(imported.is_empty());
        assert!(settings.is_empty());
        assert_eq!(
            invalid,
            &vec![
                Invalid { part: Part::Llm, field: "baseUrl", reason: Problem::BadUrl },
                Invalid { part: Part::Partbank, field: "apiKey", reason: Problem::BadKey },
                Invalid { part: Part::Bfworkflow, field: "url", reason: Problem::BadUrl },
            ]
        );
        assert_eq!(store.get("llmOpenai|https://api.openai.com").unwrap(), None);
        assert_eq!(store.get("partbankWeb|https://pb.lab.example").unwrap(), None);
        let text = serde_json::to_string(&out).unwrap();
        assert!(!text.contains("sk-should-not-store") && !text.contains("pbk_bad") && !text.contains("ftp://x"), "{text}");
    }

    #[test]
    fn other_field_problems() {
        let store = MemoryStore::default();
        let o = apply_import(&store, r#"{"llm":{"provider":"claude"}}"#, &cfg("{}"));
        assert_eq!(done(&o).1[0].reason, Problem::BadProvider);
        let o = apply_import(&store, r#"{"llm":{"provider":"ollama","apiKey":"sk-x"}}"#, &cfg("{}"));
        assert_eq!(done(&o).1[0].reason, Problem::KeyNotUsed);
        let o = apply_import(&store, r#"{"llm":{"model":7}}"#, &cfg("{}"));
        assert_eq!(done(&o).1[0], Invalid { part: Part::Llm, field: "model", reason: Problem::NotText });
        let o = apply_import(&store, r#"{"partbank":{"connection":"cloud"}}"#, &cfg("{}"));
        assert_eq!(done(&o).1[0].reason, Problem::BadConnection);
        let o = apply_import(&store, r#"{"llm":{"model":"a\tb"}}"#, &cfg("{}"));
        assert_eq!(done(&o).1[0].reason, Problem::BadModel);
        // A key whose stored address is invalid, with none in the file, has nowhere to go.
        let o = apply_import(&store, r#"{"partbank":{"apiKey":"pbk_1"}}"#, &cfg(r#"{"partbankWebUrl":"nope"}"#));
        assert_eq!(done(&o).1[0], Invalid { part: Part::Partbank, field: "apiKey", reason: Problem::NoUrl });
        // Blank values count as absent; a part with nothing in it is skipped silently.
        let o = apply_import(&store, r#"{"llm":{"apiKey":"  "},"partbank":{},"bfworkflow":{"url":"https://wf.example"}}"#, &cfg("{}"));
        let (imported, invalid, _) = done(&o);
        assert!(invalid.is_empty());
        assert_eq!(imported.iter().map(|i| i.part).collect::<Vec<_>>(), vec![Part::Bfworkflow]);
    }

    #[test]
    fn llm_base_url_may_end_in_v1_and_bare_hosts_get_https() {
        let store = MemoryStore::default();
        let o = apply_import(&store, "LLM_BASE_URL=api.openai.example/v1\nLLM_API_KEY=sk-v1", &cfg("{}"));
        assert_eq!(done(&o).2["llmEndpointOpenai"], "https://api.openai.example/v1");
        assert_eq!(store.get("llmOpenai|https://api.openai.example").unwrap().as_deref(), Some("sk-v1"));
    }

    #[test]
    fn unrecognized_text_is_refused() {
        let store = MemoryStore::default();
        for text in ["", "hello world", "{not json", "[1,2]", r#"{"other":{"url":"https://x"}}"#, "FOO=bar\n", r#"{"llm":"x"}"#] {
            assert_eq!(apply_import(&store, text, &cfg("{}")), ImportOutcome::Refused { reason: Refusal::Unrecognized }, "{text:?}");
        }
    }

    #[test]
    fn file_checks_size_text_and_location() {
        let dir = scratch_dir("import-file");
        std::fs::create_dir_all(dir.join("vault").join("sub")).unwrap();
        let vault = dir.join("vault");
        let read = |p: &Path| read_import_file(p, &vault).map(|(_, t)| t);
        // Inside the vault (directly or via a relative spelling) is refused before reading.
        let inside = vault.join("sub").join("conn.json");
        std::fs::write(&inside, FULL_JSON).unwrap();
        assert_eq!(read(&inside), Err(Refusal::InsideVault));
        assert_eq!(read(&vault.join("sub").join("..").join("sub").join("conn.json")), Err(Refusal::InsideVault));
        // Size cap.
        let big = dir.join("big.json");
        std::fs::write(&big, vec![b' '; MAX_IMPORT_BYTES as usize + 1]).unwrap();
        assert_eq!(read(&big), Err(Refusal::TooLarge));
        let edge = dir.join("edge.env");
        std::fs::write(&edge, vec![b'#'; MAX_IMPORT_BYTES as usize]).unwrap();
        assert!(read(&edge).is_ok());
        // Not UTF-8, missing, a folder.
        let bin = dir.join("bin.txt");
        std::fs::write(&bin, [0xff, 0xfe, 0x00, 0x41]).unwrap();
        assert_eq!(read(&bin), Err(Refusal::NotText));
        assert_eq!(read(&dir.join("missing.json")), Err(Refusal::Unreadable));
        assert_eq!(read(&dir), Err(Refusal::Unreadable));
        // A BOM is dropped.
        let bom = dir.join("bom.json");
        std::fs::write(&bom, b"\xEF\xBB\xBF{}").unwrap();
        assert_eq!(read(&bom).unwrap(), "{}");
        // import_file reports the refusal and keeps no path.
        let store = MemoryStore::default();
        let (out, kept) = import_file(&store, &inside, &vault, &cfg("{}"));
        assert_eq!(out, ImportOutcome::Refused { reason: Refusal::InsideVault });
        assert_eq!(kept, None);
        assert_eq!(store.get("partbankWeb|https://pb.lab.example").unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_with_nothing_imported_is_not_kept_for_deletion() {
        let dir = scratch_dir("import-none");
        std::fs::create_dir_all(dir.join("vault")).unwrap();
        let file = dir.join("bad.json");
        std::fs::write(&file, r#"{"partbank":{"url":"nope"}}"#).unwrap();
        let (out, kept) = import_file(&MemoryStore::default(), &file, &dir.join("vault"), &cfg("{}"));
        assert!(done(&out).0.is_empty());
        assert_eq!(kept, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_uses_the_trash_then_asks_before_deleting_for_good() {
        let dir = scratch_dir("import-del");
        let file = dir.join("conn.json");
        std::fs::write(&file, "{}").unwrap();
        let refused = delete_import_with(&file, false, |_| Err(trash::Error::Unknown { description: "no bin".into() })).unwrap();
        assert_eq!(refused, DeleteOutcome::TrashUnavailable);
        assert!(file.exists(), "nothing deleted when the trash refuses");
        let mut seen = None;
        assert_eq!(
            delete_import_with(&file, false, |p| {
                seen = Some(p.to_path_buf());
                Ok(())
            })
            .unwrap(),
            DeleteOutcome::Trashed
        );
        assert_eq!(seen.as_deref(), Some(file.as_path()));
        assert_eq!(delete_import_with(&file, true, |_| unreachable!()).unwrap(), DeleteOutcome::Deleted);
        assert!(!file.exists());
        assert_eq!(delete_import_with(&file, true, |_| unreachable!()).unwrap(), DeleteOutcome::Gone);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
