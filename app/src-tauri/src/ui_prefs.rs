//! App-wide UI layout preferences (sidebar widths, which sidebars are open,
//! the active tabs, row density, and the floating assistant's place, size,
//! visibility, skin and chat window size), kept in `ui.json` next to `settings.json` in the app
//! config dir. Per PC, not per vault and not a secret.
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
/// The assistant's offsets are measured from the window's right and bottom
/// edges in CSS px. Rust does not know the window size: it only caps them, and
/// the webview clamps them into the viewport.
pub const PET_OFFSET_MAX: u16 = 4096;
pub const PET_X_DEFAULT: u16 = 24;
pub const PET_Y_DEFAULT: u16 = 40;
pub const PET_SKIN_DEFAULT: &str = "flasko";
/// The assistant's chat window ("bubble") size in CSS px: 0 means the default
/// size, a set size is at least this and at most `PET_OFFSET_MAX`. The webview
/// clamps it to the window. One side alone is not a size: both become 0.
pub const BUBBLE_MIN_W: u16 = 280;
pub const BUBBLE_MIN_H: u16 = 240;

/// The floating assistant ("pet"). Integer display scale 2 or 3 only. `skin`
/// is only checked against the id pattern `[a-z0-9-]{3,32}`: Rust does not
/// know which skins are installed, the webview falls back to the built-in one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPrefs {
    pub x: u16,
    pub y: u16,
    pub hidden: bool,
    pub scale: u8,
    pub skin: String,
    pub bubble_w: u16,
    pub bubble_h: u16,
}

impl Default for PetPrefs {
    fn default() -> Self {
        PetPrefs {
            x: PET_X_DEFAULT,
            y: PET_Y_DEFAULT,
            hidden: false,
            scale: 2,
            skin: PET_SKIN_DEFAULT.into(),
            bubble_w: 0,
            bubble_h: 0,
        }
    }
}

/// `[a-z0-9-]{3,32}`.
pub fn valid_skin_id(id: &str) -> bool {
    (3..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// One side of the bubble size: 0 stays 0 (default), anything else into `[min, PET_OFFSET_MAX]`.
fn bubble_side(v: u16, min: u16) -> u16 {
    if v == 0 {
        0
    } else {
        v.clamp(min, PET_OFFSET_MAX)
    }
}

impl PetPrefs {
    pub fn clamp(self) -> Self {
        let w = bubble_side(self.bubble_w, BUBBLE_MIN_W);
        let h = bubble_side(self.bubble_h, BUBBLE_MIN_H);
        let sized = w > 0 && h > 0;
        PetPrefs {
            x: self.x.min(PET_OFFSET_MAX),
            y: self.y.min(PET_OFFSET_MAX),
            hidden: self.hidden,
            scale: if self.scale == 3 { 3 } else { 2 },
            skin: if valid_skin_id(&self.skin) { self.skin } else { PET_SKIN_DEFAULT.into() },
            bubble_w: if sized { w } else { 0 },
            bubble_h: if sized { h } else { 0 },
        }
    }
}

/// Lenient like `UiPrefs`: a non-object gives the defaults, a bad field its default.
impl From<Option<&Value>> for PetPrefs {
    fn from(v: Option<&Value>) -> Self {
        let d = PetPrefs::default();
        let Some(o) = v.filter(|v| v.is_object()) else { return d };
        PetPrefs {
            x: width(o.get("x"), d.x),
            y: width(o.get("y"), d.y),
            hidden: flag(o.get("hidden"), d.hidden),
            scale: match o.get("scale").and_then(Value::as_f64) {
                Some(n) if n == 3.0 => 3,
                _ => 2,
            },
            skin: o.get("skin").and_then(Value::as_str).map(str::to_owned).unwrap_or(d.skin),
            bubble_w: width(o.get("bubbleW"), d.bubble_w),
            bubble_h: width(o.get("bubbleH"), d.bubble_h),
        }
        .clamp()
    }
}

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
    pub pet: PetPrefs,
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
            pet: PetPrefs::default(),
        }
    }
}

