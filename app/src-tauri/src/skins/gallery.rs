//! The community skin gallery (assistant spec §8.5, plan Task 19).
//!
//! - Index: `skin_gallery_index()` reads the address from this PC's
//!   `assistant.json` (`galleryUrl`; empty = [`DEFAULT_INDEX_URL`]); the
//!   webview never passes one. `https://` only (plain `http://` only for a
//!   listed loopback port of a test policy), no redirects, at most
//!   [`MAX_INDEX_BYTES`], [`TIMEOUT`], at most [`MAX_INDEX_ENTRIES`] entries.
//!   A 404, a network error or a redirect is `galleryUnreachable` (no retry).
//!   Entry text is untrusted: control and bidi characters are stripped, and an
//!   entry that breaks a rule (id, lengths, licence outside the allowlist,
//!   sha256, size, pack path) is left out of the list.
//! - Pack path: relative, `^[A-Za-z0-9._/-]{1,200}$`, no `.`/`..`/empty
//!   segment, no leading `/` (so no `%`, `\`, `:`, `?` or `#` either); joined
//!   to the index's directory, and the result must keep the index's origin and
//!   directory prefix.
//! - Download: `skin_gallery_fetch(entryId)` takes the id only and looks it up
//!   in the index fetched last. At most [`MAX_PACK_BYTES`], no redirects, the
//!   size and SHA-256 must match the index (`galleryMismatch`), then
//!   [`validate_pack`]. The preview carries the manifest's licence; when it
//!   differs from the index's, the pack is **not staged** (no staging id), so
//!   it cannot be installed at all. Nothing is ever installed here: install
//!   goes through `skin_install` after the webview's confirm.
//! - Gallery text never reaches a model: no assistant tool reads it.
//! - Submit: `skin_submit_open(id)` builds a GitHub new-issue URL from an
//!   **installed** skin's re-validated manifest (fixed [`SUBMIT_PREFIX`],
//!   fields URL-encoded, at most [`MAX_SUBMIT_URL`] bytes, no token) and opens
//!   it in the system browser. A test exe built with `e2e-fakes` appends it to
//!   `<app_data_dir>/assistant/opened-urls.log` instead.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::header::CONTENT_LENGTH;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::State;

use super::pack::{clean_text, is_skin_id, validate_pack, Manifest, SkinError, SkinErrorKind as K, ValidPack, LICENCES, MAX_PACK_BYTES};
use super::store::{installed_manifest, per_state, SkinStaging, BUILTIN_ID};
use crate::assistant::AssistantDirs;
use crate::net::config::Url;
use crate::net::fetch_page::{app_policy, FetchPolicy};
use crate::vault::SettingsFile;

/// The gallery index used when `galleryUrl` is empty (the repo is drafted, not published yet).
pub const DEFAULT_INDEX_URL: &str = "https://raw.githubusercontent.com/ParkYaeseong/labnoteo-assistant-skins/main/index.json";
/// The submit page: the gallery repo's skin issue form.
pub const SUBMIT_PREFIX: &str = "https://github.com/ParkYaeseong/labnoteo-assistant-skins/issues/new?template=skin-submission.yml";
/// Query fields appended to [`SUBMIT_PREFIX`] (the issue form's field ids).
pub const SUBMIT_FIELDS: [&str; 4] = ["title", "skin-name", "author", "licence"];
pub const MAX_SUBMIT_URL: usize = 2048;
pub const MAX_INDEX_BYTES: usize = 256 * 1024;
pub const MAX_INDEX_ENTRIES: usize = 200;
pub const TIMEOUT: Duration = Duration::from_secs(15);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_PACK_PATH: usize = 200;
pub const NAME_MAX: usize = 40;
pub const AUTHOR_MAX: usize = 60;
pub const VERSION_MAX: usize = 16;
pub const DESCRIPTION_MAX: usize = 200;

fn err(kind: K, detail: &str) -> SkinError {
    SkinError::new(kind, Some(detail))
}

/// One skin as the gallery list shows it (all text sanitised; the pack
/// address stays in Rust).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GalleryEntry {
    pub id: String,
    pub name: String,
    pub author: String,
    pub licence: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub size: u64,
    pub sha256: String,
}

/// An entry with its resolved pack address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub entry: GalleryEntry,
    pub pack_url: Url,
}

/// A fetched index: where it came from and its valid entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GalleryIndex {
    pub url: Url,
    pub entries: Vec<Listed>,
}

