//! App-data stores for the integrations (D13): offline PartBank catalogs and
//! small per-vault integration state documents. They live under the managed
//! `IntegrationDirs` (`app_local_data_dir/integrations`), never in the vault:
//!
//! - `partbank/<vaultKey>/{Type}_partbank-{desktop|web}.json`
//! - `partbank/<vaultKey>/usage-state.json`
//! - `bfworkflow/<vaultKey>/catalog-cache.json`
//!
//! `vaultKey` is `vault::settings::vault_key(root)`. Every command needs an
//! open vault (`notConfigured` otherwise). Writes take a JSON object only and
//! go through a temp file and a rename, so a crash never leaves half a file.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::State;

use super::{NetError, NetErrorKind};
use crate::vault::settings::vault_key;
use crate::vault::VaultState;

/// The integrations folder in the app's local data dir (managed once).
pub struct IntegrationDirs(pub PathBuf);

/// The integration state documents the webview may read and write.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StateName {
    /// PartBank note-usage sync: `{clientId, sent, dirty, backfill}`.
    PartbankUsage,
    /// bfworkflow catalog cache: `{origin, fetchedAt, hash, workflows, hw, sw}`.
    BfwCatalogCache,
    /// Shared scan folder's 90-day history: `{"<name>|<size>|<mtimeMs>": <seenAtMs>}`.
    ScanFolderHistory,
    /// Slack inbox link: `{enabled, mode, channelId, linkCode, userId, lastTs, claimedTs}` (never the token).
    SlackLink,
}

impl StateName {
    fn location(self) -> (&'static str, &'static str) {
        match self {
            StateName::PartbankUsage => ("partbank", "usage-state.json"),
            StateName::BfwCatalogCache => ("bfworkflow", "catalog-cache.json"),
            StateName::ScanFolderHistory => ("scan", "history.json"),
            StateName::SlackLink => ("scan", "slack-link.json"),
        }
    }
}

const PARTBANK: &str = "partbank";
const CATALOG_SUFFIXES: [&str; 2] = ["_partbank-desktop.json", "_partbank-web.json"];
const FORBIDDEN: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// `^[^/\:*?"<>|.][^/\:*?"<>|]{0,63}_partbank-(desktop|web)\.json$`
pub fn catalog_name_ok(name: &str) -> bool {
    let Some(stem) = CATALOG_SUFFIXES.iter().find_map(|s| name.strip_suffix(s)) else {
        return false;
    };
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) if first != '.' && !FORBIDDEN.contains(&first) => {}
        _ => return false,
    }
    let mut rest = 0usize;
    for c in chars {
        if FORBIDDEN.contains(&c) {
            return false;
        }
        rest += 1;
    }
    rest <= 63
}

/// `dirs/<service>/<vault_key(root)>`.
pub fn vault_dir(dirs: &Path, service: &str, root: &Path) -> PathBuf {
    dirs.join(service).join(vault_key(root))
}

/// A local disk failure. No kind fits exactly (D10 pins the set, and every
/// kind names a network or input condition), so it is `badInput` with a
/// message that says it was the app data; it never carries vault content.
fn disk(what: &str, e: impl std::fmt::Display) -> NetError {
    NetError::new(NetErrorKind::BadInput, format!("app data {what} failed: {e}"))
}

fn bad_name() -> NetError {
    NetError::new(NetErrorKind::BadInput, "not a partbank catalog name")
}

fn read_opt(path: &Path) -> Result<Option<String>, NetError> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(disk("read", e)),
    }
}

/// Writes `content` (a JSON object, else `badInput` and nothing is written)
/// through a sibling temp file and a rename.
fn write_object(path: &Path, content: &str) -> Result<(), NetError> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(v) if v.is_object() => {}
        _ => return Err(NetError::new(NetErrorKind::BadInput, "content must be a JSON object")),
    }
    crate::vault::fs::write_atomic(path, content).map_err(|e| disk("write", format!("{e:?}")))
}

