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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;

use super::pack::{decode_png, is_skin_id, parse_manifest, Manifest, SkinError, SkinErrorKind as K, ValidPack, MAX_ENTRY_BYTES, MAX_MANIFEST_BYTES, STATES};
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
}