/// What `skin_gallery_index` answers.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GalleryList {
    pub url: String,
    pub skins: Vec<GalleryEntry>,
}

/// The index fetched last (managed state); downloads look entries up here.
#[derive(Default)]
pub struct GalleryState(Mutex<Option<GalleryIndex>>);

impl GalleryState {
    pub fn set(&self, index: Option<GalleryIndex>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = index;
    }

    pub fn find(&self, id: &str) -> Option<Listed> {
        let g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        g.as_ref()?.entries.iter().find(|l| l.entry.id == id).cloned()
    }
}

/// A downloaded, validated pack as the gallery dialog shows it. `staging_id`
/// is `None` when the manifest's licence differs from the index's: such a
/// pack is shown but cannot be installed.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GalleryPreview {
    pub staging_id: Option<String>,
    pub manifest: Manifest,
    pub sheets: BTreeMap<String, Vec<u8>>,
    pub index_licence: String,
    pub licence_matches: bool,
}

// ---------------------------------------------------------------- addresses

/// Whether the gallery may contact `url`: https, or plain http on a loopback
/// port the policy lists.
pub fn url_allowed(url: &Url, policy: &FetchPolicy) -> bool {
    let no_userinfo = url.username().is_empty() && url.password().is_none();
    no_userinfo && (url.scheme() == "https" || (url.scheme() == "http" && policy.allows_loopback_url(url)))
}

/// The index's directory (its address without the last path segment).
fn index_dir(index: &Url) -> Option<Url> {
    let mut dir = index.join("./").ok()?;
    dir.set_query(None);
    dir.set_fragment(None);
    Some(dir)
}

/// Resolves an index `pack` path against the index address; `None` when the
/// path breaks a rule or the result leaves the index's origin or directory.
pub fn pack_url(index: &Url, pack: &str) -> Option<Url> {
    let ok_chars = pack.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'));
    if pack.is_empty() || pack.len() > MAX_PACK_PATH || !ok_chars || pack.starts_with('/') {
        return None;
    }
    if pack.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return None;
    }
    let dir = index_dir(index)?;
    let joined = dir.join(pack).ok()?;
    let same = joined.origin() == index.origin()
        && joined.as_str().starts_with(dir.as_str())
        && joined.query().is_none()
        && joined.fragment().is_none();
    same.then_some(joined)
}

// ---------------------------------------------------------------- index

fn text(v: &Value, key: &str, max: usize) -> Option<String> {
    let s = clean_text(v.get(key)?.as_str()?);
    (!s.is_empty() && s.chars().count() <= max).then_some(s)
}

fn parse_entry(index: &Url, v: &Value) -> Option<Listed> {
    let id = v.get("id")?.as_str()?;
    if !is_skin_id(id) || id == BUILTIN_ID {
        return None;
    }
    let licence = text(v, "licence", 32)?;
    if !LICENCES.contains(&licence.as_str()) {
        return None;
    }
    let description = match v.get("description") {
        None | Some(Value::Null) => None,
        Some(_) => Some(text(v, "description", DESCRIPTION_MAX)?),
    };
    let sha256 = v.get("sha256")?.as_str()?.to_ascii_lowercase();
    if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let size = v.get("size")?.as_u64()?;
    if size == 0 || size > MAX_PACK_BYTES as u64 {
        return None;
    }
    let pack_url = pack_url(index, v.get("pack")?.as_str()?)?;
    Some(Listed {
        entry: GalleryEntry {
            id: id.to_string(),
            name: text(v, "name", NAME_MAX)?,
            author: text(v, "author", AUTHOR_MAX)?,
            licence,
            version: text(v, "version", VERSION_MAX)?,
            description,
            size,
            sha256,
        },
        pack_url,
    })
}

/// Parses an index body: `{schema: 1, skins: [...]}`. Entries that break a
/// rule are left out; a repeated id keeps its first entry.
pub fn parse_index(index: &Url, body: &[u8]) -> Result<GalleryIndex, SkinError> {
    let v: Value = serde_json::from_slice(body).map_err(|_| err(K::GalleryInvalid, "index.json"))?;
    if v.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err(err(K::GalleryInvalid, "schema"));
    }
    let skins = v.get("skins").and_then(Value::as_array).ok_or_else(|| err(K::GalleryInvalid, "skins"))?;
    if skins.len() > MAX_INDEX_ENTRIES {
        return Err(err(K::GalleryInvalid, "skins"));
    }
    let mut entries: Vec<Listed> = Vec::new();
    for s in skins {
        if let Some(l) = parse_entry(index, s) {
            if !entries.iter().any(|e| e.entry.id == l.entry.id) {
                entries.push(l);
            }
        }
    }
    Ok(GalleryIndex { url: index.clone(), entries })
}

