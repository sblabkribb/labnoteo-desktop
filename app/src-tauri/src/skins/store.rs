//! Installed skins (assistant spec §8.3, plan Task 16): install, list, read
//! and remove, in the app data folder (per PC), never in a vault.
//!
//! - Staging: packs that Rust itself read and validated (import, gallery,
//!   editor-lite; later tasks) wait in memory under a random 128-bit hex id,
//!   at most [`STAGING_MAX`] entries for [`STAGING_TTL`], oldest evicted.
//!   There is no command that stages bytes from the webview.
//! - Install: `<app_local_data_dir>/assistant/skins/<id>-<sha8>/` holding only
//!   fixed names: `manifest.json` (re-serialised from the parsed struct, every
//!   state's sheet renamed to `<state>.png`) and `idle.png`, `talk.png`,
//!   `think.png`, `done.png` (the re-encoded sheets). No name from the archive
//!   reaches the disk. `sha8` is the first 8 hex digits of the SHA-256 of the
//!   installed bytes ([`content_hash`]). The same id with other content is
//!   refused with `exists` unless `replace` is set; the same content again is a
//!   no-op. The built-in skin's id is reserved.
//! - Read: every `skin_read` re-validates the installed files (manifest shape,
//!   fixed sheet names, PNG decode and sizes, and the content hash against the
//!   folder name). A file changed on disk is refused with `tampered`.
//! - The skins folder must not resolve inside the open vault (`io`).
//! - Import and export (Task 17): `skin_import_pick` asks Rust's own open
//!   dialog for a `.labnoteo-skin` file (the path never comes from the
//!   webview), refuses a file over [`MAX_PACK_BYTES`] before reading it,
//!   validates it and stages it; nothing is installed until `skin_install`.
//!   `skin_export(id)` writes a pack built from the re-validated installed
//!   files (or the built-in skin) through Rust's save dialog. Exported packs
//!   are deterministic (fixed entry order and timestamps) and pass
//!   [`validate_pack`] before they are written.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;

use super::pack::{
    decode_png, is_skin_id, parse_manifest, validate_pack, Manifest, SkinError, SkinErrorKind as K, ValidPack, MAX_ENTRY_BYTES,
    MAX_MANIFEST_BYTES, MAX_PACK_BYTES, STATES,
};
use crate::assistant::AssistantDirs;
use crate::vault::VaultState;

/// The built-in skin (served from `app/public/skins/flasko`); it cannot be
/// installed over, read from here or removed.
pub const BUILTIN_ID: &str = "flasko";
pub const STAGING_MAX: usize = 4;
pub const STAGING_TTL: Duration = Duration::from_secs(10 * 60);
const MANIFEST: &str = "manifest.json";

/// Serialises installs and removes (and the reads that follow them).
static LOCK: Mutex<()> = Mutex::new(());

fn err(kind: K, detail: &str) -> SkinError {
    SkinError::new(kind, Some(detail))
}

fn io(what: &str) -> impl Fn(std::io::Error) -> SkinError + '_ {
    move |_| err(K::Io, what)
}

// ---------------------------------------------------------------- staging

struct Staged {
    id: String,
    at: Instant,
    pack: ValidPack,
}

/// Packs validated by Rust and waiting for an explicit install (managed state).
#[derive(Default)]
pub struct SkinStaging(Mutex<Vec<Staged>>);

/// 128 random bits as 32 lowercase hex digits.
fn random_id() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("the OS random number generator failed");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

impl SkinStaging {
    pub fn stage(&self, pack: ValidPack) -> String {
        self.stage_at(pack, Instant::now())
    }

    /// Stages `pack` as of `now`; drops expired entries and evicts the oldest
    /// when full.
    pub fn stage_at(&self, pack: ValidPack, now: Instant) -> String {
        let mut v = self.0.lock().unwrap_or_else(|e| e.into_inner());
        v.retain(|s| now.saturating_duration_since(s.at) < STAGING_TTL);
        while v.len() >= STAGING_MAX {
            v.remove(0);
        }
        let id = random_id();
        v.push(Staged { id: id.clone(), at: now, pack });
        id
    }

    /// A copy of the staged pack, if it is still there at `now`.
    pub fn get_at(&self, id: &str, now: Instant) -> Option<ValidPack> {
        let mut v = self.0.lock().unwrap_or_else(|e| e.into_inner());
        v.retain(|s| now.saturating_duration_since(s.at) < STAGING_TTL);
        v.iter().find(|s| s.id == id).map(|s| s.pack.clone())
    }

    /// Forgets a staged pack (installed or cancelled). Returns whether it was there.
    pub fn discard(&self, id: &str) -> bool {
        let mut v = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let before = v.len();
        v.retain(|s| s.id != id);
        v.len() != before
    }
}

// ---------------------------------------------------------------- files

/// What `skin_read` returns: the manifest (sheets named `<state>.png`) and
/// each state's PNG bytes (a JSON byte array; the webview makes `blob:` URLs).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct SkinData {
    pub manifest: Manifest,
    pub sheets: BTreeMap<String, Vec<u8>>,
}

pub fn skins_dir(dirs: &AssistantDirs) -> PathBuf {
    dirs.0.join("skins")
}

fn sheet_name(state: &str) -> String {
    format!("{state}.png")
}

