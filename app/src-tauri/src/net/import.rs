//! "Import from file…" in the Integration settings dialog: LLM, PartBank,
//! bfworkflow and GitHub connection settings and keys, read from one file the
//! user picks.
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
//!  "bfworkflow": {"url": "…", "apiKey": "…"},
//!  "github": {"clientId": "…", "token": "…"}}
//! ```
//!
//! or as `.env` lines (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_PROVIDER`,
//! `PARTBANK_URL`, `PARTBANK_API_KEY`, `PARTBANK_CONNECTION`, `BFWORKFLOW_URL`,
//! `BFWORKFLOW_API_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_TOKEN`; a ` # comment`
//! after an unquoted value is dropped), and
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
//! The GitHub part is app-wide, not a vault setting: its token goes to the
//! fixed-origin GitHub slot (offline, not checked against GitHub; the next
//! GitHub call does that), and its client ID comes back in the outcome's
//! Rust-only `github` field, which the commands write to `github/app.json`
//! (`finish_github_import`). An import never sets an owner or a visibility:
//! those keys are ignored like any other unknown key.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;

use super::config::{parse_llm_endpoint, parse_origin_url, LlmKind, ServiceConfig, Url};
use super::error::{NetError, NetErrorKind};
use super::github::GithubState;
use super::secrets::{clear_secret, store_secret, store_secret_at_url, validate_secret_for, SecretStore, Secrets, Slot};
use super::{IntegrationDirs, NetState};
use crate::gitsync::state::{client_id_ok, github_client_id, read_doc, write_doc, GithubAppSettings, GithubDoc};
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
    Github,
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
    /// Not a GitHub access token (`ghp_`, `github_pat_`, `gho_`, `ghu_`).
    BadToken,
    /// Not the shape of a GitHub OAuth App client ID.
    BadClientId,
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
    /// The file's field name (`baseUrl`, `url`, `apiKey`, `model`, `provider`,
    /// `connection`, `clientId`, `token`).
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
        /// The GitHub part, when it was imported: for the command to write
        /// app-wide. Never sent to the webview.
        #[serde(skip)]
        github: Option<GithubImport>,
    },
}

/// What an imported GitHub part leaves for `finish_github_import`. Holds no
/// secret (the token is already in the keychain).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GithubImport {
    /// The client ID from the file, already checked.
    pub client_id: Option<String>,
    /// A token was stored in the GitHub slot.
    pub token_saved: bool,
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
struct GithubFields {
    client_id: Field,
    token: Field,
}

