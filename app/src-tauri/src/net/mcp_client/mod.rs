//! The MCP client (spec §4): the app talks to MCP servers the user set up
//! (RAPID, BioModel Portal, custom ones) over streamable HTTP. Everything
//! network-side lives here in Rust so a token never reaches the webview.
//!
//! - `transport`: one HTTP exchange (POST with a JSON or SSE answer, GET
//!   resume, DELETE of a session).
//! - `session`: initialize with version negotiation, re-initialize on 404,
//!   tools/list and tools/call.
//! - `tools`: sanitising tool descriptors and compacting call results.
//! - `placeholder`: example tokens (`<YOUR_TOKEN>` …) that are never stored.
//! - `cache`: the Rust-owned tool lists, per vault.
//!
//! The commands below (spec §4.5) take a server **id**; the URL is always read
//! from the open vault's stored settings (`mcpClientServers`), never from the
//! webview. A token crosses IPC once, webview → Rust, in
//! `mcp_client_secret_set`; nothing returns it. It is kept in the keychain
//! under `mcpClient:<id>|<origin>` (chunked, `secrets::store_long`), so it is
//! only ever sent to the origin it was saved for.
//!
//! Open sessions live in `McpClients`, keyed by server id and remembered with
//! what they were opened with (vault, URL, auth, token epoch). When any of
//! those changes the old session is ended (a best-effort `DELETE` with the
//! **old** token to the **old** origin) and a new one is opened. A vault
//! switch and app exit end every session.

pub mod cache;
pub mod placeholder;
pub mod session;
pub mod tools;
pub mod transport;

#[cfg(test)]
pub mod fake;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::net::config::{origin, McpAuthKind, McpServerCfg, ServiceConfig};
use crate::net::secrets::{delete_long, epoch_of, get_long, mcp_account, store_long, SecretStore, Secrets};
use crate::net::store::IntegrationDirs;
use crate::net::{NetError, NetErrorKind, NetState};
use crate::vault::settings::vault_key;
use crate::vault::{SettingsFile, VaultState};
use session::{call_tool_in, list_tools_in, open_in, ServerInfo, Session, MAX_ARGS};
use tools::{McpCallResult, McpToolInfo};
use transport::{delete_session, Endpoint};

/// What `mcp_client_connect` returns and the cache keeps (spec §4.5). The
/// server's `instructions` text is only flagged, never kept.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub version: String,
    pub protocol_version: String,
    pub has_instructions: bool,
    pub tools: Vec<McpToolInfo>,
    pub truncated: bool,
}

impl McpServerInfo {
    fn new(info: &ServerInfo, tools: Vec<McpToolInfo>, truncated: bool) -> Self {
        McpServerInfo {
            name: info.name.clone(),
            title: info.title.clone(),
            version: info.version.clone(),
            protocol_version: info.protocol_version.clone(),
            has_instructions: info.has_instructions,
            tools,
            truncated,
        }
    }
}

/// What the webview may know about a server's token.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct SecretFlag {
    pub set: bool,
    pub epoch: u64,
}

/// What a session was opened with. Any change ends it.
#[derive(Clone, Debug, PartialEq)]
struct SessionKey {
    vault: String,
    url: String,
    auth: McpAuthKind,
    epoch: u64,
}

/// An open session and the endpoint (with the token) it was opened with, so
/// it is ended with that token at that origin.
struct Live {
    key: SessionKey,
    ep: Endpoint,
    session: Session,
}

/// The open MCP sessions, by server id (managed once for the app).
#[derive(Default)]
pub struct McpClients {
    live: Mutex<HashMap<String, Live>>,
}

fn copy_ep(ep: &Endpoint) -> Endpoint {
    Endpoint { url: ep.url.clone(), token: ep.token.clone(), allow_http: ep.allow_http }
}

/// Ends a session, best effort, with the token and origin it was opened with.
async fn close(live: Live) {
    delete_session(&live.ep, live.session.exchange()).await;
}

async fn close_each(all: Vec<Live>) {
    for live in all {
        close(live).await;
    }
}

impl McpClients {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Live>> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn take(&self, id: &str) -> Option<Live> {
        self.lock().remove(id)
    }

    /// Ends server `id`'s session, if one is open.
    pub async fn disconnect(&self, id: &str) {
        if let Some(live) = self.take(id) {
            close(live).await;
        }
    }

