//! The upload journal (spec §8.4): the `state` of a link record, saved
//! (temp file + rename) **before** each side effect runs, so an interrupted
//! upload can be finished without creating a second repository.
//!
//! `planned → repoCreating → repoReady → committed → pushed`
//!
//! Records are found by `linkId`, not by folder: a folder renamed while an
//! upload runs is re-keyed by the rename hook, and the journal follows.

use std::path::Path;

use super::links::{update_links, LinkRecord, LinkState};
use crate::net::{NetError, NetErrorKind};

/// Unix milliseconds now.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn gone() -> NetError {
    NetError::new(NetErrorKind::BadInput, "the folder's GitHub link is gone")
}

/// `repoCreating`: records the new link before the create request is sent
/// (`requestedAt`, `sentDescription`). Refused when the folder already has a
/// link, so a folder never gets a second repository by accident, and when the
/// folder is no longer there: the vault renames a folder on disk before the
/// rename hook re-keys the links under the same write lock, so a record is
/// never written under a name the folder has just left.
pub(crate) fn begin_create(dirs: &Path, root: &Path, folder: &str, record: LinkRecord) -> Result<(), NetError> {
    debug_assert_eq!(record.state, LinkState::RepoCreating);
    insert_new(dirs, root, folder, record)
}

/// `repoReady` for an existing repository the user linked (nothing is
/// created), with the same refusals as `begin_create`.
pub(crate) fn begin_link(dirs: &Path, root: &Path, folder: &str, record: LinkRecord) -> Result<(), NetError> {
    debug_assert_eq!(record.state, LinkState::RepoReady);
    insert_new(dirs, root, folder, record)
}

fn insert_new(dirs: &Path, root: &Path, folder: &str, record: LinkRecord) -> Result<(), NetError> {
    update_links(dirs, root, |doc| {
        if doc.links.contains_key(folder) {
            return Err(NetError::new(NetErrorKind::BadInput, "this folder is already linked to a repository"));
        }
        if !crate::vault::path::confine(root, folder).is_ok_and(|p| p.is_dir()) {
            return Err(NetError::new(NetErrorKind::BadInput, "the folder was moved or renamed; prepare the upload again"));
        }
        doc.links.insert(folder.to_string(), record);
        Ok(())
    })
}

/// Changes the record of `link_id` (wherever its folder now is).
pub(crate) fn advance(dirs: &Path, root: &Path, link_id: &str, f: impl FnOnce(&mut LinkRecord)) -> Result<(), NetError> {
    update_links(dirs, root, |doc| {
        let rec = doc.links.values_mut().find(|r| r.link_id == link_id).ok_or_else(gone)?;
        f(rec);
        Ok(())
    })
}

/// The create request was answered with a refusal, so nothing was created:
/// the `repoCreating` record goes away and the folder is unlinked again.
/// A record in any other state is kept.
pub(crate) fn abandon(dirs: &Path, root: &Path, link_id: &str) -> Result<(), NetError> {
    update_links(dirs, root, |doc| {
        doc.links.retain(|_, r| !(r.link_id == link_id && r.state == LinkState::RepoCreating));
        Ok(())
    })
}

/// The folder (link key) of `link_id`, if the link still exists.
pub(crate) fn folder_of(dirs: &Path, root: &Path, link_id: &str) -> Option<String> {
    let doc = super::links::read_links(dirs, root).ok()?;
    doc.links.into_iter().find(|(_, r)| r.link_id == link_id).map(|(k, _)| k)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitsync::links::read_links;
    use crate::net::config::tests::scratch_dir;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn states_follow_the_link_and_a_refusal_unlinks() {
        let dirs = scratch_dir("gh-journal");
        let root = dirs.join("vault");
        let rec = LinkRecord {
            link_id: ID.into(),
            owner: "kim-lab".into(),
            name: "exp".into(),
            state: LinkState::RepoCreating,
            requested_at: Some(now_ms()),
            sent_description: Some("단백질 · labnoteO".into()),
            ..LinkRecord::default()
        };
        // A folder that is not (or no longer) there gets no record.
        assert_eq!(begin_create(&dirs, &root, "labnote/001_a", rec.clone()).unwrap_err().kind, NetErrorKind::BadInput);
        assert!(read_links(&dirs, &root).unwrap().links.is_empty());
        std::fs::create_dir_all(root.join("labnote").join("001_a")).unwrap();
        begin_create(&dirs, &root, "labnote/001_a", rec.clone()).unwrap();
        // A second create for the same folder is refused.
        assert_eq!(begin_create(&dirs, &root, "labnote/001_a", rec.clone()).unwrap_err().kind, NetErrorKind::BadInput);
        crate::gitsync::links::on_rename(&dirs, &root, "labnote/001_a", "labnote/001_b").unwrap();
        advance(&dirs, &root, ID, |r| r.state = LinkState::RepoReady).unwrap();
        assert_eq!(read_links(&dirs, &root).unwrap().links["labnote/001_b"].state, LinkState::RepoReady);
        assert_eq!(folder_of(&dirs, &root, ID).as_deref(), Some("labnote/001_b"));
        // Past repoCreating, abandon keeps the record.
        abandon(&dirs, &root, ID).unwrap();
        assert!(read_links(&dirs, &root).unwrap().links.contains_key("labnote/001_b"));
        advance(&dirs, &root, ID, |r| r.state = LinkState::RepoCreating).unwrap();
        abandon(&dirs, &root, ID).unwrap();
        assert!(read_links(&dirs, &root).unwrap().links.is_empty());
        assert!(advance(&dirs, &root, ID, |_| {}).is_err());
        let _ = std::fs::remove_dir_all(&dirs);
    }
}
