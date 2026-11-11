//! GitHub state documents, Rust-only (plan P-R10, P-R11).
//!
//! - App-wide, because the GitHub sign-in is app-wide (one keychain entry):
//!   `<IntegrationDirs>/github/app.json` (`{clientId?, forgetOnExit}`) and
//!   `<IntegrationDirs>/github/account.json` (`{login, id, avatarUrl}`).
//! - Per vault: `<IntegrationDirs>/github/<vaultKey>/links.json` and
//!   `.../status-cache.json` (bare repos later go under `.../repos/`).
//!
//! `GithubDoc` deliberately has no `Deserialize` and is not a `StateName`:
//! `integration_state_write` lets the webview write any `StateName`, and link
//! records hold `allowedHits` and `excluded`. No token is ever in these files.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use tauri::State;

use crate::net::config::{ServiceConfig, DEFAULT_GITHUB_CLIENT_ID};
use crate::net::github::GithubState;
use crate::net::secrets::{clear_secret, SecretStore, Secrets, Slot};
use crate::net::store::vault_dir;
use crate::net::{IntegrationDirs, NetError, NetErrorKind};

/// The service folder under `IntegrationDirs`.
const SERVICE: &str = "github";

/// The GitHub state documents. Rust-only: no `Deserialize`, so no IPC
/// argument can ever name one.
// `Links` and `StatusCache` get their first non-test users with the folder
// status and link tasks.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GithubDoc {
    /// App-wide settings: `{clientId?, forgetOnExit}`.
    App,
    /// The signed-in identity: `{login, id, avatarUrl}` (never the token).
    Account,
    /// Per vault: folder links.
    Links,
    /// Per vault: `{folder -> {path -> [size, mtimeNs, blobHex]}}`.
    StatusCache,
}

impl GithubDoc {
    /// Where the document lives. The per-vault documents need the vault
    /// root (`notConfigured` without one); the app-wide ones ignore it.
    pub(crate) fn path(self, dirs: &Path, root: Option<&Path>) -> Result<PathBuf, NetError> {
        let per_vault = |file: &str| {
            root.map(|r| vault_dir(dirs, SERVICE, r).join(file))
                .ok_or_else(|| NetError::new(NetErrorKind::NotConfigured, "no vault is open"))
        };
        match self {
            GithubDoc::App => Ok(dirs.join(SERVICE).join("app.json")),
            GithubDoc::Account => Ok(dirs.join(SERVICE).join("account.json")),
            GithubDoc::Links => per_vault("links.json"),
            GithubDoc::StatusCache => per_vault("status-cache.json"),
        }
    }
}

/// A local disk failure (same shape as the other app-data stores).
fn disk(what: &str, e: impl std::fmt::Display) -> NetError {
    NetError::new(NetErrorKind::BadInput, format!("app data {what} failed: {e}"))
}

/// Reads a document; a missing file is `T::default()`. A file that is not
/// valid JSON for `T` is an error, so a damaged link list is never silently
/// replaced by an empty one.
pub(crate) fn read_doc<T: DeserializeOwned + Default>(
    dirs: &Path,
    root: Option<&Path>,
    doc: GithubDoc,
) -> Result<T, NetError> {
    let path = doc.path(dirs, root)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|_| disk("read", "the file is damaged")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(disk("read", e)),
    }
}

/// Writes a document through a temp file and a rename.
pub(crate) fn write_doc<T: Serialize>(
    dirs: &Path,
    root: Option<&Path>,
    doc: GithubDoc,
    value: &T,
) -> Result<(), NetError> {
    let path = doc.path(dirs, root)?;
    let text = serde_json::to_string_pretty(value).map_err(|e| disk("write", e))?;
    crate::vault::fs::write_atomic(&path, &text).map_err(|e| disk("write", format!("{e:?}")))
}

/// Deletes a document; a missing one is fine.
pub(crate) fn remove_doc(dirs: &Path, root: Option<&Path>, doc: GithubDoc) -> Result<(), NetError> {
    match std::fs::remove_file(doc.path(dirs, root)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(disk("delete", e)),
    }
}

/// `GithubDoc::App`. The client ID is not a secret.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct GithubAppSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    pub forget_on_exit: bool,
}

/// `^[A-Za-z0-9.]{1,64}$`: the shape of a GitHub OAuth App client ID.
pub fn client_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
}

/// The first valid of: the setting, the build's `LABNOTEO_GITHUB_CLIENT_ID`,
/// the constant. `None` when none is valid (the constant stays empty until
/// the maintainer registers the OAuth App).
fn client_id_from(setting: Option<&str>, env: Option<&str>, default: &str) -> Option<String> {
    [setting, env, Some(default)]
        .into_iter()
        .flatten()
        .find(|id| client_id_ok(id))
        .map(str::to_string)
}

