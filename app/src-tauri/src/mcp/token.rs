//! The MCP bearer token: made in Rust, kept in Windows Credential Manager
//! under account `mcpServer|loopback`, with a non-secret epoch counter under
//! `epoch|mcpServer|loopback` (the SP6 D6 pattern). No function here returns
//! the token to the webview.

use std::sync::RwLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::bridge::check_port;
use super::clipboard::{clear_if_unchanged_after, ClipState};
use super::{McpError, McpErrorKind, McpState};
use crate::net::secrets::{SecretStore, Secrets};

/// The Credential Manager account the token is stored under.
pub const MCP_ACCOUNT: &str = "mcpServer|loopback";

/// What the webview may know about the token.
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
pub struct TokenStatus {
    pub set: bool,
    pub epoch: u64,
}

/// The non-secret epoch counter's account, bumped on every regenerate.
const EPOCH_ACCOUNT: &str = "epoch|mcpServer|loopback";

/// How long a copied token stays on the clipboard.
pub const COPY_CLEAR_AFTER: Duration = Duration::from_secs(60);

/// The one message for every keychain failure: no store error text (which
/// could echo a value) ever reaches the webview.
fn keychain_error() -> McpError {
    McpError::new(McpErrorKind::Keychain, "Windows Credential Manager refused the request")
}

/// True for 48 lowercase hex chars, the plugin's `MCP_TOKEN_RE` shape.
fn is_token(s: &str) -> bool {
    s.len() == 48 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn set_mem(mem: &RwLock<String>, token: &str) {
    *mem.write().unwrap_or_else(|e| e.into_inner()) = token.to_string();
}

fn read_epoch(store: &dyn SecretStore) -> u64 {
    store.get(EPOCH_ACCOUNT).ok().flatten().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

/// A fresh token: 24 random bytes as 48 lowercase hex chars.
pub fn new_token() -> String {
    let mut bytes = [0u8; 24];
    // The OS RNG failing is unrecoverable here: never fall back to a weak token.
    getrandom::getrandom(&mut bytes).expect("the OS random number generator failed");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The stored token, made and stored first when there is none (or when the
/// stored value is not a token); `mem` is filled. Making the first token does
/// not bump the epoch.
pub fn ensure_token(store: &dyn SecretStore, mem: &RwLock<String>) -> Result<String, McpError> {
    if let Some(t) = store.get(MCP_ACCOUNT).map_err(|_| keychain_error())? {
        if is_token(&t) {
            set_mem(mem, &t);
            return Ok(t);
        }
    }
    let t = new_token();
    store.set(MCP_ACCOUNT, &t).map_err(|_| keychain_error())?;
    set_mem(mem, &t);
    Ok(t)
}

/// A new token, epoch + 1, and `mem` replaced: a running server accepts only
/// the new token from the next request on.
pub fn regenerate(store: &dyn SecretStore, mem: &RwLock<String>) -> Result<TokenStatus, McpError> {
    let t = new_token();
    store.set(MCP_ACCOUNT, &t).map_err(|_| keychain_error())?;
    set_mem(mem, &t);
    let epoch = read_epoch(store).saturating_add(1);
    store.set(EPOCH_ACCOUNT, &epoch.to_string()).map_err(|_| keychain_error())?;
    Ok(TokenStatus { set: true, epoch })
}

/// Whether a token is stored, and its epoch.
pub fn token_status(store: &dyn SecretStore) -> Result<TokenStatus, McpError> {
    let set = store.get(MCP_ACCOUNT).map_err(|_| keychain_error())?.is_some_and(|t| is_token(&t));
    Ok(TokenStatus { set, epoch: read_epoch(store) })
}

#[tauri::command]
pub fn mcp_token_status(secrets: State<'_, Secrets>) -> Result<TokenStatus, McpError> {
    token_status(secrets.0.as_ref())
}

#[tauri::command]
pub fn mcp_token_regenerate(secrets: State<'_, Secrets>, state: State<'_, McpState>) -> Result<TokenStatus, McpError> {
    regenerate(secrets.0.as_ref(), &state.token)
}

/// The MCP clients the settings' "Connect a client" rows set up (user
/// decision 2026-11-09). A closed list: the webview names a client, never a
/// template, so the token only ever lands in these texts.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum McpClient {
    ClaudeCode,
    Cursor,
    VsCode,
    ClaudeDesktop,
}

/// `mcp_token_copy`'s optional argument: copy a client's setup instead of the bare token.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Snippet {
    pub client: McpClient,
    pub port: u16,
}

/// A client's setup text for `http://127.0.0.1:<port>/mcp` with `token` in its
/// `Authorization` header. The exact texts are pinned, with `<token>`, in
/// `tests/mcp-snippets.json`, which the TypeScript side shows.
pub fn snippet_text(client: McpClient, port: u16, token: &str) -> String {
    let url = format!("http://127.0.0.1:{port}/mcp");
    match client {
        McpClient::ClaudeCode => {
            format!("claude mcp add --transport http labnoteo {url} --header \"Authorization: Bearer {token}\"")
        }
        McpClient::Cursor => format!(
            "{{
  \"mcpServers\": {{
    \"labnoteo\": {{
      \"url\": \"{url}\",
      \"headers\": {{
        \"Authorization\": \"Bearer {token}\"
      }}
    }}
  }}
}}"
        ),
        McpClient::VsCode => format!(
            "{{
  \"servers\": {{
    \"labnoteo\": {{
      \"type\": \"http\",
      \"url\": \"{url}\",
      \"headers\": {{
        \"Authorization\": \"Bearer {token}\"
      }}
    }}
  }}
}}"
        ),
        McpClient::ClaudeDesktop => format!(
            "{{
  \"mcpServers\": {{
    \"labnoteo\": {{
      \"command\": \"npx\",
      \"args\": [
        \"mcp-remote\",
        \"{url}\",
        \"--header\",
        \"Authorization: Bearer {token}\"
      ]
    }}
  }}
}}"
        ),
    }
}

