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
    let args = |cmd: &str, vals: Vec<Value>| -> Value {
        let names = fixture[cmd].as_array().unwrap_or_else(|| panic!("{cmd} missing from ipc-args.json"));
        assert_eq!(names.len(), vals.len(), "{cmd}: fixture lists {names:?}");
        Value::Object(names.iter().map(|n| n.as_str().unwrap().to_string()).zip(vals).collect())
    };

    // Before vault_open every file command refuses with noVault, and the
    // error reaches JS as {kind, message}.
    assert_eq!(call("vault_exists", args("vault_exists", vec![json!("a.md")])).unwrap_err()["kind"], "noVault");
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
    // `expectedBefore` (camelCase on the wire) must reach `expected_before`.
    assert_eq!(
        ok("vault_modify", args("vault_modify", vec![json!("notes/a.md"), json!("two"), json!("one")])),
        json!({"kind": "ok"})
    );
    assert_eq!(
        ok("vault_modify", args("vault_modify", vec![json!("notes/a.md"), json!("x"), json!("stale")])),
        json!({"kind": "conflict", "current": "two"})
    );
    ok("vault_remove", args("vault_remove", vec![json!("notes/a.md")]));
    ok("vault_rmdir", args("vault_rmdir", vec![json!("notes")]));
    assert_eq!(std::fs::read_dir(dir.join("vault")).unwrap().count(), 0);

    // A misspelled argument is refused rather than ignored.
    assert!(call("vault_write", json!({"path": "b.md", "contents": "x"})).is_err());
    assert!(call("vault_list", json!({"path": ""})).is_err());
    assert!(call("vault_open", json!({"vault": "x"})).is_err());

    drop(webview);
    let _ = std::fs::remove_dir_all(&dir);
}