/// The client ID the device flow uses (see `client_id_from`).
pub fn github_client_id(app: &GithubAppSettings) -> Option<String> {
    client_id_from(app.client_id.as_deref(), option_env!("LABNOTEO_GITHUB_CLIENT_ID"), DEFAULT_GITHUB_CLIENT_ID)
}

/// Whether the build carries a client ID of its own (`LABNOTEO_GITHUB_CLIENT_ID`
/// or the constant), so that leaving the setting empty can still sign in.
fn builtin_client_id_available() -> bool {
    client_id_from(None, option_env!("LABNOTEO_GITHUB_CLIENT_ID"), DEFAULT_GITHUB_CLIENT_ID).is_some()
}

/// What the webview learns: the stored client ID (not secret), whether the
/// built-in default is in use instead, whether such a default exists at all
/// (so the field does not claim one that is missing), and the forget-on-exit flag.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubAppSettingsView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    pub client_id_default: bool,
    pub builtin_available: bool,
    pub forget_on_exit: bool,
}

fn view_of(app: &GithubAppSettings) -> GithubAppSettingsView {
    let own = app.client_id.as_deref().filter(|id| client_id_ok(id));
    GithubAppSettingsView {
        client_id: own.map(str::to_string),
        client_id_default: own.is_none(),
        builtin_available: builtin_client_id_available(),
        forget_on_exit: app.forget_on_exit,
    }
}

/// `Some(None)` for an explicit `null`, `None` when the field is absent.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

/// A change to the app-wide settings. `clientId: null` or `""` goes back to
/// the built-in default. Unknown fields are refused.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GithubAppSettingsPatch {
    #[serde(default, deserialize_with = "present")]
    pub client_id: Option<Option<String>>,
    #[serde(default)]
    pub forget_on_exit: Option<bool>,
}

/// Forgets the stored sign-in: both keychain slots and the account record.
/// `GithubState::sign_out` adds the in-memory token of `forgetOnExit`.
pub(crate) fn sign_out_stored(dirs: &Path, store: &dyn SecretStore) -> Result<(), NetError> {
    // The GitHub slots have a fixed origin: the vault's config plays no part.
    let cfg = ServiceConfig::from_settings_json("{}");
    clear_secret(store, Slot::Github, &cfg)?;
    clear_secret(store, Slot::GithubRefresh, &cfg)?;
    remove_doc(dirs, None, GithubDoc::Account)
}

/// The startup sweep of "sign out when the app closes": with `forgetOnExit`
/// on, no sign-in survives a start. The exit hook already zeroized the memory
/// token and forgot the account record; this also covers a crash, and a
/// token a connection import stored in the keychain just before a crash
/// (it moves into memory only after the keychain write). Best effort: a
/// failure is not a reason to stop the app from starting.
pub fn sweep_forgotten_sign_in(dirs: &Path, store: &dyn SecretStore) {
    let app: GithubAppSettings = read_doc(dirs, None, GithubDoc::App).unwrap_or_default();
    if app.forget_on_exit {
        let _ = sign_out_stored(dirs, store);
    }
}

pub fn app_settings_get_at(dirs: &Path) -> Result<GithubAppSettingsView, NetError> {
    Ok(view_of(&read_doc(dirs, None, GithubDoc::App)?))
}

/// Applies `patch`. A client ID that changes the one the device flow uses
/// signs out first, since a token belongs to the OAuth App that issued it.
/// A refused patch changes nothing.
pub fn app_settings_set_at(
    dirs: &Path,
    store: &dyn SecretStore,
    github: &GithubState,
    patch: GithubAppSettingsPatch,
) -> Result<GithubAppSettingsView, NetError> {
    let mut app: GithubAppSettings = read_doc(dirs, None, GithubDoc::App)?;
    let before = github_client_id(&app);
    let forgot_before = app.forget_on_exit;
    if let Some(id) = patch.client_id {
        let id = id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if id.as_deref().is_some_and(|s| !client_id_ok(s)) {
            return Err(NetError::new(
                NetErrorKind::BadInput,
                "the client ID may hold only letters, digits and dots (at most 64)",
            ));
        }
        app.client_id = id;
    }
    if let Some(flag) = patch.forget_on_exit {
        app.forget_on_exit = flag;
    }
    if github_client_id(&app) != before {
        github.sign_out(dirs, store)?;
    }
    // Turning "sign out when the app closes" on while signed in moves the
    // keychain token into memory (the keychain entries are deleted). Turning
    // it off keeps a memory token in memory until the next sign-in.
    if app.forget_on_exit && !forgot_before {
        github.move_to_memory(store)?;
    }
    write_doc(dirs, None, GithubDoc::App, &app)?;
    Ok(view_of(&app))
}

