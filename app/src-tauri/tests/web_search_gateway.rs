//! End to end through the `web_search` IPC command, with the repo's fakes on
//! 127.0.0.1 only: `scripts/fakeSearxng.mjs --require-bearer` (a SearXNG behind
//! an API gateway) and `scripts/fakeLlm.mjs` (an OpenAI-compatible LLM) served
//! on ONE origin by a tiny front (the gateway): `…/search` goes to the fake
//! SearXNG, everything else to the fake LLM. Keys are test strings in the
//! in-memory store, set through `secret_set` like the settings page does.
//!
//! What it pins:
//! - search address on the LLM origin, no search key stored: the LLM key goes;
//! - search address elsewhere with a search key stored: that key goes, never
//!   the LLM key;
//! - search address elsewhere with no search key: no key at all;
//! - a 302 from the LLM origin to another origin: not followed, so the other
//!   origin never sees a request (and so never a key);
//! - a gateway 401: `unauthorized`, with no key in the error.
//!
//! Needs `node` on PATH (the same as `realAppFakes.test.ts`).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;
use labnoteo_app_lib::vault::{SettingsFile, VaultState};

const LLM_KEY: &str = "test-llm-key-456";
const SEARCH_KEY: &str = "test-search-key-123";

/// A child process killed on drop.
struct Fake(Child, String);

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Starts `node <args>` and returns it with the `http://127.0.0.1:<port>`
/// printed on its first stdout line.
fn start(args: &[&str]) -> Fake {
    let mut child = Command::new("node")
        .args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("node on PATH");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let start = line.find("http://127.0.0.1:").unwrap_or_else(|| panic!("no URL in {line:?}"));
    let url = line[start..].trim().trim_end_matches('/').to_string();
    Fake(child, url)
}

fn script(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("scripts").join(name).to_string_lossy().into_owned()
}

/// The gateway: one origin in front of the fake SearXNG (`…/search`) and the
/// fake LLM (the rest). `/moved/…` answers 302 to argv[3] (another origin).
const GATEWAY: &str = r#"
const http = require('http');
const [searx, llm, other] = process.argv.slice(1).map((u) => new URL(u));
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/moved/')) {
    res.writeHead(302, { Location: `${other.origin}/search${u.search}` }).end();
    return;
  }
  const t = u.pathname.endsWith('/search') ? searx : llm;
  const p = http.request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  req.pipe(p);
}).listen(0, '127.0.0.1', function () {
  process.stdout.write(`gateway on http://127.0.0.1:${this.address().port}/\n`);
});
"#;

/// The fake's request log (`GET /__log`), fetched with no key.
fn log_of(base: &str) -> Vec<Value> {
    let url = format!("{base}/__log");
    let text = tauri::async_runtime::block_on(async { reqwest::get(&url).await.unwrap().text().await.unwrap() });
    assert!(!text.contains(LLM_KEY) && !text.contains(SEARCH_KEY), "a fake logged a key: {text}");
    serde_json::from_str(&text).unwrap()
}

fn auths(base: &str) -> Vec<String> {
    log_of(base).iter().map(|e| e["auth"].as_str().unwrap_or("").to_string()).collect()
}

