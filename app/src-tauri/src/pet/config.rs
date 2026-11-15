//! `pet-window.json` in the app config dir: the pet's position, quiet mode and bubble size. Never in a vault.
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

pub const FILE: &str = "pet-window.json";
const LIMIT: i64 = 100_000;
/// Saved bubble sizes are logical px; the window clamps them again to the monitor, these only keep nonsense out of the file.
const SIZE_LIMIT: i64 = 4_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PetConfig {
    pub pos: Option<(i32, i32)>,
    pub quiet: bool,
    /// The bubble's size in logical px (width, height) the person dragged it to.
    pub panel: Option<(u32, u32)>,
}

fn extent(v: Option<&Value>) -> Option<u32> {
    let n = v?.as_i64()?;
    (1..=SIZE_LIMIT).contains(&n).then_some(n as u32)
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
    let panel = match (extent(v.get("bw")), extent(v.get("bh"))) {
        (Some(w), Some(h)) => Some((w, h)),
        _ => None,
    };
    PetConfig { pos, quiet: v.get("quiet").and_then(Value::as_bool).unwrap_or(false), panel }
}

pub fn to_text(c: &PetConfig) -> String {
    let mut v = json!({ "v": 1, "quiet": c.quiet });
    if let Some((x, y)) = c.pos {
        v["x"] = json!(x);
        v["y"] = json!(y);
    }
    if let Some((w, h)) = c.panel {
        v["bw"] = json!(w);
        v["bh"] = json!(h);
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
    // A name of its own: two writers (or two app instances) never share one temp file.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = config_dir.join(format!("{FILE}.{}-{}.tmp", std::process::id(), SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    std::fs::write(&tmp, to_text(c))?;
    std::fs::rename(&tmp, path(config_dir)).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
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
        write(&d, &PetConfig { pos: Some((-120, 340)), quiet: true, panel: Some((400, 520)) }).unwrap();
        assert_eq!(read(&d), PetConfig { pos: Some((-120, 340)), quiet: true, panel: Some((400, 520)) });
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn writers_at_the_same_moment_never_share_a_temp_file() {
        let d = dir("race");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let d = d.clone();
                std::thread::spawn(move || (0..25).all(|j| write(&d, &PetConfig { pos: Some((i, j)), quiet: false, panel: None }).is_ok()))
            })
            .collect();
        for h in handles {
            assert!(h.join().unwrap(), "a write failed");
        }
        assert!(read(&d).pos.is_some());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn bad_values_fall_back_per_field() {
        assert_eq!(parse("not json"), PetConfig::default());
        assert_eq!(parse(r#"{"v":2,"x":1,"y":1}"#), PetConfig::default());
        assert_eq!(parse(r#"{"v":1,"x":1e9,"y":5,"quiet":true}"#), PetConfig { pos: None, quiet: true, panel: None });
        assert_eq!(parse(r#"{"v":1,"x":"7","y":5}"#).pos, None);
        assert_eq!(parse(r#"{"v":1,"x":100001,"y":5}"#).pos, None);
        assert_eq!(parse(r#"{"v":1,"x":-100000,"y":100000,"quiet":"yes"}"#), PetConfig { pos: Some((-100000, 100000)), quiet: false, panel: None });
    }

    #[test]
    fn the_bubble_size_is_kept_only_when_both_sides_are_sane() {
        assert_eq!(parse(r#"{"v":1,"bw":420,"bh":500}"#).panel, Some((420, 500)));
        assert_eq!(parse(r#"{"v":1,"bw":420}"#).panel, None);
        assert_eq!(parse(r#"{"v":1,"bw":0,"bh":500}"#).panel, None);
        assert_eq!(parse(r#"{"v":1,"bw":-5,"bh":500}"#).panel, None);
        assert_eq!(parse(r#"{"v":1,"bw":4001,"bh":500}"#).panel, None);
        assert_eq!(parse(r#"{"v":1,"bw":"420","bh":500}"#).panel, None);
        assert_eq!(parse(r#"{"v":1,"bw":420.5,"bh":500}"#).panel, None);
        // a bad size does not cost the position or quiet mode
        assert_eq!(parse(r#"{"v":1,"x":1,"y":2,"quiet":true,"bw":9999,"bh":5}"#), PetConfig { pos: Some((1, 2)), quiet: true, panel: None });
        assert!(to_text(&PetConfig { pos: None, quiet: false, panel: Some((300, 400)) }).contains("\"bw\": 300"));
    }

    #[test]
    fn unknown_keys_are_ignored_and_not_kept() {
        assert!(!to_text(&parse(r#"{"v":1,"x":1,"y":2,"cmd":"calc.exe"}"#)).contains("calc"));
    }
}
