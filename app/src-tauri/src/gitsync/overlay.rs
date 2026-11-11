//! Files that exist only in the commit, never on disk (spec §6.2), and the
//! generated commit message (§5.4). All of them are scanned like any other
//! file before anything goes up.
//!
//! - `.gitattributes`: `* -text` (data stays byte-exact) plus `binary` for
//!   common lab-data types.
//! - `.gitignore`: only the generic hard-exclude patterns. The names of
//!   user-excluded files are never written.
//! - `README.md`: only when the folder has none and the setting is on.
//! - `_labnoteo/samples/<Type>.json`: only the referenced Global samples,
//!   offered when the plan found any (the upload decides whether they go).

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::walk::gitignore_patterns;
use crate::vault::path::is_safe_component;

/// Where the sample snapshot goes inside the repository.
pub const SAMPLES_DIR: &str = "_labnoteo/samples";

/// What the overlays depend on besides the folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OverlayConfig {
    /// The vault setting `githubReadmeOverlay` (on by default).
    pub readme: bool,
}

/// One Global sample record, read in Rust from `<Global folder>/<Type>.json`.
#[derive(Clone, Debug, PartialEq)]
pub struct SampleEntry {
    pub id: String,
    pub sample_type: String,
    /// The record verbatim, as the registry holds it.
    pub record: Value,
}

/// Lab-data types marked `binary` (never diffed or merged as text).
const BINARY_TYPES: [&str; 24] = [
    "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "czi", "nd2", "lif", "lsm", "oib", "ab1", "fcs",
    "xlsx", "xls", "docx", "pptx", "pdf", "zip", "gz", "7z", "h5",
];

/// `.gitattributes`.
pub fn gitattributes() -> String {
    let mut out = String::from("# labnoteO: every file is kept byte for byte.\n* -text\n");
    for ext in BINARY_TYPES {
        out.push_str(&format!("*.{ext} binary\n"));
    }
    out
}

/// `.gitignore`: generic patterns only.
pub fn gitignore() -> String {
    let mut out = String::from("# labnoteO: files that are never uploaded.\n");
    for p in gitignore_patterns() {
        out.push_str(&p);
        out.push('\n');
    }
    out
}

/// The title shown for an experiment folder: its last segment without the
/// `###_` number, with `_` read as a space (`001_단백질_발현` → `단백질 발현`).
pub fn folder_title(folder_rel: &str) -> String {
    let last = folder_rel.rsplit('/').next().unwrap_or(folder_rel);
    let b = last.as_bytes();
    let rest = if b.len() > 4 && b[..3].iter().all(u8::is_ascii_digit) && b[3] == b'_' { &last[4..] } else { last };
    let title = rest.replace('_', " ").trim().to_string();
    if title.is_empty() {
        last.to_string()
    } else {
        title
    }
}

/// Markdown link text with the characters that would end it escaped.
fn link_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '[' | ']' | '*' | '_' | '`') {
            out.push('\\');
        }
        if !c.is_control() {
            out.push(c);
        }
    }
    out
}

/// A note's name for the list: the file name without `.labnote.md` / `.md`.
fn note_name(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".labnote.md").or_else(|| name.strip_suffix(".md")).unwrap_or(name)
}

/// The generated `README.md`: title, a link to `README.labnote.md`, the note
/// list as standard links, and where it came from.
fn readme(title: &str, notes: &[String]) -> String {
    let title: String = title.chars().filter(|c| !c.is_control()).collect();
    let mut out = format!("# {title}\n\n");
    if notes.iter().any(|n| n == "README.labnote.md") {
        out.push_str("실험 개요: [README.labnote.md](<README.labnote.md>)\n\n");
    }
    let listed: Vec<&String> = notes.iter().filter(|n| n.as_str() != "README.labnote.md").collect();
    if !listed.is_empty() {
        out.push_str("## 노트\n\n");
        for n in listed {
            out.push_str(&format!("- [{}](<{}>)\n", link_text(note_name(n)), n));
        }
        out.push('\n');
    }
    out.push_str("---\n\nlabnoteO에서 올림\n");
    out
}

