//! "Import from file…" in the Integration settings dialog: LLM, PartBank and
//! bfworkflow connection settings and keys, read from one file the user picks.
//!
//! The webview never names a path: Rust shows the file picker itself
//! (`integration_import_pick`), so a compromised webview cannot make it read an
//! arbitrary file. A file dropped on the dialog arrives as raw bytes with its
//! name (`integration_import_bytes`) and goes through the same checks and
//! parser. Rust reads at most `MAX_IMPORT_BYTES` (UTF-8 with or without a BOM),
//! refuses a picked file inside the open vault (a vault may be synced or
//! shared), takes only `.env`, `.json`, `.txt` or no extension (the name picks
//! the format; `.txt` and none are guessed), and parses it as JSON
//!
//! ```json
//! {"llm": {"provider": "openai", "baseUrl": "…", "model": "…", "apiKey": "…"},
//!  "partbank": {"connection": "web", "url": "…", "apiKey": "…"},
//!  "bfworkflow": {"url": "…", "apiKey": "…"}}
//! ```
//!
//! or as `.env` lines (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_PROVIDER`,
//! `PARTBANK_URL`, `PARTBANK_API_KEY`, `PARTBANK_CONNECTION`, `BFWORKFLOW_URL`,
//! `BFWORKFLOW_API_KEY`; a ` # comment` after an unquoted value is dropped), and
//! checks every field with the same parsers and key
//! rules the dialog uses. Unknown keys are ignored.
//!
//! Each part is all or nothing: one invalid field skips the whole part, so a
//! key is never stored for an address that was not saved. Keys go to Windows
//! Credential Manager bound to the origin of the URL being saved (or of the
//! stored URL when the file names none), with their epochs bumped. The
//! non-secret fields go back to the webview, which saves them through the
//! dialog's own settings flow (the one source of truth for settings). The
//! answer is a summary of codes: it never holds a key, and nothing in it is
//! copied from the file. A file that names no LLM provider leaves the stored
//! provider as it is, and its LLM fields fill that provider's settings.
//!
//! The same JSON may also hold MCP servers in the Claude-Desktop form
//! (`{"mcpServers": {"<name>": {"url": "…", "headers": {"Authorization":
//! "Bearer …"}}}}`) or the VS Code form (`"servers"`), spec §6.2. Each
//! streamable-HTTP entry is checked like a server added by hand (URL rules,
//! no secret-looking path, at most 16 servers); a real bearer token goes to
//! the keychain under `mcpClient:<id>|<origin>` (chunked), a placeholder such
//! as `<YOUR_TOKEN>` is never stored and the server is marked `needsToken`.
//! stdio entries (`command`/`args`) and legacy SSE entries are listed as
//! skipped: nothing is ever started or contacted, and their command, args and
//! env values are never copied anywhere. Only an `Authorization: Bearer`
//! header is used; any other header is dropped with a problem line. This is
//! the one place where the answer holds text copied from the file: the
//! sanitised server names and the URLs of the servers saved (in the
//! `mcpClientServers` settings patch, which holds the whole new list), never a
//! header value. A secret-looking URL is skipped and never echoed.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;

use super::config::{
    is_loopback, is_secret_looking_url, origin, parse_llm_endpoint, parse_origin_url, parse_service_url, LlmKind, McpAuthKind,
    ServiceConfig, Url, MAX_MCP_NAME, MAX_MCP_SERVERS,
};
use super::error::{NetError, NetErrorKind};
use super::mcp_client::placeholder::{is_placeholder, strip_bearer};
use super::secrets::{get_long, mcp_account, store_long, store_secret_at_url, validate_secret_for, SecretStore, Secrets, Slot};
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
    /// Not a `.env`, `.json` or `.txt` file (or a name with no extension).
    WrongType,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Part {
    Llm,
    Partbank,
    Bfworkflow,
    /// One entry of `mcpServers` / `servers`.
    McpServer,
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
    /// A stdio MCP server (`command`/`args`): never started, listed as skipped.
    StdioSkipped,
    /// A legacy SSE MCP server: not supported.
    SseSkipped,
    /// An MCP connection type other than streamable HTTP, SSE or stdio.
    BadType,
    /// Headers other than `Authorization: Bearer …` were not imported.
    OtherHeaders,
    /// A bearer server with no usable token: the user enters it.
    NeedsToken,
    /// The URL looks like it holds a secret: skipped, never echoed.
    UrlSecret,
    /// Already 16 MCP servers: skipped.
    TooMany,
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
    /// The MCP server's sanitised name (MCP entries only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// One MCP server the import added or updated. No token, no header value.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpImported {
    /// The server's id in `mcpClientServers` (8 lowercase hex).
    pub id: String,
    pub name: String,
    /// The origin its token is bound to.
    pub origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// A token from the file was saved.
    pub token_stored: bool,
    /// A bearer server with no stored token: the user is asked for it.
    pub needs_token: bool,
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
        /// MCP servers added or updated (spec §6.2).
        mcp: Vec<McpImported>,
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
    /// The `mcpServers` (or `servers`) object as found.
    mcp: Option<Map<String, Value>>,
}

impl Parsed {
    fn is_empty(&self) -> bool {
        *self == Parsed::default()
    }
}

/// How the text is read, from the file name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Json,
    Env,
    /// `.txt` or no extension: JSON when it starts with `{`, else `.env`.
    Guess,
}