/// What `mcp_token_copy` puts on the clipboard: the token, or a client's setup
/// holding it (`badInput` for a port outside 1024..=65535).
pub fn copy_text(token: &str, snippet: Option<Snippet>) -> Result<String, McpError> {
    match snippet {
        None => Ok(token.to_string()),
        Some(s) => {
            check_port(s.port)?;
            Ok(snippet_text(s.client, s.port, token))
        }
    }
}

/// Copies the token, or a client's setup holding it, to the clipboard from
/// Rust (the token is made first if there is none), kept out of clipboard
/// history, and clears it 60 s later if unchanged.
#[tauri::command]
pub fn mcp_token_copy(
    secrets: State<'_, Secrets>,
    state: State<'_, McpState>,
    clip: State<'_, ClipState>,
    snippet: Option<Snippet>,
) -> Result<(), McpError> {
    let token = ensure_token(secrets.0.as_ref(), &state.token)?;
    let text = copy_text(&token, snippet)?;
    let clip = clip.0.clone();
    clip.set_secret(&text)?;
    tauri::async_runtime::spawn(clear_if_unchanged_after(clip, text, COPY_CLEAR_AFTER));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::secrets::MemoryStore;

    /// True when `s` holds a run of 48 or more hex chars (a token, whatever its case).
    fn has_48_hex(s: &str) -> bool {
        let mut run = 0;
        for c in s.chars() {
            run = if c.is_ascii_hexdigit() { run + 1 } else { 0 };
            if run >= 48 {
                return true;
            }
        }
        false
    }

    #[test] fn token_is_48_lower_hex_and_stable_once_made() {
        let store = MemoryStore::default(); let mem = RwLock::new(String::new());
        let a = ensure_token(&store, &mem).unwrap(); let b = ensure_token(&store, &mem).unwrap();
        assert_eq!(a, b); assert_eq!(a.len(), 48); assert!(a.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))); assert_eq!(*mem.read().unwrap(), a);
        assert_ne!(new_token(), new_token());
    }
    #[test] fn ensure_token_reads_a_stored_token_into_memory() {
        let store = MemoryStore::default(); let mem = RwLock::new(String::new());
        let t = "0123456789abcdef".repeat(3);
        store.set(MCP_ACCOUNT, &t).unwrap();
        assert_eq!(ensure_token(&store, &mem).unwrap(), t);
        assert_eq!(*mem.read().unwrap(), t);
        assert_eq!(token_status(&store).unwrap(), TokenStatus { set: true, epoch: 0 });
    }
    #[test] fn ensure_token_replaces_a_stored_value_that_is_not_a_token() {
        let store = MemoryStore::default(); let mem = RwLock::new(String::new());
        store.set(MCP_ACCOUNT, "short").unwrap();
        let t = ensure_token(&store, &mem).unwrap();
        assert_eq!(t.len(), 48);
        assert_eq!(store.get(MCP_ACCOUNT).unwrap().as_deref(), Some(t.as_str()));
    }
    #[test] fn regenerate_bumps_epoch_and_changes_token() {
        let store = MemoryStore::default(); let mem = RwLock::new(String::new()); let a = ensure_token(&store, &mem).unwrap();
        let s = regenerate(&store, &mem).unwrap(); assert_eq!(s, TokenStatus { set: true, epoch: 1 });
        assert_ne!(*mem.read().unwrap(), a); assert_eq!(store.get(MCP_ACCOUNT).unwrap().as_deref(), Some(mem.read().unwrap().as_str()));
        assert_eq!(regenerate(&store, &mem).unwrap().epoch, 2);
        assert_eq!(store.get("epoch|mcpServer|loopback").unwrap().as_deref(), Some("2"));
    }
    #[test] fn status_of_an_empty_store_is_unset_epoch_zero() {
        assert_eq!(token_status(&MemoryStore::default()).unwrap(), TokenStatus { set: false, epoch: 0 });
    }
    #[test] fn client_snippets_match_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../tests/mcp-snippets.json")).unwrap();
        let port = fixture["port"].as_u64().unwrap() as u16;
        let token = fixture["token"].as_str().unwrap();
        let snippets = fixture["snippets"].as_object().unwrap();
        assert_eq!(snippets.len(), 4);
        for (name, client) in [("claudeCode", McpClient::ClaudeCode), ("cursor", McpClient::Cursor), ("vsCode", McpClient::VsCode), ("claudeDesktop", McpClient::ClaudeDesktop)] {
            assert_eq!(snippet_text(client, port, token), snippets[name].as_str().unwrap(), "{name}");
            let parsed: McpClient = serde_json::from_value(serde_json::json!(name)).unwrap();
            assert_eq!(parsed, client);
        }
        assert!(snippet_text(McpClient::Cursor, 4000, "t").contains("http://127.0.0.1:4000/mcp"));
    }
    #[test] fn copy_text_is_the_token_or_the_snippet_holding_it() {
        let t = "ab".repeat(24);
        assert_eq!(copy_text(&t, None).unwrap(), t);
        let s = copy_text(&t, Some(Snippet { client: McpClient::ClaudeCode, port: 3987 })).unwrap();
        assert!(s.starts_with("claude mcp add") && s.contains(&format!("Bearer {t}")), "{s}");
        assert_eq!(copy_text(&t, Some(Snippet { client: McpClient::VsCode, port: 80 })).unwrap_err().kind, McpErrorKind::BadInput);
    }
    #[test] fn no_mcp_command_returns_or_emits_the_token() {
        let store = MemoryStore::default(); let mem = RwLock::new(String::new());
        let mut out = vec![serde_json::to_string(&token_status(&store).unwrap()).unwrap()];
        ensure_token(&store, &mem).unwrap(); out.push(serde_json::to_string(&regenerate(&store, &mem).unwrap()).unwrap());
        out.push(serde_json::to_string(&token_status(&store).unwrap()).unwrap());
        for kind in [McpErrorKind::PortInUse, McpErrorKind::Keychain, McpErrorKind::BadInput, McpErrorKind::Clipboard, McpErrorKind::Io, McpErrorKind::NotRunning] {
            out.push(serde_json::to_string(&McpError::new(kind, "x")).unwrap());
        }
        let token = store.get(MCP_ACCOUNT).unwrap().unwrap();
        for s in &out { assert!(!s.contains(&token), "{s}"); assert!(!has_48_hex(s), "{s}"); }
    }
}