/// The snapshot files, one per sample type, records keyed by ID. A type that
/// is not a safe file name is left out.
fn sample_files(samples: &[SampleEntry]) -> Vec<(String, Vec<u8>)> {
    let mut by_type: BTreeMap<&str, Map<String, Value>> = BTreeMap::new();
    for s in samples {
        if s.sample_type.starts_with('.') || !is_safe_component(&s.sample_type) {
            continue;
        }
        by_type.entry(&s.sample_type).or_default().insert(s.id.clone(), s.record.clone());
    }
    by_type
        .into_iter()
        .map(|(t, records)| {
            let mut text = serde_json::to_string_pretty(&Value::Object(records)).unwrap_or_default();
            text.push('\n');
            (format!("{SAMPLES_DIR}/{t}.json"), text.into_bytes())
        })
        .collect()
}

/// Every overlay for one folder, sorted by path. `notes` are the folder's
/// note paths (folder-relative); `has_readme_md` is true when the folder has
/// its own `README.md` (any case), which then wins.
pub fn overlays(
    cfg: &OverlayConfig,
    folder_title: &str,
    notes: &[String],
    has_readme_md: bool,
    samples: Option<&[SampleEntry]>,
) -> Vec<(String, Vec<u8>)> {
    let mut out = vec![
        (".gitattributes".to_string(), gitattributes().into_bytes()),
        (".gitignore".to_string(), gitignore().into_bytes()),
    ];
    if cfg.readme && !has_readme_md {
        out.push(("README.md".to_string(), readme(folder_title, notes).into_bytes()));
    }
    if let Some(samples) = samples {
        out.extend(sample_files(samples));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// A wall-clock time to the minute.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalTime {
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
}

/// Now, in the computer's local time (UTC where the OS gives no local time).
pub fn local_now() -> LocalTime {
    #[cfg(windows)]
    {
        let mut st: windows_sys::Win32::Foundation::SYSTEMTIME = Default::default();
        // SAFETY: GetLocalTime writes one SYSTEMTIME into the pointer given.
        unsafe { windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut st) };
        LocalTime {
            year: st.wYear,
            month: st.wMonth as u8,
            day: st.wDay as u8,
            hour: st.wHour as u8,
            minute: st.wMinute as u8,
        }
    }
    #[cfg(not(windows))]
    {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        utc_from_unix(secs)
    }
}

/// The UTC civil time of a Unix time (days-from-civil, inverted).
#[cfg_attr(windows, allow(dead_code))]
pub fn utc_from_unix(secs: u64) -> LocalTime {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    LocalTime {
        year: year as u16,
        month: month as u8,
        day: day as u8,
        hour: (rem / 3600) as u8,
        minute: ((rem % 3600) / 60) as u8,
    }
}

/// How many files a commit adds, changes and removes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub new: u32,
    pub changed: u32,
    pub deleted: u32,
}