/// App-wide: needs no open vault, and never reaches the network.
#[tauri::command]
pub fn github_app_settings_get(dirs: State<'_, IntegrationDirs>) -> Result<GithubAppSettingsView, NetError> {
    app_settings_get_at(&dirs.0)
}

/// App-wide: needs no open vault, and never reaches the network.
#[tauri::command]
pub fn github_app_settings_set(
    dirs: State<'_, IntegrationDirs>,
    secrets: State<'_, Secrets>,
    github: State<'_, GithubState>,
    patch: GithubAppSettingsPatch,
) -> Result<GithubAppSettingsView, NetError> {
    app_settings_set_at(&dirs.0, secrets.0.as_ref(), &github, patch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::config::tests::scratch_dir;
    use crate::net::secrets::{status_of, store_secret, MemoryStore};
    use crate::net::store::StateName;
    use crate::vault::settings::vault_key;

    const FAKE: &str = "ghp_FAKE0000000000000000000000000000000000";

    fn patch(json: &str) -> GithubAppSettingsPatch {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn doc_paths() {
        let dirs = Path::new("C:/data/integrations");
        let root = Path::new("D:/실험 노트");
        let gh = dirs.join("github");
        assert_eq!(GithubDoc::App.path(dirs, None).unwrap(), gh.join("app.json"));
        assert_eq!(GithubDoc::Account.path(dirs, Some(root)).unwrap(), gh.join("account.json"));
        let per = gh.join(vault_key(root));
        assert_eq!(GithubDoc::Links.path(dirs, Some(root)).unwrap(), per.join("links.json"));
        assert_eq!(GithubDoc::StatusCache.path(dirs, Some(root)).unwrap(), per.join("status-cache.json"));
        assert_eq!(GithubDoc::Links.path(dirs, None).unwrap_err().kind, NetErrorKind::NotConfigured);
    }

    #[test]
    fn state_name_has_no_github_variant() {
        for name in ["githubLinks", "githubApp", "githubAccount", "githubStatusCache", "github", "links", "app"] {
            assert!(serde_json::from_str::<StateName>(&format!("\"{name}\"")).is_err(), "{name}");
        }
    }

    #[test]
    fn read_and_write_docs() {
        let dir = scratch_dir("gh-docs");
        let app: GithubAppSettings = read_doc(&dir, None, GithubDoc::App).unwrap();
        assert_eq!(app, GithubAppSettings::default());
        let set = GithubAppSettings { client_id: Some("Iv1.abc".into()), forget_on_exit: true };
        write_doc(&dir, None, GithubDoc::App, &set).unwrap();
        assert_eq!(read_doc::<GithubAppSettings>(&dir, None, GithubDoc::App).unwrap(), set);
        let text = std::fs::read_to_string(dir.join("github").join("app.json")).unwrap();
        assert!(text.contains("\"clientId\"") && text.contains("\"forgetOnExit\""), "{text}");
        std::fs::write(dir.join("github").join("app.json"), "{oops").unwrap();
        assert!(read_doc::<GithubAppSettings>(&dir, None, GithubDoc::App).is_err());
        remove_doc(&dir, None, GithubDoc::App).unwrap();
        remove_doc(&dir, None, GithubDoc::App).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn client_id_order() {
        assert_eq!(client_id_from(Some("Iv1.own"), Some("Ov23env"), "const").as_deref(), Some("Iv1.own"));
        // An invalid setting falls back to the build's default, then the constant.
        assert_eq!(client_id_from(Some("bad id!"), Some("Ov23env"), "const").as_deref(), Some("Ov23env"));
        assert_eq!(client_id_from(Some(""), None, "const1").as_deref(), Some("const1"));
        assert_eq!(client_id_from(Some(&"a".repeat(65)), None, "c").as_deref(), Some("c"));
        // Empty everywhere is no client ID at all.
        assert_eq!(client_id_from(None, None, ""), None);
        assert_eq!(client_id_from(Some(""), Some(""), ""), None);
        let app = GithubAppSettings { client_id: Some("Iv1.mine".into()), forget_on_exit: false };
        assert_eq!(github_client_id(&app).as_deref(), Some("Iv1.mine"));
        let fallback = github_client_id(&GithubAppSettings { client_id: Some("no way".into()), forget_on_exit: false });
        assert_eq!(fallback, github_client_id(&GithubAppSettings::default()));
    }

    #[test]
    fn settings_view_and_patch() {
        let dir = scratch_dir("gh-app");
        let store = MemoryStore::default();
        let gh = GithubState::default();
        let v = app_settings_get_at(&dir).unwrap();
        let builtin = builtin_client_id_available();
        assert_eq!(
            serde_json::to_value(&v).unwrap(),
            serde_json::json!({"clientIdDefault": true, "builtinAvailable": builtin, "forgetOnExit": false})
        );
        let v = app_settings_set_at(&dir, &store, &gh, patch(r#"{"forgetOnExit":true}"#)).unwrap();
        assert!(v.forget_on_exit && v.client_id_default);
        let v = app_settings_set_at(&dir, &store, &gh, patch(r#"{"clientId":" Iv1.lab "}"#)).unwrap();
        assert_eq!(
            serde_json::to_value(&v).unwrap(),
            serde_json::json!({"clientId": "Iv1.lab", "clientIdDefault": false, "builtinAvailable": builtin, "forgetOnExit": true})
        );
        assert_eq!(app_settings_get_at(&dir).unwrap(), v);
        assert_eq!(
            app_settings_set_at(&dir, &store, &gh, patch(r#"{"clientId":"bad/id"}"#)).unwrap_err().kind,
            NetErrorKind::BadInput
        );
        assert_eq!(app_settings_get_at(&dir).unwrap(), v, "a refused patch changes nothing");
        let v = app_settings_set_at(&dir, &store, &gh, patch(r#"{"clientId":null}"#)).unwrap();
        assert!(v.client_id.is_none() && v.client_id_default && v.forget_on_exit);
        assert!(serde_json::from_str::<GithubAppSettingsPatch>(r#"{"token":"x"}"#).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_different_client_id_signs_out() {
        let dir = scratch_dir("gh-signout");
        let store = MemoryStore::default();
        let gh = GithubState::default();
        let cfg = ServiceConfig::from_settings_json("{}");
        store_secret(&store, Slot::Github, &cfg, FAKE).unwrap();
        store_secret(&store, Slot::GithubRefresh, &cfg, "ghr_FAKE").unwrap();
        write_doc(&dir, None, GithubDoc::Account, &serde_json::json!({"login": "me", "id": 1})).unwrap();
        // Same effective client ID (forget flag only): still signed in.
        app_settings_set_at(&dir, &store, &gh, patch(r#"{"forgetOnExit":false}"#)).unwrap();
        assert!(status_of(&store, &cfg).set.github);
        // A new client ID: both slots and the account record are gone.
        app_settings_set_at(&dir, &store, &gh, patch(r#"{"clientId":"Iv1.other"}"#)).unwrap();
        let st = status_of(&store, &cfg);
        assert!(!st.set.github && !st.set.github_refresh);
        assert!(!dir.join("github").join("account.json").exists());
        // Nothing in the app data holds a token.
        let text = std::fs::read_to_string(dir.join("github").join("app.json")).unwrap();
        assert!(!text.contains("ghp_") && !text.contains("ghr_"));
        // Setting the same client ID again does not sign out.
        store_secret(&store, Slot::Github, &cfg, FAKE).unwrap();
        app_settings_set_at(&dir, &store, &gh, patch(r#"{"clientId":"Iv1.other"}"#)).unwrap();
        assert!(status_of(&store, &cfg).set.github);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_startup_sweep_clears_a_sign_in_only_with_forget_on_exit() {
        let dir = scratch_dir("gh-sweep");
        let store = MemoryStore::default();
        let cfg = ServiceConfig::from_settings_json("{}");
        let stored = |store: &MemoryStore| {
            store_secret(store, Slot::Github, &cfg, FAKE).unwrap();
            store_secret(store, Slot::GithubRefresh, &cfg, "ghr_FAKE").unwrap();
            write_doc(&dir, None, GithubDoc::Account, &serde_json::json!({"login": "me", "id": 1})).unwrap();
        };
        // Off (and no app.json at all): the sign-in stays.
        stored(&store);
        sweep_forgotten_sign_in(&dir, &store);
        assert!(status_of(&store, &cfg).set.github);
        assert!(dir.join("github").join("account.json").exists());
        // On: a token left in the keychain by a crash (say, right after a
        // connection import stored it) and the account record are gone.
        write_doc(&dir, None, GithubDoc::App, &GithubAppSettings { client_id: None, forget_on_exit: true }).unwrap();
        sweep_forgotten_sign_in(&dir, &store);
        let st = status_of(&store, &cfg);
        assert!(!st.set.github && !st.set.github_refresh);
        assert!(!dir.join("github").join("account.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
