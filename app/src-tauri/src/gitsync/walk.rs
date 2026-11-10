//! The experiment-folder walk (spec §6.1): which files go up, which are
//! listed under "제외됨" and why, size limits, git detection, and the
//! status cache that keeps panel renders from re-hashing every image.
//!
//! Nothing here opens a git repository, follows a link, or reads a file's
//! content (the status hash reads through the caller's closure).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use git2::{ObjectType, Oid};
use serde::{Deserialize, Serialize};

use crate::scan::folder::{reparse_of, Reparse};
use crate::vault::path::{confine, is_safe_component, VaultError};

/// Size thresholds. Injectable so tests never create 100 MiB files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// A file this big or bigger is auto-excluded (`TooLarge`).
    pub file_block: u64,
    /// A file this big or bigger is shown yellow.
    pub file_warn: u64,
    /// One upload above this is refused.
    pub upload_block: u64,
    /// A repository above this gets a one-time notice.
    pub repo_warn: u64,
    /// The most bytes of one file the secret scan reads.
    pub scan_max: u64,
}

const MIB: u64 = 1024 * 1024;

impl Limits {
    pub const DEFAULT: Limits = Limits {
        file_block: 100 * MIB,
        file_warn: 50 * MIB,
        upload_block: 1536 * MIB,
        repo_warn: 1024 * MIB,
        scan_max: 10 * MIB,
    };
}

/// One file that would go up. `rel` is POSIX, relative to the folder,
/// byte-exact as found on disk.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub rel: String,
    pub size: u64,
    pub mtime_ns: u64,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExcludeReason {
    /// Always excluded for safety (§6.1 hard excludes).
    Hard,
    /// Unticked by the user in a preview.
    User,
    /// At or above `Limits::file_block`.
    TooLarge,
    /// A symlink, junction or mount point: never followed, never read.
    Link,
}

/// A file or folder that does not go up. A folder is listed once; nothing
/// under it is visited.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Excluded {
    pub rel: String,
    pub reason: ExcludeReason,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SizeWarning {
    /// A file between `file_warn` and `file_block`.
    Large { rel: String, size: u64 },
    /// The files together are above `upload_block`.
    UploadTooLarge { total: u64, limit: u64 },
    /// The files together are above `repo_warn`.
    RepoLarge { total: u64 },
    /// A name in decomposed (NFD) Hangul, as macOS writes it.
    Nfd { rel: String },
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Walk {
    /// Sorted by `rel` (byte order).
    pub files: Vec<FileEntry>,
    pub excluded: Vec<Excluded>,
    pub warnings: Vec<SizeWarning>,
    /// `<folder>/.git` exists (a folder or a file).
    pub folder_has_git: bool,
    /// `.git` exists in the vault root or a folder between it and the
    /// experiment folder.
    pub vault_is_git: bool,
    /// Names the vault path rules reject (reserved, unsafe, not UTF-8).
    pub bad_paths: Vec<String>,
    /// The confined (`\\?\`) folder path every later read joins onto.
    #[serde(skip)]
    pub folder_abs: PathBuf,
}

#[derive(Debug)]
pub enum WalkError {
    /// The folder path is not a valid vault path.
    BadFolder,
    /// The folder does not exist.
    NotFound,
    /// The path names a file, not a folder.
    NotAFolder,
    /// The folder itself is a symlink or junction.
    Link,
    /// A folder could not be listed. `rel` is relative to the folder.
    Io { rel: String, kind: std::io::ErrorKind },
}

impl std::fmt::Display for WalkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WalkError::BadFolder => write!(f, "not a valid folder path"),
            WalkError::NotFound => write!(f, "the folder does not exist"),
            WalkError::NotAFolder => write!(f, "the path is not a folder"),
            WalkError::Link => write!(f, "the folder is a link"),
            WalkError::Io { rel, kind } => write!(f, "could not list {rel:?}: {kind}"),
        }
    }
}

impl std::error::Error for WalkError {}