/// The catalog file names stored for `root`, sorted. No folder yet is empty.
pub fn catalog_list_at(dirs: &Path, root: &Path) -> Result<Vec<String>, NetError> {
    let entries = match std::fs::read_dir(vault_dir(dirs, PARTBANK, root)) {
        Ok(it) => it,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(disk("list", e)),
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| catalog_name_ok(n))
        .collect();
    names.sort();
    Ok(names)
}

pub fn catalog_read_at(dirs: &Path, root: &Path, name: &str) -> Result<Option<String>, NetError> {
    if !catalog_name_ok(name) {
        return Err(bad_name());
    }
    read_opt(&vault_dir(dirs, PARTBANK, root).join(name))
}

pub fn catalog_write_at(dirs: &Path, root: &Path, name: &str, content: &str) -> Result<(), NetError> {
    if !catalog_name_ok(name) {
        return Err(bad_name());
    }
    write_object(&vault_dir(dirs, PARTBANK, root).join(name), content)
}

pub fn state_read_at(dirs: &Path, root: &Path, name: StateName) -> Result<Option<String>, NetError> {
    let (service, file) = name.location();
    read_opt(&vault_dir(dirs, service, root).join(file))
}

pub fn state_write_at(dirs: &Path, root: &Path, name: StateName, content: &str) -> Result<(), NetError> {
    let (service, file) = name.location();
    write_object(&vault_dir(dirs, service, root).join(file), content)
}

/// The integrations folder and the open vault's root, or `notConfigured`.
fn paths(vault: &VaultState, dirs: &IntegrationDirs) -> Result<(PathBuf, PathBuf), NetError> {
    let root = vault
        .root()
        .map_err(|_| NetError::new(NetErrorKind::NotConfigured, "no vault is open"))?;
    Ok((dirs.0.clone(), root))
}

/// Catalogs can be megabytes: run the disk work off the async runtime.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, NetError> + Send + 'static) -> Result<T, NetError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| disk("task", e))?
}

#[tauri::command]
pub async fn partbank_catalog_list(
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
) -> Result<Vec<String>, NetError> {
    let (d, root) = paths(&vault, &dirs)?;
    blocking(move || catalog_list_at(&d, &root)).await
}

#[tauri::command]
pub async fn partbank_catalog_read(
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
    name: String,
) -> Result<Option<String>, NetError> {
    let (d, root) = paths(&vault, &dirs)?;
    blocking(move || catalog_read_at(&d, &root, &name)).await
}

#[tauri::command]
pub async fn partbank_catalog_write(
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
    name: String,
    content: String,
) -> Result<(), NetError> {
    let (d, root) = paths(&vault, &dirs)?;
    blocking(move || catalog_write_at(&d, &root, &name, &content)).await
}

#[tauri::command]
pub async fn integration_state_read(
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
    name: StateName,
) -> Result<Option<String>, NetError> {
    let (d, root) = paths(&vault, &dirs)?;
    blocking(move || state_read_at(&d, &root, name)).await
}

