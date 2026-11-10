//! Chat history per experiment folder (assistant spec §6.1, plan Task 8).
//!
//! - Location: `<app_local_data_dir>/assistant/history/<key>.json`, never in a vault.
//!   A store that would resolve inside the open vault (a vault opened at or above
//!   the app data folder) is refused with `io`.
//! - `key = hex(sha256(fold(root) + "\0" + fold(folder)))[..32]`, where `fold`
//!   strips the `\\?\` prefix, turns `\` into `/`, drops trailing `/` and
//!   lowercases (NTFS is case-insensitive). The root is the canonical open vault
//!   root held by Rust; JS sends only the vault-relative folder (NFC), which is
//!   validated here: no `..`, absolute, drive, UNC or NUL, and it must be an
//!   existing folder inside the vault after links are resolved.
//! - `assistant_history_read` returns `{doc, token}`; the token is the key.
//!   `assistant_history_write` recomputes the key from the *current* vault and
//!   refuses with `vaultChanged` when it differs, so a reply that ends after a
//!   vault switch never lands in another vault's same-named folder. The token
//!   is compared, never used as a path.
//! - The document holds user text, assistant text, the taint flag and the source
//!   list only (`deny_unknown_fields`): never tool results or fetched pages.
//!   Caps: 300 messages, 384 KiB per file, 4 KiB per source label.
//! - A stored file that no longer parses (or is over the caps) is moved aside to
//!   `<key>.json.bad` and the folder starts over empty.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use super::{AssistantDirs, AssistantError, AssistantErrorKind as K};
use crate::vault::path::{confine, strip_verbatim, VaultError};
use crate::vault::VaultState;

pub const VERSION: u32 = 1;
pub const MAX_MESSAGES: usize = 300;
pub const MAX_BYTES: usize = 384 * 1024;
pub const MAX_LABEL: usize = 4 * 1024;
/// Longest folder argument accepted (bytes).
pub const MAX_FOLDER: usize = 1024;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryDoc {
    pub version: u32,
    /// The vault-relative folder. Rust sets it from the validated argument.
    pub folder: String,
    /// Milliseconds since the epoch (JS `Date.now()`).
    pub updated: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<Summary>,
    pub messages: Vec<Message>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Summary {
    pub text: String,
    pub tainted: bool,
    /// How many messages the summary stands for.
    pub covers: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Note,
    Web,
    Paper,
}

/// The bubble chips (`ChipId` in `assistant/runtime.ts`).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Chip {
    Howto,
    Section,
    UnitOp,
    Workflow,
    Chat,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub kind: SourceKind,
    pub label: String,
    pub target: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub text: String,
    pub ts: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tainted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<Source>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chip: Option<Chip>,
}

impl HistoryDoc {
    pub fn empty(folder: &str) -> HistoryDoc {
        HistoryDoc { version: VERSION, folder: folder.to_string(), updated: 0.0, summary: None, messages: Vec::new() }
    }
}

/// What `assistant_history_read` returns.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct HistoryRead {
    pub doc: HistoryDoc,
    pub token: String,
}

/// What `assistant_history_stats` returns: every stored folder, every vault.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryStats {
    pub folders: usize,
    pub bytes: u64,
}

fn err(kind: K, message: impl Into<String>) -> AssistantError {
    AssistantError::new(kind, message)
}

fn io(what: &str, e: impl std::fmt::Display) -> AssistantError {
    err(K::Io, format!("{what}: {e}"))
}

/// Serialises reads, writes, clears and moves inside the history folder.
static LOCK: Mutex<()> = Mutex::new(());

/// The key folding: no `\\?\` prefix, `/` separators, no trailing `/`, lowercase.
pub fn fold(s: &str) -> String {
    let plain = strip_verbatim(Path::new(s));
    plain.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// `hex(sha256(fold(root) + "\0" + fold(folder)))[..32]`.
pub fn history_key(root: &Path, folder: &str) -> String {
    let mut h = Sha256::new();
    h.update(fold(&root.to_string_lossy()).as_bytes());
    h.update([0u8]);
    h.update(fold(folder).as_bytes());
    h.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// The open vault's canonical root.
fn canonical_root(root: &Path) -> Result<PathBuf, AssistantError> {
    std::fs::canonicalize(root).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => err(K::NoVault, "the vault folder is gone"),
        _ => io("vault root", e),
    })
}