    /// Ends every session (app exit).
    pub async fn close_all(&self) {
        let all: Vec<Live> = self.lock().drain().map(|(_, l)| l).collect();
        close_each(all).await;
    }

    /// Ends every session opened for another vault than `root` (vault switch).
    pub fn close_other_vaults(&self, root: &Path) {
        let current = vault_key(root);
        let old: Vec<Live> = {
            let mut live = self.lock();
            let ids: Vec<String> = live.iter().filter(|(_, l)| l.key.vault != current).map(|(id, _)| id.clone()).collect();
            ids.iter().filter_map(|id| live.remove(id)).collect()
        };
        if !old.is_empty() {
            tauri::async_runtime::spawn(close_each(old));
        }
    }

    /// Whether server `id` has an open session (tests).
    pub fn is_open(&self, id: &str) -> bool {
        self.lock().contains_key(id)
    }

    /// Stores a fresh session; one that was there is ended.
    async fn insert(&self, id: &str, live: Live) {
        let old = self.lock().insert(id.to_string(), live);
        if let Some(old) = old {
            close(old).await;
        }
    }

    /// A fork of the session for `key`, opening one when there is none or
    /// the open one was made with something else (then it is ended first).
    async fn session_for(
        &self,
        ctx: &Ctx<'_>,
        id: &str,
        ep: &Endpoint,
        key: &SessionKey,
        request_id: Option<&str>,
    ) -> Result<Session, NetError> {
        let stale = {
            let mut live = self.lock();
            match live.get(id).map(|l| l.key == *key) {
                Some(true) => return Ok(live.get_mut(id).map(|l| l.session.fork()).expect("checked above")),
                Some(false) => live.remove(id),
                None => None,
            }
        };
        if let Some(old) = stale {
            close(old).await;
        }
        let mut fresh = open_in(ctx.net, request_id, ep, ctx.app_version).await?;
        let (fork, unused, replaced) = {
            let mut live = self.lock();
            if live.get(id).is_some_and(|l| l.key == *key) {
                // Another call opened one meanwhile: use it, end ours.
                (live.get_mut(id).map(|l| l.session.fork()).expect("checked above"), Some(fresh), None)
            } else {
                let fork = fresh.fork();
                let old = live.insert(id.to_string(), Live { key: key.clone(), ep: copy_ep(ep), session: fresh });
                (fork, None, old)
            }
        };
        if let Some(s) = unused {
            delete_session(ep, s.exchange()).await;
        }
        if let Some(old) = replaced {
            close(old).await;
        }
        Ok(fork)
    }

    /// After a call: keep a session the fork re-initialized; drop the session
    /// on `mcpAuth` (the token no longer works, so a `DELETE` would too).
    fn after_call(&self, id: &str, key: &SessionKey, fork: &Session, failed_auth: bool) {
        let mut live = self.lock();
        if !live.get(id).is_some_and(|l| l.key == *key) {
            return;
        }
        if failed_auth {
            live.remove(id);
        } else if let Some(l) = live.get_mut(id) {
            l.session.adopt(fork);
        }
    }
}

/// Everything a command needs, gathered once.
pub struct Ctx<'a> {
    pub cfg: &'a ServiceConfig,
    pub root: &'a Path,
    pub dirs: &'a Path,
    pub store: &'a dyn SecretStore,
    pub net: &'a NetState,
    pub app_version: &'a str,
}

fn bad(message: &str) -> NetError {
    NetError::new(NetErrorKind::BadInput, message)
}

/// The configured server with this id, or `notConfigured`.
fn server<'a>(cfg: &'a ServiceConfig, id: &str) -> Result<&'a McpServerCfg, NetError> {
    cfg.mcp_server(id).ok_or_else(|| NetError::new(NetErrorKind::NotConfigured, "no MCP server with this id is set up"))
}

fn account_of(server: &McpServerCfg) -> String {
    mcp_account(&server.id, &origin(&server.url))
}

/// The endpoint for `server` (its token read from the keychain for its
/// current origin) and the key a session for it is opened with. A bearer
/// server without a stored token is `keyMissing`, and nothing is sent.
fn endpoint(ctx: &Ctx<'_>, server: &McpServerCfg) -> Result<(Endpoint, SessionKey), NetError> {
    let account = account_of(server);
    let (token, epoch) = match server.auth {
        McpAuthKind::Bearer => {
            let token = get_long(ctx.store, &account)?
                .ok_or_else(|| NetError::new(NetErrorKind::KeyMissing, "enter the token first"))?;
            (Some(token), epoch_of(ctx.store, &account))
        }
        McpAuthKind::None => (None, 0),
    };
    let ep = Endpoint { url: server.url.clone(), token, allow_http: ctx.cfg.allows_http(&server.url) };
    let key = SessionKey { vault: vault_key(ctx.root), url: server.url.to_string(), auth: server.auth, epoch };
    Ok((ep, key))
}