// ---------------------------------------------------------------- network

/// The gallery's own client: no proxy, no cookies, no redirects, no Referer.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .referer(false)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TIMEOUT)
            .user_agent(concat!("labnoteO/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("the gallery client builds")
    })
}

/// One GET: a 2xx body of at most `max` bytes. A network error, a redirect or
/// any other status is `galleryUnreachable`; a bigger body is `tooLarge`.
async fn get_capped(url: &Url, policy: &FetchPolicy, max: usize) -> Result<Vec<u8>, SkinError> {
    if !url_allowed(url, policy) {
        return Err(err(K::GalleryInvalid, "address"));
    }
    let resp = client().get(url.clone()).send().await.map_err(|e| {
        let what = if e.is_timeout() { "timeout" } else { "network" };
        err(K::GalleryUnreachable, what)
    })?;
    let status = resp.status().as_u16();
    if (300..400).contains(&status) {
        return Err(err(K::GalleryUnreachable, "redirect"));
    }
    if !(200..300).contains(&status) {
        return Err(err(K::GalleryUnreachable, &status.to_string()));
    }
    let declared = resp.headers().get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > max as u64) {
        return Err(SkinError::new(K::TooLarge, None));
    }
    crate::net::http::read_capped(resp, max).await.map_err(|e| match e.kind {
        crate::net::error::NetErrorKind::TooLarge => SkinError::new(K::TooLarge, None),
        crate::net::error::NetErrorKind::Timeout => err(K::GalleryUnreachable, "timeout"),
        _ => err(K::GalleryUnreachable, "network"),
    })
}

/// Fetches and parses the index at `url`.
pub async fn fetch_index(url: &Url, policy: &FetchPolicy) -> Result<GalleryIndex, SkinError> {
    let body = get_capped(url, policy, MAX_INDEX_BYTES).await?;
    parse_index(url, &body)
}

/// Lowercase hex SHA-256.
fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Downloads one listed pack, checks its size and SHA-256 against the index
/// and validates it.
pub async fn fetch_pack(listed: &Listed, policy: &FetchPolicy) -> Result<ValidPack, SkinError> {
    let bytes = get_capped(&listed.pack_url, policy, MAX_PACK_BYTES).await?;
    if bytes.len() as u64 != listed.entry.size {
        return Err(err(K::GalleryMismatch, "size"));
    }
    if sha256_hex(&bytes) != listed.entry.sha256 {
        return Err(err(K::GalleryMismatch, "sha256"));
    }
    tauri::async_runtime::spawn_blocking(move || validate_pack(&bytes))
        .await
        .map_err(|_| err(K::Io, "gallery"))?
}

/// The dialog's view of a downloaded pack; staged only when the licences match.
pub fn preview(pack: ValidPack, index_licence: &str, staging: &SkinStaging) -> Result<GalleryPreview, SkinError> {
    let manifest = installed_manifest(&pack.manifest);
    let sheets = per_state(&pack)?;
    let licence_matches = manifest.licence == index_licence;
    let staging_id = licence_matches.then(|| staging.stage(pack));
    Ok(GalleryPreview { staging_id, manifest, sheets, index_licence: index_licence.to_string(), licence_matches })
}

// ---------------------------------------------------------------- submit