/// The folder as stored (no trailing `/`), when it is an existing folder inside the vault.
pub fn validate_folder(root: &Path, folder: &str) -> Result<String, AssistantError> {
    let bad = |why: &str| err(K::BadFolder, why.to_string());
    if folder.len() > MAX_FOLDER {
        return Err(bad("folder name too long"));
    }
    if folder.contains('\0') || folder.contains('\\') || folder.starts_with('/') {
        return Err(bad("not a vault-relative folder"));
    }
    let f = folder.trim_end_matches('/');
    if f.is_empty() {
        return Err(bad("empty folder"));
    }
    // `confine` rejects `..`, `.`, empty parts, drive prefixes (`:`), reserved
    // names and links that resolve outside the vault.
    let abs = confine(root, f).map_err(|e| match e {
        VaultError::Escape => bad("folder outside the vault"),
        VaultError::NotFound => err(K::NoVault, "the vault folder is gone"),
        VaultError::Io(e) => io("folder", e),
    })?;
    if !abs.is_dir() {
        return Err(bad("not an existing folder"));
    }
    Ok(f.to_string())
}

fn history_dir(dirs: &AssistantDirs) -> PathBuf {
    dirs.0.join("history")
}

/// Where `key` is stored. The history folder is created, and refused when it
/// resolves inside the vault (`root` is canonical).
fn located(dirs: &AssistantDirs, root: &Path, key: &str) -> Result<PathBuf, AssistantError> {
    let dir = history_dir(dirs);
    std::fs::create_dir_all(&dir).map_err(|e| io("history folder", e))?;
    let canon = std::fs::canonicalize(&dir).map_err(|e| io("history folder", e))?;
    if canon.starts_with(root) {
        return Err(err(K::Io, "the history folder is inside the vault"));
    }
    Ok(canon.join(format!("{key}.json")))
}

/// The resolved file for `folder` of the vault at `root` (validated, outside the vault).
pub fn history_path(dirs: &AssistantDirs, root: &Path, folder: &str) -> Result<PathBuf, AssistantError> {
    let root = canonical_root(root)?;
    let folder = validate_folder(&root, folder)?;
    located(dirs, &root, &history_key(&root, &folder))
}

/// Caps and the schema version. `folder` is not checked: the caller sets it.
pub fn check_doc(doc: &HistoryDoc) -> Result<(), AssistantError> {
    if doc.version != VERSION {
        return Err(err(K::Io, format!("unknown history version {}", doc.version)));
    }
    if doc.messages.len() > MAX_MESSAGES {
        return Err(err(K::TooLarge, format!("more than {MAX_MESSAGES} messages")));
    }
    let long_label = doc
        .messages
        .iter()
        .flat_map(|m| m.sources.iter().flatten())
        .any(|s| s.label.len() > MAX_LABEL || s.target.len() > MAX_LABEL);
    if long_label {
        return Err(err(K::TooLarge, format!("a source label or target is over {MAX_LABEL} bytes")));
    }
    Ok(())
}

/// Parse and check a stored file; `None` when it is unusable.
fn parse_stored(text: &str) -> Option<HistoryDoc> {
    if text.len() > MAX_BYTES {
        return None;
    }
    let doc: HistoryDoc = serde_json::from_str(text).ok()?;
    check_doc(&doc).ok()?;
    Some(doc)
}