/// Saves server `id`'s token (chunked, bound to its current origin) and ends
/// its session, so a new token never reuses an old session.
pub async fn secret_set_at(clients: &McpClients, cfg: &ServiceConfig, store: &dyn SecretStore, id: &str, value: &str) -> Result<(), NetError> {
    let server = server(cfg, id)?;
    if server.auth != McpAuthKind::Bearer {
        return Err(bad("this server is set up without a token"));
    }
    store_long(store, &account_of(server), value)?;
    clients.disconnect(id).await;
    Ok(())
}

/// Deletes server `id`'s token and ends its session.
pub async fn secret_clear_at(clients: &McpClients, cfg: &ServiceConfig, store: &dyn SecretStore, id: &str) -> Result<(), NetError> {
    let server = server(cfg, id)?;
    delete_long(store, &account_of(server))?;
    clients.disconnect(id).await;
    Ok(())
}

/// `{set, epoch}` per configured server, for its current origin.
pub fn secret_status_at(cfg: &ServiceConfig, store: &dyn SecretStore) -> BTreeMap<String, SecretFlag> {
    cfg.mcp_servers
        .iter()
        .map(|s| {
            let account = account_of(s);
            let set = matches!(get_long(store, &account), Ok(Some(_)));
            (s.id.clone(), SecretFlag { set, epoch: epoch_of(store, &account) })
        })
        .collect()
}

/// Opens a fresh session, lists the tools, caches the list (no token, no
/// session id) and keeps the session for calls.
pub async fn connect_at(clients: &McpClients, ctx: &Ctx<'_>, id: &str) -> Result<McpServerInfo, NetError> {
    let server = server(ctx.cfg, id)?;
    let (ep, key) = endpoint(ctx, server)?;
    clients.disconnect(id).await;
    let mut s = open_in(ctx.net, None, &ep, ctx.app_version).await?;
    let (tools, truncated) = match list_tools_in(&mut s, ctx.net, None, &ep).await {
        Ok(listed) => listed,
        Err(e) => {
            delete_session(&ep, s.exchange()).await;
            return Err(e);
        }
    };
    let info = McpServerInfo::new(s.info(), tools, truncated);
    if let Err(e) = cache::put(ctx.dirs, ctx.root, id, &origin(&server.url), &info) {
        delete_session(&ep, s.exchange()).await;
        return Err(e);
    }
    clients.insert(id, Live { key, ep, session: s }).await;
    Ok(info)
}

/// Calls one tool of server `id`. The tool must be in the cached list for the
/// server's current origin and usable; arguments are an object (or null) of
/// at most 32 KiB. Cancellable through `net_cancel(request_id)`.
pub async fn call_at(
    clients: &McpClients,
    ctx: &Ctx<'_>,
    id: &str,
    tool: &str,
    args: Value,
    request_id: Option<&str>,
) -> Result<McpCallResult, NetError> {
    let server = server(ctx.cfg, id)?;
    let cached = cache::get(ctx.dirs, ctx.root, id, &origin(&server.url)).ok_or_else(|| bad("connect to the server first"))?;
    let info = cached.tools.iter().find(|t| t.name == tool).ok_or_else(|| bad("the server does not offer this tool"))?;
    if info.too_large || info.input_schema.is_none() {
        return Err(bad("this tool cannot be used"));
    }
    if !(args.is_object() || args.is_null()) {
        return Err(bad("the tool arguments must be an object"));
    }
    if serde_json::to_vec(&args).map(|b| b.len()).unwrap_or(usize::MAX) > MAX_ARGS {
        return Err(bad("the tool arguments are too large"));
    }
    let (ep, key) = endpoint(ctx, server)?;
    let mut fork = clients.session_for(ctx, id, &ep, &key, request_id).await?;
    let result = call_tool_in(&mut fork, ctx.net, request_id, &ep, tool, args).await;
    let failed_auth = matches!(&result, Err(e) if e.kind == NetErrorKind::McpAuth);
    clients.after_call(id, &key, &fork, failed_auth);
    result
}

