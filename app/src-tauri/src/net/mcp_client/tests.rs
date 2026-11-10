//! Command-level tests of the MCP client against the scripted fake on
//! `127.0.0.1` (never a real server) and the in-memory key store with the
//! Credential Manager's 1,280-char entry limit.

use super::*;
use crate::net::config::tests::scratch_dir;
use crate::net::mcp_client::fake::{fake, fixed, json_body, FakeMcp, Reply};
use crate::net::secrets::MemoryStore;
use crate::net::testserver::{Canned, Recorded};
use serde_json::json;
use std::time::{Duration, Instant};
use tauri::async_runtime::block_on;

const TOKEN: &str = "test-token-123";
const TOKEN2: &str = "test-token-456";
const ID: &str = "0a1b2c3d";

struct Env {
    dir: PathBuf,
    root: PathBuf,
    dirs: PathBuf,
    store: MemoryStore,
    net: NetState,
    clients: McpClients,
}

impl Env {
    fn new(tag: &str) -> Env {
        let dir = scratch_dir(tag);
        Env {
            root: dir.join("vault"),
            dirs: dir.join("data"),
            dir,
            store: MemoryStore::with_entry_limit(1280),
            net: NetState::default(),
            clients: McpClients::default(),
        }
    }

    fn ctx<'a>(&'a self, cfg: &'a ServiceConfig) -> Ctx<'a> {
        Ctx { cfg, root: &self.root, dirs: &self.dirs, store: &self.store, net: &self.net, app_version: "0.0.1" }
    }

    /// Stores `token` for server `id` at `url`'s origin, as `secret_set` would.
    fn token(&self, url: &str, token: &str) {
        let u = crate::net::config::parse_service_url(url).unwrap();
        store_long(&self.store, &mcp_account(ID, &origin(&u)), token).unwrap();
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn cfg(servers: Value) -> ServiceConfig {
    ServiceConfig::from_settings_json(&json!({ "mcpClientServers": servers }).to_string())
}

fn bearer(url: &str) -> ServiceConfig {
    cfg(json!([{"id": ID, "name": "Fake", "url": url, "auth": "bearer", "enabled": true}]))
}

fn no_auth(url: &str) -> ServiceConfig {
    cfg(json!([{"id": ID, "name": "Fake", "url": url, "auth": "none", "enabled": true}]))
}

fn body_of(r: &Recorded) -> Value {
    serde_json::from_str(&r.body).unwrap_or(Value::Null)
}

fn ok(result: Value) -> Reply {
    Box::new(move |r| json_body(&json!({"jsonrpc": "2.0", "id": body_of(r)["id"], "result": result})))
}

fn init(session: &'static str) -> Reply {
    Box::new(move |r| {
        json_body(&json!({"jsonrpc": "2.0", "id": body_of(r)["id"], "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "Fake MCP", "version": "1.2.3"},
            "instructions": "Use me well.",
        }}))
        .header("Mcp-Session-Id", session)
    })
}

fn accepted() -> Reply {
    fixed(Canned::status(202))
}

fn deleted() -> Reply {
    fixed(Canned::status(200))
}

fn tools_list() -> Reply {
    ok(json!({"tools": [
        {"name": "get_part", "description": "Read a part", "inputSchema": {"type": "object"},
         "annotations": {"readOnlyHint": true}},
        {"name": "big", "inputSchema": {"type": "string"}},
    ]}))
}

fn text(t: &str) -> Reply {
    ok(json!({"content": [{"type": "text", "text": t}]}))
}

/// The script of a connect: initialize, initialized, tools/list.
fn connect_script(session: &'static str) -> Vec<Reply> {
    vec![init(session), accepted(), tools_list()]
}

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url).map(|u| format!("{}:{}", u.host_str().unwrap(), u.port().unwrap())).unwrap()
}

