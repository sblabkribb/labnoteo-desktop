//! Folder links (spec §4 "What is remembered"): the Rust-only
//! `GithubDoc::Links` document of one vault, keyed by the experiment folder's
//! vault-relative POSIX path, plus the per-vault `defaultOwner`.
//!
//! The upload plan reads it (user exclusions, acknowledged scan hits, the
//! last pushed commit). Writing it, the lock and the rename hook come with the
//! upload task. It is never reachable through `integration_state_*`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::state::{read_doc, GithubDoc};
use crate::net::store::vault_dir;
use crate::net::NetError;

/// Where an upload stands (spec §8.4). Each state is saved before its side
/// effect runs.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LinkState {
    #[default]
    Planned,
    RepoCreating,
    RepoReady,
    Committed,
    Pushed,
}

/// A scan hit the user marked "키가 아닙니다": the file and the hash of the
/// line, so an edit of that line brings the hit back.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct AllowedHit {
    pub path: String,
    pub line_hash: String,
}

/// One folder's link to a repository.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct LinkRecord {
    /// 16 random bytes in hex: names the bare repo (`repos/<linkId>.git`).
    pub link_id: String,
    pub repo_id: u64,
    pub owner: String,
    pub name: String,
    pub html_url: String,
    pub branch: String,
    pub private: bool,
    pub state: LinkState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_pushed_commit: Option<String>,
    /// Unix milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_pushed_at: Option<u64>,
    /// Folder-relative paths the user unticked (or that were too large).
    pub excluded: Vec<String>,
    pub allowed_hits: Vec<AllowedHit>,
    /// Unix milliseconds of the create request (journal `repoCreating`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_description: Option<String>,
}

/// The whole `GithubDoc::Links` document of one vault.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct LinksDoc {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_owner: Option<String>,
    /// Folder (vault-relative POSIX) → link.
    pub links: BTreeMap<String, LinkRecord>,
}

/// `^[0-9a-f]{32}$`: the shape of a link id (and of a plan id).
pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Reads the vault's links (a missing file is no links).
pub(crate) fn read_links(dirs: &Path, root: &Path) -> Result<LinksDoc, NetError> {
    read_doc(dirs, Some(root), GithubDoc::Links)
}

/// The app-owned bare repository of a link (spec §8.1), outside the vault:
/// `<IntegrationDirs>/github/<vaultKey>/repos/<linkId>.git`. `None` for a
/// link id that is not 32 hex characters.
pub(crate) fn bare_repo_path(dirs: &Path, root: &Path, link_id: &str) -> Option<PathBuf> {
    valid_id(link_id).then(|| vault_dir(dirs, "github", root).join("repos").join(format!("{link_id}.git")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitsync::state::write_doc;
    use crate::net::config::tests::scratch_dir;

    #[test]
    fn links_round_trip_and_tolerate_missing_fields() {
        let dirs = scratch_dir("gh-links");
        let root = dirs.join("vault");
        assert_eq!(read_links(&dirs, &root).unwrap(), LinksDoc::default());
        let doc: LinksDoc = serde_json::from_value(serde_json::json!({
            "defaultOwner": "kim-lab",
            "links": {"labnote/001_a": {"linkId": "0123456789abcdef0123456789abcdef", "excluded": ["big.czi"],
                "allowedHits": [{"path": "a.md", "lineHash": "ab"}], "state": "pushed", "lastPushedCommit": "00"}}
        }))
        .unwrap();
        write_doc(&dirs, Some(&root), GithubDoc::Links, &doc).unwrap();
        let back = read_links(&dirs, &root).unwrap();
        assert_eq!(back, doc);
        let link = &back.links["labnote/001_a"];
        assert_eq!(link.state, LinkState::Pushed);
        assert_eq!(link.excluded, ["big.czi"]);
        let _ = std::fs::remove_dir_all(&dirs);
    }

    #[test]
    fn bare_repo_paths_need_a_hex_id() {
        let dirs = Path::new("C:/data/integrations");
        let root = Path::new("D:/vault");
        let p = bare_repo_path(dirs, root, "0123456789abcdef0123456789abcdef").unwrap();
        assert!(p.ends_with("repos/0123456789abcdef0123456789abcdef.git"));
        assert!(p.starts_with(vault_dir(dirs, "github", root)));
        for bad in ["", "../x", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde"] {
            assert!(bare_repo_path(dirs, root, bad).is_none(), "{bad}");
        }
    }
}