/// The §6.1 hard excludes, by name (case-insensitive, as on NTFS). Shared
/// with the overlay `.gitignore` generator.
pub fn hard_excluded(name: &str, is_dir: bool) -> bool {
    if name.starts_with('.') {
        return true;
    }
    let n = name.to_lowercase();
    if is_dir && n == "node_modules" {
        return true;
    }
    const SUFFIXES: [&str; 10] =
        [".labnote-tmp", ".draft.md", ".lnk", ".pem", ".key", ".p12", ".pfx", ".ppk", ".kdbx", ".keystore"];
    const PREFIXES: [&str; 3] = ["~$", "id_rsa", "id_ed25519"];
    n == "thumbs.db"
        || n == "desktop.ini"
        || SUFFIXES.iter().any(|s| n.ends_with(s))
        || PREFIXES.iter().any(|p| n.starts_with(p))
        || (n.starts_with("credentials") && n.ends_with(".json"))
}

/// True when `name` holds conjoining Hangul jamo, i.e. Hangul in NFD
/// (U+1100–U+11FF, U+A960–U+A97F, U+D7B0–U+D7FF). Precomposed syllables and
/// the compatibility jamo (`ㄱ`, U+3131…) are NFC and do not count.
pub fn is_nfd_hangul(name: &str) -> bool {
    name.chars()
        .any(|c| matches!(c, '\u{1100}'..='\u{11FF}' | '\u{A960}'..='\u{A97F}' | '\u{D7B0}'..='\u{D7FF}'))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EntryKind {
    File,
    Dir,
    Link,
}

/// The `scan/folder.rs` rule: a name surrogate is a link; any other reparse
/// point (a cloud placeholder, dedup) is an ordinary file or folder.
pub(crate) fn entry_kind(reparse: Reparse, is_dir: bool) -> EntryKind {
    match reparse {
        Reparse::Link => EntryKind::Link,
        Reparse::Other | Reparse::None if is_dir => EntryKind::Dir,
        Reparse::Other | Reparse::None => EntryKind::File,
    }
}

fn mtime_ns(m: &std::fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn user_excluded_hit(user: &[String], rel: &str) -> bool {
    user.iter().any(|u| {
        let u = u.trim_end_matches('/');
        !u.is_empty() && (u == rel || rel.strip_prefix(u).is_some_and(|rest| rest.starts_with('/')))
    })
}

/// Walks one experiment folder of the vault. `folder_rel` is vault-relative
/// POSIX. The folder goes through `confine`; every entry name below it must
/// pass the same component rule `confine` applies (else `bad_paths`), and
/// since no link is ever followed, every visited path stays inside.
pub fn walk(vault_root: &Path, folder_rel: &str, user_excluded: &[String], limits: &Limits) -> Result<Walk, WalkError> {
    let folder_abs = confine(vault_root, folder_rel).map_err(|e| match e {
        VaultError::Escape => WalkError::BadFolder,
        VaultError::NotFound => WalkError::NotFound,
        VaultError::Io(e) => WalkError::Io { rel: String::new(), kind: e.kind() },
    })?;

    // `confine` resolves links on the way; the folder itself must not be one.
    let plain = folder_rel.split('/').fold(vault_root.to_path_buf(), |p, c| p.join(c));
    let own = std::fs::symlink_metadata(&plain).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => WalkError::NotFound,
        k => WalkError::Io { rel: String::new(), kind: k },
    })?;
    if reparse_of(&own) == Reparse::Link {
        return Err(WalkError::Link);
    }
    if !own.is_dir() {
        return Err(WalkError::NotAFolder);
    }

    // Plain existence checks only: no repository is ever opened.
    let has_git = |dir: &Path| std::fs::symlink_metadata(dir.join(".git")).is_ok();
    let folder_has_git = has_git(&folder_abs);
    let mut vault_is_git = has_git(vault_root);
    let parts: Vec<&str> = folder_rel.split('/').collect();
    let mut between = vault_root.to_path_buf();
    for part in &parts[..parts.len() - 1] {
        between.push(part);
        vault_is_git |= has_git(&between);
    }

    let mut out = Walk {
        files: Vec::new(),
        excluded: Vec::new(),
        warnings: Vec::new(),
        folder_has_git,
        vault_is_git,
        bad_paths: Vec::new(),
        folder_abs: folder_abs.clone(),
    };

    let mut stack: Vec<String> = vec![String::new()];
    while let Some(prefix) = stack.pop() {
        let dir = if prefix.is_empty() { folder_abs.clone() } else { folder_abs.join(&prefix) };
        let rd = std::fs::read_dir(&dir).map_err(|e| WalkError::Io { rel: prefix.clone(), kind: e.kind() })?;
        let mut entries: Vec<std::fs::DirEntry> = Vec::new();
        for e in rd {
            entries.push(e.map_err(|e| WalkError::Io { rel: prefix.clone(), kind: e.kind() })?);
        }
        entries.sort_by_key(|e| e.file_name());
        let join = |name: &str| if prefix.is_empty() { name.to_string() } else { format!("{prefix}/{name}") };
        for entry in entries {
            let name = match entry.file_name().into_string() {
                Ok(n) => n,
                Err(os) => {
                    out.bad_paths.push(join(&os.to_string_lossy()));
                    continue;
                }
            };
            let rel = join(&name);
            let meta = std::fs::symlink_metadata(entry.path()).map_err(|e| WalkError::Io { rel: rel.clone(), kind: e.kind() })?;
            let kind = entry_kind(reparse_of(&meta), meta.is_dir());
            if hard_excluded(&name, kind == EntryKind::Dir) {
                out.excluded.push(Excluded { rel, reason: ExcludeReason::Hard });
                continue;
            }
            if !is_safe_component(&name) {
                out.bad_paths.push(rel);
                continue;
            }
            if kind == EntryKind::Link {
                out.excluded.push(Excluded { rel, reason: ExcludeReason::Link });
                continue;
            }
            if user_excluded_hit(user_excluded, &rel) {
                out.excluded.push(Excluded { rel, reason: ExcludeReason::User });
                continue;
            }
            if is_nfd_hangul(&name) {
                out.warnings.push(SizeWarning::Nfd { rel: rel.clone() });
            }
            match kind {
                EntryKind::Dir => stack.push(rel),
                _ => {
                    let size = meta.len();
                    if size >= limits.file_block {
                        out.excluded.push(Excluded { rel, reason: ExcludeReason::TooLarge });
                        continue;
                    }
                    if size >= limits.file_warn {
                        out.warnings.push(SizeWarning::Large { rel: rel.clone(), size });
                    }
                    out.files.push(FileEntry { rel, size, mtime_ns: mtime_ns(&meta) });
                }
            }
        }
    }

    out.files.sort_by(|a, b| a.rel.cmp(&b.rel));
    out.excluded.sort_by(|a, b| a.rel.cmp(&b.rel));
    let total: u64 = out.files.iter().map(|f| f.size).sum();
    if total > limits.upload_block {
        out.warnings.push(SizeWarning::UploadTooLarge { total, limit: limits.upload_block });
    }
    if total > limits.repo_warn {
        out.warnings.push(SizeWarning::RepoLarge { total });
    }
    Ok(out)
}

