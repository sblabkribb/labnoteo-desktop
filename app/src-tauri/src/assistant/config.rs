//! The per-PC `assistant.json` (assistant spec §7.1, plan Task 12, ruling R9).
//!
//! - Location: next to `settings.json` in the app config dir, never in a vault
//!   and never in the per-vault settings: a shared vault must not choose where
//!   this PC's web-search queries go.
//! - Shape: `{searxngUrl?, galleryUrl?}`. Rust validates on write and the
//!   network commands re-read the file on every call (the webview never passes
//!   a host, D8).
//! - The SearXNG address may be private (self-hosted instances are common,
//!   ruling R5); clear-text `http://` is accepted only for loopback or an
//!   origin the open vault lists in `allowHttpOrigins` (the same rule as the
//!   other integration URLs), and re-checked on every search.
//! - The gallery index address is `https://` only (loopback `http://` only in
//!   tests); it is used from Task 19 on.
//! - Reading is lenient: an unreadable file or an invalid entry gives "not set".

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use super::{AssistantError, AssistantErrorKind as K};
use crate::net::config::{is_loopback, parse_service_url, Url};
use crate::net::web_search::parse_searxng_url;
use crate::vault::{SettingsFile, VaultState};

/// Longest URL accepted in `assistant.json`, in chars.
pub const MAX_URL: usize = 2048;

/// What `assistant.json` holds (and what `assistant_config_read/write` answer).
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub searxng_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gallery_url: Option<String>,
}

/// What the webview may write: both fields, unknown fields refused. A missing,
/// `null` or blank field clears that setting.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantConfigIn {
    #[serde(default)]
    pub searxng_url: Option<String>,
    #[serde(default)]
    pub gallery_url: Option<String>,
}

/// `assistant.json` next to `settings.json`.
pub fn config_path(settings_file: &Path) -> PathBuf {
    settings_file.with_file_name("assistant.json")
}

/// A gallery index URL: `parse_service_url`, https only (loopback http in tests).
pub fn parse_gallery_url(raw: &str) -> Option<Url> {
    if raw.chars().count() > MAX_URL {
        return None;
    }
    let url = parse_service_url(raw)?;
    let ok = url.scheme() == "https" || (cfg!(test) && url.scheme() == "http" && is_loopback(&url));
    ok.then_some(url)
}

