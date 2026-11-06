//! IPC round trip through Tauri's mock runtime, with the exact JSON argument
//! names the TypeScript side sends (`tauriLabnoteFs.ts`, `useVault.ts`). Direct
//! Rust calls and a fake `invoke` both pass when a name drifts; this does not.

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;
use labnoteo_app_lib::vault::{SettingsFile, VaultState};

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

    // Before vault_open every file command refuses with noVault, and the
    // error reaches JS as {kind, message}.
    assert_eq!(call("vault_exists", json!({"path": "a.md"})).unwrap_err()["kind"], "noVault");
    assert_eq!(ok("vault_current", json!({})), Value::Null);

    let info = ok("vault_open", json!({"path": vault}));
    assert_eq!(info["name"], "vault");
    assert_eq!(info["hasObsidianConfig"], false);
    assert_eq!(ok("vault_current", json!({}))["name"], "vault");

    ok("vault_mkdir", json!({"path": "notes"}));
    ok("vault_write", json!({"path": "notes/a.md", "content": "one"}));
    assert_eq!(ok("vault_read", json!({"path": "notes/a.md"})), "one");
    assert_eq!(ok("vault_exists", json!({"path": "notes/a.md"})), true);
    assert_eq!(ok("vault_list", json!({"dir": "notes"})), json!(["a.md"]));
    assert_eq!(ok("vault_list", json!({"dir": ""})), json!(["notes"]));
    // `expectedBefore` (camelCase on the wire) must reach `expected_before`.
    assert_eq!(
        ok("vault_modify", json!({"path": "notes/a.md", "content": "two", "expectedBefore": "one"})),
        json!({"kind": "ok"})
    );
    assert_eq!(
        ok("vault_modify", json!({"path": "notes/a.md", "content": "x", "expectedBefore": "stale"})),
        json!({"kind": "conflict", "current": "two"})
    );
    ok("vault_remove", json!({"path": "notes/a.md"}));
    ok("vault_rmdir", json!({"path": "notes"}));
    assert_eq!(std::fs::read_dir(dir.join("vault")).unwrap().count(), 0);

    // A misspelled argument is refused rather than ignored.
    assert!(call("vault_write", json!({"path": "b.md", "contents": "x"})).is_err());
    assert!(call("vault_list", json!({"path": ""})).is_err());
    assert!(call("vault_open", json!({"vault": "x"})).is_err());

    drop(webview);
    let _ = std::fs::remove_dir_all(&dir);
}