impl UiPrefs {
    /// Widths into their ranges and the pet's fields checked. The enums are valid by construction.
    pub fn clamp(self) -> Self {
        UiPrefs {
            left_width: self.left_width.clamp(LEFT_MIN, LEFT_MAX),
            right_width: self.right_width.clamp(RIGHT_MIN, RIGHT_MAX),
            pet: self.pet.clamp(),
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
            pet: PetPrefs::from(v.get("pet")),
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
        assert_eq!(keys.len(), 9);
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
            pet: PetPrefs { x: 120, y: 64, hidden: true, scale: 3, skin: "flasko-blue".into(), bubble_w: 480, bubble_h: 360 },
        };
        assert_eq!(write_at(&s.settings(), prefs.clone()).unwrap(), prefs);
        assert_eq!(read_at(&s.settings()), prefs);
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(ui_path(&s.settings())).unwrap()).unwrap();
        assert_eq!(
            raw,
            json!({ "leftWidth": 350, "leftHidden": true, "leftTab": "experiments", "rightWidth": 300,
                    "rightOpen": true, "rightTab": "links", "density": "compact", "showSystemFiles": true,
                    "pet": { "x": 120, "y": 64, "hidden": true, "scale": 3, "skin": "flasko-blue",
                             "bubbleW": 480, "bubbleH": 360 } })
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

    #[test]
    fn ui_prefs_pet_defaults() {
        let p = UiPrefs::default().pet;
        assert_eq!(
            p,
            PetPrefs { x: PET_X_DEFAULT, y: PET_Y_DEFAULT, hidden: false, scale: 2, skin: "flasko".into(), bubble_w: 0, bubble_h: 0 }
        );
        assert_eq!(UiPrefs::from(json!({})).pet, p);
    }

    #[test]
    fn ui_prefs_pet_is_parsed_leniently_and_clamped() {
        let p = UiPrefs::from(json!({ "pet": { "x": -5, "y": 1e9, "hidden": true, "scale": 7, "skin": "../evil" } })).pet;
        assert_eq!((p.x, p.y, p.hidden, p.scale, p.skin.as_str()), (0, PET_OFFSET_MAX, true, 2, "flasko"));
        let p = UiPrefs::from(json!({ "pet": { "x": 33.6, "y": "far", "scale": 3, "skin": "my-skin-2" } })).pet;
        assert_eq!((p.x, p.y, p.hidden, p.scale, p.skin.as_str()), (34, PET_Y_DEFAULT, false, 3, "my-skin-2"));
        for bad in ["ab", "Flasko", "a_b_c", "x".repeat(33).as_str(), "", "가나다", "abc/def"] {
            assert_eq!(UiPrefs::from(json!({ "pet": { "skin": bad } })).pet.skin, "flasko", "{bad:?}");
        }
        assert_eq!(UiPrefs::from(json!({ "pet": { "skin": "a".repeat(32) } })).pet.skin, "a".repeat(32));
        // clamp() (the write path) applies the same rules to a struct built in Rust
        let p = UiPrefs {
            pet: PetPrefs { x: 60000, y: 1, hidden: false, scale: 9, skin: "BAD".into(), bubble_w: 0, bubble_h: 0 },
            ..UiPrefs::default()
        }
        .clamp()
        .pet;
        assert_eq!((p.x, p.scale, p.skin.as_str()), (PET_OFFSET_MAX, 2, "flasko"));
    }

    #[test]
    fn ui_prefs_bubble_size_is_parsed_leniently_and_clamped() {
        let size = |v: Value| {
            let p = UiPrefs::from(json!({ "pet": v })).pet;
            (p.bubble_w, p.bubble_h)
        };
        assert_eq!(size(json!({ "bubbleW": 500.4, "bubbleH": 420 })), (500, 420));
        assert_eq!(size(json!({ "bubbleW": 100, "bubbleH": 1 })), (BUBBLE_MIN_W, BUBBLE_MIN_H));
        assert_eq!(size(json!({ "bubbleW": 1e9, "bubbleH": 99999 })), (PET_OFFSET_MAX, PET_OFFSET_MAX));
        assert_eq!(size(json!({ "bubbleW": -5, "bubbleH": "tall" })), (0, 0));
        // one side alone is not a size
        assert_eq!(size(json!({ "bubbleW": 500 })), (0, 0));
        assert_eq!(size(json!({})), (0, 0));
        let p = PetPrefs { bubble_w: 9000, bubble_h: 10, ..PetPrefs::default() }.clamp();
        assert_eq!((p.bubble_w, p.bubble_h), (PET_OFFSET_MAX, BUBBLE_MIN_H));
    }

    #[test]
    fn ui_prefs_junk_pet_falls_back_without_losing_the_layout() {
        for junk in [json!("junk"), json!(42), json!(null), json!([1, 2]), json!(true)] {
            let p = UiPrefs::from(json!({ "leftWidth": 300, "rightOpen": true, "pet": junk.clone() }));
            assert_eq!(p.pet, PetPrefs::default(), "{junk}");
            assert_eq!(p.left_width, 300);
            assert!(p.right_open);
        }
        // unknown pet fields are dropped
        let out = serde_json::to_value(UiPrefs::from(json!({ "pet": { "x": 10, "evil": "<script>" } }))).unwrap();
        let mut keys: Vec<&String> = out["pet"].as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["bubbleH", "bubbleW", "hidden", "scale", "skin", "x", "y"]);
        assert_eq!(out["pet"]["x"], 10);
    }
}