/// Removal of a server: ends its session, drops its cached tools and deletes
/// every chunk of its token (and bumps the epoch). Runs **before** the
/// settings drop the entry, since the origin comes from them.
pub async fn forget_at(clients: &McpClients, ctx: &Ctx<'_>, id: &str) -> Result<(), NetError> {
    clients.disconnect(id).await;
    cache::remove(ctx.dirs, ctx.root, id)?;
    let server = server(ctx.cfg, id)?;
    delete_long(ctx.store, &account_of(server))
}

/// The cached tool lists still valid for the configured servers.
pub fn tools_cached_at(cfg: &ServiceConfig, dirs: &Path, root: &Path) -> BTreeMap<String, McpServerInfo> {
    let current: BTreeMap<String, String> = cfg.mcp_servers.iter().map(|s| (s.id.clone(), origin(&s.url))).collect();
    cache::current(dirs, root, &current)
}

/// The open vault's root and service config, or `notConfigured`.
fn open_vault(vault: &VaultState, settings: &SettingsFile) -> Result<(ServiceConfig, PathBuf), NetError> {
    let root = vault.root().map_err(|_| NetError::new(NetErrorKind::NotConfigured, "no vault is open"))?;
    let cfg = ServiceConfig::load(&settings.0, Some(&root))?;
    Ok((cfg, root))
}

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[tauri::command]
pub async fn mcp_client_secret_set(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    clients: State<'_, McpClients>,
    id: String,
    value: String,
) -> Result<(), NetError> {
    let (cfg, _) = open_vault(&vault, &settings)?;
    secret_set_at(&clients, &cfg, secrets.0.as_ref(), &id, &value).await
}

#[tauri::command]
pub async fn mcp_client_secret_clear(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    clients: State<'_, McpClients>,
    id: String,
) -> Result<(), NetError> {
    let (cfg, _) = open_vault(&vault, &settings)?;
    secret_clear_at(&clients, &cfg, secrets.0.as_ref(), &id).await
}

#[tauri::command]
pub fn mcp_client_secret_status(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
) -> Result<BTreeMap<String, SecretFlag>, NetError> {
    let (cfg, _) = open_vault(&vault, &settings)?;
    Ok(secret_status_at(&cfg, secrets.0.as_ref()))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mcp_client_connect(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    dirs: State<'_, IntegrationDirs>,
    clients: State<'_, McpClients>,
    id: String,
) -> Result<McpServerInfo, NetError> {
    let (cfg, root) = open_vault(&vault, &settings)?;
    let ctx = Ctx { cfg: &cfg, root: &root, dirs: &dirs.0, store: secrets.0.as_ref(), net: &net, app_version: APP_VERSION };
    connect_at(&clients, &ctx, &id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mcp_client_call(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    dirs: State<'_, IntegrationDirs>,
    clients: State<'_, McpClients>,
    id: String,
    tool: String,
    args: Value,
    request_id: Option<String>,
) -> Result<McpCallResult, NetError> {
    let (cfg, root) = open_vault(&vault, &settings)?;
    let ctx = Ctx { cfg: &cfg, root: &root, dirs: &dirs.0, store: secrets.0.as_ref(), net: &net, app_version: APP_VERSION };
    call_at(&clients, &ctx, &id, &tool, args, request_id.as_deref()).await
}

#[tauri::command]
pub async fn mcp_client_disconnect(clients: State<'_, McpClients>, id: String) -> Result<(), NetError> {
    clients.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_client_forget(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    secrets: State<'_, Secrets>,
    net: State<'_, NetState>,
    dirs: State<'_, IntegrationDirs>,
    clients: State<'_, McpClients>,
    id: String,
) -> Result<(), NetError> {
    let (cfg, root) = open_vault(&vault, &settings)?;
    let ctx = Ctx { cfg: &cfg, root: &root, dirs: &dirs.0, store: secrets.0.as_ref(), net: &net, app_version: APP_VERSION };
    forget_at(&clients, &ctx, &id).await
}

#[tauri::command]
pub fn mcp_client_tools_cached(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    dirs: State<'_, IntegrationDirs>,
) -> Result<BTreeMap<String, McpServerInfo>, NetError> {
    let (cfg, root) = open_vault(&vault, &settings)?;
    Ok(tools_cached_at(&cfg, &dirs.0, &root))
}

#[cfg(test)]
mod tests;