pub fn read(dirs: &AssistantDirs, root: &Path, folder: &str) -> Result<HistoryRead, AssistantError> {
    let root = canonical_root(root)?;
    let folder = validate_folder(&root, folder)?;
    let token = history_key(&root, &folder);
    let path = located(dirs, &root, &token)?;
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let doc = match std::fs::read(&path) {
        Ok(bytes) => match std::str::from_utf8(&bytes).ok().and_then(parse_stored) {
            Some(mut doc) => {
                doc.folder = folder.clone();
                doc
            }
            None => {
                // Keep the unusable file for diagnosis; the folder starts over.
                let aside = path.with_extension("json.bad");
                let _ = std::fs::remove_file(&aside);
                std::fs::rename(&path, &aside).map_err(|e| io("history move aside", e))?;
                HistoryDoc::empty(&folder)
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => HistoryDoc::empty(&folder),
        Err(e) => return Err(io("history read", e)),
    };
    Ok(HistoryRead { doc, token })
}

pub fn write(
    dirs: &AssistantDirs,
    root: &Path,
    folder: &str,
    token: &str,
    doc: serde_json::Value,
) -> Result<(), AssistantError> {
    let root = canonical_root(root)?;
    let folder = validate_folder(&root, folder)?;
    let key = history_key(&root, &folder);
    let path = located(dirs, &root, &key)?;
    if token != key {
        return Err(err(K::VaultChanged, "the vault or folder changed since the history was read"));
    }
    let mut doc: HistoryDoc = serde_json::from_value(doc).map_err(|e| io("history document", e))?;
    check_doc(&doc)?;
    doc.folder = folder;
    let text = serde_json::to_string(&doc).map_err(|e| io("history document", e))?;
    if text.len() > MAX_BYTES {
        return Err(err(K::TooLarge, format!("the history is over {MAX_BYTES} bytes")));
    }
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    crate::vault::fs::write_atomic(&path, &text).map_err(|e| io("history write", e))
}

/// Forget one folder's history (and a set-aside copy). Nothing stored is not an error.
pub fn clear(dirs: &AssistantDirs, root: &Path, folder: &str) -> Result<(), AssistantError> {
    let path = history_path(dirs, root, folder)?;
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    for p in [path.clone(), path.with_extension("json.bad")] {
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io("history clear", e)),
        }
    }
    Ok(())
}