#[derive(Debug, Default, PartialEq)]
struct Parsed {
    llm: LlmFields,
    partbank: PartbankFields,
    bfw: BfwFields,
    github: GithubFields,
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
    // Only these two: an `owner`, `public` or any other key is ignored.
    if let Some(o) = part("github") {
        p.github = GithubFields { client_id: Field::of_json(o.get("clientId")), token: Field::of_json(o.get("token")) };
    }
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
            "GITHUB_CLIENT_ID" => p.github.client_id = field,
            "GITHUB_TOKEN" => p.github.token = field,
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
    let named = text_of(&f.provider, part, "provider", bad).map(str::to_ascii_lowercase);
    let ollama = match named.as_deref() {
        // No provider in the file: the stored one stays, and the fields are its.
        None => cfg.llm_provider == LlmKind::Ollama,
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

/// The GitHub part: a checked client ID and token. No network call.
struct GithubPlan {
    client_id: Option<String>,
    token: Option<zeroize::Zeroizing<String>>,
}

fn plan_github(f: &GithubFields, bad: &mut Vec<Invalid>) -> Option<GithubPlan> {
    let part = Part::Github;
    let before = bad.len();
    let client_id = text_of(&f.client_id, part, "clientId", bad).and_then(|id| {
        let ok = client_id_ok(id);
        if !ok {
            bad.push(Invalid { part, field: "clientId", reason: Problem::BadClientId });
        }
        ok.then(|| id.to_string())
    });
    let token = text_of(&f.token, part, "token", bad).and_then(|raw| match validate_secret_for(Slot::Github, raw) {
        Ok(t) => Some(zeroize::Zeroizing::new(t)),
        Err(_) => {
            bad.push(Invalid { part, field: "token", reason: Problem::BadToken });
            None
        }
    });
    (bad.len() == before).then_some(GithubPlan { client_id, token })
}

/// Stores the GitHub token in the fixed-origin slot. The refresh token of an
/// earlier sign-in belongs to another token, so it goes first.
fn store_github(store: &dyn SecretStore, cfg: &ServiceConfig, token: &str) -> Result<(), NetError> {
    clear_secret(store, Slot::GithubRefresh, cfg)?;
    store_secret(store, Slot::Github, cfg, token)
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
    let mut github = None;
    let parts = [
        (Part::Llm, parsed.llm == LlmFields::default()),
        (Part::Partbank, parsed.partbank == PartbankFields::default()),
        (Part::Bfworkflow, parsed.bfw == BfwFields::default()),
        (Part::Github, parsed.github == GithubFields::default()),
    ];
    for (part, empty) in parts {
        if empty {
            continue;
        }
        if part == Part::Github {
            let Some(plan) = plan_github(&parsed.github, &mut invalid) else { continue };
            if let Some(token) = &plan.token {
                if store_github(store, cfg, token).is_err() {
                    invalid.push(Invalid { part, field: "token", reason: Problem::Keychain });
                    continue;
                }
            }
            let token_saved = plan.token.is_some();
            github = Some(GithubImport { client_id: plan.client_id, token_saved });
            imported.push(Imported { part, key_saved: token_saved });
            continue;
        }
        let plan = match part {
            Part::Llm => plan_llm(&parsed.llm, cfg, &mut invalid),
            Part::Partbank => plan_partbank(&parsed.partbank, cfg, &mut invalid),
            Part::Bfworkflow => plan_bfw(&parsed.bfw, cfg, &mut invalid),
            Part::Github => unreachable!("handled above"),
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
    ImportOutcome::Done { imported, invalid, settings, github }
}

/// The app-wide half of an imported GitHub part (`apply_import` has no
/// app-data access): writes the client ID to `github/app.json`, and settles
/// the sign-in. A new token replaces the old sign-in (device session, memory
/// tokens, account record; with `forgetOnExit` on it moves into memory). A new
/// client ID with no token signs out, as in the settings, since a token
/// belongs to the OAuth App that issued it. Nothing for any other outcome.
pub fn finish_github_import(
    dirs: &Path,
    store: &dyn SecretStore,
    gh: &GithubState,
    outcome: &ImportOutcome,
) -> Result<(), NetError> {
    let ImportOutcome::Done { github: Some(imported), .. } = outcome else { return Ok(()) };
    let mut app: GithubAppSettings = read_doc(dirs, None, GithubDoc::App)?;
    let before = github_client_id(&app);
    if let Some(id) = &imported.client_id {
        app.client_id = Some(id.clone());
    }
    if imported.token_saved {
        gh.adopt_imported_token(dirs, store, app.forget_on_exit)?;
    } else if github_client_id(&app) != before {
        gh.sign_out(dirs, store)?;
    }
    write_doc(dirs, None, GithubDoc::App, &app)
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
            let any = matches!(&outcome, ImportOutcome::Done { imported, .. } if !imported.is_empty());
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
    dirs: State<'_, IntegrationDirs>,
    github: State<'_, GithubState>,
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
    finish_github_import(&dirs.0, secrets.0.as_ref(), &github, &outcome)?;
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
    dirs: State<'_, IntegrationDirs>,
    github: State<'_, GithubState>,
    request: tauri::ipc::Request<'_>,
) -> Result<ImportOutcome, NetError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(NetError::new(NetErrorKind::BadInput, "the file must be sent as raw bytes"));
    };
    let name = crate::vault::fs::header(&request, "x-lno-name")
        .map_err(|_| NetError::new(NetErrorKind::BadInput, "the file name is missing"))?;
    let root = vault.root().map_err(|_| no_vault())?;
    let cfg = ServiceConfig::load(&settings.0, Some(&root))?;
    let outcome = import_bytes(secrets.0.as_ref(), &name, bytes, &cfg);
    finish_github_import(&dirs.0, secrets.0.as_ref(), &github, &outcome)?;
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
    use crate::net::github::GithubState;
    use crate::net::secrets::{status_of, MemoryStore};

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

    const GH_FAKE: &str = "ghp_FAKEimport0000000000000000000000000000";

    fn gh_dir(tag: &str) -> PathBuf {
        let dir = scratch_dir(tag);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The import, then the command's app-wide step.
    fn import_github(dir: &Path, store: &MemoryStore, gh: &GithubState, name: &str, text: &str) -> ImportOutcome {
        let out = import_bytes(store, name, text.as_bytes(), &cfg("{}"));
        finish_github_import(dir, store, gh, &out).unwrap();
        out
    }

    fn app_doc(dir: &Path) -> Option<Value> {
        std::fs::read_to_string(dir.join("github").join("app.json")).ok().map(|t| serde_json::from_str(&t).unwrap())
    }

    fn gh_token(gh: &GithubState, store: &MemoryStore) -> Option<String> {
        crate::net::github::auth::token(gh, store).unwrap().map(|t| t.as_str().to_string())
    }

    #[test]
    fn github_json_saves_the_token_in_the_keychain_and_the_client_id_app_wide() {
        let dir = gh_dir("import-gh-json");
        let (store, gh) = (MemoryStore::default(), GithubState::default());
        let text = format!(r#"{{"github":{{"clientId":"Iv1.lab0001","token":"{GH_FAKE}"}}}}"#);
        let out = import_github(&dir, &store, &gh, "conn.json", &text);
        let (imported, invalid, settings) = done(&out);
        assert!(invalid.is_empty(), "{invalid:?}");
        assert_eq!(imported, &vec![Imported { part: Part::Github, key_saved: true }]);
        // Nothing for the vault settings: the client ID is app-wide.
        assert!(settings.is_empty(), "{settings:?}");
        let account = crate::net::secrets::account(Slot::Github, &cfg("{}")).unwrap();
        assert!(account.starts_with("github|https://github.com"), "{account}");
        assert_eq!(store.get(&account).unwrap().as_deref(), Some(GH_FAKE));
        assert_eq!(app_doc(&dir).unwrap()["clientId"], "Iv1.lab0001");
        assert_eq!(crate::gitsync::state::app_settings_get_at(&dir).unwrap().client_id.as_deref(), Some("Iv1.lab0001"));
        // The summary carries neither the token nor the client ID.
        let wire = serde_json::to_string(&out).unwrap();
        assert!(!wire.contains(GH_FAKE) && !wire.contains("ghp_") && !wire.contains("Iv1.lab0001"), "{wire}");
        assert!(!format!("{out:?}").contains(GH_FAKE));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn github_env_lines_behave_the_same() {
        let dir = gh_dir("import-gh-env");
        let (store, gh) = (MemoryStore::default(), GithubState::default());
        let text = format!("GITHUB_CLIENT_ID=Ov23lab # lab app\nexport GITHUB_TOKEN=\"{GH_FAKE}\"\n");
        let out = import_github(&dir, &store, &gh, ".env", &text);
        let (imported, invalid, settings) = done(&out);
        assert!(invalid.is_empty() && settings.is_empty(), "{invalid:?} {settings:?}");
        assert_eq!(imported, &vec![Imported { part: Part::Github, key_saved: true }]);
        assert_eq!(gh_token(&gh, &store).as_deref(), Some(GH_FAKE));
        assert_eq!(app_doc(&dir).unwrap()["clientId"], "Ov23lab");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bad_github_token_or_client_id_stores_nothing() {
        let dir = gh_dir("import-gh-bad");
        let (store, gh) = (MemoryStore::default(), GithubState::default());
        let fixed = cfg("{}");
        let nothing = |store: &MemoryStore| {
            crate::net::secrets::key_for(store, Slot::Github, &fixed).unwrap().is_none()
                && crate::net::secrets::status_of(store, &fixed).epoch.github == 0
        };
        let out = import_github(&dir, &store, &gh, "c.json", r#"{"github":{"clientId":"Iv1.ok","token":"abc"}}"#);
        let (imported, invalid, _) = done(&out);
        assert!(imported.is_empty());
        assert_eq!(invalid, &vec![Invalid { part: Part::Github, field: "token", reason: Problem::BadToken }]);
        // All or nothing: the valid client ID is not saved either.
        assert_eq!(app_doc(&dir), None);
        assert!(nothing(&store));
        let out =
            import_github(&dir, &store, &gh, "c.json", &format!(r#"{{"github":{{"clientId":"Iv1 lab","token":"{GH_FAKE}"}}}}"#));
        assert_eq!(done(&out).1, &vec![Invalid { part: Part::Github, field: "clientId", reason: Problem::BadClientId }]);
        assert!(done(&out).0.is_empty());
        assert_eq!(app_doc(&dir), None);
        assert!(nothing(&store));
        let out = import_github(&dir, &store, &gh, "c.json", r#"{"github":{"token":7}}"#);
        assert_eq!(done(&out).1, &vec![Invalid { part: Part::Github, field: "token", reason: Problem::NotText }]);
        // A refresh token is not an access token.
        let out = import_github(&dir, &store, &gh, "c.env", "GITHUB_TOKEN=ghr_FAKE00\n");
        assert_eq!(done(&out).1[0].reason, Problem::BadToken);
        assert!(nothing(&store));
        let wire = serde_json::to_string(&out).unwrap();
        assert!(!wire.contains("ghr_FAKE00"), "{wire}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every file under `dir`, concatenated.
    fn walk_text(dir: &Path) -> String {
        let mut out = String::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.push_str(&String::from_utf8_lossy(&std::fs::read(&p).unwrap_or_default()));
                }
            }
        }
        out
    }

    #[test]
    fn unknown_github_keys_are_ignored_and_never_applied() {
        let dir = gh_dir("import-gh-unknown");
        let (store, gh) = (MemoryStore::default(), GithubState::default());
        // Only unknown keys: there is nothing to import.
        let out = import_github(&dir, &store, &gh, "c.json", r#"{"github":{"public":true,"owner":"kim-lab"}}"#);
        assert_eq!(out, ImportOutcome::Refused { reason: Refusal::Unrecognized });
        let text = format!(r#"{{"github":{{"public":true,"owner":"kim-lab","visibility":"public","token":"{GH_FAKE}"}}}}"#);
        let out = import_github(&dir, &store, &gh, "c.json", &text);
        let (imported, invalid, settings) = done(&out);
        assert!(invalid.is_empty() && settings.is_empty());
        assert_eq!(imported, &vec![Imported { part: Part::Github, key_saved: true }]);
        // No client ID in the file: the app-wide one is left alone, and no
        // owner or visibility was written anywhere.
        let app = app_doc(&dir).unwrap_or(Value::Null);
        assert!(app.get("clientId").is_none(), "{app}");
        let all = walk_text(&dir);
        assert!(!all.contains("kim-lab") && !all.contains("public") && !all.contains(GH_FAKE), "{all}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_imported_token_replaces_the_old_sign_in_without_losing_itself() {
        use crate::gitsync::state::{read_doc, write_doc, GithubDoc};
        let dir = gh_dir("import-gh-replace");
        let (store, gh) = (MemoryStore::default(), GithubState::default());
        // Signed in before with another app's token, a refresh token and an account.
        let fixed = cfg("{}");
        crate::net::secrets::store_secret(&store, Slot::Github, &fixed, "gho_FAKEold").unwrap();
        crate::net::secrets::store_secret(&store, Slot::GithubRefresh, &fixed, "ghr_FAKEold").unwrap();
        write_doc(&dir, None, GithubDoc::Account, &serde_json::json!({"login": "old-login", "id": 1, "avatarUrl": ""}))
            .unwrap();
        let text = format!(r#"{{"github":{{"clientId":"Iv1.new","token":"{GH_FAKE}"}}}}"#);
        import_github(&dir, &store, &gh, "c.json", &text);
        // The new client ID did not sign the new token out; the old refresh
        // token and the old identity are gone.
        assert_eq!(gh_token(&gh, &store).as_deref(), Some(GH_FAKE));
        assert_eq!(crate::net::secrets::key_for(&store, Slot::GithubRefresh, &fixed).unwrap(), None);
        assert_eq!(read_doc::<Option<Value>>(&dir, None, GithubDoc::Account).unwrap(), None);
        assert_eq!(app_doc(&dir).unwrap()["clientId"], "Iv1.new");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_client_id_alone_signs_the_old_token_out() {
        let dir = gh_dir("import-gh-client");
        let (store, gh) = (MemoryStore::default(), GithubState::default());
        let fixed = cfg("{}");
        crate::net::secrets::store_secret(&store, Slot::Github, &fixed, "gho_FAKEold").unwrap();
        let out = import_github(&dir, &store, &gh, "c.env", "GITHUB_CLIENT_ID=Iv1.other\n");
        assert_eq!(done(&out).0, &vec![Imported { part: Part::Github, key_saved: false }]);
        assert_eq!(gh_token(&gh, &store), None);
        assert_eq!(app_doc(&dir).unwrap()["clientId"], "Iv1.other");
        // The same client ID again keeps a token.
        crate::net::secrets::store_secret(&store, Slot::Github, &fixed, "gho_FAKEnew").unwrap();
        import_github(&dir, &store, &gh, "c.env", "GITHUB_CLIENT_ID=Iv1.other\n");
        assert_eq!(gh_token(&gh, &store).as_deref(), Some("gho_FAKEnew"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn with_forget_on_exit_an_imported_token_is_kept_in_memory_only() {
        use crate::gitsync::state::{write_doc, GithubAppSettings, GithubDoc};
        let dir = gh_dir("import-gh-forget");
        let (store, gh) = (MemoryStore::default(), GithubState::default());
        write_doc(&dir, None, GithubDoc::App, &GithubAppSettings { client_id: None, forget_on_exit: true }).unwrap();
        import_github(&dir, &store, &gh, "c.env", &format!("GITHUB_TOKEN={GH_FAKE}\n"));
        assert!(gh.has_memory_token());
        assert_eq!(crate::net::secrets::key_for(&store, Slot::Github, &cfg("{}")).unwrap(), None);
        assert_eq!(gh_token(&gh, &store).as_deref(), Some(GH_FAKE));
        assert_eq!(app_doc(&dir).unwrap()["forgetOnExit"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn github_sits_beside_the_other_parts_and_is_all_or_nothing_alone() {
        let dir = gh_dir("import-gh-mixed");
        let (store, gh) = (MemoryStore::default(), GithubState::default());
        let text = r#"{"bfworkflow":{"url":"https://wf.lab.example","apiKey":"bfw_t"},"github":{"token":"nope"}}"#;
        let out = import_github(&dir, &store, &gh, "c.json", text);
        let (imported, invalid, settings) = done(&out);
        assert_eq!(imported, &vec![Imported { part: Part::Bfworkflow, key_saved: true }]);
        assert_eq!(invalid, &vec![Invalid { part: Part::Github, field: "token", reason: Problem::BadToken }]);
        assert_eq!(settings["bfwUrl"], "https://wf.lab.example");
        assert_eq!(gh_token(&gh, &store), None);
        assert_eq!(app_doc(&dir), None);
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