/// SHA-256 over the installed bytes: the manifest, then each state's sheet in
/// [`STATES`] order, each prefixed with its length.
pub fn content_hash(manifest: &[u8], sheets: &[Vec<u8>]) -> String {
    let mut h = Sha256::new();
    for part in std::iter::once(manifest).chain(sheets.iter().map(|s| s.as_slice())) {
        h.update((part.len() as u64).to_le_bytes());
        h.update(part);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// `<id>-<8 hex>` -> `(id, sha8)`.
fn split_dir_name(name: &str) -> Option<(&str, &str)> {
    let (id, sha8) = name.rsplit_once('-')?;
    (sha8.len() == 8 && sha8.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) && is_skin_id(id)).then_some((id, sha8))
}

/// The skins folder, created and canonical, refused when it is inside `vault`.
fn located(dirs: &AssistantDirs, vault: Option<&Path>) -> Result<PathBuf, SkinError> {
    let dir = skins_dir(dirs);
    std::fs::create_dir_all(&dir).map_err(io("skins folder"))?;
    let canon = std::fs::canonicalize(&dir).map_err(io("skins folder"))?;
    if let Some(root) = vault {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        if canon.starts_with(&root) {
            return Err(err(K::Io, "skins folder inside the vault"));
        }
    }
    Ok(canon)
}

/// Installed folders (real directories, not links) for each id, sorted.
fn installed(dir: &Path) -> Result<BTreeMap<String, Vec<(String, PathBuf)>>, SkinError> {
    let mut out: BTreeMap<String, Vec<(String, PathBuf)>> = BTreeMap::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(io("skins folder")(e)),
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() || ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some((id, sha8)) = split_dir_name(&name) {
            out.entry(id.to_string()).or_default().push((sha8.to_string(), entry.path()));
        }
    }
    for v in out.values_mut() {
        v.sort();
    }
    Ok(out)
}

/// Reads a regular file of at most `cap` bytes.
fn read_capped(path: &Path, cap: u64) -> Result<Vec<u8>, SkinError> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| err(K::Tampered, "missing file"))?;
    if !meta.is_file() || meta.len() > cap {
        return Err(err(K::Tampered, "file"));
    }
    std::fs::read(path).map_err(io("skin read"))
}

/// The manifest an install writes: the pack's, with each state's sheet renamed.
fn installed_manifest(pack: &Manifest) -> Manifest {
    let mut m = pack.clone();
    m.states.idle.sheet = sheet_name("idle");
    m.states.talk.sheet = sheet_name("talk");
    m.states.think.sheet = sheet_name("think");
    m.states.done.sheet = sheet_name("done");
    m
}

/// Re-validates one installed folder.
fn read_dir_skin(path: &Path, id: &str, sha8: &str) -> Result<SkinData, SkinError> {
    let mbytes = read_capped(&path.join(MANIFEST), MAX_MANIFEST_BYTES as u64)?;
    let manifest = parse_manifest(&mbytes).map_err(|_| err(K::Tampered, MANIFEST))?;
    if manifest.id != id {
        return Err(err(K::Tampered, MANIFEST));
    }
    let mut sheets = BTreeMap::new();
    let mut ordered = Vec::new();
    for (state, spec) in manifest.states.all() {
        let name = sheet_name(state);
        if spec.sheet != name {
            return Err(err(K::Tampered, MANIFEST));
        }
        let bytes = read_capped(&path.join(&name), MAX_ENTRY_BYTES)?;
        let (w, h, _) = decode_png(&name, &bytes).map_err(|_| err(K::Tampered, &name))?;
        if w != manifest.frame.width * spec.frames || h != manifest.frame.height {
            return Err(err(K::Tampered, &name));
        }
        ordered.push(bytes.clone());
        sheets.insert(state.to_string(), bytes);
    }
    if &content_hash(&mbytes, &ordered)[..8] != sha8 {
        return Err(err(K::Tampered, id));
    }
    Ok(SkinData { manifest, sheets })
}