/// Cuts `s` to at most `max` chars.
fn cut(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// The prefilled new-issue address for a skin. Fields are cut until the whole
/// address fits [`MAX_SUBMIT_URL`] bytes.
pub fn submit_url(m: &Manifest) -> String {
    let build = |name_max: usize, author_max: usize| -> String {
        let name = cut(&clean_text(&m.name), name_max);
        let author = cut(&clean_text(&m.author), author_max);
        let licence = cut(&clean_text(&m.licence), 32);
        let mut url = Url::parse(SUBMIT_PREFIX).expect("the submit prefix parses");
        url.query_pairs_mut()
            .append_pair(SUBMIT_FIELDS[0], &format!("Skin: {name}"))
            .append_pair(SUBMIT_FIELDS[1], &name)
            .append_pair(SUBMIT_FIELDS[2], &author)
            .append_pair(SUBMIT_FIELDS[3], &licence);
        url.to_string()
    };
    let (mut name_max, mut author_max) = (NAME_MAX, AUTHOR_MAX);
    loop {
        let url = build(name_max, author_max);
        if url.len() <= MAX_SUBMIT_URL || (name_max == 0 && author_max == 0) {
            return url;
        }
        if author_max >= name_max && author_max > 0 {
            author_max -= 1;
        } else {
            name_max = name_max.saturating_sub(1);
        }
    }
}

/// The submit address for the installed skin `id` (re-validated on read).
pub fn submit_url_for(dirs: &AssistantDirs, id: &str) -> Result<String, SkinError> {
    if id == BUILTIN_ID {
        return Err(err(K::Builtin, id));
    }
    let data = super::store::read(dirs, id)?;
    Ok(submit_url(&data.manifest))
}

/// `e2e-fakes`: the opened address goes to a log instead of a browser.
#[cfg(any(test, feature = "e2e-fakes"))]
pub fn log_opened_url(dirs: &AssistantDirs, url: &str) -> Result<(), SkinError> {
    use std::io::Write;
    std::fs::create_dir_all(&dirs.0).map_err(|_| err(K::Io, "opened-urls.log"))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dirs.0.join("opened-urls.log"))
        .map_err(|_| err(K::Io, "opened-urls.log"))?;
    writeln!(f, "{url}").map_err(|_| err(K::Io, "opened-urls.log"))
}

// ---------------------------------------------------------------- commands

/// The configured index address (empty = the default).
fn configured_index(settings: &SettingsFile) -> Result<Url, SkinError> {
    let raw = crate::assistant::config::read_at(&settings.0).gallery_url.unwrap_or_else(|| DEFAULT_INDEX_URL.to_string());
    crate::assistant::config::parse_gallery_url(&raw).ok_or_else(|| err(K::GalleryInvalid, "address"))
}

/// Fetches the gallery index from the address in `assistant.json`. Takes no address.
#[tauri::command]
pub async fn skin_gallery_index(settings: State<'_, SettingsFile>, gallery: State<'_, GalleryState>) -> Result<GalleryList, SkinError> {
    gallery.set(None);
    let url = configured_index(&settings)?;
    let index = fetch_index(&url, app_policy()).await?;
    let list = GalleryList { url: index.url.to_string(), skins: index.entries.iter().map(|l| l.entry.clone()).collect() };
    gallery.set(Some(index));
    Ok(list)
}

/// Downloads, verifies and validates the entry `entry_id` of the last index
/// and returns its preview. Installs nothing.
#[tauri::command]
pub async fn skin_gallery_fetch(
    gallery: State<'_, GalleryState>,
    staging: State<'_, SkinStaging>,
    entry_id: String,
) -> Result<GalleryPreview, SkinError> {
    let listed = gallery.find(&entry_id).ok_or_else(|| err(K::NotFound, &entry_id))?;
    let pack = fetch_pack(&listed, app_policy()).await?;
    preview(pack, &listed.entry.licence, &staging)
}

