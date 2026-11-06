use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum VaultError {
    Escape,
    NotFound,
    Io(std::io::Error),
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VaultError::Escape => write!(f, "path escapes the vault"),
            VaultError::NotFound => write!(f, "vault root not found"),
            VaultError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl std::error::Error for VaultError {}

/// Windows device names that resolve to devices whatever the extension.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn is_safe_component(name: &str) -> bool {
    // Backslash and ':' also rule out UNC, `\\?\`, drive prefixes (`C:`, `C:foo`)
    // and alternate data streams (`file:stream`).
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return false;
    }
    // Windows strips trailing dots/spaces, so `a.` would alias `a`.
    if name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    // `CON`, `con.txt`, `NUL.tar.gz`: the part before the first dot decides.
    let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ');
    !RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r))
}

/// Resolve a vault-relative POSIX path against `root`, rejecting anything that
/// could land outside it. The target need not exist yet.
pub fn confine(root: &Path, rel: &str) -> Result<PathBuf, VaultError> {
    if rel.starts_with('/') {
        return Err(VaultError::Escape);
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in rel.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(VaultError::Escape),
            p if is_safe_component(p) => parts.push(p),
            _ => return Err(VaultError::Escape),
        }
    }
    if parts.is_empty() {
        return Err(VaultError::Escape);
    }

    let canon_root = std::fs::canonicalize(root).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::NotFound,
        _ => VaultError::Io(e),
    })?;

    // Walk down from the root, canonicalizing as far as entries exist so that
    // links (junctions/symlinks) are resolved before the containment check.
    let mut resolved = canon_root.clone();
    let mut iter = parts.into_iter();
    for part in iter.by_ref() {
        let next = resolved.join(part);
        match std::fs::symlink_metadata(&next) {
            Ok(_) => {
                // An existing entry that cannot be resolved is a dangling
                // link; writing through it could create a file outside.
                resolved = std::fs::canonicalize(&next).map_err(|e| match e.kind() {
                    std::io::ErrorKind::NotFound => VaultError::Escape,
                    _ => VaultError::Io(e),
                })?;
                if !resolved.starts_with(&canon_root) {
                    return Err(VaultError::Escape);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // First missing component: the rest is plain, already-validated text.
                resolved = next;
                resolved.extend(iter);
                return Ok(resolved);
            }
            Err(e) => return Err(VaultError::Io(e)),
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// Scratch directory under the OS temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir()
                .join(format!("labnoteo-confine-{}-{}", std::process::id(), n));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn vault(&self) -> PathBuf {
            let v = self.0.join("vault");
            fs::create_dir_all(&v).unwrap();
            v
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            // Remove junctions first so remove_dir_all never follows one out.
            if let Ok(rd) = fs::read_dir(self.0.join("vault")) {
                for e in rd.flatten() {
                    if e.file_type().map(|t| t.is_symlink()).unwrap_or(false)
                        || fs::symlink_metadata(e.path())
                            .map(|m| m.file_type().is_symlink())
                            .unwrap_or(false)
                    {
                        let _ = fs::remove_dir(e.path());
                    }
                }
            }
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn junction(link: &Path, target: &Path) {
        let out = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("failed to run cmd");
        assert!(
            out.status.success(),
            "mklink /J failed: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn assert_escape(root: &Path, rel: &str) {
        match confine(root, rel) {
            Err(VaultError::Escape) => {}
            other => panic!("expected Escape for {rel:?}, got {other:?}"),
        }
    }

    #[test]
    fn accepts_plain_relative_path() {
        let s = Scratch::new();
        let root = s.vault();
        fs::create_dir_all(root.join("labnote/001_PCR")).unwrap();
        fs::write(root.join("labnote/001_PCR/02.md"), "x").unwrap();
        let got = confine(&root, "labnote/001_PCR/02.md").unwrap();
        let canon = fs::canonicalize(&root).unwrap();
        assert_eq!(got, canon.join("labnote").join("001_PCR").join("02.md"));
    }

    #[test]
    fn rejects_dot_dot_traversal() {
        let s = Scratch::new();
        assert_escape(&s.vault(), "../../.obsidian/plugins/evil/main");
        assert_escape(&s.vault(), "a/../b");
        assert_escape(&s.vault(), "..");
    }

    #[test]
    fn rejects_absolute_path() {
        let s = Scratch::new();
        assert_escape(&s.vault(), "C:\\Windows\\System32");
        assert_escape(&s.vault(), "C:/Windows/System32");
        assert_escape(&s.vault(), "/etc/passwd");
    }

    #[test]
    fn rejects_backslash_traversal() {
        let s = Scratch::new();
        assert_escape(&s.vault(), "..\\..\\evil.md");
        assert_escape(&s.vault(), "sub\\evil.md");
    }

    #[test]
    fn rejects_unc_path() {
        let s = Scratch::new();
        assert_escape(&s.vault(), "\\\\server\\share\\x.md");
        assert_escape(&s.vault(), "//server/share/x.md");
        assert_escape(&s.vault(), "\\\\?\\C:\\Windows");
    }

    #[test]
    fn rejects_symlink_pointing_outside() {
        let s = Scratch::new();
        let root = s.vault();
        let outside = s.0.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "s").unwrap();
        junction(&root.join("link"), &outside);
        assert_escape(&root, "link/secret.md");
        assert_escape(&root, "link/not-yet.md");
        assert_escape(&root, "link");
    }

    #[test]
    fn rejects_dangling_link_pointing_outside() {
        let s = Scratch::new();
        let root = s.vault();
        let outside = s.0.join("gone");
        fs::create_dir_all(&outside).unwrap();
        junction(&root.join("dangling"), &outside);
        fs::remove_dir(&outside).unwrap();
        assert_escape(&root, "dangling/x.md");
    }

    #[test]
    fn allows_link_pointing_inside() {
        let s = Scratch::new();
        let root = s.vault();
        fs::create_dir_all(root.join("real")).unwrap();
        junction(&root.join("alias"), &root.join("real"));
        let got = confine(&root, "alias/x.md").unwrap();
        let canon = fs::canonicalize(&root).unwrap();
        assert_eq!(got, canon.join("real").join("x.md"));
    }

    #[test]
    fn rejects_empty_path() {
        let s = Scratch::new();
        assert_escape(&s.vault(), "");
        assert_escape(&s.vault(), ".");
        assert_escape(&s.vault(), "./");
    }

    #[test]
    fn allows_path_that_does_not_exist_yet() {
        let s = Scratch::new();
        let root = s.vault();
        let got = confine(&root, "new/deep/file.md").unwrap();
        let canon = fs::canonicalize(&root).unwrap();
        assert_eq!(got, canon.join("new").join("deep").join("file.md"));
        assert!(!got.exists());
    }

    #[test]
    fn rejects_drive_relative_and_alternate_data_streams() {
        let s = Scratch::new();
        let root = s.vault();
        assert_escape(&root, "C:foo");
        assert_escape(&root, "note.md:evil");
        assert_escape(&root, "note.md:evil:$DATA");
        assert_escape(&root, "dir/note.md::$DATA");
    }

    #[test]
    fn rejects_reserved_device_names() {
        let s = Scratch::new();
        let root = s.vault();
        for rel in ["CON", "con.txt", "a/NUL", "aux.md", "Com1", "lpt9.log", "dir/PRN.tar.gz"] {
            assert_escape(&root, rel);
        }
        // Names that merely contain a reserved word are fine.
        assert!(confine(&root, "console.md").is_ok());
        assert!(confine(&root, "com10.md").is_ok());
    }

    #[test]
    fn rejects_trailing_dot_or_space_components() {
        let s = Scratch::new();
        let root = s.vault();
        assert_escape(&root, "a./b.md");
        assert_escape(&root, "a /b.md");
        assert_escape(&root, "b.md.");
        assert_escape(&root, "b.md ");
    }

    #[test]
    fn rejects_invalid_filename_characters() {
        let s = Scratch::new();
        let root = s.vault();
        for rel in ["a<b", "a>b", "a\"b", "a|b", "a?b", "a*b", "a\0b", "a\u{1}b"] {
            assert_escape(&root, rel);
        }
    }

    #[test]
    fn missing_root_is_not_found() {
        let s = Scratch::new();
        match confine(&s.0.join("nope"), "a.md") {
            Err(VaultError::NotFound) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }
}