/// One status-cache entry, stored as `[size, mtimeNs, blobHex]`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CacheEntry(pub u64, pub u64, pub String);

/// One folder's status cache: `{path -> [size, mtimeNs, blobHex]}`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(transparent)]
pub struct FolderCache(pub BTreeMap<String, CacheEntry>);

/// The whole `GithubDoc::StatusCache` document: `{folder -> FolderCache}`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(transparent)]
pub struct StatusCache(pub BTreeMap<String, FolderCache>);

/// Blob ids for every walked file. Only entries whose size or mtime changed
/// (or that are new) are read and hashed; the cache drops files that are
/// gone. A file `read` fails on is left out of the result and the cache, so
/// the caller sees it as changed. The upload plan always re-hashes, so a
/// same-size, same-mtime edit missed here never reaches a commit (P-R2).
pub fn status_hash(
    cache: &mut FolderCache,
    walk: &Walk,
    read: impl Fn(&str) -> std::io::Result<Vec<u8>>,
) -> HashMap<String, Oid> {
    let mut ids = HashMap::with_capacity(walk.files.len());
    let mut next = BTreeMap::new();
    for f in &walk.files {
        let cached = cache
            .0
            .get(&f.rel)
            .filter(|c| c.0 == f.size && c.1 == f.mtime_ns)
            .and_then(|c| Oid::from_str(&c.2).ok().map(|id| (id, c.clone())));
        let (id, entry) = match cached {
            Some(hit) => hit,
            None => {
                let Ok(bytes) = read(&f.rel) else { continue };
                let Ok(id) = Oid::hash_object(ObjectType::Blob, &bytes) else { continue };
                (id, CacheEntry(f.size, f.mtime_ns, id.to_string()))
            }
        };
        ids.insert(f.rel.clone(), id);
        next.insert(f.rel.clone(), entry);
    }
    cache.0 = next;
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::folder::classify;
    use std::cell::Cell;
    use std::fs;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, SystemTime};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// Scratch dir under the OS temp dir, removed on drop (junctions first,
    /// so `remove_dir_all` never follows one out).
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!("labnoteo-walk-{}-{}", std::process::id(), n));
            fs::create_dir_all(dir.join("vault")).unwrap();
            Scratch(dir)
        }
        fn vault(&self) -> PathBuf {
            self.0.join("vault")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            fn unlink_junctions(dir: &Path) {
                if let Ok(rd) = fs::read_dir(dir) {
                    for e in rd.flatten() {
                        let p = e.path();
                        match fs::symlink_metadata(&p) {
                            Ok(m) if m.file_type().is_symlink() => {
                                let _ = fs::remove_dir(&p);
                            }
                            Ok(m) if m.is_dir() => unlink_junctions(&p),
                            _ => {}
                        }
                    }
                }
            }
            unlink_junctions(&self.0);
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn put(root: &Path, rel: &str, bytes: &[u8]) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    fn junction(link: &Path, target: &Path) {
        // `mklink` needs backslashes throughout.
        let win = |p: &Path| p.to_string_lossy().replace('/', "\\");
        let out = Command::new("cmd").args(["/C", "mklink", "/J"]).arg(win(link)).arg(win(target)).output().expect("cmd");
        assert!(
            out.status.success(),
            "mklink /J failed: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn small() -> Limits {
        Limits { file_block: 100, file_warn: 50, upload_block: 1000, repo_warn: 500, scan_max: 10 }
    }

    fn rels(w: &Walk) -> Vec<&str> {
        w.files.iter().map(|f| f.rel.as_str()).collect()
    }

    fn reason(w: &Walk, rel: &str) -> Option<ExcludeReason> {
        w.excluded.iter().find(|e| e.rel == rel).map(|e| e.reason)
    }

    #[test]
    fn default_limits() {
        assert_eq!(Limits::DEFAULT.file_block, 100 * MIB);
        assert_eq!(Limits::DEFAULT.file_warn, 50 * MIB);
        assert_eq!(Limits::DEFAULT.upload_block, 1536 * MIB);
        assert_eq!(Limits::DEFAULT.repo_warn, 1024 * MIB);
        assert_eq!(Limits::DEFAULT.scan_max, 10 * MIB);
    }

    #[test]
    fn hard_excludes_by_name() {
        for name in [
            ".env", ".env.local", ".git", ".labnote", ".obsidian", ".github", "x.labnote-tmp", "a.draft.md",
            "Thumbs.db", "desktop.ini", "~$x.xlsx", "link.lnk", "a.pem", "server.KEY", "c.p12", "c.pfx", "k.ppk",
            "id_rsa", "id_rsa.pub", "id_ed25519", "db.kdbx", "app.keystore", "credentials.json",
            "credentials-prod.json",
        ] {
            assert!(hard_excluded(name, false), "{name} must be hard-excluded");
        }
        assert!(hard_excluded("node_modules", true));
        assert!(hard_excluded(".ipynb_checkpoints", true));
        for name in ["01_PCR.md", "README.md", "data.csv", "keys.txt", "credentials.txt", "node_modules", "단백질.md"] {
            assert!(!hard_excluded(name, false), "{name} must not be hard-excluded");
        }
        assert!(!hard_excluded("images", true));
    }

    #[test]
    fn hard_excluded_entries_are_listed_and_not_uploaded() {
        let s = Scratch::new();
        let v = s.vault();
        let f = "labnote/001_PCR";
        for rel in [
            ".env", "sub/.env.local", ".git/config", "a.labnote-tmp", ".github/workflows/x.yml", "id_rsa", "a.pem",
            "~$x.xlsx", "Thumbs.db", "01_PCR.md", "sub/data.csv",
        ] {
            put(&v, &format!("{f}/{rel}"), b"x");
        }
        let w = walk(&v, f, &[], &small()).unwrap();
        assert_eq!(rels(&w), vec!["01_PCR.md", "sub/data.csv"]);
        for rel in [".env", "sub/.env.local", ".git", "a.labnote-tmp", ".github", "id_rsa", "a.pem", "~$x.xlsx", "Thumbs.db"] {
            assert_eq!(reason(&w, rel), Some(ExcludeReason::Hard), "{rel}");
        }
        assert!(w.folder_has_git);
        assert!(!w.vault_is_git);
        assert!(w.bad_paths.is_empty());
    }

    #[test]
    fn junction_is_listed_as_link_and_never_followed() {
        let s = Scratch::new();
        let v = s.vault();
        let f = "labnote/001_PCR";
        put(&v, &format!("{f}/01.md"), b"note");
        let outside = s.0.join("outside");
        put(&outside, "secret.txt", b"never read");
        put(&outside, "deep/more.txt", b"never read");
        junction(&v.join(f).join("raw"), &outside);
        let w = walk(&v, f, &[], &small()).unwrap();
        assert_eq!(rels(&w), vec!["01.md"]);
        assert_eq!(reason(&w, "raw"), Some(ExcludeReason::Link));
        assert!(w.excluded.iter().all(|e| !e.rel.starts_with("raw/")));
    }

    #[test]
    fn non_surrogate_reparse_point_is_an_ordinary_file() {
        // A OneDrive/Dropbox placeholder: FILE_ATTRIBUTE_REPARSE_POINT, not a name surrogate.
        assert_eq!(entry_kind(classify(0x400 | 0x20, false), false), EntryKind::File);
        assert_eq!(entry_kind(classify(0x400 | 0x10, false), true), EntryKind::Dir);
        assert_eq!(entry_kind(classify(0x400, true), false), EntryKind::Link);
        assert_eq!(entry_kind(classify(0x400, true), true), EntryKind::Link);
        assert_eq!(entry_kind(classify(0x20, false), false), EntryKind::File);
        assert_eq!(entry_kind(classify(0x10, false), true), EntryKind::Dir);
    }

    #[test]
    fn size_limits_block_and_warn() {
        let s = Scratch::new();
        let v = s.vault();
        put(&v, "e/big.tif", &[0u8; 100]);
        put(&v, "e/huge.tif", &[0u8; 150]);
        put(&v, "e/mid.tif", &[0u8; 60]);
        put(&v, "e/ok.md", &[0u8; 10]);
        let w = walk(&v, "e", &[], &small()).unwrap();
        assert_eq!(rels(&w), vec!["mid.tif", "ok.md"]);
        assert_eq!(reason(&w, "big.tif"), Some(ExcludeReason::TooLarge));
        assert_eq!(reason(&w, "huge.tif"), Some(ExcludeReason::TooLarge));
        assert!(w.warnings.contains(&SizeWarning::Large { rel: "mid.tif".into(), size: 60 }));
        assert!(!w.warnings.iter().any(|x| matches!(x, SizeWarning::Large { rel, .. } if rel == "ok.md")));
        assert!(!w
            .warnings
            .iter()
            .any(|x| matches!(x, SizeWarning::UploadTooLarge { .. } | SizeWarning::RepoLarge { .. })));
    }

    #[test]
    fn total_size_warnings() {
        let s = Scratch::new();
        let v = s.vault();
        for i in 0..12 {
            put(&v, &format!("e/f{i:02}.bin"), &[1u8; 49]);
        }
        let w = walk(&v, "e", &[], &small()).unwrap();
        assert_eq!(w.files.len(), 12);
        assert!(w.warnings.contains(&SizeWarning::RepoLarge { total: 588 }));
        assert!(!w.warnings.iter().any(|x| matches!(x, SizeWarning::UploadTooLarge { .. })));
        for i in 12..24 {
            put(&v, &format!("e/f{i:02}.bin"), &[1u8; 49]);
        }
        let w = walk(&v, "e", &[], &small()).unwrap();
        assert!(w.warnings.contains(&SizeWarning::UploadTooLarge { total: 1176, limit: 1000 }));
    }

    #[test]
    fn user_excludes_files_and_folders() {
        let s = Scratch::new();
        let v = s.vault();
        put(&v, "e/keep.md", b"k");
        put(&v, "e/raw data/1.tif", b"r");
        put(&v, "e/raw data/2.tif", b"r");
        put(&v, "e/notes/draft 2.md", b"d");
        put(&v, "e/notes/final.md", b"f");
        put(&v, "e/raw data2/x.md", b"x");
        let ex = vec!["raw data".to_string(), "notes/draft 2.md".to_string()];
        let w = walk(&v, "e", &ex, &small()).unwrap();
        assert_eq!(rels(&w), vec!["keep.md", "notes/final.md", "raw data2/x.md"]);
        assert_eq!(reason(&w, "raw data"), Some(ExcludeReason::User));
        assert_eq!(reason(&w, "notes/draft 2.md"), Some(ExcludeReason::User));
    }

    #[test]
    fn korean_folder_with_spaces_and_legacy_readme() {
        let s = Scratch::new();
        let v = s.vault();
        let f = "labnote/001_단백질 발현";
        put(&v, &format!("{f}/README.md"), b"# legacy");
        put(&v, &format!("{f}/01_세포 배양.md"), "본문".as_bytes());
        put(&v, &format!("{f}/이미지/겔 사진 1.png"), b"png");
        let w = walk(&v, f, &[], &small()).unwrap();
        assert_eq!(rels(&w), vec!["01_세포 배양.md", "README.md", "이미지/겔 사진 1.png"]);
        assert!(w.excluded.is_empty());
        assert!(w.bad_paths.is_empty());
        assert!(!w.warnings.iter().any(|x| matches!(x, SizeWarning::Nfd { .. })));
        let f0 = &w.files[0];
        assert_eq!(f0.size, "본문".len() as u64);
        assert!(f0.mtime_ns > 0);
    }

    #[test]
    fn nfd_name_is_warned_and_kept_byte_exact() {
        let s = Scratch::new();
        let v = s.vault();
        // "한글" decomposed: U+1112 U+1161 U+11AB U+1100 U+1173 U+11AF.
        let nfd = "\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF}.md";
        put(&v, &format!("e/{nfd}"), b"x");
        put(&v, "e/한글.md", b"y");
        let w = walk(&v, "e", &[], &small()).unwrap();
        assert!(rels(&w).contains(&nfd));
        assert!(rels(&w).contains(&"한글.md"));
        assert!(w.warnings.contains(&SizeWarning::Nfd { rel: nfd.to_string() }));
        assert!(!w.warnings.contains(&SizeWarning::Nfd { rel: "한글.md".to_string() }));
        assert!(is_nfd_hangul(nfd));
        assert!(!is_nfd_hangul("한글"));
        assert!(!is_nfd_hangul("ㄱㄴ"));
    }

    #[test]
    fn vault_git_is_detected_without_opening_it() {
        let s = Scratch::new();
        let v = s.vault();
        put(&v, "labnote/e/01.md", b"x");
        let w = walk(&v, "labnote/e", &[], &small()).unwrap();
        assert!(!w.vault_is_git);
        assert!(!w.folder_has_git);
        fs::create_dir(v.join(".git")).unwrap();
        fs::write(v.join(".git/config"), b"\x00\xffgarbage [[[ not a config").unwrap();
        let w = walk(&v, "labnote/e", &[], &small()).unwrap();
        assert!(w.vault_is_git);
        assert!(!w.folder_has_git);
        assert_eq!(rels(&w), vec!["01.md"]);
    }

    #[test]
    fn git_in_a_folder_between_root_and_experiment() {
        let s = Scratch::new();
        let v = s.vault();
        put(&v, "labnote/e/01.md", b"x");
        put(&v, "labnote/.git", b"gitdir: elsewhere");
        let w = walk(&v, "labnote/e", &[], &small()).unwrap();
        assert!(w.vault_is_git);
        assert!(!w.folder_has_git);
        put(&v, "labnote/e/.git", b"gitdir: elsewhere");
        let w = walk(&v, "labnote/e", &[], &small()).unwrap();
        assert!(w.folder_has_git, ".git as a file counts");
    }

    #[test]
    fn bad_folder_and_missing_folder_are_errors() {
        let s = Scratch::new();
        let v = s.vault();
        put(&v, "e/a.md", b"x");
        assert!(matches!(walk(&v, "../x", &[], &small()), Err(WalkError::BadFolder)));
        assert!(matches!(walk(&v, "", &[], &small()), Err(WalkError::BadFolder)));
        assert!(matches!(walk(&v, "nope", &[], &small()), Err(WalkError::NotFound)));
        assert!(matches!(walk(&v, "e/a.md", &[], &small()), Err(WalkError::NotAFolder)));
    }

    #[test]
    fn experiment_folder_that_is_itself_a_junction_is_refused() {
        let s = Scratch::new();
        let v = s.vault();
        put(&v, "real/a.md", b"x");
        junction(&v.join("alias"), &v.join("real"));
        assert!(matches!(walk(&v, "alias", &[], &small()), Err(WalkError::Link)));
    }

    #[test]
    fn status_cache_hashes_only_what_changed() {
        let s = Scratch::new();
        let v = s.vault();
        put(&v, "e/a.md", b"alpha");
        put(&v, "e/b.csv", b"1,2,3");
        let lim = small();
        let base = v.join("e");
        let hashes = Cell::new(0usize);
        let read = |rel: &str| {
            hashes.set(hashes.get() + 1);
            fs::read(base.join(rel))
        };
        let mut cache = FolderCache::default();

        let w = walk(&v, "e", &[], &lim).unwrap();
        let ids = status_hash(&mut cache, &w, read);
        assert_eq!(hashes.get(), 2);
        assert_eq!(ids["a.md"], Oid::hash_object(ObjectType::Blob, b"alpha").unwrap());
        assert_eq!(cache.0.len(), 2);

        let w = walk(&v, "e", &[], &lim).unwrap();
        let again = status_hash(&mut cache, &w, read);
        assert_eq!(hashes.get(), 2, "nothing changed: no hashing");
        assert_eq!(again, ids);

        // Same size, new content, new mtime.
        fs::write(base.join("a.md"), b"ALPHA").unwrap();
        let later = SystemTime::now() + Duration::from_secs(5);
        fs::File::options().write(true).open(base.join("a.md")).unwrap().set_modified(later).unwrap();
        let w = walk(&v, "e", &[], &lim).unwrap();
        let after = status_hash(&mut cache, &w, read);
        assert_eq!(hashes.get(), 3, "one touched file: one hash");
        assert_eq!(after["a.md"], Oid::hash_object(ObjectType::Blob, b"ALPHA").unwrap());
        assert_eq!(after["b.csv"], ids["b.csv"]);

        // A removed file leaves the cache.
        fs::remove_file(base.join("b.csv")).unwrap();
        let w = walk(&v, "e", &[], &lim).unwrap();
        let gone = status_hash(&mut cache, &w, read);
        assert_eq!(hashes.get(), 3);
        assert!(!gone.contains_key("b.csv"));
        assert!(!cache.0.contains_key("b.csv"));
    }

    #[test]
    fn status_cache_round_trips_as_tuples() {
        let mut cache = FolderCache::default();
        cache.0.insert("a.md".into(), CacheEntry(5, 7, "ab".repeat(20)));
        let json = serde_json::to_string(&cache).unwrap();
        assert_eq!(json, format!("{{\"a.md\":[5,7,\"{}\"]}}", "ab".repeat(20)));
        let back: FolderCache = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cache);
        let mut all = StatusCache::default();
        all.0.insert("labnote/001_단백질 발현".into(), back);
        let json = serde_json::to_string(&all).unwrap();
        assert_eq!(serde_json::from_str::<StatusCache>(&json).unwrap(), all);
    }
}