/// Installs a validated pack. Returns the installed manifest.
pub fn install_pack(dirs: &AssistantDirs, vault: Option<&Path>, pack: &ValidPack, replace: bool) -> Result<Manifest, SkinError> {
    let id = pack.manifest.id.as_str();
    if id == BUILTIN_ID {
        return Err(err(K::Builtin, id));
    }
    let manifest = installed_manifest(&pack.manifest);
    let mbytes = serde_json::to_vec_pretty(&manifest).map_err(|_| err(K::Io, MANIFEST))?;
    let mut ordered = Vec::new();
    for (_, spec) in pack.manifest.states.all() {
        let bytes = pack.sheets.get(&spec.sheet).ok_or_else(|| err(K::SheetMissing, &spec.sheet))?;
        ordered.push(bytes.clone());
    }
    let sha8 = content_hash(&mbytes, &ordered)[..8].to_string();

    let dir = located(dirs, vault)?;
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let others: Vec<(String, PathBuf)> = installed(&dir)?.remove(id).unwrap_or_default();
    let same = others.iter().any(|(s, _)| *s == sha8);
    let stale: Vec<PathBuf> = others.into_iter().filter(|(s, _)| *s != sha8).map(|(_, p)| p).collect();
    if !stale.is_empty() && !replace {
        return Err(err(K::Exists, id));
    }
    if !same {
        // Write under a temp name, then move into place in one rename.
        let tmp = dir.join(format!(".tmp-{}", random_id()));
        let written = (|| -> Result<(), SkinError> {
            std::fs::create_dir(&tmp).map_err(io("skin write"))?;
            std::fs::write(tmp.join(MANIFEST), &mbytes).map_err(io("skin write"))?;
            for (state, bytes) in STATES.iter().zip(&ordered) {
                std::fs::write(tmp.join(sheet_name(state)), bytes).map_err(io("skin write"))?;
            }
            std::fs::rename(&tmp, dir.join(format!("{id}-{sha8}"))).map_err(io("skin write"))
        })();
        if let Err(e) = written {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
    }
    for p in stale {
        let _ = std::fs::remove_dir_all(p);
    }
    Ok(manifest)
}

/// Installs a staged pack and forgets the staging entry. An `exists` refusal
/// keeps the entry so the user can choose "replace".
pub fn install(
    dirs: &AssistantDirs,
    vault: Option<&Path>,
    staging: &SkinStaging,
    staging_id: &str,
    replace: bool,
    now: Instant,
) -> Result<Manifest, SkinError> {
    let pack = staging.get_at(staging_id, now).ok_or_else(|| SkinError::new(K::StagingUnknown, None))?;
    let m = install_pack(dirs, vault, &pack, replace)?;
    staging.discard(staging_id);
    Ok(m)
}

/// Installed skins' manifests (one per id; unreadable folders are skipped).
/// The built-in skin is not listed: the webview always has it.
pub fn list(dirs: &AssistantDirs) -> Result<Vec<Manifest>, SkinError> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = Vec::new();
    for (id, found) in installed(&skins_dir(dirs))? {
        for (_, path) in found {
            let Ok(bytes) = read_capped(&path.join(MANIFEST), MAX_MANIFEST_BYTES as u64) else { continue };
            match parse_manifest(&bytes) {
                Ok(m) if m.id == id => {
                    out.push(m);
                    break;
                }
                _ => continue,
            }
        }
    }
    Ok(out)
}

