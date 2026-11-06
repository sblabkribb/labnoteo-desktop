//! IPC round trip through Tauri's mock runtime. The argument names come from
//! `ipc-args.json`, the one artifact shared with the TypeScript side:
//! `src/fs/__tests__/ipcArgs.test.ts` checks that `tauriLabnoteFs.ts` and
//! `useVault.ts` send exactly those names. This test checks that the Rust
//! commands accept exactly those names (values are zipped positionally onto the
//! fixture's names, so renaming one in the fixture breaks it). Renaming an
//! argument on either side, or in the fixture alone, turns one of the two red.
//! Neither test reads the other's source, and the fixture itself is only as
//! right as the two tests that pin it.

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;
use labnoteo_app_lib::index::IndexState;
use labnoteo_app_lib::vault::{SettingsFile, VaultState};

const ARGS: &str = include_str!("ipc-args.json");

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
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();

    let call = |cmd: &str, args: Value| -> Result<Value, Value> {
        get_ipc_response(
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
        .map(|b| b.deserialize::<Value>().unwrap())
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

    let info = ok("vault_open", args("vault_open", vec![json!(vault)]));
    assert_eq!(info["name"], "vault");
    assert_eq!(info["hasObsidianConfig"], false);
    assert_eq!(ok("vault_current", args("vault_current", vec![]))["name"], "vault");

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
    ok("index_remove", args("index_remove", vec![json!("notes/k.md")]));
    assert_eq!(ok("search", args("search", vec![json!("agarose"), json!(10)])), json!({"hits": [], "truncated": false}));
    ok("vault_remove", args("vault_remove", vec![json!("notes/k.md")]));
    ok("vault_remove", args("vault_remove", vec![json!("notes/a.md")]));
    ok("vault_rmdir", args("vault_rmdir", vec![json!("notes")]));
    assert_eq!(std::fs::read_dir(dir.join("vault")).unwrap().count(), 0);

    // A misspelled argument is refused rather than ignored.
    assert!(call("vault_write", json!({"path": "b.md", "contents": "x"})).is_err());
    assert!(call("vault_list", json!({"path": ""})).is_err());
    assert!(call("vault_open", json!({"vault": "x"})).is_err());
    assert!(call("search", json!({"q": "x", "limit": 5})).is_err());
    // A fixture entry nobody exercises pins nothing: every one was called above.
    let fixture_keys: std::collections::BTreeSet<String> = fixture.as_object().unwrap().keys().cloned().collect();
    assert_eq!(*used.borrow(), fixture_keys, "commands this test called vs ipc-args.json");

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