#[tauri::command]
pub async fn integration_state_write(
    vault: State<'_, VaultState>,
    dirs: State<'_, IntegrationDirs>,
    name: StateName,
    content: String,
) -> Result<(), NetError> {
    let (d, root) = paths(&vault, &dirs)?;
    blocking(move || state_write_at(&d, &root, name, &content)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::config::tests::scratch_dir;

    fn kind<T: std::fmt::Debug>(r: Result<T, NetError>) -> NetErrorKind {
        r.unwrap_err().kind
    }

    #[test]
    fn catalog_names() {
        assert!(catalog_name_ok("DNA_partbank-web.json"));
        assert!(catalog_name_ok("Strain_partbank-desktop.json"));
        assert!(catalog_name_ok("Cell line v1.2_partbank-web.json"));
        assert!(catalog_name_ok(&format!("{}_partbank-web.json", "a".repeat(64))));
        for n in [
            "../DNA_partbank-web.json",
            "DNA_partbank-cloud.json",
            "DNA.json",
            ".x_partbank-web.json",
            "a/b_partbank-web.json",
            "a\\b_partbank-web.json",
            "C:x_partbank-web.json",
            "_partbank-web.json",
            "usage-state.json",
            "DNA_partbank-web.JSON",
        ] {
            assert!(!catalog_name_ok(n), "{n}");
        }
        assert!(!catalog_name_ok(&format!("{}_partbank-web.json", "a".repeat(65))));
    }

    #[test]
    fn vault_dir_is_service_then_vault_key() {
        let root = Path::new("C:/Vaults/Lab");
        let d = vault_dir(Path::new("D:/data/integrations"), "partbank", root);
        assert_eq!(d, Path::new("D:/data/integrations").join("partbank").join(vault_key(root)));
    }

    #[test]
    fn catalogs_are_per_vault() {
        let dir = scratch_dir("store-cat");
        let dirs = dir.join("integrations");
        let (a, b) = (dir.join("vaultA"), dir.join("vaultB"));
        assert_eq!(catalog_list_at(&dirs, &a).unwrap(), Vec::<String>::new());
        assert_eq!(catalog_read_at(&dirs, &a, "DNA_partbank-web.json").unwrap(), None);
        catalog_write_at(&dirs, &a, "DNA_partbank-web.json", r#"{"items":[1]}"#).unwrap();
        assert_eq!(catalog_list_at(&dirs, &a).unwrap(), vec!["DNA_partbank-web.json".to_string()]);
        assert_eq!(catalog_read_at(&dirs, &a, "DNA_partbank-web.json").unwrap().as_deref(), Some(r#"{"items":[1]}"#));
        assert_eq!(catalog_list_at(&dirs, &b).unwrap(), Vec::<String>::new());
        assert_eq!(catalog_read_at(&dirs, &b, "DNA_partbank-web.json").unwrap(), None);
        // The file sits under partbank/<vaultKey>/, never in the vault.
        assert!(vault_dir(&dirs, "partbank", &a).join("DNA_partbank-web.json").is_file());
        assert!(!a.exists());
        // A second write replaces the first, and no temp file is left behind.
        catalog_write_at(&dirs, &a, "DNA_partbank-web.json", r#"{"items":[2]}"#).unwrap();
        assert_eq!(catalog_read_at(&dirs, &a, "DNA_partbank-web.json").unwrap().as_deref(), Some(r#"{"items":[2]}"#));
        assert_eq!(std::fs::read_dir(vault_dir(&dirs, "partbank", &a)).unwrap().count(), 1);
        // The usage state sits in the same folder but is not a catalog.
        state_write_at(&dirs, &a, StateName::PartbankUsage, "{}").unwrap();
        assert_eq!(catalog_list_at(&dirs, &a).unwrap(), vec!["DNA_partbank-web.json".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_catalog_names_are_refused() {
        let dir = scratch_dir("store-name");
        let dirs = dir.join("integrations");
        let root = dir.join("vault");
        assert_eq!(kind(catalog_read_at(&dirs, &root, "../x_partbank-web.json")), NetErrorKind::BadInput);
        assert_eq!(kind(catalog_write_at(&dirs, &root, "../x_partbank-web.json", "{}")), NetErrorKind::BadInput);
        assert_eq!(kind(catalog_write_at(&dirs, &root, "usage-state.json", "{}")), NetErrorKind::BadInput);
        assert!(!dirs.exists(), "nothing written");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_json_object_is_refused() {
        let dir = scratch_dir("store-json");
        let dirs = dir.join("integrations");
        let root = dir.join("vault");
        for bad in ["[]", "x", "", "1", "\"s\"", "null", "{"] {
            assert_eq!(kind(catalog_write_at(&dirs, &root, "DNA_partbank-web.json", bad)), NetErrorKind::BadInput, "{bad:?}");
            assert_eq!(kind(state_write_at(&dirs, &root, StateName::BfwCatalogCache, bad)), NetErrorKind::BadInput, "{bad:?}");
        }
        assert!(!dirs.exists(), "nothing written");
        // A refused write leaves an earlier good file alone.
        catalog_write_at(&dirs, &root, "DNA_partbank-web.json", r#"{"a":1}"#).unwrap();
        assert!(catalog_write_at(&dirs, &root, "DNA_partbank-web.json", "[]").is_err());
        assert_eq!(catalog_read_at(&dirs, &root, "DNA_partbank-web.json").unwrap().as_deref(), Some(r#"{"a":1}"#));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn state_roundtrip() {
        let dir = scratch_dir("store-state");
        let dirs = dir.join("integrations");
        let (a, b) = (dir.join("vaultA"), dir.join("vaultB"));
        assert_eq!(state_read_at(&dirs, &a, StateName::PartbankUsage).unwrap(), None);
        state_write_at(&dirs, &a, StateName::PartbankUsage, r#"{"clientId":"c"}"#).unwrap();
        state_write_at(&dirs, &a, StateName::BfwCatalogCache, r#"{"origin":"https://w"}"#).unwrap();
        assert_eq!(state_read_at(&dirs, &a, StateName::PartbankUsage).unwrap().as_deref(), Some(r#"{"clientId":"c"}"#));
        assert_eq!(state_read_at(&dirs, &a, StateName::BfwCatalogCache).unwrap().as_deref(), Some(r#"{"origin":"https://w"}"#));
        assert_eq!(state_read_at(&dirs, &b, StateName::PartbankUsage).unwrap(), None);
        assert!(vault_dir(&dirs, "partbank", &a).join("usage-state.json").is_file());
        assert!(vault_dir(&dirs, "bfworkflow", &a).join("catalog-cache.json").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_state_names_roundtrip() {
        let dir = scratch_dir("store-scan-state");
        let dirs = dir.join("integrations");
        let (a, b) = (dir.join("vaultA"), dir.join("vaultB"));
        assert_eq!(state_read_at(&dirs, &a, StateName::ScanFolderHistory).unwrap(), None);
        assert_eq!(state_read_at(&dirs, &a, StateName::SlackLink).unwrap(), None);
        state_write_at(&dirs, &a, StateName::ScanFolderHistory, "{\"a|1|2\":3}").unwrap();
        state_write_at(&dirs, &a, StateName::SlackLink, r#"{"enabled":true}"#).unwrap();
        assert_eq!(state_read_at(&dirs, &a, StateName::ScanFolderHistory).unwrap().as_deref(), Some("{\"a|1|2\":3}"));
        assert_eq!(state_read_at(&dirs, &a, StateName::SlackLink).unwrap().as_deref(), Some(r#"{"enabled":true}"#));
        assert_eq!(state_read_at(&dirs, &b, StateName::ScanFolderHistory).unwrap(), None);
        assert_eq!(state_read_at(&dirs, &b, StateName::SlackLink).unwrap(), None);
        // Both sit next to the scan folder's folder.json, under scan/<vaultKey>/.
        assert!(vault_dir(&dirs, "scan", &a).join("history.json").is_file());
        assert!(vault_dir(&dirs, "scan", &a).join("slack-link.json").is_file());
        assert!(!a.exists());
        assert_eq!(serde_json::from_str::<StateName>(r#""scanFolderHistory""#).unwrap(), StateName::ScanFolderHistory);
        assert_eq!(serde_json::from_str::<StateName>(r#""slackLink""#).unwrap(), StateName::SlackLink);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn state_names_deserialize_in_camel_case() {
        assert_eq!(serde_json::from_str::<StateName>(r#""partbankUsage""#).unwrap(), StateName::PartbankUsage);
        assert_eq!(serde_json::from_str::<StateName>(r#""bfwCatalogCache""#).unwrap(), StateName::BfwCatalogCache);
        assert!(serde_json::from_str::<StateName>(r#""../x""#).is_err());
    }
}