/// The format for a file name, or `None` for any other extension (or a name
/// that is not a single file name).
fn format_for(name: &str) -> Option<Format> {
    if name.is_empty() || name.contains(['/', '\\']) || name.chars().all(|c| c == '.') {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    if lower == ".env" {
        return Some(Format::Env);
    }
    match lower.rsplit_once('.').map(|(_, ext)| ext) {
        None => Some(Format::Guess),
        Some("env") => Some(Format::Env),
        Some("json") => Some(Format::Json),
        Some("txt") => Some(Format::Guess),
        Some(_) => None,
    }
}

/// JSON text (an object) or `.env` lines. `None` when it is neither, or holds
/// no known setting. Never keeps an error that could quote the text.
fn parse(text: &str, format: Format) -> Option<Parsed> {
    let json = match format {
        Format::Json => true,
        Format::Env => false,
        Format::Guess => text.trim_start().starts_with('{'),
    };
    let parsed = if json { parse_json(text)? } else { parse_env(text) };
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
    p.mcp = part("mcpServers").or_else(|| part("servers")).cloned();
    Some(p)
}

/// One `.env` value (the text after `=`): inside a pair of matching quotes
/// (anything after the closing quote is dropped), or else up to a `#` that
/// follows whitespace (`abc # note` is `abc`, `abc#x` stays whole, `= # x` is
/// blank).
fn env_value(raw: &str) -> &str {
    let value = raw.trim_start();
    for q in ['"', '\''] {
        if let Some(rest) = value.strip_prefix(q) {
            if let Some(end) = rest.find(q) {
                return &rest[..end];
            }
        }
    }
    let cut = value
        .char_indices()
        .find(|&(i, c)| c == '#' && (i == 0 && raw.len() > value.len() || value[..i].ends_with(char::is_whitespace)))
        .map_or(value.len(), |(i, _)| i);
    value[..cut].trim()
}

/// `KEY=VALUE` lines; blank lines, `#` comments and unknown keys are skipped,
/// an `export ` prefix is allowed, one pair of matching quotes is removed, and
/// a ` # comment` after an unquoted value is dropped.
fn parse_env(text: &str) -> Parsed {
    let mut p = Parsed::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        let Some((key, value)) = line.split_once('=') else { continue };
        let field = Field::of_text(env_value(value));
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
            bad.push(Invalid { part, field: name, reason: Problem::NotText, name: None });
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
            bad.push(Invalid { part, field: "apiKey", reason: Problem::BadKey, name: None });
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
    let named = text_of(&f.provider, part, "provider", bad).map(str::to_ascii_lowercase);
    let ollama = match named.as_deref() {
        // No provider in the file: the stored one stays, and the fields are its.
        None => cfg.llm_provider == LlmKind::Ollama,
        Some("openai") => false,
        Some("ollama") => true,
        Some(_) => {
            bad.push(Invalid { part, field: "provider", reason: Problem::BadProvider, name: None });
            false
        }
    };
    let url = text_of(&f.base_url, part, "baseUrl", bad).and_then(|raw| {
        let u = parse_llm_endpoint(raw);
        if u.is_none() {
            bad.push(Invalid { part, field: "baseUrl", reason: Problem::BadUrl, name: None });
        }
        u
    });
    let model = text_of(&f.model, part, "model", bad).and_then(|m| {
        let ok = m.chars().count() <= MAX_MODEL && !m.chars().any(char::is_control);
        if !ok {
            bad.push(Invalid { part, field: "model", reason: Problem::BadModel, name: None });
        }
        ok.then(|| m.to_string())
    });
    let key = if ollama && !f.api_key.is_absent() {
        bad.push(Invalid { part, field: "apiKey", reason: Problem::KeyNotUsed, name: None });
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
                bad.push(Invalid { part, field: "apiKey", reason: Problem::NoUrl, name: None });
                return None;
            }
        },
        None => None,
    };
    let mut settings = Vec::new();
    if named.is_some() {
        settings.push(("llmProvider", Value::from(if ollama { "ollama" } else { "openai" })));
    }
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
            bad.push(Invalid { part, field: "connection", reason: Problem::BadConnection, name: None });
            false
        }
    };
    let url = text_of(&f.url, part, "url", bad).and_then(|raw| {
        let u = parse_origin_url(raw);
        if u.is_none() {
            bad.push(Invalid { part, field: "url", reason: Problem::BadUrl, name: None });
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
                bad.push(Invalid { part, field: "apiKey", reason: Problem::NoUrl, name: None });
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
            bad.push(Invalid { part, field: "url", reason: Problem::BadUrl, name: None });
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
                bad.push(Invalid { part, field: "apiKey", reason: Problem::NoUrl, name: None });
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
    apply_import_as(store, text, Format::Guess, cfg)
}

fn apply_import_as(store: &dyn SecretStore, text: &str, format: Format, cfg: &ServiceConfig) -> ImportOutcome {
    let Some(parsed) = parse(text, format) else {
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
            // MCP entries are imported one by one below.
            Part::McpServer => None,
        };
        let Some(plan) = plan else { continue };
        // The key first: if Credential Manager refuses it, the part's settings are not saved either.
        let key_saved = match &plan.key {
            Some((slot, url, key)) => {
                if store_secret_at_url(store, *slot, url, key).is_err() {
                    invalid.push(Invalid { part, field: "apiKey", reason: Problem::Keychain, name: None });
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
    let mut mcp = Vec::new();
    if let Some(entries) = &parsed.mcp {
        let (done, servers) = plan_mcp(store, entries, cfg, &mut invalid);
        if !done.is_empty() {
            settings.insert("mcpClientServers".to_string(), servers);
        }
        mcp = done;
    }
    ImportOutcome::Done { imported, invalid, mcp, settings }
}

/// The preset servers (spec §5.3): preset, name, URL. Same as `presets.ts`.
const MCP_PRESETS: [(&str, &str, &str); 2] = [
    ("rapid", "RAPID", "https://rapid.kbiofoundry.kr/mcp"),
    ("biomodel", "BioModel Portal", "https://biomodel.kbiofoundry.kr/mcp"),
];

/// One `mcpClientServers` entry while the import builds the new list.
struct McpEntry {
    id: String,
    name: String,
    url: Url,
    auth: McpAuthKind,
    preset: Option<String>,
    enabled: bool,
    tools: Map<String, Value>,
}

impl McpEntry {
    fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("id".into(), Value::from(self.id.clone()));
        o.insert("name".into(), Value::from(self.name.clone()));
        o.insert("url".into(), Value::from(url_setting(&self.url)));
        o.insert("auth".into(), Value::from(if self.auth == McpAuthKind::Bearer { "bearer" } else { "none" }));
        if let Some(p) = &self.preset {
            o.insert("preset".into(), Value::from(p.clone()));
        }
        o.insert("enabled".into(), Value::from(self.enabled));
        o.insert("tools".into(), Value::Object(self.tools.clone()));
        Value::Object(o)
    }
}

/// A server name from a JSON key: control chars removed, trimmed, at most 40 chars.
fn mcp_name(key: &str) -> String {
    let cleaned: String = key.chars().filter(|c| !c.is_control()).collect();
    cleaned.trim().chars().take(MAX_MCP_NAME).collect::<String>().trim_end().to_string()
}

/// A fresh 8-hex id not used by `taken`.
fn new_mcp_id(taken: &[McpEntry]) -> String {
    loop {
        let mut b = [0u8; 4];
        getrandom::getrandom(&mut b).expect("the OS random number generator failed");
        let id: String = b.iter().map(|x| format!("{x:02x}")).collect();
        if !taken.iter().any(|e| e.id == id) {
            return id;
        }
    }
}

/// What an entry's `headers` hold: the `Authorization: Bearer` value (maybe a
/// placeholder) and whether anything else was there.
fn mcp_headers(v: Option<&Value>) -> (Option<String>, bool) {
    match v {
        None | Some(Value::Null) => (None, false),
        Some(Value::Object(h)) => {
            let mut bearer = None;
            let mut other = false;
            for (k, v) in h {
                let is_bearer = |s: &str| s.trim().get(..6).is_some_and(|w| w.eq_ignore_ascii_case("bearer"));
                match v.as_str() {
                    Some(s) if k.eq_ignore_ascii_case("authorization") && is_bearer(s) => bearer = Some(s.to_string()),
                    _ => other = true,
                }
            }
            (bearer, other)
        }
        Some(_) => (None, true),
    }
}

fn mcp_problem(bad: &mut Vec<Invalid>, name: &str, field: &'static str, reason: Problem) {
    bad.push(Invalid { part: Part::McpServer, field, reason, name: Some(name.to_string()) });
}

/// The stored URL an entry would use, or the problem noted.
fn mcp_entry_url(o: &Map<String, Value>, cfg: &ServiceConfig, name: &str, bad: &mut Vec<Invalid>) -> Option<Url> {
    match o.get("type") {
        None | Some(Value::Null) => {}
        Some(Value::String(t)) if matches!(t.as_str(), "http" | "streamable-http" | "streamableHttp") => {}
        Some(Value::String(t)) if t == "sse" => {
            mcp_problem(bad, name, "type", Problem::SseSkipped);
            return None;
        }
        Some(Value::String(t)) if t == "stdio" => {
            mcp_problem(bad, name, "command", Problem::StdioSkipped);
            return None;
        }
        Some(_) => {
            mcp_problem(bad, name, "type", Problem::BadType);
            return None;
        }
    }
    let raw = match o.get("url") {
        Some(Value::String(u)) => u,
        None | Some(Value::Null) if o.contains_key("command") || o.contains_key("args") => {
            mcp_problem(bad, name, "command", Problem::StdioSkipped);
            return None;
        }
        None | Some(Value::Null) => {
            mcp_problem(bad, name, "url", Problem::BadUrl);
            return None;
        }
        Some(_) => {
            mcp_problem(bad, name, "url", Problem::NotText);
            return None;
        }
    };
    let Some(url) = parse_service_url(raw) else {
        mcp_problem(bad, name, "url", Problem::BadUrl);
        return None;
    };
    if is_secret_looking_url(&url) {
        mcp_problem(bad, name, "url", Problem::UrlSecret);
        return None;
    }
    if url.scheme() == "http" && !is_loopback(&url) && !cfg.allows_http(&url) {
        mcp_problem(bad, name, "url", Problem::BadUrl);
        return None;
    }
    Some(url)
}

/// Imports the MCP entries into the stored list; returns what was added or
/// updated and the whole new `mcpClientServers` array. Never starts or
/// contacts anything. A real token is stored under the entry's origin.
fn plan_mcp(store: &dyn SecretStore, entries: &Map<String, Value>, cfg: &ServiceConfig, bad: &mut Vec<Invalid>) -> (Vec<McpImported>, Value) {
    let mut list: Vec<McpEntry> = cfg
        .mcp_servers
        .iter()
        .map(|s| McpEntry {
            id: s.id.clone(),
            name: s.name.clone(),
            url: s.url.clone(),
            auth: s.auth,
            preset: s.preset.clone(),
            enabled: s.enabled,
            tools: s.tools.clone(),
        })
        .collect();
    let mut done: Vec<McpImported> = Vec::new();
    for (key, v) in entries {
        let key_name = mcp_name(key);
        let Some(o) = v.as_object() else {
            mcp_problem(bad, &key_name, "mcpServers", Problem::NotText);
            continue;
        };
        let Some(url) = mcp_entry_url(o, cfg, &key_name, bad) else { continue };
        let (bearer, other_headers) = mcp_headers(o.get("headers"));
        let at = match list.iter().position(|e| e.url == url) {
            Some(i) => i,
            None => {
                if list.len() >= MAX_MCP_SERVERS {
                    mcp_problem(bad, &key_name, "mcpServers", Problem::TooMany);
                    continue;
                }
                // Same URL as a preset not yet stored: the import fills that preset row.
                let preset = MCP_PRESETS
                    .iter()
                    .find(|(_, _, u)| parse_service_url(u).as_ref() == Some(&url))
                    .filter(|(p, _, _)| !list.iter().any(|e| e.preset.as_deref() == Some(*p)));
                let name = match preset {
                    Some((_, n, _)) => n.to_string(),
                    None if key_name.is_empty() => mcp_name(url.host_str().unwrap_or("MCP")),
                    None => key_name.clone(),
                };
                let auth = if bearer.is_some() || preset.is_some() { McpAuthKind::Bearer } else { McpAuthKind::None };
                let id = new_mcp_id(&list);
                list.push(McpEntry {
                    id,
                    name,
                    url: url.clone(),
                    auth,
                    preset: preset.map(|(p, _, _)| p.to_string()),
                    enabled: true,
                    tools: Map::new(),
                });
                list.len() - 1
            }
        };
        if bearer.is_some() {
            list[at].auth = McpAuthKind::Bearer;
        }
        let entry = &list[at];
        let account = mcp_account(&entry.id, &origin(&entry.url));
        let mut token_stored = false;
        if let Some(raw) = bearer.as_deref().filter(|b| !is_placeholder(b)) {
            match store_long(store, &account, strip_bearer(raw)) {
                Ok(()) => token_stored = true,
                Err(e) if e.kind == NetErrorKind::BadInput => mcp_problem(bad, &entry.name, "headers", Problem::BadKey),
                Err(_) => mcp_problem(bad, &entry.name, "headers", Problem::Keychain),
            }
        }
        let needs_token = entry.auth == McpAuthKind::Bearer && !token_stored && !matches!(get_long(store, &account), Ok(Some(_)));
        if needs_token {
            mcp_problem(bad, &entry.name, "headers", Problem::NeedsToken);
        }
        if other_headers {
            mcp_problem(bad, &entry.name, "headers", Problem::OtherHeaders);
        }
        let item = McpImported {
            id: entry.id.clone(),
            name: entry.name.clone(),
            origin: origin(&entry.url),
            preset: entry.preset.clone(),
            token_stored,
            needs_token,
        };
        match done.iter_mut().find(|d| d.id == item.id) {
            Some(prev) => *prev = item,
            None => done.push(item),
        }
    }
    (done, Value::Array(list.iter().map(McpEntry::to_json).collect()))
}

/// The text of an import file's bytes: at most `MAX_IMPORT_BYTES`, UTF-8 with
/// an optional BOM (dropped).
fn import_text(bytes: &[u8]) -> Result<&str, Refusal> {
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(Refusal::TooLarge);
    }
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    std::str::from_utf8(body).map_err(|_| Refusal::NotText)
}

/// Reads the file at `path` for the import: a regular file outside `vault_root`
/// (both canonicalized, so a link into the vault counts as inside), at most
/// `MAX_IMPORT_BYTES`, UTF-8 with an optional BOM. Returns the canonical path
/// and the text without the BOM.
pub fn read_import_file(path: &Path, vault_root: &Path) -> Result<(PathBuf, String), Refusal> {
    let (file, bytes) = read_import_bytes(path, vault_root)?;
    let text = import_text(&bytes)?.to_string();
    Ok((file, text))
}

/// The checks of `read_import_file`, returning the raw bytes (at most
/// `MAX_IMPORT_BYTES`).
fn read_import_bytes(path: &Path, vault_root: &Path) -> Result<(PathBuf, Vec<u8>), Refusal> {
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
    Ok((file, bytes))
}

/// Checks and imports one file's bytes; `name` is its file name (no folder),
/// which picks the format. The one path for a picked and a dropped file.
pub fn import_bytes(store: &dyn SecretStore, name: &str, bytes: &[u8], cfg: &ServiceConfig) -> ImportOutcome {
    let Some(format) = format_for(name) else {
        return ImportOutcome::Refused { reason: Refusal::WrongType };
    };
    match import_text(bytes) {
        Err(reason) => ImportOutcome::Refused { reason },
        Ok(text) => apply_import_as(store, text, format, cfg),
    }
}

/// Reads, checks and imports the file; see the module doc. Also returns the
/// canonical path when something was imported (the file the user may then
/// delete).
pub fn import_file(
    store: &dyn SecretStore,
    path: &Path,
    vault_root: &Path,
    cfg: &ServiceConfig,
) -> (ImportOutcome, Option<PathBuf>) {
    match read_import_bytes(path, vault_root) {
        Err(reason) => (ImportOutcome::Refused { reason }, None),
        Ok((file, mut bytes)) => {
            let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let outcome = import_bytes(store, &name, &bytes, cfg);
            bytes.fill(0);
            let any = matches!(&outcome, ImportOutcome::Done { imported, mcp, .. } if !imported.is_empty() || !mcp.is_empty());
            (outcome, any.then_some(file))
        }
    }
}

/// Imports a file the picker returned, and remembers it for
/// `integration_import_delete` when something was imported.
pub fn import_picked(net: &NetState, store: &dyn SecretStore, path: &Path, vault_root: &Path, cfg: &ServiceConfig) -> ImportOutcome {
    let (outcome, file) = import_file(store, path, vault_root, cfg);
    if let Some(file) = file {
        *net.last_import.lock().unwrap_or_else(|e| e.into_inner()) = Some(file);
    }
    outcome
}

fn no_vault() -> NetError {
    NetError::new(NetErrorKind::NotConfigured, "no vault is open")
}

/// Longest picker title taken from the webview, in chars.
const MAX_TITLE: usize = 200;

/// "Import from file…": Rust shows the file picker (modal to the main window)
/// and imports the chosen file. `None` when the picker was cancelled. The
/// webview sends only the localised title and never names a path. A pick made
/// after another vault was opened is dropped.
#[tauri::command]
pub async fn integration_import_pick<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    title: String,
) -> Result<Option<ImportOutcome>, NetError> {
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;
    let root = vault.root().map_err(|_| no_vault())?;
    let title: String = title.chars().filter(|c| !c.is_control()).take(MAX_TITLE).collect();
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = dialog_app.dialog().file().set_title(title).add_filter("JSON / .env", &["env", "json", "txt"]);
        if let Some(window) = dialog_app.get_webview_window("main") {
            builder = builder.set_parent(&window);
        }
        builder.blocking_pick_file()
    })
    .await
    .map_err(|e| NetError::new(NetErrorKind::Io, format!("file picker failed: {e}")))?;
    let Some(picked) = picked else { return Ok(None) };
    if vault.root().ok().as_deref() != Some(root.as_path()) {
        return Err(NetError::new(NetErrorKind::BadInput, "another vault was opened while the file picker was up"));
    }
    let path = picked
        .into_path()
        .map_err(|_| NetError::new(NetErrorKind::BadInput, "the chosen file is not a local path"))?;
    let cfg = ServiceConfig::load(&settings.0, Some(&root))?;
    let store = secrets.0.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        import_picked(&app.state::<NetState>(), store.as_ref(), &path, &root, &cfg)
    })
    .await
    .map_err(|e| NetError::new(NetErrorKind::Io, format!("import failed: {e}")))?;
    Ok(Some(outcome))
}