/// One installed skin, re-validated.
pub fn read(dirs: &AssistantDirs, id: &str) -> Result<SkinData, SkinError> {
    if !is_skin_id(id) || id == BUILTIN_ID {
        return Err(err(K::NotFound, id));
    }
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let found = installed(&skins_dir(dirs))?.remove(id).unwrap_or_default();
    let mut last = err(K::NotFound, id);
    for (sha8, path) in found {
        match read_dir_skin(&path, id, &sha8) {
            Ok(d) => return Ok(d),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Removes every installed folder of `id`.
pub fn remove(dirs: &AssistantDirs, id: &str) -> Result<(), SkinError> {
    if id == BUILTIN_ID {
        return Err(err(K::Builtin, id));
    }
    if !is_skin_id(id) {
        return Err(err(K::NotFound, id));
    }
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let found = installed(&skins_dir(dirs))?.remove(id).unwrap_or_default();
    if found.is_empty() {
        return Err(err(K::NotFound, id));
    }
    for (_, path) in found {
        std::fs::remove_dir_all(&path).map_err(io("skin remove"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------- import / export

/// The file extension of a skin pack.
pub const PACK_EXT: &str = "labnoteo-skin";

/// Rust's own open and save dialogs for pack files (the path never comes from
/// the webview). Blocking: commands call them inside `spawn_blocking`. Tests
/// and the IPC contract test use closures. `save` gets the suggested file name.
#[derive(Clone)]
pub struct SkinFileDialogs {
    pub open: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>,
    pub save: Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>,
}

impl SkinFileDialogs {
    /// The production dialogs (the dialog plugin, modal to the main window,
    /// as `skill.rs` `SkillPicker::dialog` does), filtered to `.labnoteo-skin`.
    pub fn dialog<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> SkinFileDialogs {
        let app2 = app.clone();
        SkinFileDialogs {
            open: Arc::new(move || {
                use tauri::Manager;
                use tauri_plugin_dialog::DialogExt;
                let mut b = app.dialog().file().add_filter("labnoteO skin", &[PACK_EXT]);
                if let Some(w) = app.get_webview_window("main") {
                    b = b.set_parent(&w);
                }
                b.blocking_pick_file().and_then(|p| p.into_path().ok())
            }),
            save: Arc::new(move |name: &str| {
                use tauri::Manager;
                use tauri_plugin_dialog::DialogExt;
                let mut b = app2.dialog().file().set_file_name(name).add_filter("labnoteO skin", &[PACK_EXT]);
                if let Some(w) = app2.get_webview_window("main") {
                    b = b.set_parent(&w);
                }
                b.blocking_save_file().and_then(|p| p.into_path().ok())
            }),
        }
    }
}

/// A staged pack as the webview sees it: the staging id, the manifest (sheets
/// named `<state>.png`) and each state's re-encoded PNG bytes.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StagedSkin {
    pub staging_id: String,
    pub manifest: Manifest,
    pub sheets: BTreeMap<String, Vec<u8>>,
}

/// Each state's sheet bytes of a validated pack (a shared sheet is repeated).
fn per_state(pack: &ValidPack) -> Result<BTreeMap<String, Vec<u8>>, SkinError> {
    let mut out = BTreeMap::new();
    for (state, spec) in pack.manifest.states.all() {
        let bytes = pack.sheets.get(&spec.sheet).ok_or_else(|| err(K::SheetMissing, &spec.sheet))?;
        out.insert(state.to_string(), bytes.clone());
    }
    Ok(out)
}

/// Stages a validated pack and returns what the import dialog shows.
pub fn stage_view(staging: &SkinStaging, pack: ValidPack) -> Result<StagedSkin, SkinError> {
    let manifest = installed_manifest(&pack.manifest);
    let sheets = per_state(&pack)?;
    let staging_id = staging.stage(pack);
    Ok(StagedSkin { staging_id, manifest, sheets })
}

/// Reads a picked pack file: a regular file of at most [`MAX_PACK_BYTES`],
/// checked by its size before anything is read (and capped while reading).
pub fn read_pack_file(path: &Path) -> Result<Vec<u8>, SkinError> {
    let meta = std::fs::metadata(path).map_err(io("pack file"))?;
    if !meta.is_file() {
        return Err(err(K::Io, "not a file"));
    }
    if meta.len() > MAX_PACK_BYTES as u64 {
        return Err(SkinError::new(K::TooLarge, None));
    }
    let f = std::fs::File::open(path).map_err(io("pack file"))?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    f.take(MAX_PACK_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(io("pack file"))?;
    if bytes.len() > MAX_PACK_BYTES {
        return Err(SkinError::new(K::TooLarge, None));
    }
    Ok(bytes)
}

/// Asks the open dialog for a pack file and reads and validates it. Cancel
/// gives `Ok(None)`.
fn pick_pack(dialogs: &SkinFileDialogs) -> Result<Option<ValidPack>, SkinError> {
    let Some(path) = (dialogs.open)() else { return Ok(None) };
    let bytes = read_pack_file(&path)?;
    validate_pack(&bytes).map(Some)
}

/// Asks the open dialog for a pack, validates and stages it. Cancel gives
/// `Ok(None)`. Nothing is installed.
pub fn import_pick(dialogs: &SkinFileDialogs, staging: &SkinStaging) -> Result<Option<StagedSkin>, SkinError> {
    pick_pack(dialogs)?.map(|pack| stage_view(staging, pack)).transpose()
}

/// Writes `entries` into a zip with fixed options (Deflated or Stored, fixed
/// timestamp and mode), so the same input always gives the same bytes.
fn zip_entries<'a>(entries: impl IntoIterator<Item = (String, &'a [u8])>, method: zip::CompressionMethod) -> Result<Vec<u8>, SkinError> {
    use zip::write::SimpleFileOptions;
    let opts = SimpleFileOptions::default()
        .compression_method(method)
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o644);
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        w.start_file(name, opts).map_err(|_| err(K::Io, "pack build"))?;
        w.write_all(bytes).map_err(|_| err(K::Io, "pack build"))?;
    }
    Ok(w.finish().map_err(|_| err(K::Io, "pack build"))?.into_inner())
}

/// A pack from a manifest (sheets named `<state>.png`) and each state's sheet:
/// `manifest.json`, then the four sheets in [`STATES`] order.
pub fn build_pack(manifest: &Manifest, sheets: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, SkinError> {
    let mbytes = serde_json::to_vec_pretty(manifest).map_err(|_| err(K::Io, MANIFEST))?;
    let mut entries: Vec<(String, &[u8])> = vec![(MANIFEST.to_string(), &mbytes)];
    for state in STATES {
        let bytes = sheets.get(state).ok_or_else(|| err(K::SheetMissing, state))?;
        entries.push((sheet_name(state), bytes));
    }
    zip_entries(entries, zip::CompressionMethod::Deflated)
}

/// The built-in skin's shipped files (`app/public/skins/flasko`), compiled in.
fn builtin_files() -> [(&'static str, &'static [u8]); 5] {
    macro_rules! f {
        ($n:literal) => {
            ($n, include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../public/skins/flasko/", $n)) as &[u8])
        };
    }
    [f!("manifest.json"), f!("idle.png"), f!("talk.png"), f!("think.png"), f!("done.png")]
}

/// The built-in skin, validated (and re-encoded) like any pack.
fn builtin_pack() -> Result<ValidPack, SkinError> {
    let zipped = zip_entries(builtin_files().into_iter().map(|(n, b)| (n.to_string(), b)), zip::CompressionMethod::Stored)?;
    validate_pack(&zipped)
}

/// The pack file name and bytes for `id` (installed and re-validated, or the
/// built-in skin). The bytes passed [`validate_pack`].
pub fn export_bytes(dirs: &AssistantDirs, id: &str) -> Result<(String, Vec<u8>), SkinError> {
    let (manifest, sheets) = if id == BUILTIN_ID {
        let pack = builtin_pack()?;
        (installed_manifest(&pack.manifest), per_state(&pack)?)
    } else {
        let data = read(dirs, id)?;
        (data.manifest, data.sheets)
    };
    let bytes = build_pack(&manifest, &sheets)?;
    validate_pack(&bytes)?;
    Ok((format!("{}.{PACK_EXT}", manifest.id), bytes))
}

/// Builds the pack, then asks the save dialog where to write it (temp file +
/// rename). Returns whether it was saved (`false` on cancel).
pub fn export(dirs: &AssistantDirs, dialogs: &SkinFileDialogs, id: &str) -> Result<bool, SkinError> {
    let (name, bytes) = export_bytes(dirs, id)?;
    let Some(path) = (dialogs.save)(&name) else { return Ok(false) };
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let tmp = parent.join(format!(".{}.tmp", random_id()));
    let written = (|| -> Result<(), SkinError> {
        std::fs::write(&tmp, &bytes).map_err(io("pack write"))?;
        std::fs::rename(&tmp, &path).map_err(io("pack write"))
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map(|()| true)
}

/// File work and dialogs block: keep them off the async runtime.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, SkinError> + Send + 'static) -> Result<T, SkinError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|_| err(K::Io, "skin task"))?
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn skin_install(
    vault: State<'_, VaultState>,
    dirs: State<'_, AssistantDirs>,
    staging: State<'_, SkinStaging>,
    staging_id: String,
    replace: bool,
) -> Result<Manifest, SkinError> {
    let root = vault.root().ok();
    install(&dirs, root.as_deref(), &staging, &staging_id, replace, Instant::now())
}

#[tauri::command]
pub fn skin_list(dirs: State<'_, AssistantDirs>) -> Result<Vec<Manifest>, SkinError> {
    list(&dirs)
}

#[tauri::command]
pub fn skin_read(dirs: State<'_, AssistantDirs>, id: String) -> Result<SkinData, SkinError> {
    read(&dirs, &id)
}

#[tauri::command]
pub fn skin_remove(dirs: State<'_, AssistantDirs>, id: String) -> Result<(), SkinError> {
    remove(&dirs, &id)
}

/// Picks a `.labnoteo-skin` file in Rust's open dialog, validates and stages
/// it. `null` on cancel. Takes no path; installs nothing.
#[tauri::command]
pub async fn skin_import_pick(dialogs: State<'_, SkinFileDialogs>, staging: State<'_, SkinStaging>) -> Result<Option<StagedSkin>, SkinError> {
    let dialogs = dialogs.inner().clone();
    let picked = blocking(move || pick_pack(&dialogs)).await?;
    picked.map(|pack| stage_view(&staging, pack)).transpose()
}

/// Drops a staged pack (the import dialog was cancelled). Returns whether it was there.
#[tauri::command]
pub fn skin_staging_discard(staging: State<'_, SkinStaging>, staging_id: String) -> bool {
    staging.discard(&staging_id)
}

/// Writes the skin `id` (installed or built-in) as a pack through Rust's save
/// dialog. Returns whether it was saved. Takes no path.
#[tauri::command]
pub async fn skin_export(dirs: State<'_, AssistantDirs>, dialogs: State<'_, SkinFileDialogs>, id: String) -> Result<bool, SkinError> {
    let dirs = AssistantDirs(dirs.0.clone());
    let dialogs = dialogs.inner().clone();
    blocking(move || export(&dirs, &dialogs, &id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skins::testpacks::*;
    use crate::skins::validate_pack;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// `<tmp>/vault` and `<tmp>/data/assistant`; removed on drop.
    struct Fx {
        base: PathBuf,
        vault: PathBuf,
        dirs: AssistantDirs,
    }

    impl Fx {
        fn new() -> Fx {
            let base = std::env::temp_dir().join(format!("labnoteo-skins-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
            let _ = std::fs::remove_dir_all(&base);
            let vault = base.join("vault");
            std::fs::create_dir_all(&vault).unwrap();
            Fx { dirs: AssistantDirs(base.join("data").join("assistant")), base, vault }
        }
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    /// Flasko renamed to `id` (optionally with another name, so the content differs).
    fn pack(id: &str, name: &str) -> ValidPack {
        let mut m = flasko_manifest();
        m["id"] = id.into();
        m["name"] = name.into();
        validate_pack(&flasko_pack_with(&m)).unwrap()
    }

    /// Flasko with one sheet shared by every state.
    fn shared_sheet_pack(id: &str) -> ValidPack {
        let mut m = flasko_manifest();
        m["id"] = id.into();
        for s in STATES {
            m["states"][s] = serde_json::json!({"sheet": "idle.png", "frames": 4, "fps": 4});
        }
        let mb = serde_json::to_vec(&m).unwrap();
        let idle = flasko_sheet("idle.png");
        validate_pack(&zip_with(&[("manifest.json", &mb), ("idle.png", &idle)], zip::CompressionMethod::Deflated)).unwrap()
    }

    fn files_under(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.file_type().unwrap().is_dir() {
                for f in files_under(&e.path()) {
                    out.push(format!("{name}/{f}"));
                }
            } else {
                out.push(name);
            }
        }
        out.sort();
        out
    }

    fn kind<T: std::fmt::Debug>(r: Result<T, SkinError>) -> K {
        r.expect_err("was accepted").kind
    }

    #[test]
    fn install_writes_only_fixed_names_in_the_skins_folder_never_the_vault() {
        let fx = Fx::new();
        let staging = SkinStaging::default();
        let id = staging.stage(shared_sheet_pack("flasko-blue"));
        let m = install(&fx.dirs, Some(&fx.vault), &staging, &id, false, Instant::now()).unwrap();
        assert_eq!(m.id, "flasko-blue");
        assert_eq!(m.states.talk.sheet, "talk.png", "every state gets its own fixed name");
        let files = files_under(&skins_dir(&fx.dirs));
        assert_eq!(files.len(), 5, "{files:?}");
        let (dir, _) = files[0].split_once('/').unwrap();
        let (sid, sha8) = split_dir_name(dir).unwrap();
        assert_eq!(sid, "flasko-blue");
        assert_eq!(sha8.len(), 8);
        let names: Vec<&str> = files.iter().map(|f| f.split_once('/').unwrap().1).collect();
        assert_eq!(names, ["done.png", "idle.png", "manifest.json", "talk.png", "think.png"]);
        assert!(std::fs::read_dir(&fx.vault).unwrap().next().is_none(), "nothing in the vault");
        assert!(!skins_dir(&fx.dirs).starts_with(&fx.vault));
        // Installed and read back, re-validated.
        let data = read(&fx.dirs, "flasko-blue").unwrap();
        assert_eq!(data.manifest, m);
        assert_eq!(data.sheets.keys().cloned().collect::<Vec<_>>(), ["done", "idle", "talk", "think"]);
        assert!(data.sheets.values().all(|b| b.starts_with(&[0x89, b'P', b'N', b'G'])));
        // The staging entry is used up.
        assert_eq!(kind(install(&fx.dirs, Some(&fx.vault), &staging, &id, false, Instant::now())), K::StagingUnknown);
    }

    #[test]
    fn a_skins_folder_inside_the_vault_is_refused() {
        let fx = Fx::new();
        let dirs = AssistantDirs(fx.vault.join("data").join("assistant"));
        let staging = SkinStaging::default();
        let id = staging.stage(pack("flasko-blue", "Blue"));
        assert_eq!(kind(install(&dirs, Some(&fx.vault), &staging, &id, false, Instant::now())), K::Io);
        assert!(!dirs.0.join("skins").read_dir().map(|mut d| d.next().is_some()).unwrap_or(false));
    }

    #[test]
    fn unknown_expired_and_evicted_staging_ids_are_refused() {
        let fx = Fx::new();
        let staging = SkinStaging::default();
        let t0 = Instant::now();
        assert_eq!(kind(install(&fx.dirs, None, &staging, "0123456789abcdef0123456789abcdef", false, t0)), K::StagingUnknown);
        let first = staging.stage_at(pack("skin-a", "A"), t0);
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
        // Expired after the TTL.
        assert_eq!(kind(install(&fx.dirs, None, &staging, &first, false, t0 + STAGING_TTL)), K::StagingUnknown);
        // Evicted: the oldest goes when a fifth is staged.
        let ids: Vec<String> = (0..5).map(|i| staging.stage_at(pack(&format!("skin-{i}"), "S"), t0)).collect();
        assert_ne!(ids[0], ids[1]);
        assert_eq!(kind(install(&fx.dirs, None, &staging, &ids[0], false, t0)), K::StagingUnknown);
        assert_eq!(install(&fx.dirs, None, &staging, &ids[4], false, t0).unwrap().id, "skin-4");
        // Discarded (a cancelled import).
        assert!(staging.discard(&ids[3]));
        assert_eq!(kind(install(&fx.dirs, None, &staging, &ids[3], false, t0)), K::StagingUnknown);
    }

    #[test]
    fn same_id_with_other_content_needs_replace() {
        let fx = Fx::new();
        let staging = SkinStaging::default();
        let a = staging.stage(pack("flasko-blue", "Blue"));
        install(&fx.dirs, None, &staging, &a, false, Instant::now()).unwrap();
        // The same content again is a no-op.
        let again = staging.stage(pack("flasko-blue", "Blue"));
        install(&fx.dirs, None, &staging, &again, false, Instant::now()).unwrap();
        assert_eq!(files_under(&skins_dir(&fx.dirs)).len(), 5);
        // Other content: refused, and the staged pack stays for "replace".
        let b = staging.stage(pack("flasko-blue", "Blue Two"));
        assert_eq!(kind(install(&fx.dirs, None, &staging, &b, false, Instant::now())), K::Exists);
        assert_eq!(read(&fx.dirs, "flasko-blue").unwrap().manifest.name, "Blue");
        install(&fx.dirs, None, &staging, &b, true, Instant::now()).unwrap();
        assert_eq!(read(&fx.dirs, "flasko-blue").unwrap().manifest.name, "Blue Two");
        assert_eq!(files_under(&skins_dir(&fx.dirs)).len(), 5, "the old copy is gone");
        assert_eq!(list(&fx.dirs).unwrap().len(), 1);
    }

    #[test]
    fn the_builtin_skin_cannot_be_installed_over_or_removed() {
        let fx = Fx::new();
        let staging = SkinStaging::default();
        let id = staging.stage(validate_pack(&flasko_pack()).unwrap());
        assert_eq!(kind(install(&fx.dirs, None, &staging, &id, true, Instant::now())), K::Builtin);
        assert_eq!(kind(remove(&fx.dirs, BUILTIN_ID)), K::Builtin);
        assert_eq!(kind(read(&fx.dirs, BUILTIN_ID)), K::NotFound);
    }

    #[test]
    fn list_and_remove() {
        let fx = Fx::new();
        assert!(list(&fx.dirs).unwrap().is_empty());
        let staging = SkinStaging::default();
        for (id, name) in [("skin-b", "B"), ("skin-a", "A")] {
            let s = staging.stage(pack(id, name));
            install(&fx.dirs, None, &staging, &s, false, Instant::now()).unwrap();
        }
        let ids: Vec<String> = list(&fx.dirs).unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["skin-a", "skin-b"]);
        remove(&fx.dirs, "skin-a").unwrap();
        assert_eq!(kind(read(&fx.dirs, "skin-a")), K::NotFound);
        assert_eq!(kind(remove(&fx.dirs, "skin-a")), K::NotFound);
        assert_eq!(kind(remove(&fx.dirs, "../x")), K::NotFound);
        assert_eq!(kind(read(&fx.dirs, "..\\x")), K::NotFound);
        assert_eq!(list(&fx.dirs).unwrap().len(), 1);
    }

    #[test]
    fn a_tampered_installed_file_is_refused_on_read() {
        let fx = Fx::new();
        let staging = SkinStaging::default();
        let s = staging.stage(pack("skin-t", "T"));
        install(&fx.dirs, None, &staging, &s, false, Instant::now()).unwrap();
        let dir = std::fs::read_dir(skins_dir(&fx.dirs)).unwrap().next().unwrap().unwrap().path();

        // A different but valid PNG of the same size: decodes, but the hash differs.
        let think = std::fs::read(dir.join("think.png")).unwrap();
        let (w, h, mut rgba) = decode_png("think.png", &think).unwrap();
        rgba[3] ^= 0xff;
        std::fs::write(dir.join("think.png"), crate::skins::pack::encode_rgba("x", w, h, &rgba).unwrap()).unwrap();
        assert_eq!(kind(read(&fx.dirs, "skin-t")), K::Tampered);

        // Garbage instead of a PNG.
        std::fs::write(dir.join("think.png"), b"<svg/>").unwrap();
        assert_eq!(kind(read(&fx.dirs, "skin-t")), K::Tampered);

        // Restored, then a manifest edit pointing at another name.
        std::fs::write(dir.join("think.png"), &think).unwrap();
        read(&fx.dirs, "skin-t").unwrap();
        let m = std::fs::read_to_string(dir.join("manifest.json")).unwrap();
        std::fs::write(dir.join("manifest.json"), m.replacen("\"idle.png\"", "\"talk.png\"", 1)).unwrap();
        assert_eq!(kind(read(&fx.dirs, "skin-t")), K::Tampered);

        // A missing file.
        std::fs::write(dir.join("manifest.json"), m).unwrap();
        std::fs::remove_file(dir.join("done.png")).unwrap();
        assert_eq!(kind(read(&fx.dirs, "skin-t")), K::Tampered);
    }

    #[test]
    fn folder_names_are_parsed_strictly() {
        assert_eq!(split_dir_name("flasko-blue-0a1b2c3d"), Some(("flasko-blue", "0a1b2c3d")));
        for bad in ["flasko-blue", "x-0a1b2c3d", "Flasko-0a1b2c3d", "skin-0A1B2C3D", ".tmp-0a1b2c3d", "skin-0a1b2c3"] {
            assert_eq!(split_dir_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn skin_data_serialises_sheets_as_byte_arrays() {
        let fx = Fx::new();
        let staging = SkinStaging::default();
        let s = staging.stage(pack("skin-j", "J"));
        install(&fx.dirs, None, &staging, &s, false, Instant::now()).unwrap();
        let v = serde_json::to_value(read(&fx.dirs, "skin-j").unwrap()).unwrap();
        assert_eq!(v["sheets"]["idle"][0], 0x89);
        assert_eq!(v["manifest"]["states"]["idle"]["sheet"], "idle.png");
    }

    // ------------------------------------------------------------ import / export (Task 17)

    fn dialogs(open: Option<PathBuf>, save: Option<PathBuf>) -> (SkinFileDialogs, Arc<Mutex<Vec<String>>>) {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let a = asked.clone();
        let d = SkinFileDialogs {
            open: Arc::new(move || open.clone()),
            save: Arc::new(move |name: &str| {
                a.lock().unwrap().push(name.to_string());
                save.clone()
            }),
        };
        (d, asked)
    }

    fn pixels(sheets: &BTreeMap<String, Vec<u8>>) -> BTreeMap<String, (u32, u32, Vec<u8>)> {
        sheets.iter().map(|(k, v)| (k.clone(), decode_png(k, v).unwrap())).collect()
    }

    #[test]
    fn export_then_import_round_trips_manifest_and_pixels_and_is_stable() {
        let fx = Fx::new();
        let staging = SkinStaging::default();
        let s = staging.stage(pack("flasko-blue", "Blue"));
        install(&fx.dirs, None, &staging, &s, false, Instant::now()).unwrap();
        let installed = read(&fx.dirs, "flasko-blue").unwrap();

        let (name, bytes) = export_bytes(&fx.dirs, "flasko-blue").unwrap();
        assert_eq!(name, "flasko-blue.labnoteo-skin");
        let (_, again) = export_bytes(&fx.dirs, "flasko-blue").unwrap();
        assert_eq!(bytes, again, "two exports of the same skin are byte-identical");

        // Import: the exported pack validates and stages the same manifest and pixels.
        let file = fx.base.join("out.labnoteo-skin");
        std::fs::write(&file, &bytes).unwrap();
        let (d, _) = dialogs(Some(file), None);
        let staged = import_pick(&d, &staging).unwrap().expect("picked");
        assert_eq!(staged.manifest, installed.manifest);
        assert_eq!(pixels(&staged.sheets), pixels(&installed.sheets));
        // Nothing is installed by the pick; the staged pack installs as the same skin.
        assert_eq!(list(&fx.dirs).unwrap().len(), 1);
        install(&fx.dirs, None, &staging, &staged.staging_id, false, Instant::now()).unwrap();
        assert_eq!(files_under(&skins_dir(&fx.dirs)).len(), 5, "same content: still one copy");
    }

    #[test]
    fn the_builtin_skin_exports_as_a_valid_pack() {
        let fx = Fx::new();
        let (name, bytes) = export_bytes(&fx.dirs, BUILTIN_ID).unwrap();
        assert_eq!(name, "flasko.labnoteo-skin");
        let v = validate_pack(&bytes).unwrap();
        assert_eq!(v.manifest.id, BUILTIN_ID);
        assert_eq!(v.manifest.licence, "CC0-1.0");
        let shipped: BTreeMap<String, Vec<u8>> = flasko_files().into_iter().skip(1).collect();
        assert_eq!(pixels(&v.sheets), pixels(&shipped));
        assert_eq!(kind(export_bytes(&fx.dirs, "not-there")), K::NotFound);
        assert_eq!(kind(export_bytes(&fx.dirs, "../x")), K::NotFound);
    }

    #[test]
    fn export_writes_where_the_save_dialog_points_and_cancel_writes_nothing() {
        let fx = Fx::new();
        let target = fx.base.join("saved").join("mine.labnoteo-skin");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        let (d, asked) = dialogs(None, Some(target.clone()));
        assert!(export(&fx.dirs, &d, BUILTIN_ID).unwrap());
        assert_eq!(asked.lock().unwrap().as_slice(), ["flasko.labnoteo-skin"]);
        validate_pack(&std::fs::read(&target).unwrap()).unwrap();
        let names: Vec<String> = std::fs::read_dir(target.parent().unwrap()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["mine.labnoteo-skin"], "no temp file left behind");

        let (cancel, asked) = dialogs(None, None);
        assert!(!export(&fx.dirs, &cancel, BUILTIN_ID).unwrap());
        assert_eq!(asked.lock().unwrap().len(), 1);
        // An unknown skin fails before any dialog opens.
        let (d, asked) = dialogs(None, Some(fx.base.join("x.labnoteo-skin")));
        assert_eq!(kind(export(&fx.dirs, &d, "skin-none")), K::NotFound);
        assert!(asked.lock().unwrap().is_empty());
        assert!(!fx.base.join("x.labnoteo-skin").exists());
    }

    #[test]
    fn import_pick_refuses_big_files_bad_packs_and_returns_none_on_cancel() {
        let fx = Fx::new();
        let staging = SkinStaging::default();
        let (cancel, _) = dialogs(None, None);
        assert!(import_pick(&cancel, &staging).unwrap().is_none());

        let big = fx.base.join("big.labnoteo-skin");
        std::fs::write(&big, vec![0u8; MAX_PACK_BYTES + 1]).unwrap();
        let (d, _) = dialogs(Some(big), None);
        assert_eq!(kind(import_pick(&d, &staging)), K::TooLarge);

        let dir = fx.base.join("a-folder");
        std::fs::create_dir_all(&dir).unwrap();
        let (d, _) = dialogs(Some(dir), None);
        assert_eq!(kind(import_pick(&d, &staging)), K::Io);

        let evil = fx.base.join("evil.labnoteo-skin");
        std::fs::write(&evil, zip_with(&[("manifest.json", b"{}"), ("x.svg", b"<svg/>")], zip::CompressionMethod::Stored)).unwrap();
        let (d, _) = dialogs(Some(evil), None);
        assert_eq!(kind(import_pick(&d, &staging)), K::FileNotAllowed);

        let missing = fx.base.join("gone.labnoteo-skin");
        let (d, _) = dialogs(Some(missing), None);
        assert_eq!(kind(import_pick(&d, &staging)), K::Io);
        assert!(list(&fx.dirs).unwrap().is_empty(), "nothing installed");
    }

    #[test]
    fn a_staged_import_can_be_discarded() {
        let fx = Fx::new();
        let staging = SkinStaging::default();
        let file = fx.base.join("p.labnoteo-skin");
        std::fs::write(&file, flasko_pack_with(&{
            let mut m = flasko_manifest();
            m["id"] = "skin-d".into();
            m
        }))
        .unwrap();
        let (d, _) = dialogs(Some(file), None);
        let staged = import_pick(&d, &staging).unwrap().unwrap();
        assert_eq!(staged.staging_id.len(), 32);
        let v = serde_json::to_value(&staged).unwrap();
        assert_eq!(v["stagingId"], staged.staging_id.as_str());
        assert_eq!(v["sheets"]["idle"][0], 0x89);
        assert!(staging.discard(&staged.staging_id));
        assert_eq!(kind(install(&fx.dirs, None, &staging, &staged.staging_id, false, Instant::now())), K::StagingUnknown);
    }
}
