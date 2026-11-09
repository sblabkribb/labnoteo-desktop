//! IPC round trip through Tauri's mock runtime. The argument names come from
//! `ipc-args.json`, the one artifact shared with the TypeScript side:
//! `src/fs/__tests__/ipcArgs.test.ts` checks that `tauriLabnoteFs.ts` and
//! `useVault.ts` send exactly those names. This test checks that the Rust
//! commands accept exactly those names (values are zipped positionally onto the
//! fixture's names, so renaming one in the fixture breaks it). Renaming an
//! argument on either side, or in the fixture alone, turns one of the two red.
//! Neither test reads the other's source, and the fixture itself is only as
//! right as the two tests that pin it.
//!
//! The other half of the wire gets the same treatment: `ipc-errors.json` (the
//! `kind` strings of a rejected command) and `ipc-events.json` (the name,
//! payload fields and `kind` values of `vault://changed`) are read here against
//! the Rust `Serialize` impls and in `src/fs/__tests__/ipcErrors.test.ts` /
//! the editor and events tests against the TypeScript consumers.

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;
use labnoteo_app_lib::index::IndexState;
use labnoteo_app_lib::vault::{LinkJournalDir, SettingsFile, VaultState};

const ARGS: &str = include_str!("ipc-args.json");
const ERRORS: &str = include_str!("ipc-errors.json");
const EVENTS: &str = include_str!("ipc-events.json");
const NET_ERRORS: &str = include_str!("ipc-net-errors.json");

