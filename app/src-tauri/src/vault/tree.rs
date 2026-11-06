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

/// Names that are never vault content, as a file or a folder: `.obsidian`,
/// `.git`, `node_modules`, and everything else that starts with a dot (so
/// `.draft.md` is hidden too). Case-insensitive because NTFS is. Prefer
/// `is_listed_path`, which adds the other name rules; this is its building block.
pub fn is_excluded(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case("node_modules")
}

fn is_listed_name(name: &str) -> bool {
    !name.is_empty() && is_safe_component(name) && !is_excluded(name)
}

/// `.md` (any case) after at least one character.
fn has_md_extension(name: &str) -> bool {
    name.len() > 3 && name.get(name.len() - 3..).is_some_and(|e| e.eq_ignore_ascii_case(".md"))
}

/// Whether the vault-relative POSIX path `rel` belongs in the tree: every
/// component is a name `confine` accepts and is not excluded, and a file
/// (`is_dir == false`) ends in `.md`. This is the single definition of "what is
/// in the vault"; the walk uses its pieces and the file watcher must call this
/// on each event path rather than restate the rule. It looks at names only: a
/// watcher must also skip links (the walk does not follow them), which needs the
/// file system.
pub fn is_listed_path(rel: &str, is_dir: bool) -> bool {
    let mut parts = rel.split('/').peekable();
    while let Some(part) = parts.next() {
        let last = parts.peek().is_none();
        let ok = is_listed_name(part) && (!last || is_dir || has_md_extension(part));
        if !ok {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Dir,
    File,
    Link,
}

/// Split directory entries into listed folder names and listed note names.
/// An entry that cannot be read, whose type cannot be read, whose name is not
/// UTF-8, or that is a link is skipped on its own: one bad entry must never
/// make its siblings (or the whole tree) disappear.
fn partition(
    items: impl Iterator<Item = std::io::Result<(std::ffi::OsString, std::io::Result<Kind>)>>,
) -> (Vec<String>, Vec<String>) {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for item in items {
        let Ok((name, kind)) = item else { continue };
        let Ok(name) = name.into_string() else { continue };
        if !is_listed_name(&name) {
            continue;
        }
        match kind {
            Ok(Kind::Dir) => dirs.push(name),
            Ok(Kind::File) if has_md_extension(&name) => files.push(name),
            _ => {}
        }
    }
    (dirs, files)
}

/// Walk `root` (depth-first, folders before files, names case-insensitive).
///
/// Paths are built from the names the walk reads, never from `to_rel`, and
/// links (symlinks, junctions) are not followed: nothing outside the vault is
/// listed and a link cannot create a cycle. What is listed follows
/// `is_listed_path`, so every row offered can be opened. A subfolder that
/// cannot be read is shown but empty; only an unreadable root is an error.
/// Folders are kept even when they hold no notes, so a folder the user just
/// made shows up.
pub fn walk(root: &Path) -> Result<Vec<TreeEntry>, FsError> {
    fn visit(dir: &Path, prefix: &str, depth: u32, out: &mut Vec<TreeEntry>) -> std::io::Result<()> {
        let (mut dirs, mut files) = partition(std::fs::read_dir(dir)?.map(|entry| {
            let entry = entry?;
            let kind = entry.file_type().map(|ft| {
                if ft.is_symlink() {
                    Kind::Link
                } else if ft.is_dir() {
                    Kind::Dir
                } else {
                    Kind::File
                }
            });
            Ok((entry.file_name(), kind))
        }));
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

    #[test]
    fn hidden_markdown_files_are_not_listed() {
        let s = Scratch::new();
        s.file(".draft.md");
        s.file("sub/.draft.md");
        s.file("sub/ok.md");
        assert_eq!(paths(&s), ["sub", "sub/ok.md"]);
    }

    #[test]
    fn is_listed_path_is_the_one_rule_the_walk_and_the_watcher_share() {
        // Files: every ancestor must be a listed folder, the name must be a safe `.md` that is not hidden.
        for ok in ["a.md", "A.MD", "labnote/001/02.md", "x.labnote.md"] {
            assert!(is_listed_path(ok, false), "{ok}");
        }
        for no in [
            "", "a.txt", ".draft.md", "sub/.draft.md", ".obsidian/a.md", "a/.git/b.md", "node_modules/p/r.md",
            "Node_Modules/r.md", "a//b.md", "a/../b.md", "./a.md", "/a.md", "con.md", "a/nul.md", "a./b.md", "dir/b .md ",
        ] {
            assert!(!is_listed_path(no, false), "{no}");
        }
        // Folders: same ancestors, no `.md` requirement.
        assert!(is_listed_path("a/b", true) && is_listed_path("notes.md", true));
        assert!(!is_listed_path(".obsidian", true) && !is_listed_path("a/node_modules", true));
        assert!(!is_listed_path("a/.cache", true) && !is_listed_path("aux", true));
        // Every row the walk returns satisfies it.
        let s = Scratch::new();
        s.file("a/b/c.md");
        s.file("z.md");
        s.file(".hid/x.md");
        s.file("a/.x.md");
        for e in walk(&s.0).unwrap() {
            assert!(is_listed_path(&e.path, e.is_dir), "{}", e.path);
        }
    }

    #[test]
    fn one_bad_entry_does_not_hide_its_siblings() {
        use std::io::{Error, ErrorKind};
        let denied = || Error::from(ErrorKind::PermissionDenied);
        let items: Vec<std::io::Result<(std::ffi::OsString, std::io::Result<Kind>)>> = vec![
            Ok(("a.md".into(), Ok(Kind::File))),
            Err(denied()),                                // the directory iterator failed on one entry
            Ok(("broken.md".into(), Err(denied()))),      // its type could not be read
            Ok(("sub".into(), Ok(Kind::Dir))),
            Ok(("link".into(), Ok(Kind::Link))),
            Ok(("b.md".into(), Ok(Kind::File))),
        ];
        let (dirs, files) = partition(items.into_iter());
        assert_eq!(dirs, ["sub"]);
        assert_eq!(files, ["a.md", "b.md"]);
    }
}
