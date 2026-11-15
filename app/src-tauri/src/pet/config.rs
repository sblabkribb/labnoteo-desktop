//! `pet-window.json` in the app config dir: the pet's position and quiet mode. Never in a vault.
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

pub const FILE: &str = "pet-window.json";
const LIMIT: i64 = 100_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PetConfig {
    pub pos: Option<(i32, i32)>,
    pub quiet: bool,
}

fn coord(v: Option<&Value>) -> Option<i32> {
    let n = v?.as_i64()?;
    (-LIMIT..=LIMIT).contains(&n).then_some(n as i32)
}

/// A validated config from the text of the file. Anything wrong falls back per field.
pub fn parse(text: &str) -> PetConfig {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return PetConfig::default() };
    if v.get("v").and_then(Value::as_i64) != Some(1) {
        return PetConfig::default();
    }
    let pos = match (coord(v.get("x")), coord(v.get("y"))) {
        (Some(x), Some(y)) => Some((x, y)),
        _ => None,
    };
    PetConfig { pos, quiet: v.get("quiet").and_then(Value::as_bool).unwrap_or(false) }
}

pub fn to_text(c: &PetConfig) -> String {
    let mut v = json!({ "v": 1, "quiet": c.quiet });
    if let Some((x, y)) = c.pos {
        v["x"] = json!(x);
        v["y"] = json!(y);
    }
    serde_json::to_string_pretty(&v).expect("a json value serialises")
}

pub fn path(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE)
}

pub fn read(config_dir: &Path) -> PetConfig {
    std::fs::read_to_string(path(config_dir)).map(|t| parse(&t)).unwrap_or_default()
}

/// Atomic: a temp file in the same folder, then rename.
pub fn write(config_dir: &Path, c: &PetConfig) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let tmp = config_dir.join(format!("{FILE}.tmp"));
    std::fs::write(&tmp, to_text(c))?;
    std::fs::rename(&tmp, path(config_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("labnoteo-pet-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_missing_file_is_the_default() {
        assert_eq!(read(&dir("missing")), PetConfig::default());
    }

    #[test]
    fn write_then_read_round_trips_and_leaves_no_temp_file() {
        let d = dir("roundtrip");
        write(&d, &PetConfig { pos: Some((-120, 340)), quiet: true }).unwrap();
        assert_eq!(read(&d), PetConfig { pos: Some((-120, 340)), quiet: true });
        assert!(!d.join("pet-window.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn bad_values_fall_back_per_field() {
        assert_eq!(parse("not json"), PetConfig::default());
        assert_eq!(parse(r#"{"v":2,"x":1,"y":1}"#), PetConfig::default());
        assert_eq!(parse(r#"{"v":1,"x":1e9,"y":5,"quiet":true}"#), PetConfig { pos: None, quiet: true });
        assert_eq!(parse(r#"{"v":1,"x":"7","y":5}"#).pos, None);
        assert_eq!(parse(r#"{"v":1,"x":100001,"y":5}"#).pos, None);
        assert_eq!(parse(r#"{"v":1,"x":-100000,"y":100000,"quiet":"yes"}"#), PetConfig { pos: Some((-100000, 100000)), quiet: false });
    }

    #[test]
    fn unknown_keys_are_ignored_and_not_kept() {
        assert!(!to_text(&parse(r#"{"v":1,"x":1,"y":2,"cmd":"calc.exe"}"#)).contains("calc"));
    }
}