/// A connection file dropped on the dialog: its bytes as the raw request body
/// and its name in the percent-encoded `x-lno-name` header. The same checks and
/// parser as a picked file; there is no path, so nothing is kept for deletion.
///
/// Known limit: the raw body is borrowed from Tauri's request (`&[u8]` behind a
/// shared reference) and freed by Tauri after the command returns, so it cannot
/// be zeroed here. Only the copies this module owns are zeroed; the webview
/// zeroes its own buffer after sending.
#[tauri::command]
pub fn integration_import_bytes(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    request: tauri::ipc::Request<'_>,
) -> Result<ImportOutcome, NetError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(NetError::new(NetErrorKind::BadInput, "the file must be sent as raw bytes"));
    };
    let name = crate::vault::fs::header(&request, "x-lno-name")
        .map_err(|_| NetError::new(NetErrorKind::BadInput, "the file name is missing"))?;
    let root = vault.root().map_err(|_| no_vault())?;
    let cfg = ServiceConfig::load(&settings.0, Some(&root))?;
    Ok(import_bytes(secrets.0.as_ref(), &name, bytes, &cfg))
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
    use crate::net::config::{MAX_MCP_NAME, MAX_MCP_SERVERS};
    use crate::net::secrets::{get_long, status_of, MemoryStore};

    fn cfg(json: &str) -> ServiceConfig {
        ServiceConfig::from_settings_json(json)
    }

    fn done(o: &ImportOutcome) -> (&Vec<Imported>, &Vec<Invalid>, &Map<String, Value>) {
        match o {
            ImportOutcome::Done { imported, invalid, settings, .. } => (imported, invalid, settings),
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
                Invalid { part: Part::Llm, field: "baseUrl", reason: Problem::BadUrl, name: None },
                Invalid { part: Part::Partbank, field: "apiKey", reason: Problem::BadKey, name: None },
                Invalid { part: Part::Bfworkflow, field: "url", reason: Problem::BadUrl, name: None },
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
        assert_eq!(done(&o).1[0], Invalid { part: Part::Llm, field: "model", reason: Problem::NotText, name: None });
        let o = apply_import(&store, r#"{"partbank":{"connection":"cloud"}}"#, &cfg("{}"));
        assert_eq!(done(&o).1[0].reason, Problem::BadConnection);
        let o = apply_import(&store, r#"{"llm":{"model":"a\tb"}}"#, &cfg("{}"));
        assert_eq!(done(&o).1[0].reason, Problem::BadModel);
        // A key whose stored address is invalid, with none in the file, has nowhere to go.
        let o = apply_import(&store, r#"{"partbank":{"apiKey":"pbk_1"}}"#, &cfg(r#"{"partbankWebUrl":"nope"}"#));
        assert_eq!(done(&o).1[0], Invalid { part: Part::Partbank, field: "apiKey", reason: Problem::NoUrl, name: None });
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
    fn a_file_without_a_provider_keeps_the_stored_one() {
        let store = MemoryStore::default();
        let o = apply_import(&store, "LLM_BASE_URL=https://gw.lab.example/v1\nLLM_MODEL=m", &cfg(r#"{"llmProvider":"none"}"#));
        let (imported, invalid, settings) = done(&o);
        assert!(invalid.is_empty(), "{invalid:?}");
        assert_eq!(imported.len(), 1);
        assert!(!settings.contains_key("llmProvider"), "{settings:?}");
        assert_eq!(settings["llmEndpointOpenai"], "https://gw.lab.example/v1");
        // With Ollama stored, a file that names no provider fills the Ollama fields.
        let o = apply_import(&store, r#"{"llm":{"baseUrl":"http://localhost:11434","model":"llama3"}}"#, &cfg(r#"{"llmProvider":"ollama"}"#));
        let settings = done(&o).2;
        assert!(!settings.contains_key("llmProvider"), "{settings:?}");
        assert_eq!(settings["llmEndpointOllama"], "http://localhost:11434");
        // An explicit provider is still written.
        let o = apply_import(&store, "LLM_PROVIDER=ollama\nLLM_MODEL=m", &cfg(r#"{"llmProvider":"openai"}"#));
        assert_eq!(done(&o).2["llmProvider"], "ollama");
        let o = apply_import(&store, r#"{"llm":{"provider":"openai","model":"m"}}"#, &cfg(r#"{"llmProvider":"ollama"}"#));
        assert_eq!(done(&o).2["llmProvider"], "openai");
    }

    #[test]
    fn env_inline_comments_are_stripped_only_after_unquoted_values() {
        let store = MemoryStore::default();
        let model = |text: &str| -> Value {
            let o = apply_import(&store, text, &cfg("{}"));
            done(&o).2.get("llmModel").cloned().unwrap_or(Value::Null)
        };
        assert_eq!(model("LLM_MODEL=abc # note"), "abc");
        assert_eq!(model("LLM_MODEL=abc\t# note"), "abc");
        assert_eq!(model("LLM_MODEL=\"abc # x\""), "abc # x");
        assert_eq!(model("LLM_MODEL='abc # x' # note"), "abc # x");
        assert_eq!(model("LLM_MODEL=abc#x"), "abc#x");
        // A value that is only a comment is blank, so absent.
        let o = apply_import(&store, "LLM_MODEL= # none\nPARTBANK_URL=https://pb.lab.example # web", &cfg("{}"));
        let (imported, _, settings) = done(&o);
        assert_eq!(imported.iter().map(|i| i.part).collect::<Vec<_>>(), vec![Part::Partbank]);
        assert_eq!(settings["partbankWebUrl"], "https://pb.lab.example");
        // A key with a trailing comment is stored without it.
        apply_import(&store, "BFWORKFLOW_URL=https://wf.lab.example\nBFWORKFLOW_API_KEY=bfw_c # mine", &cfg("{}"));
        assert_eq!(store.get("bfwServer|https://wf.lab.example").unwrap().as_deref(), Some("bfw_c"));
    }

    #[test]
    fn import_bytes_matches_import_file_and_checks_name_and_size() {
        let dir = scratch_dir("import-bytes");
        std::fs::create_dir_all(dir.join("vault")).unwrap();
        let env = "LLM_BASE_URL=https://gw.lab.example/v1 # gw\nLLM_API_KEY=sk-bytes\nPARTBANK_URL=https://pb.lab.example\n";
        for (name, text) in [("conn.env", env), (".env", env), ("conn.json", FULL_JSON), ("conn.txt", FULL_JSON), ("conn", env)] {
            let file = dir.join(if name == ".env" { "dot.env" } else { name });
            std::fs::write(&file, text).unwrap();
            let (a, b) = (MemoryStore::default(), MemoryStore::default());
            let (from_file, _) = import_file(&a, &file, &dir.join("vault"), &cfg("{}"));
            let from_bytes = import_bytes(&b, name, text.as_bytes(), &cfg("{}"));
            assert_eq!(from_file, from_bytes, "{name}");
            assert!(!done(&from_bytes).0.is_empty(), "{name}");
            assert_eq!(a.get("llmOpenai|https://gw.lab.example").unwrap(), b.get("llmOpenai|https://gw.lab.example").unwrap());
            assert!(b.get("llmOpenai|https://gw.lab.example").unwrap().is_some(), "{name}");
        }
        // The name picks the format: a .json file must be JSON.
        let store = MemoryStore::default();
        assert_eq!(import_bytes(&store, "conn.json", env.as_bytes(), &cfg("{}")), ImportOutcome::Refused { reason: Refusal::Unrecognized });
        // Other extensions, oversize and non-text are refused before parsing.
        for name in ["conn.exe", "conn.md", "conn.env.bak", "", "dir/"] {
            assert_eq!(import_bytes(&store, name, env.as_bytes(), &cfg("{}")), ImportOutcome::Refused { reason: Refusal::WrongType }, "{name:?}");
        }
        let big = vec![b' '; MAX_IMPORT_BYTES as usize + 1];
        assert_eq!(import_bytes(&store, "conn.env", &big, &cfg("{}")), ImportOutcome::Refused { reason: Refusal::TooLarge });
        assert_eq!(import_bytes(&store, "conn.env", &[0xff, 0xfe, 0x41], &cfg("{}")), ImportOutcome::Refused { reason: Refusal::NotText });
        let mut bom = b"\xEF\xBB\xBF".to_vec();
        bom.extend_from_slice(env.as_bytes());
        assert!(!done(&import_bytes(&store, "conn.env", &bom, &cfg("{}"))).0.is_empty());
        assert_eq!(store.get("partbankWeb|https://pb.lab.example").unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_picked_file_is_remembered_for_deletion_only_when_something_was_imported() {
        let dir = scratch_dir("import-picked");
        std::fs::create_dir_all(dir.join("vault")).unwrap();
        let net = NetState::default();
        let bad = dir.join("bad.json");
        std::fs::write(&bad, r#"{"partbank":{"url":"nope"}}"#).unwrap();
        import_picked(&net, &MemoryStore::default(), &bad, &dir.join("vault"), &cfg("{}"));
        assert_eq!(*net.last_import.lock().unwrap(), None);
        let good = dir.join("good.json");
        std::fs::write(&good, r#"{"partbank":{"url":"https://pb.lab.example"}}"#).unwrap();
        let out = import_picked(&net, &MemoryStore::default(), &good, &dir.join("vault"), &cfg("{}"));
        assert_eq!(done(&out).0.len(), 1);
        assert_eq!(*net.last_import.lock().unwrap(), Some(std::fs::canonicalize(&good).unwrap()));
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

    // ── MCP servers (Claude-Desktop / VS Code JSON, spec §6.2) ──

    fn done_mcp(o: &ImportOutcome) -> (&Vec<Invalid>, &Vec<McpImported>, &Map<String, Value>) {
        match o {
            ImportOutcome::Done { invalid, mcp, settings, .. } => (invalid, mcp, settings),
            other => panic!("expected done, got {other:?}"),
        }
    }

    fn servers_of(settings: &Map<String, Value>) -> Vec<Value> {
        settings.get("mcpClientServers").and_then(Value::as_array).cloned().unwrap_or_default()
    }

    fn reasons_for(invalid: &[Invalid], name: &str) -> Vec<Problem> {
        invalid.iter().filter(|i| i.part == Part::McpServer && i.name.as_deref() == Some(name)).map(|i| i.reason).collect()
    }

    const TOKEN: &str = "test-token-rapid-123";

    const MCP_JSON: &str = r#"{"mcpServers": {
        "rapid": {"type": "http", "url": "https://rapid.kbiofoundry.kr/mcp", "headers": {"Authorization": "Bearer test-token-rapid-123"}},
        "biomodel": {"url": "https://biomodel.kbiofoundry.kr/mcp/", "headers": {"Authorization": "Bearer <KBF_SSO_ACCESS_TOKEN>"}},
        "local": {"url": "http://127.0.0.1:9000/mcp"},
        "fs": {"command": "npx", "args": ["-y", "server-fs"], "env": {"API_KEY": "sk-test-123"}},
        "old": {"type": "sse", "url": "https://old.example/sse"},
        "extra": {"type": "streamable-http", "url": "https://extra.example/mcp", "headers": {"Authorization": "Bearer extra-token-456", "X-Api-Key": "xkey-789"}}
    }}"#;

    #[test]
    fn claude_desktop_json_imports_mcp_servers() {
        let store = MemoryStore::with_entry_limit(1280);
        let out = apply_import(&store, MCP_JSON, &cfg("{}"));
        let (invalid, mcp, settings) = done_mcp(&out);
        let servers = servers_of(settings);
        assert_eq!(servers.len(), 4, "{servers:?}");
        let by_url = |u: &str| servers.iter().find(|s| s["url"] == u).cloned().unwrap_or_else(|| panic!("{u} in {servers:?}"));
        // RAPID merged into its preset, the token in the keychain under its origin.
        let rapid = by_url("https://rapid.kbiofoundry.kr/mcp");
        assert_eq!((rapid["preset"].as_str(), rapid["name"].as_str(), rapid["auth"].as_str()), (Some("rapid"), Some("RAPID"), Some("bearer")));
        let rid = rapid["id"].as_str().unwrap().to_string();
        assert_eq!(get_long(&store, &format!("mcpClient:{rid}|https://rapid.kbiofoundry.kr")).unwrap().as_deref(), Some(TOKEN));
        // BioModel: a placeholder is never stored; the server asks for the token.
        let bio = by_url("https://biomodel.kbiofoundry.kr/mcp");
        assert_eq!((bio["preset"].as_str(), bio["auth"].as_str()), (Some("biomodel"), Some("bearer")));
        let bid = bio["id"].as_str().unwrap().to_string();
        assert_eq!(get_long(&store, &format!("mcpClient:{bid}|https://biomodel.kbiofoundry.kr")).unwrap(), None);
        // A custom server without headers needs no auth.
        let local = by_url("http://127.0.0.1:9000/mcp");
        assert_eq!((local["auth"].as_str(), local["name"].as_str(), local.get("preset")), (Some("none"), Some("local"), None));
        assert_eq!(local["enabled"], true);
        assert_eq!(local["tools"], serde_json::json!({}));
        let extra = by_url("https://extra.example/mcp");
        assert_eq!(extra["auth"], "bearer");
        let eid = extra["id"].as_str().unwrap().to_string();
        assert_eq!(get_long(&store, &format!("mcpClient:{eid}|https://extra.example")).unwrap().as_deref(), Some("extra-token-456"));
        // The summary, per server.
        let row = |n: &str| mcp.iter().find(|m| m.name == n).cloned().unwrap_or_else(|| panic!("{n} in {mcp:?}"));
        let r = row("RAPID");
        assert_eq!((r.token_stored, r.needs_token, r.preset.as_deref(), r.origin.as_str()), (true, false, Some("rapid"), "https://rapid.kbiofoundry.kr"));
        assert_eq!(r.id, rid);
        let b = row("BioModel Portal");
        assert_eq!((b.token_stored, b.needs_token, b.id.as_str()), (false, true, bid.as_str()));
        let l = row("local");
        assert_eq!((l.token_stored, l.needs_token), (false, false));
        assert_eq!(mcp.len(), 4);
        // Problems: placeholder, stdio, sse, other headers.
        assert_eq!(reasons_for(invalid, "BioModel Portal"), vec![Problem::NeedsToken]);
        assert_eq!(reasons_for(invalid, "fs"), vec![Problem::StdioSkipped]);
        assert_eq!(reasons_for(invalid, "old"), vec![Problem::SseSkipped]);
        assert_eq!(reasons_for(invalid, "extra"), vec![Problem::OtherHeaders]);
        assert_eq!(invalid.len(), 4, "{invalid:?}");
        // Ids: 8 lowercase hex, unique.
        let ids: Vec<&str> = servers.iter().map(|s| s["id"].as_str().unwrap()).collect();
        for id in &ids {
            assert!(id.len() == 8 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)), "{id}");
        }
        let mut uniq = ids.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), ids.len());
        // No token, header value, command or env value anywhere in the outcome.
        let text = serde_json::to_string(&out).unwrap();
        for secret in [TOKEN, "extra-token-456", "xkey-789", "sk-test-123", "npx", "server-fs", "KBF_SSO_ACCESS_TOKEN", "Bearer"] {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
        // The settings round-trip through the config parser.
        assert_eq!(cfg(&Value::Object(settings.clone()).to_string()).mcp_servers.len(), 4);
    }

    #[test]
    fn vs_code_servers_form_is_accepted() {
        let store = MemoryStore::default();
        let out = apply_import(&store, r#"{"servers": {"Mine": {"type": "streamableHttp", "url": "https://mine.example/mcp"}}}"#, &cfg("{}"));
        let (invalid, mcp, settings) = done_mcp(&out);
        assert!(invalid.is_empty(), "{invalid:?}");
        assert_eq!(mcp.len(), 1);
        assert_eq!(servers_of(settings)[0]["name"], "Mine");
    }

    #[test]
    fn reimport_updates_in_place_and_keeps_stored_entries() {
        let store = MemoryStore::default();
        let stored = serde_json::json!({"mcpClientServers": [
            {"id": "0a1b2c3d", "name": "Lab", "url": "https://lab.example/mcp", "auth": "none", "enabled": false, "tools": {"t1": true, "bad": 3}},
            {"id": "0a1b2c3e", "name": "RAPID", "url": "https://rapid.kbiofoundry.kr/mcp", "auth": "bearer", "preset": "rapid", "enabled": true, "tools": {}}
        ]})
        .to_string();
        let json = r#"{"mcpServers": {
            "Renamed": {"url": "https://lab.example/mcp/", "headers": {"Authorization": "Bearer lab-token-1"}},
            "rapid": {"url": "https://rapid.kbiofoundry.kr/mcp", "headers": {"Authorization": "Bearer rapid-token-2"}}
        }}"#;
        let out = apply_import(&store, json, &cfg(&stored));
        let (invalid, mcp, settings) = done_mcp(&out);
        assert!(invalid.is_empty(), "{invalid:?}");
        let servers = servers_of(settings);
        assert_eq!(servers.len(), 2, "{servers:?}");
        assert_eq!(servers[0]["id"], "0a1b2c3d");
        assert_eq!(servers[0]["name"], "Lab", "an existing name is kept");
        assert_eq!(servers[0]["auth"], "bearer", "a token header switches the server to bearer");
        assert_eq!(servers[0]["enabled"], false);
        assert_eq!(servers[0]["tools"], serde_json::json!({"t1": true}));
        assert_eq!(servers[1]["id"], "0a1b2c3e");
        assert_eq!(get_long(&store, "mcpClient:0a1b2c3d|https://lab.example").unwrap().as_deref(), Some("lab-token-1"));
        assert_eq!(get_long(&store, "mcpClient:0a1b2c3e|https://rapid.kbiofoundry.kr").unwrap().as_deref(), Some("rapid-token-2"));
        let mut ids: Vec<&str> = mcp.iter().map(|m| m.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["0a1b2c3d", "0a1b2c3e"]);
        // A placeholder for a server whose token is already stored does not ask again.
        let again = apply_import(
            &store,
            r#"{"mcpServers":{"rapid":{"url":"https://rapid.kbiofoundry.kr/mcp","headers":{"Authorization":"Bearer <YOUR_TOKEN>"}}}}"#,
            &cfg(&stored),
        );
        let (invalid, mcp, _) = done_mcp(&again);
        assert!(invalid.is_empty(), "{invalid:?}");
        assert!(!mcp[0].needs_token && !mcp[0].token_stored);
        assert_eq!(get_long(&store, "mcpClient:0a1b2c3e|https://rapid.kbiofoundry.kr").unwrap().as_deref(), Some("rapid-token-2"));
    }

    #[test]
    fn the_17th_server_is_dropped_with_a_problem() {
        let store = MemoryStore::default();
        let entries: Vec<String> = (0..17).map(|i| format!(r#""s{i:02}": {{"url": "https://s{i}.example/mcp"}}"#)).collect();
        let out = apply_import(&store, &format!(r#"{{"mcpServers": {{{}}}}}"#, entries.join(",")), &cfg("{}"));
        let (invalid, mcp, settings) = done_mcp(&out);
        assert_eq!(servers_of(settings).len(), MAX_MCP_SERVERS);
        assert_eq!(mcp.len(), MAX_MCP_SERVERS);
        assert_eq!(invalid.iter().filter(|i| i.reason == Problem::TooMany).count(), 1, "{invalid:?}");
    }

    #[test]
    fn secret_looking_urls_are_skipped_without_echo() {
        let store = MemoryStore::default();
        let out = apply_import(
            &store,
            r#"{"mcpServers": {"hosted": {"url": "https://h.example/mcp/a1B2c3D4e5F6g7H8i9J0k1L2"},
                               "bad": {"url": "ftp://x.example"}, "plain": {"url": "http://10.0.0.5/mcp"}}}"#,
            &cfg("{}"),
        );
        let (invalid, mcp, settings) = done_mcp(&out);
        assert!(mcp.is_empty());
        assert!(servers_of(settings).is_empty());
        assert_eq!(reasons_for(invalid, "hosted"), vec![Problem::UrlSecret]);
        assert_eq!(reasons_for(invalid, "bad"), vec![Problem::BadUrl]);
        assert_eq!(reasons_for(invalid, "plain"), vec![Problem::BadUrl]);
        let text = serde_json::to_string(&out).unwrap();
        assert!(!text.contains("a1B2c3D4e5F6g7H8i9J0k1L2") && !text.contains("h.example"), "{text}");
    }

    #[test]
    fn names_are_cleaned_and_bad_entries_reported() {
        let store = MemoryStore::default();
        let long = "N".repeat(60);
        let json = serde_json::json!({"mcpServers": {
            format!("  a\u{7}b {long}"): {"url": "https://a.example/mcp"},
            "weird": {"type": "websocket", "url": "wss://w.example"},
            "nothing": {},
            "num": 7,
            "basic": {"url": "https://b.example/mcp", "headers": {"Authorization": "Basic dXNlcjpwYXNz"}},
            "toolong": {"url": "https://c.example/mcp", "headers": {"Authorization": format!("Bearer {}", "t".repeat(9000))}}
        }})
        .to_string();
        let out = apply_import(&store, &json, &cfg("{}"));
        let (invalid, mcp, _) = done_mcp(&out);
        let a = mcp.iter().find(|m| m.origin == "https://a.example").unwrap();
        assert_eq!(a.name.chars().count(), MAX_MCP_NAME);
        assert!(a.name.starts_with("ab N") && !a.name.chars().any(char::is_control), "{:?}", a.name);
        assert_eq!(reasons_for(invalid, "weird"), vec![Problem::BadType]);
        assert_eq!(reasons_for(invalid, "nothing"), vec![Problem::BadUrl]);
        assert_eq!(reasons_for(invalid, "num"), vec![Problem::NotText]);
        // A non-bearer Authorization header is another header: imported without auth.
        assert_eq!(reasons_for(invalid, "basic"), vec![Problem::OtherHeaders]);
        assert!(!mcp.iter().find(|m| m.name == "basic").unwrap().needs_token);
        // A token over 8,192 chars is refused; the server asks for the token.
        assert_eq!(reasons_for(invalid, "toolong"), vec![Problem::BadKey, Problem::NeedsToken]);
        let text = serde_json::to_string(&out).unwrap();
        assert!(!text.contains("dXNlcjpwYXNz") && !text.contains("ttttttttt"), "too much in {}", text.len());
    }

    #[test]
    fn a_file_with_only_mcp_servers_is_kept_for_deletion() {
        let dir = scratch_dir("import-mcp");
        std::fs::create_dir_all(dir.join("vault")).unwrap();
        let file = dir.join("claude_desktop_config.json");
        std::fs::write(&file, MCP_JSON).unwrap();
        let (out, kept) = import_file(&MemoryStore::default(), &file, &dir.join("vault"), &cfg("{}"));
        assert!(!done_mcp(&out).1.is_empty());
        assert_eq!(kept, Some(std::fs::canonicalize(&file).unwrap()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_import_module_never_starts_a_process() {
        let src = include_str!("import.rs");
        for needle in [["std::", "process"].concat(), ["Command", "::new"].concat(), [".sp", "awn("].concat()] {
            assert!(!src.contains(&needle), "{needle}");
        }
    }
}
