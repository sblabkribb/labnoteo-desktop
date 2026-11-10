//! The secret scan (spec §6.3), run over exactly the bytes that will be
//! committed, every file name and path, and the generated files.
//!
//! - Text is UTF-16 LE/BE with a BOM (decoded first), or any file with no
//!   NUL byte in its first 8 KiB, scanned byte-wise with lossy decoding per
//!   line. Every pattern is ASCII, so CP949/EUC-KR CSVs from Korean Excel
//!   are scanned too; the Korean `비밀번호` pattern only matches decoded text.
//! - Binaries, Office files, PDFs and files over `Limits::scan_max` are
//!   listed as `unscanned`. JPEG/TIFF location data is listed under `gps`.
//! - The app's own saved keys are searched as literals. They stay in
//!   `Zeroizing` buffers inside Rust; a hit carries only a masked value and
//!   the line hash, never the raw text.
//!
//! The matchers are hand-written (no `regex` dependency).

use std::collections::BTreeSet;
use std::sync::Arc;

use git2::{ObjectType, Oid};
use serde::Serialize;
use zeroize::Zeroizing;

use super::exif::has_gps;
use super::walk::Limits;
use crate::mcp::MCP_ACCOUNT;
use crate::net::config::ServiceConfig;
use crate::net::github::GithubState;
use crate::net::secrets::{key_for, SecretStore, Slot};

/// How far a NUL byte is looked for to call a file binary.
const SNIFF: usize = 8 * 1024;

/// Saved values shorter than this are not searched for (too many false hits).
const SAVED_MIN: usize = 8;

/// Extensions that are never scanned (zip containers and PDF).
const UNSCANNED_EXT: [&str; 5] = ["xlsx", "xlsm", "docx", "pptx", "pdf"];

/// Which of the app's saved keys a value is.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SavedLabel {
    Llm,
    Partbank,
    Bfw,
    Slack,
    Github,
    Mcp,
}

/// One of the app's saved keys, read inside Rust for the exact-match scan.
/// Zeroized on drop; `Debug` never prints the value.
pub struct SavedSecret {
    pub label: SavedLabel,
    pub value: Zeroizing<String>,
}

impl std::fmt::Debug for SavedSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SavedSecret").field("label", &self.label).field("value", &"***").finish()
    }
}

/// What a hit looks like, in plain-language groups.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "kind", content = "label", rename_all = "camelCase")]
pub enum HitKind {
    /// A cloud or AI service key (`AKIA…`, `sk-…`, `AIza…`).
    ApiKey,
    /// `-----BEGIN … PRIVATE KEY-----`.
    PrivateKey,
    /// `password:` / `비밀번호:` with a value.
    Password,
    /// A GitHub or Slack token, or a JWT.
    Token,
    /// A high-entropy value next to `key` / `token` / `secret`.
    Suspect,
    /// Exactly one of the app's own saved keys.
    Saved(SavedLabel),
}

/// One finding. `line` is 1-based; 0 means the file name or path itself.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub line: u32,
    #[serde(flatten)]
    pub kind: HitKind,
    /// The value masked: first 3 + `…` + last 4 characters, or `…` + the
    /// last 2 when it is shorter than 12 characters.
    pub masked: String,
    /// `git2::Oid::hash_object(Blob, line)` in hex: the key a "not a key"
    /// override is stored under, so editing the line brings the hit back.
    pub line_hash: String,
    /// False for private keys and saved keys: those can never be waved through.
    pub overridable: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub hits: Vec<Hit>,
    /// Files whose content was not scanned (binary, Office, PDF, too big).
    pub unscanned: Vec<String>,
    /// Pictures that carry location (EXIF GPS) data.
    pub gps: Vec<String>,
}

