//! The tool lists of connected MCP servers (spec §4.5), kept by Rust in
//! `integrations/mcp-client/<vaultKey>/tools.json` (app data, never the
//! vault), so the settings page and the agent can show the tools without
//! reconnecting at every start.
//!
//! The file is Rust-owned: it is **not** a `StateName`, so the webview can
//! read it (through `mcp_client_tools_cached`) but never write it. The tool
//! annotations in it decide which calls need a confirmation, and
//! `mcp_client_call` refuses a tool that is not in it.
//!
//! Each entry is keyed by server id and remembers the origin it was fetched
//! from; an entry whose origin no longer matches the server's URL is ignored.
//! Nothing secret is stored: no token, no session id, no instructions text.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::McpServerInfo;
use crate::net::store::vault_dir;
use crate::net::{NetError, NetErrorKind};

const SERVICE: &str = "mcp-client";
const FILE: &str = "tools.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Entry {
    origin: String,
    info: McpServerInfo,
}

fn path(dirs: &Path, root: &Path) -> PathBuf {
    vault_dir(dirs, SERVICE, root).join(FILE)
}

/// Every stored entry; a missing or damaged file is empty.
fn read_all(dirs: &Path, root: &Path) -> BTreeMap<String, Entry> {
    std::fs::read_to_string(path(dirs, root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_all(dirs: &Path, root: &Path, all: &BTreeMap<String, Entry>) -> Result<(), NetError> {
    let text = serde_json::to_string(all).map_err(|_| NetError::new(NetErrorKind::Io, "app data write failed"))?;
    crate::vault::fs::write_atomic(&path(dirs, root), &text)
        .map_err(|e| NetError::new(NetErrorKind::Io, format!("app data write failed: {e:?}")))
}

/// The cached tool list of server `id`, if it was fetched from `origin`.
pub fn get(dirs: &Path, root: &Path, id: &str, origin: &str) -> Option<McpServerInfo> {
    read_all(dirs, root).remove(id).filter(|e| e.origin == origin).map(|e| e.info)
}

/// Stores (or replaces) server `id`'s tool list, fetched from `origin`.
pub fn put(dirs: &Path, root: &Path, id: &str, origin: &str, info: &McpServerInfo) -> Result<(), NetError> {
    let mut all = read_all(dirs, root);
    all.insert(id.to_string(), Entry { origin: origin.to_string(), info: info.clone() });
    write_all(dirs, root, &all)
}

/// Drops server `id`'s entry (nothing to drop is fine).
pub fn remove(dirs: &Path, root: &Path, id: &str) -> Result<(), NetError> {
    let mut all = read_all(dirs, root);
    if all.remove(id).is_some() {
        write_all(dirs, root, &all)?;
    }
    Ok(())
}

/// The entries whose origin still matches the server's URL, by server id.
/// `current` maps each configured server id to its origin.
pub fn current(dirs: &Path, root: &Path, current: &BTreeMap<String, String>) -> BTreeMap<String, McpServerInfo> {
    read_all(dirs, root)
        .into_iter()
        .filter(|(id, e)| current.get(id) == Some(&e.origin))
        .map(|(id, e)| (id, e.info))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::config::tests::scratch_dir;

    fn info(name: &str) -> McpServerInfo {
        McpServerInfo {
            name: name.into(),
            title: None,
            version: "1".into(),
            protocol_version: "2025-06-18".into(),
            has_instructions: false,
            tools: vec![],
            truncated: false,
        }
    }

    #[test]
    fn entries_are_kept_per_vault_and_origin() {
        let dir = scratch_dir("mcp-cache");
        let (a, b) = (dir.join("a"), dir.join("b"));
        let dirs = dir.join("data");
        assert_eq!(get(&dirs, &a, "0a1b2c3d", "https://x.example"), None);
        put(&dirs, &a, "0a1b2c3d", "https://x.example", &info("X")).unwrap();
        assert_eq!(get(&dirs, &a, "0a1b2c3d", "https://x.example"), Some(info("X")));
        assert_eq!(get(&dirs, &a, "0a1b2c3d", "https://y.example"), None, "another origin");
        assert_eq!(get(&dirs, &b, "0a1b2c3d", "https://x.example"), None, "another vault");
        let cur: BTreeMap<String, String> = [("0a1b2c3d".to_string(), "https://x.example".to_string())].into();
        assert_eq!(current(&dirs, &a, &cur).len(), 1);
        let moved: BTreeMap<String, String> = [("0a1b2c3d".to_string(), "https://y.example".to_string())].into();
        assert!(current(&dirs, &a, &moved).is_empty());
        remove(&dirs, &a, "0a1b2c3d").unwrap();
        assert_eq!(get(&dirs, &a, "0a1b2c3d", "https://x.example"), None);
        remove(&dirs, &a, "0a1b2c3d").unwrap();
        // A damaged file reads as empty.
        std::fs::write(path(&dirs, &a), "not json").unwrap();
        assert!(current(&dirs, &a, &cur).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