/// The text form stored for a URL: the parsed form without a lone trailing `/`.
fn stored_form(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

/// The stored config. Entries that no longer parse are dropped (the http rule
/// for SearXNG depends on the open vault, so it is checked at call time).
pub fn read_at(settings_file: &Path) -> AssistantConfig {
    let Some(v) = std::fs::read_to_string(config_path(settings_file))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    else {
        return AssistantConfig::default();
    };
    let field = |key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
    AssistantConfig {
        searxng_url: field("searxngUrl").filter(|s| s.chars().count() <= MAX_URL && parse_service_url(s).is_some()),
        gallery_url: field("galleryUrl").filter(|s| parse_gallery_url(s).is_some()),
    }
}

fn blank_to_none(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Validates and stores `cfg` (atomic write); returns what was stored.
/// `allow_http` is the open vault's `allowHttpOrigins` (empty with no vault).
pub fn write_at(settings_file: &Path, cfg: AssistantConfigIn, allow_http: &[String]) -> Result<AssistantConfig, AssistantError> {
    let searxng_url = match blank_to_none(cfg.searxng_url) {
        None => None,
        Some(raw) => Some(stored_form(&parse_searxng_url(&raw, allow_http).ok_or_else(|| {
            AssistantError::new(K::BadUrl, "the web search address is not valid")
        })?)),
    };
    let gallery_url = match blank_to_none(cfg.gallery_url) {
        None => None,
        Some(raw) => Some(stored_form(
            &parse_gallery_url(&raw).ok_or_else(|| AssistantError::new(K::BadUrl, "the gallery address is not valid"))?,
        )),
    };
    let stored = AssistantConfig { searxng_url, gallery_url };
    let body = serde_json::to_string_pretty(&stored).map_err(|e| AssistantError::new(K::Io, e.to_string()))?;
    crate::vault::fs::write_atomic(&config_path(settings_file), &body)
        .map_err(|e| AssistantError::new(K::Io, format!("cannot save assistant.json: {e}")))?;
    Ok(stored)
}

/// The open vault's `allowHttpOrigins` (empty with no vault open).
pub fn allow_http_of(settings_file: &Path, vault: &VaultState) -> Vec<String> {
    crate::net::config::ServiceConfig::load(settings_file, vault.root().ok().as_deref())
        .map(|c| c.allow_http)
        .unwrap_or_default()
}

#[tauri::command]
pub fn assistant_config_read(settings: State<'_, SettingsFile>) -> AssistantConfig {
    read_at(&settings.0)
}

#[tauri::command]
pub fn assistant_config_write(
    vault: State<'_, VaultState>,
    settings: State<'_, SettingsFile>,
    cfg: AssistantConfigIn,
) -> Result<AssistantConfig, AssistantError> {
    let allow = allow_http_of(&settings.0, &vault);
    write_at(&settings.0, cfg, &allow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-asstcfg-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(p.join("config")).unwrap();
            Scratch(p)
        }
        fn settings(&self) -> PathBuf {
            self.0.join("config").join("settings.json")
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn input(searxng: Option<&str>, gallery: Option<&str>) -> AssistantConfigIn {
        AssistantConfigIn { searxng_url: searxng.map(str::to_string), gallery_url: gallery.map(str::to_string) }
    }

    #[test]
    fn web_search_config_missing_file_gives_nothing_set() {
        let s = Scratch::new();
        assert_eq!(read_at(&s.settings()), AssistantConfig::default());
    }

    #[test]
    fn web_search_config_lives_next_to_settings_json_not_in_a_vault() {
        let s = Scratch::new();
        assert_eq!(config_path(&s.settings()), s.0.join("config").join("assistant.json"));
        write_at(&s.settings(), input(Some("https://search.example/searxng/"), None), &[]).unwrap();
        assert!(s.0.join("config").join("assistant.json").is_file());
        assert!(!s.settings().exists(), "settings.json is not touched");
    }

    #[test]
    fn web_search_config_round_trips_and_normalises() {
        let s = Scratch::new();
        let stored = write_at(&s.settings(), input(Some("  https://Search.Example/searxng/ "), Some("https://g.example/index.json")), &[]).unwrap();
        assert_eq!(stored.searxng_url.as_deref(), Some("https://search.example/searxng"));
        assert_eq!(stored.gallery_url.as_deref(), Some("https://g.example/index.json"));
        assert_eq!(read_at(&s.settings()), stored);
        let text = std::fs::read_to_string(config_path(&s.settings())).unwrap();
        assert!(text.contains("searxngUrl") && text.contains("galleryUrl"));
    }

    #[test]
    fn web_search_config_blank_clears() {
        let s = Scratch::new();
        write_at(&s.settings(), input(Some("https://search.example"), None), &[]).unwrap();
        let stored = write_at(&s.settings(), input(Some("   "), None), &[]).unwrap();
        assert_eq!(stored, AssistantConfig::default());
        assert_eq!(read_at(&s.settings()), AssistantConfig::default());
    }

    #[test]
    fn web_search_config_refuses_bad_urls_and_keeps_the_old_file() {
        let s = Scratch::new();
        write_at(&s.settings(), input(Some("https://search.example"), None), &[]).unwrap();
        for bad in [
            "ftp://search.example",
            "https://user:pw@search.example",
            "https://search.example/?q=x",
            "https://search.example/#top",
            "http://search.example",
            "not a url",
        ] {
            let e = write_at(&s.settings(), input(Some(bad), None), &[]).unwrap_err();
            assert_eq!(e.kind, K::BadUrl, "{bad}");
        }
        let e = write_at(&s.settings(), input(None, Some("http://g.example/index.json")), &[]).unwrap_err();
        assert_eq!(e.kind, K::BadUrl);
        assert_eq!(read_at(&s.settings()).searxng_url.as_deref(), Some("https://search.example"));
    }

    #[test]
    fn web_search_config_plain_http_needs_loopback_or_an_allowed_origin() {
        let s = Scratch::new();
        assert!(write_at(&s.settings(), input(Some("http://127.0.0.1:8888"), None), &[]).is_ok());
        assert!(write_at(&s.settings(), input(Some("http://localhost:8888/"), None), &[]).is_ok());
        // A private address is fine for SearXNG (R5) once its origin is allowed.
        assert!(write_at(&s.settings(), input(Some("http://192.168.0.5:8080"), None), &[]).is_err());
        let allowed = vec!["http://192.168.0.5:8080".to_string()];
        let stored = write_at(&s.settings(), input(Some("http://192.168.0.5:8080/"), None), &allowed).unwrap();
        assert_eq!(stored.searxng_url.as_deref(), Some("http://192.168.0.5:8080"));
    }

    #[test]
    fn web_search_config_unknown_fields_are_refused_on_write() {
        let r = serde_json::from_value::<AssistantConfigIn>(serde_json::json!({"searxngUrl": "https://s.example", "x": 1}));
        assert!(r.is_err());
    }

    #[test]
    fn web_search_config_corrupt_or_junk_file_reads_as_unset() {
        let s = Scratch::new();
        std::fs::write(config_path(&s.settings()), "{not json").unwrap();
        assert_eq!(read_at(&s.settings()), AssistantConfig::default());
        std::fs::write(config_path(&s.settings()), r#"{"searxngUrl": 5, "galleryUrl": "ftp://x"}"#).unwrap();
        assert_eq!(read_at(&s.settings()), AssistantConfig::default());
    }
}