/// Scans `files` (path, exact bytes) and every path in `files` and
/// `names_only` for secrets, and checks pictures for location data.
pub fn scan(files: &[(String, Arc<[u8]>)], names_only: &[String], saved: &[SavedSecret], limits: &Limits) -> ScanReport {
    let mut report = ScanReport::default();
    let saved: Vec<(SavedLabel, &[u8])> = saved
        .iter()
        .filter(|s| s.value.len() >= SAVED_MIN)
        .map(|s| (s.label, s.value.as_bytes()))
        .collect();

    let names: BTreeSet<&str> =
        files.iter().map(|(p, _)| p.as_str()).chain(names_only.iter().map(String::as_str)).collect();
    for name in names {
        scan_line(&mut report.hits, name, 0, name.as_bytes(), name.as_bytes(), &saved);
    }

    for (path, bytes) in files {
        if has_gps(bytes) {
            report.gps.push(path.clone());
        }
        if unscanned_ext(path) || bytes.len() as u64 > limits.scan_max {
            report.unscanned.push(path.clone());
            continue;
        }
        if let Some(text) = utf16(bytes) {
            for (n, line) in lines(text.as_bytes()) {
                scan_line(&mut report.hits, path, n, line, line, &saved);
            }
            continue;
        }
        if bytes[..bytes.len().min(SNIFF)].contains(&0) {
            report.unscanned.push(path.clone());
            continue;
        }
        for (n, raw) in lines(bytes) {
            let text = String::from_utf8_lossy(raw);
            scan_line(&mut report.hits, path, n, raw, text.as_bytes(), &saved);
        }
    }
    report
}

/// Reads every saved key of the app that is set: the keychain slots (the
/// origin-bound ones for the vault's current origins), the in-memory GitHub
/// tokens and the MCP server token. Unreadable slots are skipped.
pub fn saved_secrets(store: &dyn SecretStore, cfg: &ServiceConfig, github: &GithubState) -> Vec<SavedSecret> {
    let slots = [
        (Slot::PartbankDesktop, SavedLabel::Partbank),
        (Slot::PartbankWeb, SavedLabel::Partbank),
        (Slot::LlmOpenai, SavedLabel::Llm),
        (Slot::BfwServer, SavedLabel::Bfw),
        (Slot::BfwDesktop, SavedLabel::Bfw),
        (Slot::SlackBot, SavedLabel::Slack),
        (Slot::Github, SavedLabel::Github),
        (Slot::GithubRefresh, SavedLabel::Github),
    ];
    let mut out: Vec<SavedSecret> = Vec::new();
    let mut keep = |label: SavedLabel, value: Zeroizing<String>| {
        if value.len() >= SAVED_MIN {
            out.push(SavedSecret { label, value });
        }
    };
    for (slot, label) in slots {
        if let Ok(Some(v)) = key_for(store, slot, cfg) {
            keep(label, Zeroizing::new(v));
        }
    }
    for v in github.memory_secrets() {
        keep(SavedLabel::Github, v);
    }
    if let Ok(Some(v)) = store.get(MCP_ACCOUNT) {
        keep(SavedLabel::Mcp, Zeroizing::new(v));
    }
    out
}

fn unscanned_ext(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((_, ext)) => UNSCANNED_EXT.iter().any(|e| ext.eq_ignore_ascii_case(e)),
        None => false,
    }
}

/// The text of a UTF-16 file with a BOM (a trailing odd byte is dropped).
fn utf16(bytes: &[u8]) -> Option<String> {
    let le = match bytes.get(..2) {
        Some([0xFF, 0xFE]) => true,
        Some([0xFE, 0xFF]) => false,
        _ => return None,
    };
    let units: Vec<u16> = bytes[2..]
        .chunks_exact(2)
        .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
        .collect();
    Some(String::from_utf16_lossy(&units))
}

/// Lines split on `\n` with a trailing `\r` removed, numbered from 1.
fn lines(bytes: &[u8]) -> impl Iterator<Item = (u32, &[u8])> {
    bytes.split(|&b| b == b'\n').enumerate().map(|(i, l)| {
        let l = l.strip_suffix(b"\r").unwrap_or(l);
        (u32::try_from(i + 1).unwrap_or(u32::MAX), l)
    })
}

/// A match inside one line's decoded text: the value's byte range.
struct Found {
    start: usize,
    end: usize,
    kind: HitKind,
}