/// `labnoteO: 2026-11-10 14:32 — 새 파일 2, 바뀜 3, 삭제 1` (zero counts left out).
pub fn commit_message(now: &LocalTime, counts: &Counts) -> String {
    let mut parts: Vec<String> = Vec::new();
    if counts.new > 0 {
        parts.push(format!("새 파일 {}", counts.new));
    }
    if counts.changed > 0 {
        parts.push(format!("바뀜 {}", counts.changed));
    }
    if counts.deleted > 0 {
        parts.push(format!("삭제 {}", counts.deleted));
    }
    let what = if parts.is_empty() { "바뀐 내용 없음".to_string() } else { parts.join(", ") };
    format!(
        "labnoteO: {:04}-{:02}-{:02} {:02}:{:02} — {what}",
        now.year, now.month, now.day, now.hour, now.minute
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitsync::walk::hard_excluded;

    const CFG: OverlayConfig = OverlayConfig { readme: true };

    fn get<'a>(list: &'a [(String, Vec<u8>)], path: &str) -> Option<&'a str> {
        list.iter().find(|(p, _)| p == path).map(|(_, b)| std::str::from_utf8(b).unwrap())
    }

    #[test]
    fn gitignore_is_generic_and_matches_the_walk() {
        let text = gitignore();
        assert!(text.lines().any(|l| l == ".env*"), "{text}");
        for p in [".*", "*.pem", "id_rsa*", "~$*", "Thumbs.db", "credentials*.json", "node_modules/"] {
            assert!(text.lines().any(|l| l == p), "{p} missing: {text}");
        }
        // Every simple pattern names something the walk excludes too.
        for line in text.lines().filter(|l| !l.starts_with('#') && !l.starts_with('!')) {
            let sample = line.trim_end_matches('/').replace('*', "x");
            assert!(hard_excluded(&sample, line.ends_with('/')), "{line} -> {sample}");
        }
    }

    #[test]
    fn gitignore_never_names_a_user_excluded_file() {
        let list = overlays(&CFG, "단백질 발현", &["a.md".into()], false, None);
        let ignore = get(&list, ".gitignore").unwrap();
        // The overlays take no exclusion list at all; a typical unticked name
        // cannot appear.
        assert!(!ignore.contains("gel_raw.czi") && !ignore.contains("secret_plan.xlsx"));
        assert!(get(&list, ".gitattributes").unwrap().contains("* -text"));
    }

    #[test]
    fn readme_only_when_the_folder_has_none_and_the_setting_is_on() {
        let notes: Vec<String> = vec!["README.labnote.md".into(), "workflows/002_PCR.labnote.md".into(), "old note.md".into()];
        let list = overlays(&CFG, "단백질 발현", &notes, false, None);
        let readme = get(&list, "README.md").unwrap();
        assert!(readme.starts_with("# 단백질 발현\n"), "{readme}");
        assert!(readme.contains("[README.labnote.md](<README.labnote.md>)"));
        assert!(readme.contains("- [002\\_PCR](<workflows/002_PCR.labnote.md>)"), "{readme}");
        assert!(readme.contains("- [old note](<old note.md>)"));
        assert!(readme.contains("labnoteO에서 올림"));
        assert!(get(&overlays(&CFG, "t", &notes, true, None), "README.md").is_none());
        assert!(get(&overlays(&OverlayConfig { readme: false }, "t", &notes, false, None), "README.md").is_none());
    }

    #[test]
    fn sample_snapshot_holds_only_the_given_entries_by_type() {
        let s = |id: &str, t: &str| SampleEntry {
            id: id.into(),
            sample_type: t.into(),
            record: serde_json::json!({"type": t, "alias": format!("{id} alias")}),
        };
        let samples = [s("DNA-1", "DNA"), s("P-2", "Protein"), s("DNA-9", "DNA"), s("x", "../evil")];
        let list = overlays(&CFG, "t", &[], false, Some(&samples));
        let dna: Value = serde_json::from_str(get(&list, "_labnoteo/samples/DNA.json").unwrap()).unwrap();
        assert_eq!(dna.as_object().unwrap().keys().collect::<Vec<_>>(), ["DNA-1", "DNA-9"]);
        assert!(get(&list, "_labnoteo/samples/Protein.json").is_some());
        assert!(list.iter().all(|(p, _)| !p.contains("..")));
        assert!(overlays(&CFG, "t", &[], false, None).iter().all(|(p, _)| !p.starts_with(SAMPLES_DIR)));
    }

    #[test]
    fn titles_and_messages() {
        assert_eq!(folder_title("labnote/001_단백질_발현"), "단백질 발현");
        assert_eq!(folder_title("labnote/001_단백질 발현"), "단백질 발현");
        assert_eq!(folder_title("x/labnote/123_"), "123");
        let now = LocalTime { year: 2026, month: 11, day: 10, hour: 14, minute: 32 };
        let c = Counts { new: 2, changed: 3, deleted: 1 };
        assert_eq!(commit_message(&now, &c), "labnoteO: 2026-11-10 14:32 — 새 파일 2, 바뀜 3, 삭제 1");
        assert_eq!(commit_message(&now, &Counts { new: 8, ..Counts::default() }), "labnoteO: 2026-11-10 14:32 — 새 파일 8");
        assert_eq!(utc_from_unix(1_794_320_000), LocalTime { year: 2026, month: 11, day: 10, hour: 14, minute: 13 });
        assert_eq!(utc_from_unix(0), LocalTime { year: 1970, month: 1, day: 1, hour: 0, minute: 0 });
        let n = local_now();
        assert!(n.year >= 2024 && (1..=12).contains(&n.month) && (1..=31).contains(&n.day));
    }
}
