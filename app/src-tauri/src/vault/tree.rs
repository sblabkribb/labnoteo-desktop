//! The vault's file tree: every file under the vault (notes and attachments),
//! with the folders that lead to it, as one flat depth-first list. Dot-folders
//! (`.obsidian`, `.git`, `.trash`, ...) and `node_modules` are never listed.

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
    /// The extension after the last dot, ASCII lower-cased, without the dot;
    /// empty for a folder or a name without one (`one.labnote.md` -> `md`).
    pub ext: String,
}

/// `ext` of a file name: the part after the last dot (not a leading dot), lower-cased.
fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => name[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
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
/// component is a name `confine` accepts and is not excluded (so nothing under
/// `.obsidian`, `.git`, `.trash` or any other dot-folder). Every regular file
/// is listed, notes and attachments alike. This is the single definition of
/// "what is in the vault"; the walk uses its pieces and the file watcher must
/// call this on each event path rather than restate the rule. It looks at names
/// only: a watcher must also skip links (the walk does not follow them), which
/// needs the file system. The rule is the same for files and folders.
pub fn is_listed_path(rel: &str) -> bool {
    rel.split('/').all(is_listed_name)
}

/// Whether `rel` is a note: a listed file (`is_listed_path`) whose name ends in
/// `.md` (any case) after at least one character. The search index reads these
/// and nothing else.
pub fn is_note_path(rel: &str) -> bool {
    is_listed_path(rel) && rel.rsplit('/').next().is_some_and(has_md_extension)
}

/// Whether `rel` is a sample registry, `<…>/labsamples/<name>.json`: every
/// ancestor a listed folder (`is_listed_path`), the parent named `labsamples`
/// (ASCII case-insensitive) and the name a safe, non-hidden `.json` (any case)
/// after at least one character. Registries are not notes, so the tree never
/// lists them; the watcher reports them on their own event.
pub fn is_sample_registry_path(rel: &str) -> bool {
    let Some((dir, name)) = rel.rsplit_once('/') else { return false };
    let parent = dir.rsplit('/').next().unwrap_or(dir);
    parent.eq_ignore_ascii_case("labsamples")
        && is_listed_path(dir)
        && is_listed_name(name)
        && name.len() > 5
        && name.get(name.len() - 5..).is_some_and(|e| e.eq_ignore_ascii_case(".json"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Dir,
    File,
    Link,
}

/// Split directory entries into listed folder names and listed file names.
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
            Ok(Kind::File) => files.push(name),
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
/// Folders are kept even when they hold no files, so a folder the user just
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
            out.push(TreeEntry { path: path.clone(), name: name.clone(), is_dir: true, depth, ext: String::new() });
            // A folder that cannot be read (permissions, removed mid-walk) is
            // shown but empty rather than failing the whole tree.
            let _ = visit(&dir.join(&name), &format!("{path}/"), depth + 1, out);
        }
        for name in files {
            let ext = ext_of(&name);
            out.push(TreeEntry { path: format!("{prefix}{name}"), name, is_dir: false, depth, ext });
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
    fn lists_every_file_recursively_with_its_extension() {
        let s = Scratch::new();
        s.file("top.md");
        s.file("a/one.labnote.md");
        s.file("a/b/two.md");
        s.file("a/readme.txt");
        s.file("a/pic.PNG");
        s.file("a/noext");
        let tree = walk(&s.0).unwrap();
        let rows: Vec<_> =
            tree.iter().map(|e| (e.path.as_str(), e.name.as_str(), e.is_dir, e.depth, e.ext.as_str())).collect();
        assert_eq!(
            rows,
            [
                ("a", "a", true, 0, ""),
                ("a/b", "b", true, 1, ""),
                ("a/b/two.md", "two.md", false, 2, "md"),
                ("a/noext", "noext", false, 1, ""),
                ("a/one.labnote.md", "one.labnote.md", false, 1, "md"),
                ("a/pic.PNG", "pic.PNG", false, 1, "png"),
                ("a/readme.txt", "readme.txt", false, 1, "txt"),
                ("top.md", "top.md", false, 0, "md"),
            ]
        );
    }

    #[test]
    fn attachments_are_listed_and_system_folders_are_not() {
        let s = Scratch::new();
        s.file("a/images/x.png");
        s.file("a/resources/d.csv");
        s.file(".obsidian/x");
        s.file(".git/x");
        s.file(".trash/x");
        assert_eq!(paths(&s), ["a", "a/images", "a/images/x.png", "a/resources", "a/resources/d.csv"]);
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
        // Every component must be a safe name that is not hidden: notes and attachments alike.
        for ok in ["a.md", "A.MD", "labnote/001/02.md", "x.labnote.md", "a.txt", "a/images/x.png", "a/resources/d.csv", "noext"] {
            assert!(is_listed_path(ok), "{ok}");
        }
        for no in [
            "", ".obsidian/x", ".git/x", ".trash/x", ".draft.md", "sub/.draft.md", ".obsidian/a.md", "a/.git/b.md", "node_modules/p/r.md",
            "Node_Modules/r.md", "a//b.md", "a/../b.md", "./a.md", "/a.md", "con.md", "a/nul.md", "a./b.md", "dir/b .md ",
        ] {
            assert!(!is_listed_path(no), "{no}");
        }
        // Folders follow the same rule.
        assert!(is_listed_path("a/b") && is_listed_path("notes.md"));
        assert!(!is_listed_path(".obsidian") && !is_listed_path("a/node_modules"));
        assert!(!is_listed_path("a/.cache") && !is_listed_path("aux"));
        // Notes (what the search index reads) are the listed files that end in `.md`.
        for ok in ["a.md", "A.MD", "labnote/001/02.md", "x.labnote.md"] {
            assert!(is_note_path(ok), "{ok}");
        }
        for no in ["", "a.txt", "a/images/x.png", ".obsidian/a.md", "a/.x.md", "md", ".md", "a/b"] {
            assert!(!is_note_path(no), "{no}");
        }
        // Every row the walk returns satisfies it.
        let s = Scratch::new();
        s.file("a/b/c.md");
        s.file("z.md");
        s.file(".hid/x.md");
        s.file("a/.x.md");
        s.file("a/pic.png");
        for e in walk(&s.0).unwrap() {
            assert!(is_listed_path(&e.path), "{}", e.path);
        }
    }

    #[test]
    fn sample_registry_paths_are_json_directly_in_labsamples() {
        for ok in ["resources/labsamples/DNA.json", "labnote/061_PCR/resources/labsamples/Reagent_vendor.json", "a/LabSamples/배지.json"] {
            assert!(is_sample_registry_path(ok), "{ok}");
        }
        for no in [
            "resources/labsamples/sub/DNA.json", "resources/DNA.json", "resources/labsamples/.DNA.json",
            "resources/labsamples/DNA.md", ".obsidian/labsamples/DNA.json", "labsamples", "a/labsamples/con.json",
        ] {
            assert!(!is_sample_registry_path(no), "{no}");
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