#[test]
fn web_search_picks_the_key_by_origin_against_the_fake_gateway() {
    // The fakes: SearXNG behind the gateway wants the LLM key; a second SearXNG
    // on another origin wants the search key; a third (no key needed) is the
    // "other origin" that must never get a key.
    let searx_llm = start(&[&script("fakeSearxng.mjs"), "--port", "0", "--require-bearer", LLM_KEY]);
    let searx_keyed = start(&[&script("fakeSearxng.mjs"), "--port", "0", "--require-bearer", SEARCH_KEY]);
    let searx_open = start(&[&script("fakeSearxng.mjs"), "--port", "0"]);
    let llm = start(&[&script("fakeLlm.mjs"), "--port", "0"]);
    let gw = start(&["-e", GATEWAY, &searx_llm.1, &llm.1, &searx_open.1]);
    let gw_url = gw.1.clone();
    println!("fakes: gateway {gw_url} -> searxng {} + llm {}; keyed searxng {}; open searxng {}", searx_llm.1, llm.1, searx_keyed.1, searx_open.1);

    let dir = std::env::temp_dir().join(format!("labnoteo-wsgw-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("vault")).unwrap();
    let app = labnoteo_app_lib::register_commands!(mock_builder())
        .manage(VaultState::default())
        .manage(SettingsFile(dir.join("config").join("settings.json")))
        .manage(labnoteo_app_lib::vault::watcher::WatcherState::inert())
        .manage(labnoteo_app_lib::net::secrets::Secrets::memory())
        .manage(labnoteo_app_lib::net::NetState::default())
        .manage(labnoteo_app_lib::net::mcp_client::McpClients::default())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    let call = |cmd: &str, args: Value| -> Result<Value, Value> {
        let res = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        let to_value = |b: InvokeResponseBody| match b {
            InvokeResponseBody::Json(s) => serde_json::from_str(&s).unwrap(),
            InvokeResponseBody::Raw(_) => Value::Null,
        };
        let out = res.map(to_value).map_err(|e| e);
        let text = format!("{out:?}");
        assert!(!text.contains(LLM_KEY) && !text.contains(SEARCH_KEY), "{cmd} answered with a key: {text}");
        out
    };
    let ok = |cmd: &str, args: Value| call(cmd, args.clone()).unwrap_or_else(|e| panic!("{cmd} {args} was refused: {e}"));
    let set_search_url = |url: &str| {
        ok("assistant_config_write", json!({"cfg": {"searxngUrl": url}}));
    };
    let search = |q: &str| call("web_search", json!({"requestId": format!("ws-{q}"), "query": q, "opts": null}));

    // A vault whose OpenAI-compatible LLM is the gateway, its key in the store.
    ok("vault_open", json!({"path": dir.join("vault").to_string_lossy()}));
    let llm_endpoint = format!("{gw_url}/v1");
    ok(
        "settings_vault_write",
        json!({"content": json!({"llmProvider": "openai", "llmEndpointOpenai": llm_endpoint, "llmModelOpenai": "fake-model"}).to_string()}),
    );
    ok("secret_set", json!({"slot": "llmOpenai", "value": LLM_KEY}));

    // The LLM really answers on that origin with that key.
    let chat = ok(
        "llm_chat",
        json!({"requestId": "c1", "provider": "openai", "body": {"model": "fake-model", "messages": [{"role": "user", "content": "hi"}]}}),
    );
    println!("llm_chat via gateway: {}", chat.to_string().chars().take(160).collect::<String>());
    let llm_log = log_of(llm.1.trim_end_matches("/v1"));
    assert_eq!(llm_log.last().unwrap()["path"], "/v1/chat/completions");
    assert_eq!(llm_log.last().unwrap()["auth"], "present");

    // 1. Same origin as the LLM, no search key: the LLM key goes and the
    //    gateway lets the search through.
    set_search_url(&format!("{gw_url}/v1"));
    let hits = ok("web_search", json!({"requestId": "ws1", "query": "대장균 형질전환", "opts": {"language": "ko"}}));
    assert!(!hits["hits"].as_array().unwrap().is_empty(), "{hits}");
    assert_eq!(auths(&searx_llm.1), ["ok"]);
    println!("1. same origin, no search key -> {:?} (Bearer = LLM key), hits {}", auths(&searx_llm.1), hits["hits"].as_array().unwrap().len());

    // 2. Another origin with its own search key: that key goes (the gateway
    //    there checks for the search key, so the LLM key would be a 401).
    set_search_url(&searx_keyed.1);
    ok("secret_set", json!({"slot": "webSearch", "value": SEARCH_KEY}));
    ok("web_search", json!({"requestId": "ws2", "query": "pcr", "opts": null}));
    assert_eq!(auths(&searx_keyed.1), ["ok"]);
    println!("2. other origin + stored search key -> {:?} (Bearer = search key)", auths(&searx_keyed.1));

    // 3. Another origin, no key stored for it: no Authorization at all.
    set_search_url(&searx_open.1);
    ok("web_search", json!({"requestId": "ws3", "query": "pcr", "opts": null}));
    assert_eq!(auths(&searx_open.1), ["none"]);
    println!("3. other origin, no search key -> {:?} (LLM key not sent)", auths(&searx_open.1));

    // 4. The LLM origin redirects to another origin: not followed.
    set_search_url(&format!("{gw_url}/moved"));
    let e = search("redirect").unwrap_err();
    assert_eq!(e["kind"], "redirect", "{e}");
    assert_eq!(auths(&searx_open.1), ["none"], "the redirect target got no request at all");
    println!("4. cross-origin 302 -> {e} ; target log still {:?}", auths(&searx_open.1));

    // 5. The gateway refuses a wrong key: unauthorized, with no key in the error.
    //    (The search key slot for the gateway origin overrides the LLM key.)
    set_search_url(&format!("{gw_url}/v1"));
    ok("secret_set", json!({"slot": "webSearch", "value": "test-wrong-key-789"}));
    let e = search("unauth").unwrap_err();
    assert_eq!(e["kind"], "unauthorized", "{e}");
    assert_eq!(auths(&searx_llm.1), ["ok", "wrong"]);
    // The probe ("확인" button) gives the same kind.
    let p = call("web_search_probe", json!({"url": format!("{gw_url}/v1")})).unwrap_err();
    assert_eq!(p["kind"], "unauthorized", "{p}");
    println!("5. gateway 401 -> {e} ; probe -> {}", p["kind"]);

    drop(webview);
    let _ = std::fs::remove_dir_all(&dir);
}