/// Opens the gallery's prefilled submit page for the installed skin `id`.
#[tauri::command]
pub fn skin_submit_open<R: tauri::Runtime>(app: tauri::AppHandle<R>, dirs: State<'_, AssistantDirs>, id: String) -> Result<(), SkinError> {
    let url = submit_url_for(&dirs, &id)?;
    #[cfg(feature = "e2e-fakes")]
    {
        let _ = app;
        log_opened_url(&dirs, &url)
    }
    #[cfg(not(feature = "e2e-fakes"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(url, None::<&str>).map_err(|_| err(K::Io, "browser"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::testserver::{serve, Canned, TestServer};
    use crate::skins::testpacks::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;
    use tauri::async_runtime::block_on;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn port_of(srv: &TestServer) -> u16 {
        url(&srv.url).port().unwrap()
    }

    fn allow(srv: &TestServer) -> FetchPolicy {
        FetchPolicy::with_loopback_ports(&[port_of(srv)])
    }

    fn entry_json(id: &str, licence: &str, pack: &str, sha: &str, size: usize) -> Value {
        serde_json::json!({"id": id, "name": "Flasko Teal", "author": "Kim", "licence": licence, "version": "1.0.0",
            "description": "A teal flask.", "pack": pack, "sha256": sha, "size": size})
    }

    fn index_json(skins: Vec<Value>) -> String {
        serde_json::json!({"schema": 1, "updated": "2026-11-10", "skins": skins}).to_string()
    }

    /// A Flasko pack renamed to `id` with `licence`, and its sha256 and size.
    fn teal(id: &str, licence: &str) -> (Vec<u8>, String, usize) {
        let mut m = flasko_manifest();
        m["id"] = id.into();
        m["name"] = "Flasko Teal".into();
        m["licence"] = licence.into();
        let bytes = flasko_pack_with(&m);
        let sha = sha256_hex(&bytes);
        let n = bytes.len();
        (bytes, sha, n)
    }

    fn listed(srv: &TestServer, path: &str, licence: &str, sha: &str, size: usize) -> Listed {
        let index = url(&format!("{}/repo/index.json", srv.url));
        parse_index(&index, index_json(vec![entry_json("teal-flask", licence, path, sha, size)]).as_bytes())
            .unwrap()
            .entries
            .remove(0)
    }

    const PNG_SVG: &[u8] = b"<svg xmlns='http://www.w3.org/2000/svg'/>";

    #[test]
    fn gallery_pack_paths_are_relative_and_stay_under_the_index_directory() {
        let index = url("https://raw.example/o/r/main/index.json");
        assert_eq!(
            pack_url(&index, "skins/teal-flask/teal-flask.labnoteo-skin").unwrap().as_str(),
            "https://raw.example/o/r/main/skins/teal-flask/teal-flask.labnoteo-skin"
        );
        assert_eq!(pack_url(&index, "a.labnoteo-skin").unwrap().as_str(), "https://raw.example/o/r/main/a.labnoteo-skin");
        for bad in [
            "https://evil.example/x.labnoteo-skin",
            "//evil.example/x.labnoteo-skin",
            "/o/r/main/x.labnoteo-skin",
            "../x.labnoteo-skin",
            "skins/../../x",
            "a/../b",
            "%2e%2e/x",
            "skins/%2e%2e/x",
            "a\\..\\b",
            "./x",
            "a//b",
            "a/./b",
            "a/b/",
            "",
            "a?b=1",
            "a#b",
            "C:x",
            "a b",
            "스킨.labnoteo-skin",
        ] {
            assert_eq!(pack_url(&index, bad), None, "{bad}");
        }
        assert_eq!(pack_url(&index, &"a".repeat(201)), None);
        assert!(pack_url(&index, &"a".repeat(200)).is_some());
    }

    #[test]
    fn gallery_addresses_are_https_or_a_listed_loopback_port() {
        let policy = FetchPolicy::with_loopback_ports(&[47900]);
        assert!(url_allowed(&url("https://raw.example/index.json"), &FetchPolicy::public_only()));
        assert!(!url_allowed(&url("http://raw.example/index.json"), &policy));
        assert!(!url_allowed(&url("http://127.0.0.1:47900/index.json"), &FetchPolicy::public_only()));
        assert!(url_allowed(&url("http://127.0.0.1:47900/index.json"), &policy));
        assert!(!url_allowed(&url("http://127.0.0.1:47901/index.json"), &policy));
        assert!(!url_allowed(&url("https://u:p@raw.example/index.json"), &policy));
        assert!(!url_allowed(&url("ftp://raw.example/index.json"), &policy));
    }

    #[test]
    fn gallery_index_parses_sanitises_and_drops_bad_entries() {
        let index = url("https://raw.example/o/r/main/index.json");
        let sha = "AB".repeat(32);
        let mut rtl = entry_json("rtl-skin", "MIT", "skins/rtl.labnoteo-skin", &sha, 100);
        rtl["name"] = "Evil\u{202E}gnp.exe\u{0007}".into();
        rtl["author"] = "\u{2066}Kim\u{2069}".into();
        let mut no_desc = entry_json("plain-skin", "CC0-1.0", "p.labnoteo-skin", &sha, 5);
        no_desc.as_object_mut().unwrap().remove("description");
        let mut long_name = entry_json("long-name", "MIT", "l.labnoteo-skin", &sha, 5);
        long_name["name"] = "x".repeat(41).into();
        let mut empty_name = entry_json("empty-name", "MIT", "e.labnoteo-skin", &sha, 5);
        empty_name["name"] = "\u{202E}\u{0000}".into();
        let body = index_json(vec![
            rtl,
            no_desc,
            entry_json("rtl-skin", "MIT", "dup.labnoteo-skin", &sha, 100),
            entry_json("Bad_Id", "MIT", "a.labnoteo-skin", &sha, 100),
            entry_json("flasko", "MIT", "a.labnoteo-skin", &sha, 100),
            entry_json("odd-licence", "GPL-3.0", "a.labnoteo-skin", &sha, 100),
            entry_json("bad-sha", "MIT", "a.labnoteo-skin", "abc", 100),
            entry_json("zero-size", "MIT", "a.labnoteo-skin", &sha, 0),
            entry_json("huge-size", "MIT", "a.labnoteo-skin", &sha, MAX_PACK_BYTES + 1),
            entry_json("outside", "MIT", "../a.labnoteo-skin", &sha, 100),
            entry_json("other-origin", "MIT", "https://evil.example/a.labnoteo-skin", &sha, 100),
            long_name,
            empty_name,
            serde_json::json!("not an object"),
        ]);
        let parsed = parse_index(&index, body.as_bytes()).unwrap();
        let ids: Vec<&str> = parsed.entries.iter().map(|l| l.entry.id.as_str()).collect();
        assert_eq!(ids, ["rtl-skin", "plain-skin"]);
        let first = &parsed.entries[0];
        assert_eq!(first.entry.name, "Evilgnp.exe");
        assert_eq!(first.entry.author, "Kim");
        assert_eq!(first.entry.sha256, "ab".repeat(32));
        assert_eq!(first.pack_url.as_str(), "https://raw.example/o/r/main/skins/rtl.labnoteo-skin");
        assert_eq!(parsed.entries[1].entry.description, None);
        // The list the webview sees has no pack address.
        let wire = serde_json::to_value(&first.entry).unwrap();
        assert!(wire.get("pack").is_none() && wire.get("packUrl").is_none(), "{wire}");
    }

    #[test]
    fn gallery_index_with_a_wrong_schema_or_too_many_entries_is_invalid() {
        let index = url("https://raw.example/index.json");
        for body in ["{not json", r#"{"schema":2,"skins":[]}"#, r#"{"schema":1}"#, r#"[1,2]"#] {
            assert_eq!(parse_index(&index, body.as_bytes()).unwrap_err().kind, K::GalleryInvalid, "{body}");
        }
        let many: Vec<Value> = (0..=MAX_INDEX_ENTRIES).map(|_| serde_json::json!({})).collect();
        assert_eq!(parse_index(&index, index_json(many).as_bytes()).unwrap_err().kind, K::GalleryInvalid);
        assert!(parse_index(&index, br#"{"schema":1,"updated":"2026-11-10","skins":[]}"#).unwrap().entries.is_empty());
    }

    #[test]
    fn gallery_index_404_network_error_and_redirect_are_unreachable() {
        let srv = serve(vec![Canned::status(404)]);
        let index = url(&format!("{}/index.json", srv.url));
        let e = block_on(fetch_index(&index, &allow(&srv))).unwrap_err();
        assert_eq!(e.kind, K::GalleryUnreachable);

        let srv = serve(vec![Canned::status(302).header("Location", "https://evil.example/index.json")]);
        let index = url(&format!("{}/index.json", srv.url));
        let e = block_on(fetch_index(&index, &allow(&srv))).unwrap_err();
        assert_eq!((e.kind, e.detail.as_deref()), (K::GalleryUnreachable, Some("redirect")));
        assert_eq!(srv.request_count(), 1, "the redirect is not followed");

        // Nothing listens on this port any more.
        let gone = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let index = url(&format!("http://127.0.0.1:{gone}/index.json"));
        let e = block_on(fetch_index(&index, &FetchPolicy::with_loopback_ports(&[gone]))).unwrap_err();
        assert_eq!(e.kind, K::GalleryUnreachable);
    }

    #[test]
    fn gallery_index_over_256_kib_is_too_large_and_plain_http_needs_the_policy() {
        let big = vec![b' '; MAX_INDEX_BYTES + 1];
        let srv = serve(vec![Canned::ok("").body(big)]);
        let index = url(&format!("{}/index.json", srv.url));
        assert_eq!(block_on(fetch_index(&index, &allow(&srv))).unwrap_err().kind, K::TooLarge);

        let srv = serve(vec![Canned::ok(&index_json(vec![]))]);
        let index = url(&format!("{}/index.json", srv.url));
        let e = block_on(fetch_index(&index, &FetchPolicy::public_only())).unwrap_err();
        assert_eq!(e.kind, K::GalleryInvalid);
        assert_eq!(srv.request_count(), 0, "nothing is sent to an address that is not allowed");
        let ok = block_on(fetch_index(&index, &allow(&srv))).unwrap();
        assert!(ok.entries.is_empty());
    }

    #[test]
    fn gallery_good_pack_downloads_verifies_and_validates() {
        let (bytes, sha, size) = teal("teal-flask", "CC0-1.0");
        let srv = serve(vec![Canned::status(200).header("Content-Type", "application/zip").body(bytes)]);
        let l = listed(&srv, "skins/teal.labnoteo-skin", "CC0-1.0", &sha, size);
        assert_eq!(l.pack_url.as_str(), format!("{}/repo/skins/teal.labnoteo-skin", srv.url));
        let pack = block_on(fetch_pack(&l, &allow(&srv))).unwrap();
        assert_eq!(pack.manifest.id, "teal-flask");
        assert_eq!(pack.sha256, sha);
        let reqs = srv.requests.lock().unwrap();
        assert_eq!(reqs[0].path, "/repo/skins/teal.labnoteo-skin");
        assert!(reqs[0].header("cookie").is_none() && reqs[0].header("authorization").is_none());
    }

    #[test]
    fn gallery_sha_or_size_mismatch_oversize_and_redirect_are_refused() {
        let (bytes, sha, size) = teal("teal-flask", "CC0-1.0");
        let policy_for = |srv: &TestServer| allow(srv);

        let srv = serve(vec![Canned::status(200).body(bytes.clone())]);
        let l = listed(&srv, "t.labnoteo-skin", "CC0-1.0", &"0".repeat(64), size);
        let e = block_on(fetch_pack(&l, &policy_for(&srv))).unwrap_err();
        assert_eq!((e.kind, e.detail.as_deref()), (K::GalleryMismatch, Some("sha256")));

        let srv = serve(vec![Canned::status(200).body(bytes.clone())]);
        let l = listed(&srv, "t.labnoteo-skin", "CC0-1.0", &sha, size - 1);
        let e = block_on(fetch_pack(&l, &policy_for(&srv))).unwrap_err();
        assert_eq!((e.kind, e.detail.as_deref()), (K::GalleryMismatch, Some("size")));

        let srv = serve(vec![Canned::status(200).body(vec![0u8; MAX_PACK_BYTES + 1])]);
        let l = listed(&srv, "t.labnoteo-skin", "CC0-1.0", &sha, size);
        assert_eq!(block_on(fetch_pack(&l, &policy_for(&srv))).unwrap_err().kind, K::TooLarge);

        let srv = serve(vec![Canned::status(302).header("Location", "https://evil.example/t.labnoteo-skin")]);
        let l = listed(&srv, "t.labnoteo-skin", "CC0-1.0", &sha, size);
        let e = block_on(fetch_pack(&l, &policy_for(&srv))).unwrap_err();
        assert_eq!((e.kind, e.detail.as_deref()), (K::GalleryUnreachable, Some("redirect")));
        assert_eq!(srv.request_count(), 1);
    }

    #[test]
    fn gallery_a_matching_but_malicious_pack_still_fails_validation() {
        let m = serde_json::to_vec(&flasko_manifest()).unwrap();
        let evil = zip_with(&[("manifest.json", &m), ("x.svg", PNG_SVG)], zip::CompressionMethod::Deflated);
        let sha = sha256_hex(&evil);
        let n = evil.len();
        let srv = serve(vec![Canned::status(200).body(evil)]);
        let l = listed(&srv, "evil.labnoteo-skin", "CC0-1.0", &sha, n);
        assert_eq!(block_on(fetch_pack(&l, &allow(&srv))).unwrap_err().kind, K::FileNotAllowed);
    }

    #[test]
    fn gallery_licence_mismatch_is_shown_but_not_staged() {
        let staging = SkinStaging::default();
        let (bytes, _, _) = teal("teal-flask", "MIT");
        let pack = validate_pack(&bytes).unwrap();
        let p = preview(pack.clone(), "CC0-1.0", &staging).unwrap();
        assert_eq!((p.staging_id.as_deref(), p.licence_matches), (None, false));
        assert_eq!((p.manifest.licence.as_str(), p.index_licence.as_str()), ("MIT", "CC0-1.0"));
        assert_eq!(p.sheets.len(), 4);
        let ok = preview(pack, "MIT", &staging).unwrap();
        assert!(ok.licence_matches);
        let id = ok.staging_id.unwrap();
        assert!(staging.get_at(&id, Instant::now()).is_some());
        let wire = serde_json::to_value(&ok.manifest).unwrap();
        assert_eq!(wire["states"]["idle"]["sheet"], "idle.png");
    }

    #[test]
    fn gallery_state_looks_up_only_the_last_index() {
        let state = GalleryState::default();
        assert_eq!(state.find("teal-flask"), None);
        let index = url("https://raw.example/index.json");
        let parsed = parse_index(&index, index_json(vec![entry_json("teal-flask", "MIT", "t.labnoteo-skin", &"a".repeat(64), 9)]).as_bytes()).unwrap();
        state.set(Some(parsed));
        assert_eq!(state.find("teal-flask").unwrap().pack_url.as_str(), "https://raw.example/t.labnoteo-skin");
        assert_eq!(state.find("other"), None);
        state.set(None);
        assert_eq!(state.find("teal-flask"), None);
    }

    fn manifest(name: &str, author: &str, licence: &str) -> Manifest {
        let mut m: Manifest = serde_json::from_value(flasko_manifest()).unwrap();
        m.id = "teal-flask".into();
        m.name = name.into();
        m.author = author.into();
        m.licence = licence.into();
        m
    }

    #[test]
    fn gallery_submit_url_is_exact_encoded_and_has_no_token() {
        let url = submit_url(&manifest("Flasko Teal & co", "홍 길동", "CC-BY-4.0"));
        assert_eq!(
            url,
            "https://github.com/ParkYaeseong/labnoteo-assistant-skins/issues/new?template=skin-submission.yml\
             &title=Skin%3A+Flasko+Teal+%26+co&skin-name=Flasko+Teal+%26+co\
             &author=%ED%99%8D+%EA%B8%B8%EB%8F%99&licence=CC-BY-4.0"
        );
        assert!(url.starts_with(SUBMIT_PREFIX));
        let lower = url.to_ascii_lowercase();
        assert!(!lower.contains("token") && !lower.contains("access") && !lower.contains("key="), "{url}");
        let parsed = Url::parse(&url).unwrap();
        let keys: Vec<String> = parsed.query_pairs().map(|(k, _)| k.into_owned()).collect();
        assert_eq!(keys, ["template", "title", "skin-name", "author", "licence"]);
    }

    #[test]
    fn gallery_submit_url_is_cut_to_2_kib() {
        let url = submit_url(&manifest(&"가".repeat(500), &"나".repeat(500), "MIT"));
        assert!(url.len() <= MAX_SUBMIT_URL, "{}", url.len());
        let parsed = Url::parse(&url).unwrap();
        let pairs: BTreeMap<String, String> = parsed.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(pairs["skin-name"].chars().count(), NAME_MAX);
        assert_eq!(pairs["author"].chars().count(), AUTHOR_MAX);
        assert_eq!(pairs["licence"], "MIT");
        // Bidi and control characters never reach the address.
        let url = submit_url(&manifest("A\u{202E}B\u{0007}", "K", "MIT"));
        assert!(url.contains("skin-name=AB&"), "{url}");
    }

    static N: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn gallery_submit_needs_an_installed_skin_and_the_e2e_log_appends() {
        let base = std::env::temp_dir().join(format!("labnoteo-gallery-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&base);
        let dirs = AssistantDirs(base.join("assistant"));
        assert_eq!(submit_url_for(&dirs, "flasko").unwrap_err().kind, K::Builtin);
        assert_eq!(submit_url_for(&dirs, "teal-flask").unwrap_err().kind, K::NotFound);
        let (bytes, _, _) = teal("teal-flask", "CC-BY-4.0");
        let pack = validate_pack(&bytes).unwrap();
        crate::skins::store::install_pack(&dirs, None, &pack, false).unwrap();
        let url = submit_url_for(&dirs, "teal-flask").unwrap();
        assert!(url.starts_with(SUBMIT_PREFIX) && url.contains("&licence=CC-BY-4.0"), "{url}");
        log_opened_url(&dirs, &url).unwrap();
        log_opened_url(&dirs, "https://example.org/second").unwrap();
        let log = std::fs::read_to_string(dirs.0.join("opened-urls.log")).unwrap();
        assert_eq!(log, format!("{url}\nhttps://example.org/second\n"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn gallery_default_index_is_the_drafted_repo_and_is_https() {
        assert!(DEFAULT_INDEX_URL.starts_with("https://raw.githubusercontent.com/ParkYaeseong/labnoteo-assistant-skins/"));
        assert!(crate::assistant::config::parse_gallery_url(DEFAULT_INDEX_URL).is_some());
        assert_eq!(SUBMIT_FIELDS, ["title", "skin-name", "author", "licence"]);
    }
}
