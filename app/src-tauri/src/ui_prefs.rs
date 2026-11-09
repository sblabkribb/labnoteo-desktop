//! App-wide UI layout preferences (sidebar widths, which sidebars are open,
//! the active tabs, row density), kept in `ui.json` next to `settings.json` in
//! the app config dir. Not per vault and not a secret.
//!
//! Every field is validated on read and on write: a width out of range is
//! clamped, an unknown tab or density falls back to its default, unknown
//! fields are dropped, and a missing or damaged file means the defaults. The
//! front end reads this before the window is shown so the first frame already
//! has the remembered layout.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::vault::fs::{write_atomic, FsError};
use crate::vault::SettingsFile;

pub const LEFT_MIN: u16 = 200;
pub const LEFT_MAX: u16 = 480;
pub const LEFT_DEFAULT: u16 = 272;
pub const RIGHT_MIN: u16 = 220;
pub const RIGHT_MAX: u16 = 480;
pub const RIGHT_DEFAULT: u16 = 280;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LeftTab {
    #[default]
    Files,
    Experiments,
    Samples,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RightTab {
    #[default]
    Outline,
    Links,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Density {
    #[default]
    Comfortable,
    Compact,
}

/// Deserialised leniently from any JSON value (see `From<Value>`): a bad field
/// takes its default without discarding the good ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", from = "Value")]
pub struct UiPrefs {
    pub left_width: u16,
    pub left_hidden: bool,
    pub left_tab: LeftTab,
    pub right_width: u16,
    pub right_open: bool,
    pub right_tab: RightTab,
    pub density: Density,
    pub show_system_files: bool,
}

impl Default for UiPrefs {
    fn default() -> Self {
        UiPrefs {
            left_width: LEFT_DEFAULT,
            left_hidden: false,
            left_tab: LeftTab::Files,
            right_width: RIGHT_DEFAULT,
            right_open: false,
            right_tab: RightTab::Outline,
            density: Density::Comfortable,
            show_system_files: false,
        }
    }
}

impl UiPrefs {
    /// Widths into their ranges. The enums are valid by construction.
    pub fn clamp(self) -> Self {
        UiPrefs {
            left_width: self.left_width.clamp(LEFT_MIN, LEFT_MAX),
            right_width: self.right_width.clamp(RIGHT_MIN, RIGHT_MAX),
            ..self
        }
    }
}

/// A finite JSON number as a width (rounded; negatives and huge values saturate
/// so `clamp` brings them into range).
fn width(v: Option<&Value>, default: u16) -> u16 {
    match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() => n.round().clamp(0.0, f64::from(u16::MAX)) as u16,
        _ => default,
    }
}

fn flag(v: Option<&Value>, default: bool) -> bool {
    v.and_then(Value::as_bool).unwrap_or(default)
}

impl From<Value> for UiPrefs {
    fn from(v: Value) -> Self {
        let d = UiPrefs::default();
        let s = |k: &str| v.get(k).and_then(Value::as_str);
        UiPrefs {
            left_width: width(v.get("leftWidth"), d.left_width),
            left_hidden: flag(v.get("leftHidden"), d.left_hidden),
            left_tab: match s("leftTab") {
                Some("experiments") => LeftTab::Experiments,
                Some("samples") => LeftTab::Samples,
                _ => LeftTab::Files,
            },
            right_width: width(v.get("rightWidth"), d.right_width),
            right_open: flag(v.get("rightOpen"), d.right_open),
            right_tab: match s("rightTab") {
                Some("links") => RightTab::Links,
                _ => RightTab::Outline,
            },
            density: match s("density") {
                Some("compact") => Density::Compact,
                _ => Density::Comfortable,
            },
            show_system_files: flag(v.get("showSystemFiles"), d.show_system_files),
        }
        .clamp()
    }
}

/// `ui.json` next to `settings.json`.
pub fn ui_path(settings_file: &Path) -> PathBuf {
    settings_file.with_file_name("ui.json")
}

/// The stored prefs; anything unusable gives the defaults.
pub fn read_at(settings_file: &Path) -> UiPrefs {
    std::fs::read_to_string(ui_path(settings_file))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(UiPrefs::from)
        .unwrap_or_default()
}

/// Clamp and store `prefs` (atomic write); returns what was stored.
pub fn write_at(settings_file: &Path, prefs: UiPrefs) -> Result<UiPrefs, FsError> {
    let prefs = prefs.clamp();
    let body = serde_json::to_string(&prefs).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    write_atomic(&ui_path(settings_file), &body)?;
    Ok(prefs)
}

#[tauri::command]
pub fn ui_prefs_read(settings: tauri::State<'_, SettingsFile>) -> UiPrefs {
    read_at(&settings.0)
}

#[tauri::command]
pub fn ui_prefs_write(settings: tauri::State<'_, SettingsFile>, prefs: UiPrefs) -> Result<UiPrefs, FsError> {
    write_at(&settings.0, prefs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-uiprefs-{}-{}",
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

    #[test]
    fn ui_prefs_missing_file_gives_defaults() {
        let s = Scratch::new();
        let p = read_at(&s.settings());
        assert_eq!(p, UiPrefs::default());
        assert_eq!(p.left_width, 272);
        assert_eq!(p.right_width, 280);
        assert!(!p.right_open && !p.left_hidden && !p.show_system_files);
    }

    #[test]
    fn ui_prefs_corrupt_file_gives_defaults() {
        let s = Scratch::new();
        for bad in ["{not json", "", "[]", "42", "null"] {
            std::fs::write(ui_path(&s.settings()), bad).unwrap();
            assert_eq!(read_at(&s.settings()), UiPrefs::default(), "{bad:?}");
        }
    }

    #[test]
    fn ui_prefs_widths_are_clamped() {
        let p = UiPrefs::from(json!({ "leftWidth": 10, "rightWidth": 9999 }));
        assert_eq!((p.left_width, p.right_width), (200, 480));
        let p = UiPrefs::from(json!({ "leftWidth": -5, "rightWidth": 1e12 }));
        assert_eq!((p.left_width, p.right_width), (200, 480));
        let p = UiPrefs::from(json!({ "leftWidth": 333.6, "rightWidth": "wide" }));
        assert_eq!((p.left_width, p.right_width), (334, 280));
        let p = UiPrefs { left_width: 1000, right_width: 0, ..UiPrefs::default() }.clamp();
        assert_eq!((p.left_width, p.right_width), (480, 220));
    }

    #[test]
    fn ui_prefs_unknown_tab_or_density_gives_default() {
        let p = UiPrefs::from(json!({ "leftTab": "outline", "rightTab": "files", "density": "tiny" }));
        assert_eq!((p.left_tab, p.right_tab, p.density), (LeftTab::Files, RightTab::Outline, Density::Comfortable));
        let p = UiPrefs::from(json!({ "leftTab": "samples", "rightTab": "links", "density": "compact" }));
        assert_eq!((p.left_tab, p.right_tab, p.density), (LeftTab::Samples, RightTab::Links, Density::Compact));
    }

    #[test]
    fn ui_prefs_bad_field_keeps_the_good_ones() {
        let p = UiPrefs::from(json!({ "leftHidden": "yes", "rightOpen": true, "leftWidth": 300 }));
        assert!(!p.left_hidden);
        assert!(p.right_open);
        assert_eq!(p.left_width, 300);
    }

    #[test]
    fn ui_prefs_unknown_fields_are_dropped() {
        let s = Scratch::new();
        std::fs::write(ui_path(&s.settings()), r#"{"leftWidth":300,"apiKey":"x","extra":1}"#).unwrap();
        let p = read_at(&s.settings());
        let out = serde_json::to_value(write_at(&s.settings(), p).unwrap()).unwrap();
        let keys: Vec<&String> = out.as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 8);
        assert!(out.get("apiKey").is_none() && out.get("extra").is_none());
        let stored = std::fs::read_to_string(ui_path(&s.settings())).unwrap();
        assert!(!stored.contains("apiKey") && !stored.contains("extra"));
        // deserialising (the IPC argument path) drops them too
        let ipc: UiPrefs = serde_json::from_str(r#"{"leftWidth":250,"bogus":true}"#).unwrap();
        assert_eq!(ipc.left_width, 250);
    }

    #[test]
    fn ui_prefs_write_then_read_round_trips_camel_case() {
        let s = Scratch::new();
        let prefs = UiPrefs {
            left_width: 350,
            left_hidden: true,
            left_tab: LeftTab::Experiments,
            right_width: 300,
            right_open: true,
            right_tab: RightTab::Links,
            density: Density::Compact,
            show_system_files: true,
        };
        assert_eq!(write_at(&s.settings(), prefs.clone()).unwrap(), prefs);
        assert_eq!(read_at(&s.settings()), prefs);
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(ui_path(&s.settings())).unwrap()).unwrap();
        assert_eq!(
            raw,
            json!({ "leftWidth": 350, "leftHidden": true, "leftTab": "experiments", "rightWidth": 300,
                    "rightOpen": true, "rightTab": "links", "density": "compact", "showSystemFiles": true })
        );
    }

    #[test]
    fn ui_prefs_write_clamps() {
        let s = Scratch::new();
        let out = write_at(&s.settings(), UiPrefs { left_width: 5, ..UiPrefs::default() }).unwrap();
        assert_eq!(out.left_width, 200);
        assert_eq!(read_at(&s.settings()).left_width, 200);
    }

    #[test]
    fn ui_prefs_file_is_next_to_settings_json() {
        let s = Scratch::new();
        assert_eq!(ui_path(&s.settings()), s.0.join("config").join("ui.json"));
        write_at(&s.settings(), UiPrefs::default()).unwrap();
        assert!(s.0.join("config").join("ui.json").is_file());
        assert!(!s.settings().exists(), "settings.json is not touched");
    }
}