#[test]
fn ipc_argument_names_match_the_typescript_side() {
    let dir = std::env::temp_dir().join(format!("labnoteo-ipc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("vault")).unwrap();
    let vault = dir.join("vault").to_string_lossy().into_owned();

    let app = labnoteo_app_lib::register_commands!(mock_builder())
        .manage(VaultState::default())
        .manage(SettingsFile(dir.join("config").join("settings.json")))
        .manage(IndexState::new(dir.join("data").join("index")))
        .manage(LinkJournalDir(dir.join("data").join("link-journal")))
        .manage(labnoteo_app_lib::vault::watcher::WatcherState::inert())
        .manage(labnoteo_app_lib::net::secrets::Secrets::memory())
        .manage(labnoteo_app_lib::net::NetState::default())
        .manage(labnoteo_app_lib::net::IntegrationDirs(dir.join("data").join("integrations")))
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();

    // Every response, kept so the test can check no key ever comes back.
    let responses = std::cell::RefCell::new(Vec::<String>::new());
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
        )
        .map(|b| b.deserialize::<Value>().unwrap());
        responses.borrow_mut().push(match &res {
            Ok(v) | Err(v) => v.to_string(),
        });
        res
    };
    let ok = |cmd: &str, args: Value| {
        call(cmd, args.clone()).unwrap_or_else(|e| panic!("{cmd} {args} was refused: {e}"))
    };

    // Build a command's JSON arguments from the shared fixture's names.
    let fixture: Value = serde_json::from_str(ARGS).unwrap();
    let used = std::cell::RefCell::new(std::collections::BTreeSet::<String>::new());
    let args = |cmd: &str, vals: Vec<Value>| -> Value {
        used.borrow_mut().insert(cmd.to_string());
        let names = fixture[cmd].as_array().unwrap_or_else(|| panic!("{cmd} missing from ipc-args.json"));
        assert_eq!(names.len(), vals.len(), "{cmd}: fixture lists {names:?}");
        Value::Object(names.iter().map(|n| n.as_str().unwrap().to_string()).zip(vals).collect())
    };

    // Before vault_open every file command refuses with noVault, and the
    // error reaches JS as {kind, message}.
    assert_eq!(call("vault_exists", args("vault_exists", vec![json!("a.md")])).unwrap_err()["kind"], "noVault");
    assert_eq!(call("vault_tree", args("vault_tree", vec![])).unwrap_err()["kind"], "noVault");
    assert_eq!(ok("vault_current", args("vault_current", vec![])), Value::Null);
    assert_eq!(call("link_journal_read", args("link_journal_read", vec![])).unwrap_err()["kind"], "noVault");

    // Integration keys need the open vault's settings to name their origin.
    assert_eq!(call("secret_status", args("secret_status", vec![])).unwrap_err()["kind"], "notConfigured");
    // PartBank: the webview names a connection and a path, never a host. With
    // no vault there is no saved URL or key; a probe of unsaved fields without
    // a typed key answers keyMissing and sends nothing.
    let pb = call("partbank_request", args("partbank_request", vec![json!("web"), json!("GET"), json!("/auth/me"), Value::Null, Value::Null]))
        .unwrap_err();
    assert!(pb["kind"] == "keyMissing" || pb["kind"] == "notConfigured", "{pb}");
    assert_eq!(
        call("partbank_probe", args("partbank_probe", vec![json!("web"), json!("https://x.example"), Value::Null])).unwrap_err()["kind"],
        "keyMissing"
    );
    // LLM: with no vault there is no saved provider or endpoint.
    let llm = call("llm_chat", args("llm_chat", vec![json!("r"), json!("ollama"), json!({})])).unwrap_err();
    assert!(llm["kind"] == "badInput" || llm["kind"] == "notConfigured", "{llm}");
    assert_eq!(
        call("llm_probe", args("llm_probe", vec![json!("ollama"), json!("ftp://x"), json!("m"), Value::Null])).unwrap_err()["kind"],
        "invalidUrl"
    );
    // bfworkflow: with no vault there is no saved URL to resolve.
    assert_eq!(call("bfw_base", args("bfw_base", vec![])).unwrap_err()["kind"], "notConfigured");
    // Note generation checks its input before anything else.
    let design = json!({"designType": "service", "nodes": [], "edges": []});
    assert_eq!(
        call("bfw_generate_notes", args("bfw_generate_notes", vec![json!("g1"), design.clone(), json!("fr"), json!(false)])).unwrap_err()["kind"],
        "badInput"
    );
    assert_eq!(
        call("bfw_generate_notes", args("bfw_generate_notes", vec![json!("g1"), design.clone(), json!("ko"), json!(true)])).unwrap_err()["kind"],
        "notConfigured"
    );
    assert_eq!(
        call("bfw_probe", args("bfw_probe", vec![json!("server"), json!("https://x.example"), Value::Null])).unwrap_err()["kind"],
        "keyMissing"
    );

    // App-data stores (offline catalogs, integration state) are per vault.
    assert_eq!(call("partbank_catalog_list", args("partbank_catalog_list", vec![])).unwrap_err()["kind"], "notConfigured");

    let info = ok("vault_open", args("vault_open", vec![json!(vault)]));
    assert_eq!(info["name"], "vault");
    assert_eq!(info["hasObsidianConfig"], false);
    assert_eq!(ok("vault_current", args("vault_current", vec![]))["name"], "vault");

    // Per-vault settings: kept in the app config dir, never in the vault. The
    // plugin import reads only `.obsidian/plugins/labnoteo/data.json`.
    assert_eq!(ok("settings_vault_read", args("settings_vault_read", vec![])), Value::Null);
    assert_eq!(ok("settings_import_plugin", args("settings_import_plugin", vec![])), Value::Null);
    let plugin = dir.join("vault").join(".obsidian").join("plugins").join("labnoteo");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("data.json"), r#"{"autoSyncUnitOpToc":false}"#).unwrap();
    assert_eq!(ok("settings_import_plugin", args("settings_import_plugin", vec![])), r#"{"autoSyncUnitOpToc":false}"#);
    std::fs::remove_dir_all(dir.join("vault").join(".obsidian")).unwrap();
    ok("settings_vault_write", args("settings_vault_write", vec![json!(r#"{"schemaVersion":2}"#)]));
    assert_eq!(ok("settings_vault_read", args("settings_vault_read", vec![])), r#"{"schemaVersion":2}"#);
    assert_eq!(
        call("settings_vault_write", args("settings_vault_write", vec![json!("{not json")])).unwrap_err()["kind"],
        "io"
    );
    assert!(dir.join("config").join("vaults").is_dir());

    // Integration keys (Windows Credential Manager; here the memory store):
    // the webview only ever learns a flag and an epoch, never the key.
    assert_eq!(ok("secret_set", args("secret_set", vec![json!("partbankWeb"), json!("pbk_t")])), Value::Null);
    let status = ok("secret_status", args("secret_status", vec![]));
    assert_eq!(status["set"]["partbankWeb"], true);
    assert_eq!(status["epoch"]["partbankWeb"], 1);
    assert_eq!(status["set"]["llmOpenai"], false);
    assert_eq!(
        call("secret_set", args("secret_set", vec![json!("partbankWeb"), json!("pbk_t\u{7}")])).unwrap_err()["kind"],
        "badInput"
    );
    assert_eq!(ok("secret_clear", args("secret_clear", vec![json!("partbankWeb")])), Value::Null);
    let status = ok("secret_status", args("secret_status", vec![]));
    assert_eq!((&status["set"]["partbankWeb"], &status["epoch"]["partbankWeb"]), (&json!(false), &json!(2)));

    // Plugin import (D9): the returned JSON holds no key, and an LLM key in
    // data.json is only offered. Storing it re-reads data.json in Rust, so the
    // value never crosses IPC, and an existing key is kept.
    let first = responses.borrow().len();
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("data.json"), r#"{"llmApiKey":"sk-imp","autoSyncUnitOpToc":false}"#).unwrap();
    let imported = ok("settings_import_plugin", args("settings_import_plugin", vec![]));
    assert!(imported.as_str().unwrap().contains("autoSyncUnitOpToc"), "{imported}");
    assert_eq!(ok("settings_plugin_llm_key", args("settings_plugin_llm_key", vec![])), json!(true));
    assert_eq!(ok("settings_import_llm_key", args("settings_import_llm_key", vec![])), json!(true));
    assert_eq!(ok("settings_plugin_llm_key", args("settings_plugin_llm_key", vec![])), json!(false));
    assert_eq!(ok("secret_status", args("secret_status", vec![]))["set"]["llmOpenai"], true);
    assert_eq!(ok("settings_import_llm_key", args("settings_import_llm_key", vec![])), json!(false));
    for r in responses.borrow()[first..].iter() {
        assert!(!r.contains("sk-imp"), "{r}");
    }
    std::fs::remove_dir_all(dir.join("vault").join(".obsidian")).unwrap();

    // Cancelling an id that is not in flight answers false (it is remembered,
    // so a request registered later with it answers `cancelled` unsent).
    assert_eq!(ok("net_cancel", args("net_cancel", vec![json!("none")])), json!(false));

    // With the vault open but no partbank key: keyMissing, and a path off the
    // allow-list is refused before anything else.
    assert_eq!(
        call("partbank_request", args("partbank_request", vec![json!("web"), json!("GET"), json!("/auth/me"), Value::Null, Value::Null])).unwrap_err()["kind"],
        "keyMissing"
    );
    assert_eq!(
        call("partbank_request", args("partbank_request", vec![json!("desktop"), json!("GET"), json!("//evil.example/x"), Value::Null, Value::Null])).unwrap_err()["kind"],
        "forbiddenPath"
    );
    assert_eq!(
        call("partbank_probe", args("partbank_probe", vec![json!("web"), json!("https://x.example/path"), json!("typed")])).unwrap_err()["kind"],
        "invalidUrl"
    );

    // LLM with the vault open: the default provider is none, so a chat that
    // names another provider is refused before anything is sent.
    let llm = call("llm_chat", args("llm_chat", vec![json!("r"), json!("ollama"), json!({})])).unwrap_err();
    assert!(llm["kind"] == "badInput" || llm["kind"] == "notConfigured", "{llm}");

    // bfworkflow with the vault open and no settings written: the default
    // server is the base, a request without a key is keyMissing, and a path
    // off the allow-list is refused before anything else.
    assert_eq!(ok("bfw_base", args("bfw_base", vec![])), "https://workflow.kbiofoundry.kr/");
    assert_eq!(
        call("bfw_request", args("bfw_request", vec![json!("/api/auth/me"), Value::Null])).unwrap_err()["kind"],
        "keyMissing"
    );
    assert_eq!(
        call("bfw_request", args("bfw_request", vec![json!("/api/api-keys"), Value::Null])).unwrap_err()["kind"],
        "forbiddenPath"
    );
    assert_eq!(
        call("bfw_probe", args("bfw_probe", vec![json!("server"), json!("https://x.example/path"), json!("typed")])).unwrap_err()["kind"],
        "invalidUrl"
    );
    assert_eq!(
        call("bfw_generate_notes", args("bfw_generate_notes", vec![json!("g2"), json!({"nodes": []}), json!("en"), json!(false)])).unwrap_err()["kind"],
        "badInput"
    );
    assert_eq!(
        call("bfw_generate_notes", args("bfw_generate_notes", vec![json!("g3"), design.clone(), json!("en"), json!(false)])).unwrap_err()["kind"],
        "keyMissing"
    );

    // Offline PartBank catalogs and integration state: in the app data dir,
    // per vault, JSON objects only, and never in the vault itself.
    assert_eq!(ok("partbank_catalog_list", args("partbank_catalog_list", vec![])), json!([]));
    assert_eq!(ok("partbank_catalog_read", args("partbank_catalog_read", vec![json!("DNA_partbank-web.json")])), Value::Null);
    ok("partbank_catalog_write", args("partbank_catalog_write", vec![json!("DNA_partbank-web.json"), json!(r#"{"items":[]}"#)]));
    assert_eq!(
        ok("partbank_catalog_read", args("partbank_catalog_read", vec![json!("DNA_partbank-web.json")])),
        r#"{"items":[]}"#
    );
    assert_eq!(ok("partbank_catalog_list", args("partbank_catalog_list", vec![])), json!(["DNA_partbank-web.json"]));
    assert_eq!(
        call("partbank_catalog_write", args("partbank_catalog_write", vec![json!("../x_partbank-web.json"), json!("{}")])).unwrap_err()["kind"],
        "badInput"
    );
    assert_eq!(
        call("partbank_catalog_write", args("partbank_catalog_write", vec![json!("DNA_partbank-web.json"), json!("[]")])).unwrap_err()["kind"],
        "badInput"
    );
    assert_eq!(ok("integration_state_read", args("integration_state_read", vec![json!("partbankUsage")])), Value::Null);
    ok("integration_state_write", args("integration_state_write", vec![json!("bfwCatalogCache"), json!(r#"{"origin":"o"}"#)]));
    assert_eq!(
        ok("integration_state_read", args("integration_state_read", vec![json!("bfwCatalogCache")])),
        r#"{"origin":"o"}"#
    );
    assert!(call("integration_state_read", json!({"name": "../x"})).is_err());
    assert!(dir.join("data").join("integrations").join("partbank").is_dir());

    // The link journal: kept in the app data dir, never in the vault.
    assert_eq!(ok("link_journal_read", args("link_journal_read", vec![])), Value::Null);
    ok("link_journal_write_header", args("link_journal_write_header", vec![json!("H")]));
    ok("link_journal_write_note", args("link_journal_write_note", vec![json!(1), json!("B")]));
    ok("link_journal_write_note", args("link_journal_write_note", vec![json!(0), json!("A")]));
    assert_eq!(
        ok("link_journal_read", args("link_journal_read", vec![])),
        json!({"header": "H", "notes": ["A", "B"]})
    );
    assert!(dir.join("data").join("link-journal").is_dir());
    assert_eq!(std::fs::read_dir(dir.join("vault")).unwrap().count(), 0, "nothing lands in the vault");
    ok("link_journal_clear", args("link_journal_clear", vec![]));
    assert_eq!(ok("link_journal_read", args("link_journal_read", vec![])), Value::Null);

    // A new vault: one folder is made next to the first one, opened and remembered.
    let fresh = dir.join("fresh").to_string_lossy().into_owned();
    let created = ok("vault_create", args("vault_create", vec![json!(fresh)]));
    assert_eq!(created["name"], "fresh");
    assert!(dir.join("fresh").is_dir());
    assert!(call("vault_create", json!({"folder": "x"})).is_err());
    ok("vault_open", args("vault_open", vec![json!(vault)]));

    ok("vault_mkdir", args("vault_mkdir", vec![json!("notes")]));
    ok("vault_write", args("vault_write", vec![json!("notes/a.md"), json!("one")]));
    assert_eq!(ok("vault_read", args("vault_read", vec![json!("notes/a.md")])), "one");
    assert_eq!(ok("vault_exists", args("vault_exists", vec![json!("notes/a.md")])), true);
    assert_eq!(ok("vault_list", args("vault_list", vec![json!("notes")])), json!(["a.md"]));
    assert_eq!(ok("vault_list", args("vault_list", vec![json!("")])), json!(["notes"]));
    // camelCase on the wire: `isDir`, not `is_dir`.
    assert_eq!(
        ok("vault_tree", args("vault_tree", vec![])),
        json!([
            {"path": "notes", "name": "notes", "isDir": true, "depth": 0},
            {"path": "notes/a.md", "name": "a.md", "isDir": false, "depth": 1},
        ])
    );
    // `expectedBefore` (camelCase on the wire) must reach `expected_before`.
    assert_eq!(
        ok("vault_modify", args("vault_modify", vec![json!("notes/a.md"), json!("two"), json!("one")])),
        json!({"kind": "ok"})
    );
    assert_eq!(
        ok("vault_modify", args("vault_modify", vec![json!("notes/a.md"), json!("x"), json!("stale")])),
        json!({"kind": "conflict", "current": "two"})
    );
    // The index: commands, argument names, and the wire shape of a hit.
    assert_eq!(ok("app_version", args("app_version", vec![])), env!("CARGO_PKG_VERSION"));
    ok("vault_write", args("vault_write", vec![json!("notes/k.md"), json!("---
title: 실험
---
형질전환 효율")]));
    assert_eq!(ok("index_rebuild", args("index_rebuild", vec![]))["indexed"], 2);
    let res = ok("search", args("search", vec![json!("형질전환"), json!(10)]));
    assert_eq!(res["truncated"], false);
    let hits = &res["hits"];
    assert_eq!(hits.as_array().unwrap().len(), 1);
    assert_eq!(hits[0]["path"], "notes/k.md");
    assert_eq!(hits[0]["title"], "실험");
    assert!(hits[0]["snippet"].as_str().unwrap().contains("형질전환"));
    ok("vault_write", args("vault_write", vec![json!("notes/k.md"), json!("agarose")]));
    ok("index_upsert", args("index_upsert", vec![json!("notes/k.md")]));
    assert_eq!(ok("search", args("search", vec![json!("agarose"), json!(10)]))["hits"][0]["path"], "notes/k.md");
    let page = ok("index_bodies", args("index_bodies", vec![Value::Null, json!(0)]));
    assert_eq!(page["items"].as_array().unwrap().len(), 1, "a limit of 0 is clamped to 1: {page}");
    assert!(page["next"].is_string(), "a full page names the next key: {page}");
    let rest = ok("index_bodies", args("index_bodies", vec![page["next"].clone(), json!(500)]));
    assert!(rest["items"].as_array().unwrap().iter().any(|i| i["path"] == "notes/k.md" && i["body"].is_string()), "{rest}");
    assert_eq!(rest["next"], Value::Null);
    ok("index_remove", args("index_remove", vec![json!("notes/k.md")]));
    assert_eq!(ok("search", args("search", vec![json!("agarose"), json!(10)])), json!({"hits": [], "truncated": false}));
    ok("vault_remove", args("vault_remove", vec![json!("notes/k.md")]));
    // `from` and `to` reach `rename`; an existing target is refused with `exists`.
    ok("vault_rename", args("vault_rename", vec![json!("notes/a.md"), json!("notes/b.md")]));
    assert_eq!(ok("vault_list", args("vault_list", vec![json!("notes")])), json!(["b.md"]));
    ok("vault_write", args("vault_write", vec![json!("notes/c.md"), json!("c")]));
    assert_eq!(
        call("vault_rename", args("vault_rename", vec![json!("notes/c.md"), json!("notes/b.md")])).unwrap_err()["kind"],
        "exists"
    );
    ok("vault_remove", args("vault_remove", vec![json!("notes/c.md")]));
    ok("vault_rename", args("vault_rename", vec![json!("notes/b.md"), json!("notes/a.md")]));
    // Only on a path that does not exist: Ok without touching the Recycle Bin.
    ok("vault_trash", args("vault_trash", vec![json!("notes/never-there.md")]));
    ok("vault_remove", args("vault_remove", vec![json!("notes/a.md")]));
    ok("vault_rmdir", args("vault_rmdir", vec![json!("notes")]));
    assert_eq!(std::fs::read_dir(dir.join("vault")).unwrap().count(), 0);

    // Images: raw bytes, not JSON (`Response::new`), so this goes straight
    // through `get_ipc_response` instead of `call`, which would deserialize.
    let png = [137u8, 80, 78, 71, 13, 10, 26, 10];
    std::fs::write(dir.join("vault").join("a.png"), png).unwrap();
    let raw = get_ipc_response(
        &webview,
        InvokeRequest {
            cmd: "vault_read_image".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: InvokeBody::Json(args("vault_read_image", vec![json!("a.png")])),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .unwrap_or_else(|e| panic!("vault_read_image was refused: {e}"));
    match raw {
        InvokeResponseBody::Raw(bytes) => assert_eq!(bytes, png.to_vec()),
        other => panic!("expected raw bytes, got {other:?}"),
    }
    std::fs::write(dir.join("vault").join("a.html"), "<p>").unwrap();
    assert_eq!(
        call("vault_read_image", args("vault_read_image", vec![json!("a.html")])).unwrap_err()["kind"],
        "notImage"
    );
    std::fs::remove_file(dir.join("vault").join("a.html")).unwrap();
    assert_eq!(ok("vault_list_images", args("vault_list_images", vec![])), json!(["a.png"]));
    std::fs::remove_file(dir.join("vault").join("a.png")).unwrap();

    // Creation times: one entry per path, `null` for a missing file; too many
    // paths is a malformed argument (`badInput`), not an io error.
    let times = ok("vault_created_times", args("vault_created_times", vec![json!(["a.md"])]));
    assert_eq!(times.as_array().map(Vec::len), Some(1), "{times}");
    let many: Vec<Value> = (0..20_001).map(|i| json!(format!("n{i}.md"))).collect();
    assert_eq!(
        call("vault_created_times", args("vault_created_times", vec![Value::Array(many)])).unwrap_err()["kind"],
        "badInput"
    );

    // Image write: a raw body, so the fixture lists header names instead of
    // JSON argument names. Values are percent-encoded (`encodeURIComponent`),
    // because a header value must be ASCII and a Korean name is not.
    let raw_call = |cmd: &str, vals: Vec<&str>, body: Vec<u8>| -> Result<Value, Value> {
        used.borrow_mut().insert(cmd.to_string());
        let names = fixture[cmd].as_array().unwrap_or_else(|| panic!("{cmd} missing from ipc-args.json"));
        assert_eq!(names.len(), vals.len(), "{cmd}: fixture lists {names:?}");
        let mut headers = tauri::http::HeaderMap::new();
        for (n, v) in names.iter().zip(vals) {
            headers.insert(
                tauri::http::HeaderName::from_bytes(n.as_str().unwrap().as_bytes()).unwrap(),
                tauri::http::HeaderValue::from_str(v).unwrap(),
            );
        }
        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: InvokeBody::Raw(body),
                headers,
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<Value>().unwrap())
    };
    assert_eq!(
        raw_call("vault_write_image", vec!["exp%2Fimages", "p.png"], vec![1, 2]).unwrap(),
        json!("exp/images/p.png")
    );
    assert_eq!(std::fs::read(dir.join("vault").join("exp/images/p.png")).unwrap(), vec![1u8, 2]);
    assert_eq!(
        raw_call("vault_write_image", vec!["exp/images", "p.png"], vec![3]).unwrap(),
        json!("exp/images/p 1.png"),
        "never overwrites"
    );
    assert_eq!(
        raw_call("vault_write_image", vec!["exp", "%EC%82%AC%EC%A7%84.png"], vec![4]).unwrap(),
        json!("exp/사진.png")
    );
    assert!(raw_call("vault_write_image", vec!["..", "p.png"], vec![1]).is_err());
    assert!(raw_call("vault_write_image", vec!["exp", "p.html"], vec![1]).is_err());
    // A JSON body is refused: the bytes must come raw.
    assert!(call("vault_write_image", json!({"dir": "exp", "name": "q.png"})).is_err());
    std::fs::remove_dir_all(dir.join("vault").join("exp")).unwrap();

    // A misspelled argument is refused rather than ignored.
    assert!(call("vault_write", json!({"path": "b.md", "contents": "x"})).is_err());
    assert!(call("vault_list", json!({"path": ""})).is_err());
    assert!(call("vault_open", json!({"vault": "x"})).is_err());
    assert!(call("search", json!({"q": "x", "limit": 5})).is_err());
    // A fixture entry nobody exercises pins nothing: every one was called above.
    let fixture_keys: std::collections::BTreeSet<String> = fixture.as_object().unwrap().keys().cloned().collect();
    assert_eq!(*used.borrow(), fixture_keys, "commands this test called vs ipc-args.json");
    // No response, success or error, ever carried a key back to the webview.
    let leaked: Vec<_> = responses.borrow().iter().filter(|r| r.contains("pbk_t")).cloned().collect();
    assert!(leaked.is_empty(), "a response contained the key: {leaked:?}");

    drop(webview);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The command names `register_commands!` registers, read from its source: the
/// one list the app really uses, so it cannot drift from a copy.
fn registered_commands() -> std::collections::BTreeSet<String> {
    let lib = include_str!("../src/lib.rs");
    assert_eq!(lib.matches("generate_handler![").count(), 1, "expected exactly one handler list in lib.rs");
    let start = lib.find("generate_handler![").unwrap() + "generate_handler![".len();
    let list = &lib[start..start + lib[start..].find(']').expect("handler list is closed by ]")];
    list.split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| p.rsplit("::").next().unwrap().to_string())
        .collect()
}

/// Adding a command without adding it to `ipc-args.json` (and so to both
/// round-trip tests) fails here, and so does leaving a removed command behind.
#[test]
fn fixture_covers_every_registered_command() {
    let fixture: Value = serde_json::from_str(ARGS).unwrap();
    let in_fixture: std::collections::BTreeSet<String> = fixture.as_object().unwrap().keys().cloned().collect();
    let registered = registered_commands();
    assert!(registered.contains("app_version") && registered.contains("search"), "parsed {registered:?}");
    let missing: Vec<_> = registered.difference(&in_fixture).collect();
    let stale: Vec<_> = in_fixture.difference(&registered).collect();
    assert!(missing.is_empty(), "registered but not in ipc-args.json: {missing:?}");
    assert!(stale.is_empty(), "in ipc-args.json but not registered: {stale:?}");
}

/// What `FsError` puts in `kind`, for each way it can be built.
#[test]
fn error_kinds_match_the_typescript_side() {
    use labnoteo_app_lib::vault::fs::FsError;
    use labnoteo_app_lib::vault::path::VaultError;
    use std::io::{Error, ErrorKind};
    let kind = |e: FsError| serde_json::to_value(&e).unwrap()["kind"].as_str().unwrap().to_string();
    let message = |e: FsError| serde_json::to_value(&e).unwrap()["message"].is_string();
    // Exhaustive on purpose: a new variant stops compiling here until it is
    // given a kind in the fixture.
    let _: fn(&FsError) = |e| match e {
        FsError::Forbidden
        | FsError::NoVault
        | FsError::Vault(_)
        | FsError::Io(_)
        | FsError::PathTooLong(_)
        | FsError::Exists
        | FsError::NotImage
        | FsError::TooLarge
        | FsError::BadInput(_) => (),
    };
    let fixture: std::collections::BTreeMap<String, String> = serde_json::from_str(ERRORS).unwrap();
    let actual: std::collections::BTreeMap<String, String> = [
        ("forbidden", kind(FsError::Forbidden)),
        ("noVault", kind(FsError::NoVault)),
        ("escape", kind(FsError::Vault(VaultError::Escape))),
        ("vaultNotFound", kind(FsError::Vault(VaultError::NotFound))),
        ("notFound", kind(FsError::Io(Error::from(ErrorKind::NotFound)))),
        ("io", kind(FsError::Io(Error::from(ErrorKind::PermissionDenied)))),
        ("pathTooLong", kind(FsError::PathTooLong(Error::from_raw_os_error(206)))),
        ("exists", kind(FsError::Exists)),
        ("notImage", kind(FsError::NotImage)),
        ("tooLarge", kind(FsError::TooLarge)),
        ("badInput", kind(FsError::BadInput("x".into()))),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    assert_eq!(actual, fixture, "kinds the Rust side sends vs ipc-errors.json");
    // A missing file inside the vault layer is the same `notFound` as one at the top.
    assert_eq!(kind(FsError::Vault(VaultError::Io(Error::from(ErrorKind::NotFound)))), fixture["notFound"]);
    // Error 206 is `pathTooLong` however it is wrapped, and `From` routes it there.
    assert_eq!(kind(FsError::Vault(VaultError::Io(Error::from_raw_os_error(206)))), fixture["pathTooLong"]);
    assert_eq!(kind(FsError::from(Error::from_raw_os_error(206))), fixture["pathTooLong"]);
    assert!(message(FsError::NoVault), "every error carries a display message");
}

/// What `NetError` puts in `kind`, one entry per `NetErrorKind`.
#[test]
fn net_error_kinds_match_the_fixture() {
    use labnoteo_app_lib::net::NetErrorKind as K;
    let fixture: std::collections::BTreeMap<String, String> = serde_json::from_str(NET_ERRORS).unwrap();
    assert_eq!(fixture.len(), 17, "ipc-net-errors.json lists every kind");
    let all = [
        K::NotConfigured, K::KeyMissing, K::InvalidUrl, K::ForbiddenPath, K::Offline, K::Timeout,
        K::Tls, K::Redirect, K::Status, K::NotJson, K::TooLarge, K::Cancelled, K::Keychain,
        K::BadInput, K::Remote, K::NoResult, K::Insecure,
    ];
    // Exhaustive on purpose: a new variant stops compiling here until it is
    // given a name (and an entry in the fixture).
    let name = |k: &K| match k {
        K::NotConfigured => "notConfigured",
        K::KeyMissing => "keyMissing",
        K::InvalidUrl => "invalidUrl",
        K::ForbiddenPath => "forbiddenPath",
        K::Offline => "offline",
        K::Timeout => "timeout",
        K::Tls => "tls",
        K::Redirect => "redirect",
        K::Status => "status",
        K::NotJson => "notJson",
        K::TooLarge => "tooLarge",
        K::Cancelled => "cancelled",
        K::Keychain => "keychain",
        K::BadInput => "badInput",
        K::Remote => "remote",
        K::NoResult => "noResult",
        K::Insecure => "insecure",
    };
    for k in &all {
        let expected = fixture.get(name(k)).unwrap_or_else(|| panic!("{} missing from ipc-net-errors.json", name(k)));
        assert_eq!(serde_json::to_value(k).unwrap(), Value::String(expected.clone()), "kind {}", name(k));
    }
    let named: std::collections::BTreeSet<&str> = all.iter().map(name).collect();
    assert_eq!(named.len(), 17);
}

#[test]
fn event_name_and_payload_match_the_typescript_side() {
    use labnoteo_app_lib::vault::watcher::{Change, Kind, EVENT};
    let fixture: Value = serde_json::from_str(EVENTS).unwrap();
    let ev = &fixture["vaultChanged"];
    assert_eq!(ev["name"], EVENT);
    // Exhaustive on purpose: a new `Kind` stops compiling here.
    let _: fn(Kind) = |k| match k {
        Kind::Created | Kind::Modified | Kind::Removed => (),
    };
    let wire = |k: Kind| serde_json::to_value(Change { path: "a.md".into(), kind: k }).unwrap();
    let fields: std::collections::BTreeSet<&str> =
        ev["payload"]["fields"].as_object().unwrap().values().map(|v| v.as_str().unwrap()).collect();
    for (name, k) in [("created", Kind::Created), ("modified", Kind::Modified), ("removed", Kind::Removed)] {
        let payload = wire(k);
        let keys: std::collections::BTreeSet<&str> = payload.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, fields, "payload field names vs ipc-events.json");
        assert_eq!(payload[ev["payload"]["fields"]["path"].as_str().unwrap()], "a.md");
        assert_eq!(payload[ev["payload"]["fields"]["kind"].as_str().unwrap()], ev["payload"]["kinds"][name]);
    }
    assert_eq!(ev["payload"]["kinds"].as_object().unwrap().len(), 3);
}

#[test]
fn bfworkflow_notes_event_matches_the_typescript_side() {
    use labnoteo_app_lib::net::bfw::{NotesProgress, NOTES_EVENT};
    let fixture: Value = serde_json::from_str(EVENTS).unwrap();
    let ev = &fixture["bfwNotes"];
    assert_eq!(ev["name"], NOTES_EVENT);
    let payload = serde_json::to_value(NotesProgress { request_id: "r".into(), step: "init".into(), message: "m".into() }).unwrap();
    let keys: std::collections::BTreeSet<&str> = payload.as_object().unwrap().keys().map(String::as_str).collect();
    let fields: std::collections::BTreeSet<&str> =
        ev["payload"]["fields"].as_object().unwrap().values().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(keys, fields, "payload field names vs ipc-events.json");
    assert_eq!(payload[ev["payload"]["fields"]["requestId"].as_str().unwrap()], "r");
    assert_eq!(payload[ev["payload"]["fields"]["step"].as_str().unwrap()], "init");
    assert_eq!(payload[ev["payload"]["fields"]["message"].as_str().unwrap()], "m");
}

/// The index is a cache. A vault whose index cannot open must still be watched:
/// the tree refresh and the editor's external-change check depend on the events.
#[test]
fn the_app_starter_watches_a_vault_whose_index_cannot_open() {
    use std::time::Duration;
    use tauri::{Listener, Manager};
    let dir = std::env::temp_dir().join(format!("labnoteo-starter-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("vault")).unwrap();
    let vault = std::fs::canonicalize(dir.join("vault")).unwrap();
    std::fs::write(vault.join("a.md"), "one").unwrap();
    // The app data dir is a file, so no index database can be created in it.
    let not_a_dir = dir.join("data");
    std::fs::write(&not_a_dir, "x").unwrap();
    let app = tauri::test::mock_app();
    app.manage(IndexState::new(not_a_dir));
    assert!(app.state::<IndexState>().get(&vault).is_err(), "the premise: this index cannot open");
    let (tx, rx) = std::sync::mpsc::channel();
    let name = serde_json::from_str::<Value>(EVENTS).unwrap()["vaultChanged"]["name"].as_str().unwrap().to_string();
    app.listen(name, move |ev| drop(tx.send(ev.payload().to_owned())));
    let start = labnoteo_app_lib::vault::watcher::app_starter(app.handle().clone());
    let _watcher = start(&vault).expect("a watcher even though the index would not open");
    std::thread::sleep(Duration::from_millis(100));
    std::fs::write(vault.join("a.md"), "two").unwrap();
    let payload = rx.recv_timeout(Duration::from_secs(3)).expect("the window is still told");
    assert_eq!(serde_json::from_str::<Value>(&payload).unwrap(), json!({"path": "a.md", "kind": "modified"}));
    drop(_watcher);
    let _ = std::fs::remove_dir_all(&dir);
}
