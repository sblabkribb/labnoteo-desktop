//! Fixture helpers for the real-app check against a fake GitHub (plan
//! Task 16). They build the empty bare repository the fake server copies on a
//! create call, and the "a labmate changed it on GitHub" commit, with libgit2,
//! so the check needs no installed Git.
//!
//! The two `#[ignore]` tests are the command-line entry points:
//!
//! ```text
//! LABNOTEO_FIXTURE_REPO=<dir> cargo test --features github-test-endpoints -- --ignored make_empty_bare
//! LABNOTEO_FIXTURE_REPO=<dir> LABNOTEO_FIXTURE_FILE=<path> LABNOTEO_FIXTURE_TEXT=<text> \
//!     cargo test --features github-test-endpoints -- --ignored advance_remote
//! ```
//!
//! Test-only code: nothing here is compiled into the app.

use git2::{Oid, Repository};
use std::path::Path;

/// The repo path the ignored entry points act on.
pub const REPO_ENV: &str = "LABNOTEO_FIXTURE_REPO";
/// The repo-relative file `advance_remote` writes.
pub const FILE_ENV: &str = "LABNOTEO_FIXTURE_FILE";
/// The text `advance_remote` writes into that file.
pub const TEXT_ENV: &str = "LABNOTEO_FIXTURE_TEXT";

/// A new empty bare repository at `path` whose HEAD names `main`, like a
/// repository GitHub just created without a README.
pub fn make_empty_bare_at(path: &Path) -> Result<Repository, git2::Error> {
    let mut opts = git2::RepositoryInitOptions::new();
    opts.bare(true).initial_head("main").mkpath(true);
    Repository::init_opts(path, &opts)
}

/// One commit on `refs/heads/main` of the bare repo at `path` that writes
/// `file` with `text` (as a labmate's push would). Answers the new tip.
pub fn advance_remote_at(path: &Path, file: &str, text: &str) -> Result<Oid, git2::Error> {
    let repo = Repository::open_bare(path)?;
    let parent = match repo.refname_to_id("refs/heads/main") {
        Ok(id) => Some(repo.find_commit(id)?),
        Err(_) => None,
    };
    let base = match &parent {
        Some(c) => c.tree()?,
        None => repo.find_tree(repo.treebuilder(None)?.write()?)?,
    };
    let blob = repo.blob(text.as_bytes())?;
    let mut b = git2::build::TreeUpdateBuilder::new();
    b.upsert(file, blob, git2::FileMode::Blob);
    let tree = repo.find_tree(b.create_updated(&repo, &base)?)?;
    let sig = git2::Signature::now("labmate", "labmate@example.com")?;
    let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
    repo.commit(Some("refs/heads/main"), &sig, &sig, "edited on GitHub", &tree, &parents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::config::tests::scratch_dir;
    use std::fs;

    #[test]
    fn an_empty_bare_has_main_as_head_and_no_commits() {
        let base = scratch_dir("gh-fixture-bare");
        let path = base.join("kim-lab").join("실험.git");
        let repo = make_empty_bare_at(&path).unwrap();
        assert!(repo.is_bare());
        assert!(repo.head().is_err(), "HEAD is unborn");
        assert_eq!(repo.references().unwrap().count(), 0);
        assert_eq!(repo.find_reference("HEAD").unwrap().symbolic_target().unwrap(), Some("refs/heads/main"));
        drop(repo);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn advance_remote_commits_on_main_and_keeps_history() {
        let base = scratch_dir("gh-fixture-adv");
        let path = base.join("r.git");
        make_empty_bare_at(&path).unwrap();
        let first = advance_remote_at(&path, "notes/a.md", "one\n").unwrap();
        let second = advance_remote_at(&path, "b.txt", "랩메이트\n").unwrap();
        {
            let repo = Repository::open_bare(&path).unwrap();
            let tip = repo.find_commit(repo.refname_to_id("refs/heads/main").unwrap()).unwrap();
            assert_eq!(tip.id(), second);
            assert_eq!(tip.parent_id(0).unwrap(), first);
            let tree = tip.tree().unwrap();
            let blob = |p: &str| repo.find_blob(tree.get_path(Path::new(p)).unwrap().id()).unwrap().content().to_vec();
            assert_eq!(blob("notes/a.md"), b"one\n");
            assert_eq!(blob("b.txt"), "랩메이트\n".as_bytes());
        }
        let _ = fs::remove_dir_all(&base);
    }

    fn env_path() -> std::path::PathBuf {
        std::env::var_os(REPO_ENV).map(Into::into).unwrap_or_else(|| panic!("set {REPO_ENV}"))
    }

    /// Entry point: `LABNOTEO_FIXTURE_REPO=<dir> cargo test … -- --ignored make_empty_bare`.
    #[test]
    #[ignore = "fixture tool for the Task 16 real-app check"]
    fn make_empty_bare() {
        let path = env_path();
        make_empty_bare_at(&path).unwrap();
        println!("empty bare repo at {}", path.display());
    }

    /// Entry point: `LABNOTEO_FIXTURE_REPO=… LABNOTEO_FIXTURE_FILE=… LABNOTEO_FIXTURE_TEXT=… cargo test … -- --ignored advance_remote`.
    #[test]
    #[ignore = "fixture tool for the Task 16 real-app check"]
    fn advance_remote() {
        let path = env_path();
        let file = std::env::var(FILE_ENV).unwrap_or_else(|_| "edited-on-github.txt".into());
        let text = std::env::var(TEXT_ENV).unwrap_or_else(|_| "changed on GitHub\n".into());
        let tip = advance_remote_at(&path, &file, &text).unwrap();
        println!("main is now {tip}");
    }
}