/// Delete every file in the history folder (every folder, every vault). Folders
/// and links inside it are left alone. Returns how many files were removed.
pub fn clear_all(dirs: &AssistantDirs) -> Result<usize, AssistantError> {
    let dir = history_dir(dirs);
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(io("history folder", e)),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry.map_err(|e| io("history folder", e))?;
        let ft = entry.file_type().map_err(|e| io("history folder", e))?;
        if ft.is_file() {
            std::fs::remove_file(entry.path()).map_err(|e| io("history clear", e))?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// `<32 hex>.json`: a stored history (not a temp file or a set-aside copy).
fn is_history_file(name: &str) -> bool {
    name.len() == 32 + ".json".len() && name.ends_with(".json") && name[..32].bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn stats(dirs: &AssistantDirs) -> Result<HistoryStats, AssistantError> {
    let dir = history_dir(dirs);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HistoryStats { folders: 0, bytes: 0 }),
        Err(e) => return Err(io("history folder", e)),
    };
    let mut st = HistoryStats { folders: 0, bytes: 0 };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_file() && is_history_file(&entry.file_name().to_string_lossy()) {
            st.folders += 1;
            st.bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok(st)
}

fn open_root(state: &VaultState) -> Result<PathBuf, AssistantError> {
    state.root().map_err(|_| err(K::NoVault, "no vault is open"))
}

#[tauri::command]
pub fn assistant_history_read(
    state: State<'_, VaultState>,
    dirs: State<'_, AssistantDirs>,
    folder: String,
) -> Result<HistoryRead, AssistantError> {
    read(&dirs, &open_root(&state)?, &folder)
}

#[tauri::command]
pub fn assistant_history_write(
    state: State<'_, VaultState>,
    dirs: State<'_, AssistantDirs>,
    folder: String,
    token: String,
    doc: serde_json::Value,
) -> Result<(), AssistantError> {
    write(&dirs, &open_root(&state)?, &folder, &token, doc)
}

#[tauri::command]
pub fn assistant_history_clear(
    state: State<'_, VaultState>,
    dirs: State<'_, AssistantDirs>,
    folder: String,
) -> Result<(), AssistantError> {
    clear(&dirs, &open_root(&state)?, &folder)
}

#[tauri::command]
pub fn assistant_history_clear_all(dirs: State<'_, AssistantDirs>) -> Result<usize, AssistantError> {
    clear_all(&dirs)
}

#[tauri::command]
pub fn assistant_history_stats(dirs: State<'_, AssistantDirs>) -> Result<HistoryStats, AssistantError> {
    stats(&dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// `<tmp>/vault` (with the given folders) and `<tmp>/data/assistant`; removed on drop.
    struct Fx {
        base: PathBuf,
        vault: PathBuf,
        dirs: AssistantDirs,
    }

    impl Fx {
        fn new(folders: &[&str]) -> Fx {
            let base = std::env::temp_dir().join(format!(
                "labnoteo-history-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&base);
            let vault = base.join("vault");
            std::fs::create_dir_all(&vault).unwrap();
            for f in folders {
                std::fs::create_dir_all(vault.join(f)).unwrap();
            }
            let dirs = AssistantDirs(base.join("data").join("assistant"));
            Fx { base, vault, dirs }
        }
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    fn msg(id: &str, role: &str, text: &str) -> serde_json::Value {
        json!({"id": id, "role": role, "text": text, "ts": 1.0})
    }

    fn doc(messages: Vec<serde_json::Value>) -> serde_json::Value {
        json!({"version": 1, "folder": "ignored", "updated": 5.0, "messages": messages})
    }

    fn junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn kind<T: std::fmt::Debug>(r: Result<T, AssistantError>) -> K {
        r.expect_err("expected an error").kind
    }

    #[test]
    fn folder_validation_rejects_anything_but_an_existing_folder_inside_the_vault() {
        let fx = Fx::new(&["001_Exp", "001_Exp/sub"]);
        std::fs::write(fx.vault.join("note.md"), "x").unwrap();
        for bad in [
            "",
            "/",
            "..",
            "../x",
            "001_Exp/../001_Exp",
            "./001_Exp",
            "/001_Exp",
            "C:/x",
            "C:\\x",
            "C:",
            "D:001_Exp",
            "\\\\server\\share",
            "//server/share",
            "\\\\?\\C:\\x",
            "001_Exp\\sub",
            "a\0b",
            "missing",
            "note.md",
            "001_Exp//sub",
        ] {
            assert_eq!(kind(read(&fx.dirs, &fx.vault, bad)), K::BadFolder, "{bad:?}");
        }
        let long = "a".repeat(MAX_FOLDER + 1);
        assert_eq!(kind(read(&fx.dirs, &fx.vault, &long)), K::BadFolder);
        assert!(read(&fx.dirs, &fx.vault, "001_Exp").is_ok());
        assert!(read(&fx.dirs, &fx.vault, "001_Exp/sub").is_ok());
        assert!(read(&fx.dirs, &fx.vault, "001_Exp/").is_ok(), "a trailing slash is dropped");
    }

    #[test]
    fn a_junction_pointing_outside_the_vault_is_refused() {
        let fx = Fx::new(&[]);
        let outside = fx.base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        if !junction(&fx.vault.join("link"), &outside) {
            eprintln!("skipped: mklink /J failed here");
            return;
        }
        assert_eq!(kind(read(&fx.dirs, &fx.vault, "link")), K::BadFolder);
        assert_eq!(kind(write(&fx.dirs, &fx.vault, "link", "0", doc(vec![]))), K::BadFolder);
        assert_eq!(kind(clear(&fx.dirs, &fx.vault, "link")), K::BadFolder);
    }

    #[test]
    fn korean_folder_names_round_trip() {
        let fx = Fx::new(&["002_세포 배양"]);
        let r = read(&fx.dirs, &fx.vault, "002_세포 배양").unwrap();
        assert_eq!(r.doc, HistoryDoc::empty("002_세포 배양"));
        write(&fx.dirs, &fx.vault, "002_세포 배양", &r.token, doc(vec![msg("m1", "user", "배양 조건 알려 줘")])).unwrap();
        let again = read(&fx.dirs, &fx.vault, "002_세포 배양").unwrap();
        assert_eq!(again.doc.messages[0].text, "배양 조건 알려 줘");
        assert_eq!(again.doc.folder, "002_세포 배양");
        assert_eq!(again.doc.updated, 5.0);
        assert_eq!(again.token, r.token);
    }

    #[test]
    fn folder_case_does_not_change_the_key() {
        let fx = Fx::new(&["001_Exp"]);
        let root = std::fs::canonicalize(&fx.vault).unwrap();
        assert_eq!(history_key(&root, "001_Exp"), history_key(&root, "001_exp"));
        assert_eq!(history_key(&root, "001_Exp"), history_key(&root, "001_Exp/"));
        assert_eq!(history_key(&root, "001_Exp").len(), 32);
        // NTFS is case-insensitive: the other spelling is the same folder and the same file.
        let a = read(&fx.dirs, &fx.vault, "001_Exp").unwrap();
        let b = read(&fx.dirs, &fx.vault, "001_exp").unwrap();
        assert_eq!(a.token, b.token);
        // The root is folded too (`\\?\` prefix, separators, case).
        let plain = PathBuf::from(strip_verbatim(&root).to_uppercase());
        assert_eq!(history_key(&root, "x"), history_key(&plain, "x"));
        assert_ne!(history_key(&root, "x"), history_key(&root.join("other"), "x"));
    }

    #[test]
    fn the_key_is_sha256_of_folded_root_nul_folded_folder() {
        let k = history_key(Path::new("\\\\?\\C:\\Lab\\Vault"), "001_Exp/");
        let mut h = Sha256::new();
        h.update(b"c:/lab/vault\x00001_exp");
        let full: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(k, full[..32]);
    }

    #[test]
    fn the_resolved_path_is_never_inside_the_vault() {
        let fx = Fx::new(&["001_Exp"]);
        let p = history_path(&fx.dirs, &fx.vault, "001_Exp").unwrap();
        let root = std::fs::canonicalize(&fx.vault).unwrap();
        assert!(!p.starts_with(&root), "{p:?} is inside {root:?}");
        assert!(p.starts_with(std::fs::canonicalize(&fx.dirs.0).unwrap()));
        let r = read(&fx.dirs, &fx.vault, "001_Exp").unwrap();
        write(&fx.dirs, &fx.vault, "001_Exp", &r.token, doc(vec![msg("m1", "user", "hi")])).unwrap();
        // Nothing new appeared in the vault.
        let names: Vec<_> = std::fs::read_dir(&fx.vault).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("001_Exp")]);
        assert!(std::fs::read_dir(fx.vault.join("001_Exp")).unwrap().next().is_none());
    }

    #[test]
    fn a_store_inside_the_vault_is_refused() {
        let fx = Fx::new(&["001_Exp"]);
        let inside = AssistantDirs(fx.vault.join("appdata").join("assistant"));
        assert_eq!(kind(read(&inside, &fx.vault, "001_Exp")), K::Io);
        assert_eq!(kind(write(&inside, &fx.vault, "001_Exp", "x", doc(vec![]))), K::Io);
    }

    #[test]
    fn two_folders_two_files_and_clear_removes_only_one() {
        let fx = Fx::new(&["A", "B"]);
        let a = read(&fx.dirs, &fx.vault, "A").unwrap();
        let b = read(&fx.dirs, &fx.vault, "B").unwrap();
        assert_ne!(a.token, b.token);
        write(&fx.dirs, &fx.vault, "A", &a.token, doc(vec![msg("1", "user", "alpha secret")])).unwrap();
        write(&fx.dirs, &fx.vault, "B", &b.token, doc(vec![msg("2", "user", "beta")])).unwrap();
        assert_eq!(stats(&fx.dirs).unwrap().folders, 2);
        let rb = read(&fx.dirs, &fx.vault, "B").unwrap();
        assert!(rb.doc.messages.iter().all(|m| !m.text.contains("alpha")), "A's text never reaches B");
        clear(&fx.dirs, &fx.vault, "A").unwrap();
        assert!(read(&fx.dirs, &fx.vault, "A").unwrap().doc.messages.is_empty());
        assert_eq!(read(&fx.dirs, &fx.vault, "B").unwrap().doc.messages[0].text, "beta");
        assert_eq!(stats(&fx.dirs).unwrap().folders, 1);
        clear(&fx.dirs, &fx.vault, "A").unwrap();
    }

    #[test]
    fn clear_all_empties_the_store_and_stats_count_it() {
        let fx = Fx::new(&["A", "B"]);
        assert_eq!(stats(&fx.dirs).unwrap(), HistoryStats { folders: 0, bytes: 0 });
        assert_eq!(clear_all(&fx.dirs).unwrap(), 0, "nothing stored yet");
        for f in ["A", "B"] {
            let r = read(&fx.dirs, &fx.vault, f).unwrap();
            write(&fx.dirs, &fx.vault, f, &r.token, doc(vec![msg("1", "assistant", "ok")])).unwrap();
        }
        let st = stats(&fx.dirs).unwrap();
        assert_eq!(st.folders, 2);
        assert!(st.bytes > 0);
        assert_eq!(clear_all(&fx.dirs).unwrap(), 2);
        assert_eq!(stats(&fx.dirs).unwrap(), HistoryStats { folders: 0, bytes: 0 });
        assert!(fx.vault.join("A").is_dir(), "the vault is untouched");
    }

    #[test]
    fn oversize_writes_are_refused_and_nothing_is_written() {
        let fx = Fx::new(&["A"]);
        let r = read(&fx.dirs, &fx.vault, "A").unwrap();
        let many: Vec<_> = (0..=MAX_MESSAGES).map(|i| msg(&i.to_string(), "user", "x")).collect();
        assert_eq!(kind(write(&fx.dirs, &fx.vault, "A", &r.token, doc(many))), K::TooLarge);
        let big = "가".repeat(MAX_BYTES / 3 + 10);
        assert_eq!(kind(write(&fx.dirs, &fx.vault, "A", &r.token, doc(vec![msg("1", "user", &big)]))), K::TooLarge);
        let mut m = msg("1", "assistant", "see [1]");
        m["sources"] = json!([{"kind": "web", "label": "x".repeat(MAX_LABEL + 1), "target": "https://example.org/"}]);
        assert_eq!(kind(write(&fx.dirs, &fx.vault, "A", &r.token, doc(vec![m]))), K::TooLarge);
        assert_eq!(stats(&fx.dirs).unwrap().folders, 0);
        // Exactly at the message cap is fine.
        let max: Vec<_> = (0..MAX_MESSAGES).map(|i| msg(&i.to_string(), "user", "x")).collect();
        write(&fx.dirs, &fx.vault, "A", &r.token, doc(max)).unwrap();
    }

    #[test]
    fn unknown_fields_and_bad_values_are_rejected() {
        let fx = Fx::new(&["A"]);
        let r = read(&fx.dirs, &fx.vault, "A").unwrap();
        let mut extra_top = doc(vec![]);
        extra_top["toolResults"] = json!(["page text"]);
        let mut extra_msg = msg("1", "assistant", "x");
        extra_msg["toolOutput"] = json!("fetched page");
        let mut extra_src = msg("1", "assistant", "x");
        extra_src["sources"] = json!([{"kind": "web", "label": "l", "target": "https://a/", "text": "body"}]);
        let bad_role = msg("1", "system", "x");
        let mut bad_kind = msg("1", "assistant", "x");
        bad_kind["sources"] = json!([{"kind": "script", "label": "l", "target": "t"}]);
        let mut bad_chip = msg("1", "user", "x");
        bad_chip["chip"] = json!("rm");
        let mut v2 = doc(vec![]);
        v2["version"] = json!(2);
        let mut summary_extra = doc(vec![]);
        summary_extra["summary"] = json!({"text": "s", "tainted": false, "covers": 3, "raw": "x"});
        for d in [
            extra_top,
            doc(vec![extra_msg]),
            doc(vec![extra_src]),
            doc(vec![bad_role]),
            doc(vec![bad_kind]),
            doc(vec![bad_chip]),
            v2,
            summary_extra,
            json!("not a doc"),
        ] {
            assert_eq!(kind(write(&fx.dirs, &fx.vault, "A", &r.token, d.clone())), K::Io, "{d}");
        }
        assert_eq!(stats(&fx.dirs).unwrap().folders, 0);
    }

    #[test]
    fn full_messages_round_trip_with_taint_sources_chip_and_summary() {
        let fx = Fx::new(&["A"]);
        let r = read(&fx.dirs, &fx.vault, "A").unwrap();
        let mut m = msg("2", "assistant", "PCR [1]");
        m["tainted"] = json!(true);
        m["sources"] = json!([
            {"kind": "web", "label": "Protocol", "target": "https://example.org/p"},
            {"kind": "note", "label": "a.md", "target": "A/a.md"},
            {"kind": "paper", "label": "P", "target": "https://doi.org/10.1/x"}
        ]);
        let mut u = msg("1", "user", "make a section");
        u["chip"] = json!("unitOp");
        let mut d = doc(vec![u, m]);
        d["summary"] = json!({"text": "earlier", "tainted": true, "covers": 12});
        write(&fx.dirs, &fx.vault, "A", &r.token, d).unwrap();
        let back = read(&fx.dirs, &fx.vault, "A").unwrap().doc;
        assert_eq!(back.summary, Some(Summary { text: "earlier".into(), tainted: true, covers: 12 }));
        assert_eq!(back.messages[0].chip, Some(Chip::UnitOp));
        assert_eq!(back.messages[1].tainted, Some(true));
        assert_eq!(back.messages[1].sources.as_ref().unwrap().len(), 3);
        assert_eq!(back.folder, "A", "the folder is Rust's, not the document's");
        let wire = serde_json::to_value(&back).unwrap();
        assert_eq!(wire["messages"][0].get("tainted"), None, "absent optionals stay absent");
        assert_eq!(wire["messages"][0]["chip"], "unitOp");
    }

    #[test]
    fn a_token_from_another_vault_is_refused_and_nothing_is_written() {
        let fx = Fx::new(&["001_Exp"]);
        let other = fx.base.join("vault2");
        std::fs::create_dir_all(other.join("001_Exp")).unwrap();
        let from_first = read(&fx.dirs, &fx.vault, "001_Exp").unwrap();
        // The vault switched; the reply finishes and tries to write with the old token.
        let res = write(&fx.dirs, &other, "001_Exp", &from_first.token, doc(vec![msg("1", "user", "first vault")]));
        assert_eq!(kind(res), K::VaultChanged);
        assert_eq!(stats(&fx.dirs).unwrap().folders, 0);
        assert!(read(&fx.dirs, &other, "001_Exp").unwrap().doc.messages.is_empty());
        // A token for another folder of the same vault is refused too.
        std::fs::create_dir_all(fx.vault.join("002_Exp")).unwrap();
        assert_eq!(kind(write(&fx.dirs, &fx.vault, "002_Exp", &from_first.token, doc(vec![]))), K::VaultChanged);
        // A path-like token is only compared, never used.
        assert_eq!(kind(write(&fx.dirs, &fx.vault, "001_Exp", "..\\..\\x", doc(vec![]))), K::VaultChanged);
        assert_eq!(stats(&fx.dirs).unwrap().folders, 0);
    }

    #[test]
    fn a_corrupt_file_is_moved_aside_and_the_folder_starts_over() {
        let fx = Fx::new(&["A"]);
        let p = history_path(&fx.dirs, &fx.vault, "A").unwrap();
        std::fs::write(&p, "{not json").unwrap();
        let r = read(&fx.dirs, &fx.vault, "A").unwrap();
        assert!(r.doc.messages.is_empty());
        assert!(!p.exists());
        assert_eq!(std::fs::read_to_string(p.with_extension("json.bad")).unwrap(), "{not json");
        assert_eq!(stats(&fx.dirs).unwrap().folders, 0, "a set-aside file is not counted");
        clear(&fx.dirs, &fx.vault, "A").unwrap();
        assert!(!p.with_extension("json.bad").exists());
    }

    #[test]
    fn errors_serialise_as_kind_and_message() {
        let e = AssistantError::new(K::VaultChanged, "m");
        assert_eq!(serde_json::to_value(&e).unwrap(), json!({"kind": "vaultChanged", "message": "m"}));
        assert_eq!(serde_json::to_value(K::BadFolder).unwrap(), json!("badFolder"));
        assert_eq!(serde_json::to_value(K::NoVault).unwrap(), json!("noVault"));
        assert_eq!(serde_json::to_value(K::TooLarge).unwrap(), json!("tooLarge"));
    }

    #[test]
    fn a_missing_vault_root_is_no_vault() {
        let fx = Fx::new(&[]);
        assert_eq!(kind(read(&fx.dirs, &fx.base.join("gone"), "A")), K::NoVault);
    }
}
