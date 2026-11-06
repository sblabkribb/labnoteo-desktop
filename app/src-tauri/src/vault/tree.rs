//! The vault's note tree: every `.md` file under the vault, with the folders
//! that lead to it, as one flat depth-first list.

use std::path::Path;

use serde::Serialize;

use super::fs::FsError;
use super::path::{is_safe_component, VaultError};

/// One row of the tree. `path` is vault-relative with POSIX separators and is
/// spelled exactly as the walk read it from disk, so it is the key for the row
/// and is accepted as-is by every file command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub depth: u32,
}

/// Directories that are never vault content: `.obsidian`, `.git`,
/// `node_modules`, and every other dot-directory. The one definition of this
/// rule; the file watcher uses it too rather than restating it. Names compare
/// case-insensitively because NTFS does.
pub fn is_excluded(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case("node_modules")
}

/// Walk `root` (depth-first, folders before files, names case-insensitive).
///
/// Paths are built from the names the walk reads, never from `to_rel`, and
/// links (symlinks, junctions) are not followed: nothing outside the vault is
/// listed and a link cannot create a cycle. Entries whose names `confine` would
/// refuse (reserved device names, trailing dot or space) are left out so every
/// row offered can actually be opened. A subfolder that cannot be read is
/// skipped; only an unreadable root is an error. `.md` is matched
/// case-insensitively; folders are kept even when they hold no notes, so a
/// folder the user just made shows up.
pub fn walk(root: &Path) -> Result<Vec<TreeEntry>, FsError> {
    fn visit(dir: &Path, prefix: &str, depth: u32, out: &mut Vec<TreeEntry>) -> std::io::Result<()> {
        let mut dirs: Vec<String> = Vec::new();
        let mut files: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else { continue };
            if !is_safe_component(&name) {
                continue;
            }
            let ft = entry.file_type()?;
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if !is_excluded(&name) {
                    dirs.push(name);
                }
            } else if ft.is_file() && has_md_extension(&name) {
                files.push(name);
            }
        }
        dirs.sort_by_cached_key(|n| (n.to_lowercase(), n.clone()));
        files.sort_by_cached_key(|n| (n.to_lowercase(), n.clone()));
        for name in dirs {
            let path = format!("{prefix}{name}");
            out.push(TreeEntry { path: path.clone(), name: name.clone(), is_dir: true, depth });
            // A folder that cannot be read (permissions, removed mid-walk) is
            // shown but empty rather than failing the whole tree.
            let _ = visit(&dir.join(&name), &format!("{path}/"), depth + 1, out);
        }
        for name in files {
            out.push(TreeEntry { path: format!("{prefix}{name}"), name, is_dir: false, depth });
        }
        Ok(())
    }

    let canon = std::fs::canonicalize(root).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => FsError::Vault(VaultError::NotFound),
        _ => FsError::Io(e),
    })?;
    let mut out = Vec::new();
    visit(&canon, "", 0, &mut out)?;
    Ok(out)
}

fn has_md_extension(name: &str) -> bool {
    name.len() > 3 && name.get(name.len() - 3..).is_some_and(|e| e.eq_ignore_ascii_case(".md"))
}

#[tauri::command]
pub async fn vault_tree(state: tauri::State<'_, super::VaultState>) -> Result<Vec<TreeEntry>, FsError> {
    let root = state.root()?;
    // A big vault is a long synchronous walk: keep it off the async workers.
    tauri::async_runtime::spawn_blocking(move || walk(&root))
        .await
        .map_err(|e| FsError::Io(std::io::Error::other(e.to_string())))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-tree-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
        fn file(&self, rel: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn paths(s: &Scratch) -> Vec<String> {
        walk(&s.0).unwrap().into_iter().map(|e| e.path).collect()
    }

    #[test]
    fn lists_markdown_files_recursively() {
        let s = Scratch::new();
        s.file("top.md");
        s.file("a/one.labnote.md");
        s.file("a/b/two.md");
        s.file("a/readme.txt");
        s.file("a/pic.png");
        let tree = walk(&s.0).unwrap();
        let rows: Vec<_> = tree.iter().map(|e| (e.path.as_str(), e.name.as_str(), e.is_dir, e.depth)).collect();
        assert_eq!(
            rows,
            [
                ("a", "a", true, 0),
                ("a/b", "b", true, 1),
                ("a/b/two.md", "two.md", false, 2),
                ("a/one.labnote.md", "one.labnote.md", false, 1),
                ("top.md", "top.md", false, 0),
            ]
        );
    }

    #[test]
    fn skips_dot_obsidian_and_dot_git_and_node_modules() {
        let s = Scratch::new();
        s.file(".obsidian/hidden.md");
        s.file(".git/hidden.md");
        s.file("node_modules/pkg/readme.md");
        s.file("Node_Modules/readme.md");
        s.file(".cache/hidden.md");
        s.file("sub/.obsidian/hidden.md");
        s.file("sub/ok.md");
        assert_eq!(paths(&s), ["sub", "sub/ok.md"]);
        assert!(is_excluded(".obsidian") && is_excluded(".OBSIDIAN") && is_excluded(".git"));
        assert!(is_excluded("node_modules") && is_excluded("NODE_MODULES") && is_excluded(".anything"));
        assert!(!is_excluded("notes") && !is_excluded("my.folder") && !is_excluded("node_modules2"));
    }

    #[test]
    fn sorts_folders_before_files_then_by_name() {
        let s = Scratch::new();
        s.file("zeta/x.md");
        s.file("Alpha/x.md");
        s.file("b.md");
        s.file("A.md");
        s.file("a2.md");
        // Case-insensitive like Explorer: Alpha, zeta, then A, a2, b.
        assert_eq!(paths(&s), ["Alpha", "Alpha/x.md", "zeta", "zeta/x.md", "A.md", "a2.md", "b.md"]);
    }

    #[test]
    fn returns_posix_separators_on_windows() {
        let s = Scratch::new();
        s.file("labnote/001/02.md");
        let p = paths(&s);
        assert!(p.contains(&"labnote/001/02.md".to_string()), "{p:?}");
        assert!(p.iter().all(|x| !x.contains(char::from(92u8))));
    }

    #[test]
    fn does_not_follow_links_out_of_the_vault() {
        let s = Scratch::new();
        let outside = Scratch::new();
        outside.file("secret.md");
        s.file("in.md");
        let link = s.0.join("link");
        let out = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside.0)
            .output()
            .unwrap();
        assert!(out.status.success(), "mklink: {}", String::from_utf8_lossy(&out.stdout));
        assert_eq!(paths(&s), ["in.md"]);
    }

    #[test]
    fn missing_root_is_an_error_not_an_empty_tree() {
        let s = Scratch::new();
        assert!(walk(&s.0.join("gone")).is_err());
    }
}