fn overlaps(found: &[Found], start: usize, end: usize) -> bool {
    found.iter().any(|f| start < f.end && f.start < end)
}

/// Scans one line. `raw` is what the line hash covers (the bytes on disk, or
/// the decoded line for UTF-16); `text` is the lossily decoded line.
fn scan_line(hits: &mut Vec<Hit>, path: &str, line: u32, raw: &[u8], text: &[u8], saved: &[(SavedLabel, &[u8])]) {
    let mut found: Vec<Found> = Vec::new();
    for &(label, value) in saved {
        let mut at = 0;
        while let Some(p) = find(&text[at..], value) {
            let start = at + p;
            found.push(Found { start, end: start + value.len(), kind: HitKind::Saved(label) });
            at = start + value.len();
        }
    }
    let mut i = 0;
    while i < text.len() {
        match pattern_at(text, i) {
            Some((start, end, kind)) => {
                if !overlaps(&found, start, end) {
                    found.push(Found { start, end, kind });
                }
                i = end.max(i + 1);
            }
            None => i += 1,
        }
    }
    suspects(text, &mut found);
    if found.is_empty() {
        return;
    }
    found.sort_by_key(|f| f.start);
    let line_hash = Oid::hash_object(ObjectType::Blob, raw).map(|o| o.to_string()).unwrap_or_default();
    for f in found {
        let value = String::from_utf8_lossy(&text[f.start..f.end]);
        hits.push(Hit {
            path: path.to_string(),
            line,
            kind: f.kind,
            masked: mask(&value),
            line_hash: line_hash.clone(),
            overridable: !matches!(f.kind, HitKind::PrivateKey | HitKind::Saved(_)),
        });
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// First 3 + `…` + last 4 characters; `…` + the last 2 below 12 characters.
pub fn mask(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let n = chars.len();
    if n < 12 {
        let tail: String = chars[n.saturating_sub(2)..].iter().collect();
        return format!("…{tail}");
    }
    let head: String = chars[..3].iter().collect();
    let tail: String = chars[n - 4..].iter().collect();
    format!("{head}…{tail}")
}

fn alnum(b: u8) -> bool {
    b.is_ascii_alphanumeric()
}

fn b64url(b: u8) -> bool {
    alnum(b) || b == b'_' || b == b'-'
}

/// The end of the run of bytes matching `pred` from `from`.
fn run(t: &[u8], from: usize, pred: impl Fn(u8) -> bool) -> usize {
    let mut j = from;
    while j < t.len() && pred(t[j]) {
        j += 1;
    }
    j
}

/// A token may not start in the middle of a word (`task-list` is not `sk-`).
fn boundary(t: &[u8], i: usize) -> bool {
    i == 0 || !alnum(t[i - 1])
}

/// The pattern that starts at `i`, as `(value start, value end, kind)`.
fn pattern_at(t: &[u8], i: usize) -> Option<(usize, usize, HitKind)> {
    let rest = &t[i..];
    let starts = |p: &[u8]| rest.starts_with(p);
    let at_word = boundary(t, i);

    if at_word {
        for prefix in [&b"ghp_"[..], b"gho_", b"ghu_", b"ghs_", b"ghr_"] {
            if starts(prefix) {
                let end = run(t, i + 4, alnum);
                if end - (i + 4) >= 30 {
                    return Some((i, end, HitKind::Token));
                }
            }
        }
        if starts(b"github_pat_") {
            let end = run(t, i + 11, |b| alnum(b) || b == b'_');
            if end - (i + 11) >= 20 {
                return Some((i, end, HitKind::Token));
            }
        }
        if starts(b"AKIA") {
            let end = run(t, i + 4, |b| b.is_ascii_uppercase() || b.is_ascii_digit());
            if end - (i + 4) == 16 && !t.get(end).is_some_and(|&b| alnum(b)) {
                return Some((i, end, HitKind::ApiKey));
            }
        }
        if starts(b"sk-") {
            let end = run(t, i + 3, b64url);
            let body = &t[i + 3..end];
            if body.len() >= 20 && body.iter().any(u8::is_ascii_digit) && body.iter().any(u8::is_ascii_alphabetic) {
                return Some((i, end, HitKind::ApiKey));
            }
        }
        if starts(b"AIza") {
            let end = run(t, i + 4, b64url);
            if end - (i + 4) >= 35 {
                return Some((i, end, HitKind::ApiKey));
            }
        }
        if rest.len() > 5 && starts(b"xox") && matches!(rest[3], b'a' | b'b' | b'p' | b'r') && rest[4] == b'-' {
            let end = run(t, i + 5, |b| alnum(b) || b == b'-');
            if end - (i + 5) >= 5 {
                return Some((i, end, HitKind::Token));
            }
        }
        if starts(b"eyJ") {
            if let Some(end) = jwt(t, i) {
                return Some((i, end, HitKind::Token));
            }
        }
    }
    if starts(b"-----BEGIN ") {
        let after = i + 11;
        if let Some(p) = find(&t[after..], b"PRIVATE KEY-----") {
            if t[after..after + p].iter().all(|&b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b' ') {
                return Some((i, after + p + 16, HitKind::PrivateKey));
            }
        }
    }
    let word_len = if rest.len() >= 8 && rest[..8].eq_ignore_ascii_case(b"password") {
        8
    } else if starts("비밀번호".as_bytes()) {
        "비밀번호".len()
    } else {
        0
    };
    if word_len > 0 {
        if let Some((s, e)) = assigned_value(t, i + word_len) {
            return Some((s, e, HitKind::Password));
        }
    }
    None
}

/// `eyJ…` `.` `eyJ…` `.` signature: the end of the token.
fn jwt(t: &[u8], i: usize) -> Option<usize> {
    let seg = |from: usize| -> Option<usize> {
        if !t[from..].starts_with(b"eyJ") {
            return None;
        }
        let end = run(t, from, b64url);
        (end - from >= 10 && t.get(end) == Some(&b'.')).then_some(end)
    };
    let one = seg(i)?;
    let two = seg(one + 1)?;
    Some(run(t, two + 1, b64url))
}

/// After a password word: optional spaces, `:` or `=`, optional spaces and
/// quotes, then a value of at least 3 non-space characters.
fn assigned_value(t: &[u8], from: usize) -> Option<(usize, usize)> {
    let sp = |b: u8| b == b' ' || b == b'\t';
    let j = run(t, from, sp);
    if !matches!(t.get(j), Some(b':') | Some(b'=')) {
        return None;
    }
    let s = run(t, j + 1, |b| sp(b) || b == b'"' || b == b'\'');
    let e = run(t, s, |b| !b.is_ascii_whitespace() && b != b'"' && b != b'\'');
    (e - s >= 3).then_some((s, e))
}

/// High-entropy values after `key` / `token` / `secret` on the same line,
/// not already reported.
fn suspects(t: &[u8], found: &mut Vec<Found>) {
    let lower = t.to_ascii_lowercase();
    let token_byte = |b: u8| alnum(b) || matches!(b, b'+' | b'/' | b'=' | b'_' | b'-');
    let mut i = 0;
    while i < t.len() {
        if !token_byte(t[i]) {
            i += 1;
            continue;
        }
        let end = run(t, i, token_byte);
        let value = &t[i..end];
        let keyword = ["key", "token", "secret"].iter().any(|k| find(&lower[..i], k.as_bytes()).is_some());
        if keyword
            && value.len() >= 20
            && value.iter().any(u8::is_ascii_digit)
            && value.iter().any(u8::is_ascii_alphabetic)
            && entropy(value) >= 3.5
            && !overlaps(found, i, end)
        {
            found.push(Found { start: i, end, kind: HitKind::Suspect });
        }
        i = end;
    }
}

/// Shannon entropy in bits per byte.
fn entropy(v: &[u8]) -> f64 {
    let mut counts = [0u32; 256];
    for &b in v {
        counts[usize::from(b)] += 1;
    }
    let n = v.len() as f64;
    counts.iter().filter(|&&c| c > 0).map(|&c| {
        let p = f64::from(c) / n;
        -p * p.log2()
    }).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::secrets::{store_secret, MemoryStore};

    fn file(path: &str, bytes: impl Into<Vec<u8>>) -> (String, Arc<[u8]>) {
        (path.to_string(), Arc::from(bytes.into()))
    }

    fn one(path: &str, text: &str) -> ScanReport {
        scan(&[file(path, text)], &[], &[], &Limits::DEFAULT)
    }

    fn kinds(r: &ScanReport) -> Vec<HitKind> {
        r.hits.iter().map(|h| h.kind).collect()
    }

    // Token-shaped test values are built at run time so the source holds none.
    fn ghp() -> String {
        format!("gh{}_{}", "p", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")
    }

    fn fine_grained() -> String {
        format!("github_{}_11ABCDEFG0{}", "pat", "123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789")
    }

    fn sk40() -> String {
        format!("sk-{}", "a1".repeat(20))
    }

    #[test]
    fn true_positives() {
        let cases: Vec<(String, HitKind)> = vec![
            (format!("token {}", ghp()), HitKind::Token),
            (format!("x = {}", fine_grained()), HitKind::Token),
            ("aws AKIAIOSFODNN7EXAMPLE end".into(), HitKind::ApiKey),
            (format!("OPENAI={}", sk40()), HitKind::ApiKey),
            (format!("k: sk-ant-api03-{}", "Xy9_".repeat(10)), HitKind::ApiKey),
            ("slack xoxb-1-2-abc".into(), HitKind::Token),
            (format!("maps AIza{}", "Sy0123456789abcdefghijklmnopqrstuvw"), HitKind::ApiKey),
            ("-----BEGIN OPENSSH PRIVATE KEY-----".into(), HitKind::PrivateKey),
            ("-----BEGIN RSA PRIVATE KEY-----".into(), HitKind::PrivateKey),
            ("auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2ln".into(), HitKind::Token),
            ("password: hunter22".into(), HitKind::Password),
            ("DB_PASSWORD=\"hunter22\"".into(), HitKind::Password),
        ];
        for (text, kind) in cases {
            let r = one("note.md", &text);
            assert_eq!(kinds(&r), vec![kind], "{text}");
            assert_eq!(r.hits[0].line, 1);
        }
    }

    #[test]
    fn near_misses_do_not_hit() {
        for text in [
            "see the task-list0123456789abcdefghij for details",
            "sequence key: ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT",
            "sample DNA-20250527-003 was used",
            "password:",
            "AKIAIOSFODNN7EXAMPLEX",
            "sk-learn-is-a-library-name-here",
        ] {
            let r = one("note.md", text);
            assert!(r.hits.is_empty(), "{text}: {:?}", r.hits);
        }
    }

    #[test]
    fn suspected_values_next_to_key_words() {
        let r = one("config.txt", "api_key = 'Zx81Qp0LmN4vR7tY2uWc9sKd'");
        assert_eq!(kinds(&r), vec![HitKind::Suspect]);
        assert!(r.hits[0].overridable);
        // The same value with no key word is not suspected.
        assert!(one("config.txt", "id = Zx81Qp0LmN4vR7tY2uWc9sKd").hits.is_empty());
    }

    #[test]
    fn masking() {
        assert_eq!(mask("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"), "ghp…Q7r8");
        assert_eq!(mask("hunter22"), "…22");
        assert_eq!(mask("abcdefghijk"), "…jk");
        assert_eq!(mask("abcdefghijkl"), "abc…ijkl");
        let r = one("note.md", &format!("t {}", ghp()));
        assert_eq!(r.hits[0].masked, "ghp…Q7r8");
    }

    #[test]
    fn overridable_except_private_and_saved() {
        let r = one("a.md", "-----BEGIN PRIVATE KEY-----\npassword = hunter22");
        assert_eq!(kinds(&r), vec![HitKind::PrivateKey, HitKind::Password]);
        assert!(!r.hits[0].overridable);
        assert!(r.hits[1].overridable);
        assert_eq!(r.hits[1].line, 2);
    }

    #[test]
    fn line_hash_is_the_blob_id_of_the_line_and_follows_edits() {
        let r = one("a.md", "intro\r\npassword: hunter22\r\n");
        let expected = Oid::hash_object(ObjectType::Blob, b"password: hunter22").unwrap().to_string();
        assert_eq!(r.hits[0].line, 2);
        assert_eq!(r.hits[0].line_hash, expected);
        assert_eq!(r.hits[0].line_hash.len(), 40);
        let edited = one("a.md", "intro\r\npassword: hunter23\r\n");
        assert_ne!(edited.hits[0].line_hash, expected);
    }

    fn utf16_bytes(text: &str, le: bool) -> Vec<u8> {
        let mut b = if le { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
        for u in text.encode_utf16() {
            b.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
        }
        b
    }

    #[test]
    fn utf16_files_are_decoded() {
        for le in [true, false] {
            let text = format!("첫 줄\nkey {}\n", ghp());
            let r = scan(&[file("k.txt", utf16_bytes(&text, le))], &[], &[], &Limits::DEFAULT);
            assert!(r.unscanned.is_empty());
            assert_eq!(kinds(&r), vec![HitKind::Token]);
            assert_eq!(r.hits[0].line, 2);
        }
    }

    #[test]
    fn csv_with_bom_and_korean_text_hits_on_the_right_line() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice("이름,값\n단백질,1\nkey,AKIAIOSFODNN7EXAMPLE\n".as_bytes());
        let r = scan(&[file("data.csv", b)], &[], &[], &Limits::DEFAULT);
        assert_eq!(kinds(&r), vec![HitKind::ApiKey]);
        assert_eq!(r.hits[0].line, 3);
    }

    #[test]
    fn cp949_csv_is_scanned_byte_wise() {
        let mut b = b"\xb4\xdc\xb9\xe9\xc1\xfa,".to_vec();
        b.extend_from_slice(sk40().as_bytes());
        b.extend_from_slice(b"\r\n\xb4\xdc,2\r\n");
        let r = scan(&[file("data.csv", b)], &[], &[], &Limits::DEFAULT);
        assert!(r.unscanned.is_empty(), "a CP949 CSV is text");
        assert_eq!(kinds(&r), vec![HitKind::ApiKey]);
        assert_eq!(r.hits[0].line, 1);
    }

    #[test]
    fn korean_password_in_a_note() {
        let r = one("노트.md", "# 장비\n비밀번호: abc\n");
        assert_eq!(kinds(&r), vec![HitKind::Password]);
        assert_eq!(r.hits[0].line, 2);
        assert_eq!(r.hits[0].masked, "…bc");
    }

    #[test]
    fn binaries_office_pdf_and_large_files_are_unscanned() {
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR password: hunter22".to_vec();
        let big = vec![b'a'; (10 * 1024 * 1024 + 1) as usize];
        let r = scan(
            &[
                file("a.png", png),
                file("x.xlsx", "password: hunter22"),
                file("y.PDF", "password: hunter22"),
                file("big.txt", big),
                file("ok.txt", "nothing here"),
            ],
            &[],
            &[],
            &Limits::DEFAULT,
        );
        assert_eq!(r.unscanned, vec!["a.png", "x.xlsx", "y.PDF", "big.txt"]);
        assert!(r.hits.is_empty());
    }

    #[test]
    fn small_scan_limit_is_honoured() {
        let limits = Limits { scan_max: 10, ..Limits::DEFAULT };
        let r = scan(&[file("a.md", "password: hunter22")], &[], &[], &limits);
        assert_eq!(r.unscanned, vec!["a.md"]);
        assert!(r.hits.is_empty());
    }

    #[test]
    fn file_names_and_paths_are_scanned() {
        let name = format!("notes/token_{}.txt", ghp());
        let r = scan(&[], &[name.clone()], &[], &Limits::DEFAULT);
        assert_eq!(kinds(&r), vec![HitKind::Token]);
        assert_eq!(r.hits[0].path, name);
        assert_eq!(r.hits[0].line, 0);
        // A path in `files` is scanned as a name once, besides its content.
        let r = scan(&[file(&name, "clean")], &[name.clone()], &[], &Limits::DEFAULT);
        assert_eq!(r.hits.len(), 1);
    }

    #[test]
    fn pictures_with_location_are_listed() {
        let r = scan(
            &[
                file("images/bench.jpg", crate::gitsync::exif::tests::jpeg(true)),
                file("images/plain.jpg", crate::gitsync::exif::tests::jpeg(false)),
            ],
            &[],
            &[],
            &Limits::DEFAULT,
        );
        assert_eq!(r.gps, vec!["images/bench.jpg"]);
    }

    const LLM_KEY: &str = "abc123def456ghi789jkl";

    fn store_with_keys() -> (MemoryStore, ServiceConfig) {
        let store = MemoryStore::default();
        let cfg = ServiceConfig::from_settings_json("{}");
        store_secret(&store, Slot::LlmOpenai, &cfg, LLM_KEY).unwrap();
        (store, cfg)
    }

    #[test]
    fn saved_keys_are_exact_matches_and_never_overridable() {
        let (store, cfg) = store_with_keys();
        let gh = GithubState::default();
        let saved = saved_secrets(&store, &cfg, &gh);
        assert_eq!(saved.iter().map(|s| s.label).collect::<Vec<_>>(), vec![SavedLabel::Llm]);
        let note = format!("# 분석\n\nmy key {LLM_KEY} here\n");
        let r = scan(&[file("01_분석.md", note)], &[], &saved, &Limits::DEFAULT);
        assert_eq!(kinds(&r), vec![HitKind::Saved(SavedLabel::Llm)]);
        assert_eq!(r.hits[0].line, 3);
        assert!(!r.hits[0].overridable);

        let debug = format!("{r:?} {saved:?}");
        let json = serde_json::to_string(&r).unwrap();
        for s in [&debug, &json] {
            assert!(!s.contains(LLM_KEY), "raw value leaked: {s}");
        }
        assert!(json.contains("\"kind\":\"saved\""), "{json}");
        assert!(json.contains("\"label\":\"llm\""), "{json}");
    }

    #[test]
    fn a_saved_key_wins_over_the_pattern_it_also_matches() {
        let store = MemoryStore::default();
        let cfg = ServiceConfig::from_settings_json("{}");
        store_secret(&store, Slot::LlmOpenai, &cfg, &sk40()).unwrap();
        let saved = saved_secrets(&store, &cfg, &GithubState::default());
        let r = scan(&[file("a.md", format!("key={}", sk40()))], &[], &saved, &Limits::DEFAULT);
        assert_eq!(kinds(&r), vec![HitKind::Saved(SavedLabel::Llm)]);
    }

    #[test]
    fn saved_secrets_reads_github_memory_and_mcp_tokens_and_skips_short_ones() {
        let store = MemoryStore::default();
        let cfg = ServiceConfig::from_settings_json("{}");
        store_secret(&store, Slot::Github, &cfg, &ghp()).unwrap();
        store_secret(&store, Slot::SlackBot, &cfg, "xoxb-1").unwrap();
        store.set(MCP_ACCOUNT, &"ab".repeat(24)).unwrap();
        let gh = GithubState::default();
        // forgetOnExit: the token moves out of the keychain into memory.
        gh.move_to_memory(&store).unwrap();
        assert!(key_for(&store, Slot::Github, &cfg).unwrap().is_none());
        let saved = saved_secrets(&store, &cfg, &gh);
        let labels: Vec<SavedLabel> = saved.iter().map(|s| s.label).collect();
        assert_eq!(labels, vec![SavedLabel::Github, SavedLabel::Mcp]);
        let debug = format!("{saved:?}");
        assert!(!debug.contains(&ghp()) && !debug.contains(&"ab".repeat(24)), "{debug}");
    }

    #[test]
    fn generated_text_is_scanned_like_any_file() {
        let readme = format!("# 001 {}\n\n이 폴더는 labnoteO 실험 노트입니다.\n", ghp());
        let r = scan(&[file("README.md", readme)], &[], &[], &Limits::DEFAULT);
        assert_eq!(kinds(&r), vec![HitKind::Token]);
    }
}