/// Waits (at most 3 s) until the fake has seen `n` requests.
fn wait_for(f: &FakeMcp, n: usize) {
    let start = Instant::now();
    while f.count() < n && start.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn an_unknown_id_is_not_configured() {
    let env = Env::new("mcpc-unknown");
    let c = cfg(json!([]));
    let ctx = env.ctx(&c);
    for err in [
        block_on(connect_at(&env.clients, &ctx, ID)).unwrap_err(),
        block_on(call_at(&env.clients, &ctx, ID, "x", json!({}), None)).unwrap_err(),
        block_on(forget_at(&env.clients, &ctx, ID)).unwrap_err(),
        block_on(secret_set_at(&env.clients, &c, &env.store, ID, TOKEN)).unwrap_err(),
        block_on(secret_clear_at(&env.clients, &c, &env.store, ID)).unwrap_err(),
    ] {
        assert_eq!(err.kind, NetErrorKind::NotConfigured);
    }
    assert!(secret_status_at(&c, &env.store).is_empty());
    assert!(tools_cached_at(&c, &env.dirs, &env.root).is_empty());
}

#[test]
fn a_bearer_server_without_a_token_sends_nothing() {
    let env = Env::new("mcpc-nokey");
    let f = fake(connect_script("s-1"));
    let c = bearer(&f.url);
    let err = block_on(connect_at(&env.clients, &env.ctx(&c), ID)).unwrap_err();
    assert_eq!(err.kind, NetErrorKind::KeyMissing);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(f.count(), 0);
}

#[test]
fn connect_returns_the_info_and_caches_it_without_secrets() {
    let env = Env::new("mcpc-connect");
    let f = fake(connect_script("sess-secret-1"));
    let c = bearer(&f.url);
    env.token(&f.url, TOKEN);
    let info = block_on(connect_at(&env.clients, &env.ctx(&c), ID)).unwrap();
    assert_eq!((info.name.as_str(), info.version.as_str()), ("Fake MCP", "1.2.3"));
    assert_eq!(info.protocol_version, "2025-06-18");
    assert!(info.has_instructions);
    assert_eq!(info.tools.len(), 2);
    assert!(info.tools[0].read_only && !info.tools[0].too_large);
    assert!(info.tools[1].too_large);
    assert!(env.clients.is_open(ID));
    // Only the configured origin is contacted, with the stored token.
    for i in 0..f.count() {
        let r = f.request(i);
        assert_eq!(r.header("host"), Some(host_of(&f.url).as_str()));
        assert_eq!(r.path, "/mcp");
        assert_eq!(r.header("authorization"), Some("Bearer test-token-123"));
    }
    // The IPC result and the cache file hold no token, session id or instructions.
    let shown = serde_json::to_string(&info).unwrap();
    let file = std::fs::read_to_string(env.dirs.join("mcp-client").join(vault_key(&env.root)).join("tools.json")).unwrap();
    for text in [&shown, &file] {
        assert!(!text.contains(TOKEN) && !text.contains("sess-secret-1") && !text.contains("Use me well"), "{text}");
    }
    let cached = tools_cached_at(&c, &env.dirs, &env.root);
    assert_eq!(cached.get(ID), Some(&info));
}

#[test]
fn calls_are_checked_against_the_cached_tools() {
    let env = Env::new("mcpc-call");
    let mut script = connect_script("s-1");
    script.push(text("BBa_B0034 is an RBS"));
    let f = fake(script);
    let c = bearer(&f.url);
    env.token(&f.url, TOKEN);
    let ctx = env.ctx(&c);
    // Before any connect there is no cached list: nothing is sent.
    assert_eq!(block_on(call_at(&env.clients, &ctx, ID, "get_part", json!({}), None)).unwrap_err().kind, NetErrorKind::BadInput);
    assert_eq!(f.count(), 0);
    block_on(connect_at(&env.clients, &ctx, ID)).unwrap();
    for (tool, args) in [
        ("nope", json!({})),
        ("big", json!({})),
        ("get_part", json!(["a"])),
        ("get_part", json!({"q": "w".repeat(MAX_ARGS)})),
    ] {
        let err = block_on(call_at(&env.clients, &ctx, ID, tool, args, None)).unwrap_err();
        assert_eq!(err.kind, NetErrorKind::BadInput, "{tool}");
    }
    assert_eq!(f.count(), 3, "nothing was sent for a refused call");
    let r = block_on(call_at(&env.clients, &ctx, ID, "get_part", json!({"id": "BBa_B0034"}), None)).unwrap();
    assert_eq!(r.text, "BBa_B0034 is an RBS");
    // The open session is reused: no second initialize.
    let sent = f.request(3);
    assert_eq!(body_of(&sent)["method"], "tools/call");
    assert_eq!(sent.header("mcp-session-id"), Some("s-1"));
    assert_eq!(f.count(), 4);
}

#[test]
fn a_call_without_a_session_opens_one() {
    let env = Env::new("mcpc-reopen");
    let f = fake(vec![init("s-1"), accepted(), tools_list(), deleted(), init("s-2"), accepted(), text("ok")]);
    let c = bearer(&f.url);
    env.token(&f.url, TOKEN);
    let ctx = env.ctx(&c);
    block_on(connect_at(&env.clients, &ctx, ID)).unwrap();
    block_on(env.clients.disconnect(ID));
    assert_eq!(f.request(3).method, "DELETE");
    assert!(!env.clients.is_open(ID));
    assert_eq!(block_on(call_at(&env.clients, &ctx, ID, "get_part", json!({}), None)).unwrap().text, "ok");
    assert_eq!(body_of(&f.request(4))["method"], "initialize");
    assert_eq!(f.request(6).header("mcp-session-id"), Some("s-2"));
}

#[test]
fn a_new_token_epoch_ends_the_old_session_with_the_old_token() {
    let env = Env::new("mcpc-epoch");
    let f = fake(vec![init("s-1"), accepted(), tools_list(), deleted(), init("s-2"), accepted(), text("ok")]);
    let c = bearer(&f.url);
    env.token(&f.url, TOKEN);
    let ctx = env.ctx(&c);
    block_on(connect_at(&env.clients, &ctx, ID)).unwrap();
    // A new token saved without going through the command (no eager disconnect).
    env.token(&f.url, TOKEN2);
    assert_eq!(block_on(call_at(&env.clients, &ctx, ID, "get_part", json!({}), None)).unwrap().text, "ok");
    let d = f.request(3);
    assert_eq!(d.method, "DELETE");
    assert_eq!(d.header("authorization"), Some("Bearer test-token-123"));
    assert_eq!(d.header("mcp-session-id"), Some("s-1"));
    let i = f.request(4);
    assert_eq!(body_of(&i)["method"], "initialize");
    for n in 4..7 {
        assert_eq!(f.request(n).header("authorization"), Some("Bearer test-token-456"), "request {n}");
    }
    assert_eq!(f.request(6).header("mcp-session-id"), Some("s-2"));
}

#[test]
fn a_url_change_ends_the_session_at_the_old_origin_only() {
    let env = Env::new("mcpc-url");
    let a = fake(vec![init("s-a"), accepted(), tools_list(), deleted()]);
    let b = fake(connect_script("s-b"));
    let (ca, cb) = (bearer(&a.url), bearer(&b.url));
    env.token(&a.url, TOKEN);
    block_on(connect_at(&env.clients, &env.ctx(&ca), ID)).unwrap();
    // The token is bound to A's origin: at B it reads "not set", the cached
    // tools are not offered, and nothing is sent.
    assert_eq!(secret_status_at(&cb, &env.store)[ID], SecretFlag { set: false, epoch: 0 });
    assert!(tools_cached_at(&cb, &env.dirs, &env.root).is_empty());
    assert_eq!(block_on(call_at(&env.clients, &env.ctx(&cb), ID, "get_part", json!({}), None)).unwrap_err().kind, NetErrorKind::BadInput);
    assert_eq!(block_on(connect_at(&env.clients, &env.ctx(&cb), ID)).unwrap_err().kind, NetErrorKind::KeyMissing);
    assert_eq!(b.count(), 0);
    // With B's own token, connecting ends A's session at A with A's token.
    env.token(&b.url, TOKEN2);
    block_on(connect_at(&env.clients, &env.ctx(&cb), ID)).unwrap();
    wait_for(&a, 4);
    let d = a.request(3);
    assert_eq!((d.method.as_str(), d.header("authorization")), ("DELETE", Some("Bearer test-token-123")));
    assert_eq!(d.header("host"), Some(host_of(&a.url).as_str()));
    for i in 0..b.count() {
        let r = b.request(i);
        assert_eq!(r.header("authorization"), Some("Bearer test-token-456"));
        assert_eq!(r.header("host"), Some(host_of(&b.url).as_str()));
    }
}

#[test]
fn secret_set_strips_bearer_refuses_placeholders_and_ends_the_session() {
    let env = Env::new("mcpc-secret");
    let f = fake(vec![init("s-1"), accepted(), tools_list(), deleted()]);
    let c = bearer(&f.url);
    let long: String = (0..3000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
    block_on(secret_set_at(&env.clients, &c, &env.store, ID, &format!("Bearer {long}"))).unwrap();
    assert_eq!(secret_status_at(&c, &env.store)[ID], SecretFlag { set: true, epoch: 1 });
    let account = mcp_account(ID, &origin(&c.mcp_servers[0].url));
    assert_eq!(account, format!("mcpClient:{ID}|{}", origin(&c.mcp_servers[0].url)));
    assert_eq!(get_long(&env.store, &account).unwrap().as_deref(), Some(long.as_str()));
    for bad in ["<YOUR_TOKEN>", "Bearer <KBF_SSO_ACCESS_TOKEN>", "${TOKEN}"] {
        let e = block_on(secret_set_at(&env.clients, &c, &env.store, ID, bad)).unwrap_err();
        assert_eq!(e.kind, NetErrorKind::BadInput);
    }
    assert_eq!(secret_status_at(&c, &env.store)[ID].epoch, 1, "a refused token changes nothing");
    // Saving a token ends the open session (with the old token).
    block_on(connect_at(&env.clients, &env.ctx(&c), ID)).unwrap();
    block_on(secret_set_at(&env.clients, &c, &env.store, ID, TOKEN)).unwrap();
    assert!(!env.clients.is_open(ID));
    let d = f.request(3);
    assert_eq!(d.method, "DELETE");
    assert_eq!(d.header("authorization"), Some(format!("Bearer {long}").as_str()));
    assert_eq!(secret_status_at(&c, &env.store)[ID], SecretFlag { set: true, epoch: 2 });
    block_on(secret_clear_at(&env.clients, &c, &env.store, ID)).unwrap();
    assert_eq!(secret_status_at(&c, &env.store)[ID], SecretFlag { set: false, epoch: 3 });
    // A server without auth takes no token.
    let n = no_auth(&f.url);
    assert_eq!(block_on(secret_set_at(&env.clients, &n, &env.store, ID, TOKEN)).unwrap_err().kind, NetErrorKind::BadInput);
}

#[test]
fn forget_removes_the_token_chunks_the_cache_and_the_session() {
    let env = Env::new("mcpc-forget");
    let f = fake(vec![init("s-1"), accepted(), tools_list(), deleted()]);
    let c = bearer(&f.url);
    let long = "k9".repeat(1500);
    env.token(&f.url, &long);
    let ctx = env.ctx(&c);
    block_on(connect_at(&env.clients, &ctx, ID)).unwrap();
    assert_eq!(env.store.accounts().len(), 4, "3 chunks and the epoch");
    block_on(forget_at(&env.clients, &ctx, ID)).unwrap();
    let d = f.request(3);
    assert_eq!((d.method.as_str(), d.header("mcp-session-id")), ("DELETE", Some("s-1")));
    assert!(!env.clients.is_open(ID));
    let account = mcp_account(ID, &origin(&c.mcp_servers[0].url));
    assert_eq!(env.store.accounts(), vec![format!("epoch|{account}")]);
    assert_eq!(epoch_of(&env.store, &account), 2);
    assert!(tools_cached_at(&c, &env.dirs, &env.root).is_empty());
}

#[test]
fn a_server_without_auth_sends_no_token() {
    let env = Env::new("mcpc-noauth");
    let mut script = connect_script("s-1");
    script.push(text("ok"));
    let f = fake(script);
    let c = no_auth(&f.url);
    let ctx = env.ctx(&c);
    block_on(connect_at(&env.clients, &ctx, ID)).unwrap();
    block_on(call_at(&env.clients, &ctx, ID, "get_part", json!({}), None)).unwrap();
    for i in 0..f.count() {
        assert_eq!(f.request(i).header("authorization"), None);
    }
}

#[test]
fn a_401_is_mcp_auth_without_the_token_and_drops_the_session() {
    let env = Env::new("mcpc-401");
    let mut script = connect_script("s-1");
    script.push(crate::net::mcp_client::fake::echo_auth(401));
    let f = fake(script);
    let c = bearer(&f.url);
    env.token(&f.url, TOKEN);
    let ctx = env.ctx(&c);
    block_on(connect_at(&env.clients, &ctx, ID)).unwrap();
    let err = block_on(call_at(&env.clients, &ctx, ID, "get_part", json!({}), None)).unwrap_err();
    assert_eq!(err.kind, NetErrorKind::McpAuth);
    assert!(!serde_json::to_string(&err).unwrap().contains(TOKEN));
    assert!(!format!("{err:?}").contains(TOKEN));
    assert!(!env.clients.is_open(ID));
}

#[test]
fn a_cancelled_request_id_sends_nothing_more() {
    let env = Env::new("mcpc-cancel");
    let mut script = connect_script("s-1");
    script.push(text("late"));
    let f = fake(script);
    let c = bearer(&f.url);
    env.token(&f.url, TOKEN);
    let ctx = env.ctx(&c);
    block_on(connect_at(&env.clients, &ctx, ID)).unwrap();
    assert!(!env.net.cancel("r1"));
    let err = block_on(call_at(&env.clients, &ctx, ID, "get_part", json!({}), Some("r1"))).unwrap_err();
    assert_eq!(err.kind, NetErrorKind::Cancelled);
    assert_eq!(f.count(), 3);
}

#[test]
fn a_vault_switch_ends_the_sessions_of_the_old_vault() {
    let env = Env::new("mcpc-vault");
    let f = fake(vec![init("s-1"), accepted(), tools_list(), deleted()]);
    let c = bearer(&f.url);
    env.token(&f.url, TOKEN);
    block_on(connect_at(&env.clients, &env.ctx(&c), ID)).unwrap();
    env.clients.close_other_vaults(&env.root);
    assert!(env.clients.is_open(ID), "the same vault keeps its session");
    env.clients.close_other_vaults(&env.dir.join("other-vault"));
    assert!(!env.clients.is_open(ID));
    wait_for(&f, 4);
    let d = f.request(3);
    assert_eq!((d.method.as_str(), d.header("mcp-session-id")), ("DELETE", Some("s-1")));
}

#[test]
fn close_all_ends_every_session() {
    let env = Env::new("mcpc-exit");
    let f = fake(vec![init("s-1"), accepted(), tools_list(), deleted()]);
    let c = bearer(&f.url);
    env.token(&f.url, TOKEN);
    block_on(connect_at(&env.clients, &env.ctx(&c), ID)).unwrap();
    block_on(env.clients.close_all());
    assert!(!env.clients.is_open(ID));
    assert_eq!(f.request(3).method, "DELETE");
}
