//! Attachments outside the editor: open a vault file with the system's default
//! app, and show it in Explorer. The path comes from JS as a vault-relative
//! POSIX path and is confined to the vault here (links resolved first, so a
//! junction out of the vault is `escape`). The JS opener capability stays
//! URL-only (plan ruling R7): nothing here takes an absolute path from JS.
//!
//! Also the write side of non-image attachments (`vault_write_attachment`,
//! plan Task 17): a file pasted or dropped into a note is created directly in
//! the note's computed `resources/` folder, never anywhere else.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::fs::{confine_write, create_new_image, header, join_error, FsError, PathLocks};
use super::path::{confine, is_safe_component, to_rel};

/// Extensions (lowercase) that are never opened or written as attachments:
/// running them would execute code, not show a document. Microsoft's
/// Attachment Manager high-risk list plus script interpreters that are often
/// associated on lab machines (Python, Git Bash, Perl, Ruby). Opening goes
/// further and needs `OPENABLE_EXTS` too; this list is the floor for writes.
pub const BLOCKED_EXTS: &[&str] = &[
    // executables, installers and packages
    "exe", "msi", "msp", "msu", "msix", "msixbundle", "appx", "appxbundle", "com", "scr", "pif", "cpl", "dll", "sys",
    "ocx", "drv", "cab", "diagcab", "application", "appref-ms", "gadget", "jar", "jnlp", "xll", "xbap", "vsix",
    // Windows scripts and script hosts
    "bat", "cmd", "ps1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "psm1", "psd1", "pssc", "cdxml", "msh", "msh1",
    "msh2", "mshxml", "msh1xml", "msh2xml", "vb", "vbs", "vbe", "js", "jse", "mjs", "cjs", "ws", "wsf", "wsh", "wsc", "sct", "hta",
    "mht", "mhtml", "html", "htm", "xhtml", "xht", "shtml", "svgz", "shb", "shs", "inf", "ins", "isp", "reg", "msc", "mmc", "mst", "mcf",
    // other interpreters
    "py", "pyw", "pyz", "pyzw", "pyc", "pyo", "sh", "bash", "zsh", "ksh", "csh", "pl", "pm", "rb", "rbw", "php", "tcl",
    "lua", "r", "command", "tool", "vbproj", "csproj",
    // shortcuts, shell and settings handlers
    "lnk", "url", "scf", "website", "library-ms", "search-ms", "searchconnector-ms", "settingcontent-ms", "theme",
    "themepack", "deskthemepack", "rdp", "chm", "hlp", "grp", "fxp", "prf", "prg", "crt", "der", "cer", "its",
    // Access and Office macro containers
    "ade", "adp", "mad", "maf", "mag", "mam", "maq", "mar", "mas", "mat", "mau", "mav", "maw", "mda", "mdb", "mde",
    "mdt", "mdw", "mdz", "accda", "accdb", "accde", "accdr", "accdt", "laccdb", "docm", "dotm", "xlsm", "xltm", "xlam",
    "xla", "pptm", "potm", "ppam", "ppsm", "sldm",
    // disk images
    "iso", "img", "vhd", "vhdx",
];

/// The only extensions (lowercase) that are opened with the default app: the
/// documents and data a lab note attaches. Anything else stays in labnoteO
/// (its own viewer) or is shown in Explorer, never handed to ShellExecute.
pub const OPENABLE_EXTS: &[&str] = &[
    // images
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "ico",
    // documents
    "pdf", "txt", "md", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "hwp", "hwpx",
    // data
    "csv", "tsv", "json", "log", "yaml", "yml", "fasta", "fa", "fastq", "fq", "gb", "gbk", "ab1", "dna", "pdb", "cif",
    "sdf", "mol", "fcs",
    // archives and media
    "zip", "7z", "gz", "tar", "mp4", "mov", "avi", "mkv", "webm", "mp3", "wav", "m4a",
];

fn last_ext(name: &str) -> Option<String> {
    name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase())
}

/// Whether `name`'s last extension is in `BLOCKED_EXTS`. Windows strips
/// trailing dots and spaces, but `confine` already refuses such names.
pub fn is_blocked_name(name: &str) -> bool {
    last_ext(name).is_some_and(|ext| BLOCKED_EXTS.contains(&ext.as_str()))
}

/// Whether `name` may be opened with the default app: its last extension is in
/// `OPENABLE_EXTS` (and, belt and braces, not in `BLOCKED_EXTS`).
pub fn is_openable_name(name: &str) -> bool {
    !is_blocked_name(name) && last_ext(name).is_some_and(|ext| OPENABLE_EXTS.contains(&ext.as_str()))
}

/// Larger attachments are refused (`TooLarge`); TS checks the same cap before reading.
pub const MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;

fn bad(msg: impl Into<String>) -> FsError {
    FsError::BadInput(msg.into())
}

/// Whether the '/'-separated `rel` names the plugin's system folders
/// `resources/labsamples` or `resources/workflows` anywhere (case-insensitive).
fn touches_system_folder(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    parts.windows(2).any(|w| {
        w[0].eq_ignore_ascii_case("resources") && (w[1].eq_ignore_ascii_case("labsamples") || w[1].eq_ignore_ascii_case("workflows"))
    })
}

/// The attachment folder rule, on the name the caller gave and again on where
/// it resolves: the last component is `resources`, and the path never goes
/// through `resources/labsamples` or `resources/workflows`.
fn check_attachment_dir(rel: &str) -> Result<(), FsError> {
    let last = rel.rsplit('/').next().unwrap_or(rel);
    if !last.eq_ignore_ascii_case("resources") {
        return Err(bad(format!("{rel}: attachments are written only into a resources folder")));
    }
    if touches_system_folder(rel) {
        return Err(bad(format!("{rel}: attachments are never written into the sample or workflow catalog folders")));
    }
    Ok(())
}

/// Split an attachment's file name into `(stem, ".ext" or "")`. The name must
/// be one safe path component, must not start with '.', and must not end in a
/// blocked (executable or script) extension.
fn safe_attachment_name(name: &str) -> Result<(String, String), FsError> {
    if name.is_empty() || name.contains('/') || name.starts_with('.') || !is_safe_component(name) {
        return Err(FsError::Vault(super::path::VaultError::Escape));
    }
    if is_blocked_name(name) {
        return Err(bad(format!("{name}: this kind of file is never saved as an attachment")));
    }
    Ok(match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (name.to_string(), String::new()),
    })
}

/// Write a new attachment into vault folder `dir` (a `resources` folder, created
/// when missing) without ever replacing an existing file: `stem.ext`, then
/// `stem 1.ext` .. `stem 99.ext`, each with `create_new`. Returns the vault path written.
pub fn write_attachment(locks: &PathLocks, root: &Path, dir: &str, name: &str, bytes: &[u8]) -> Result<String, FsError> {
    check_attachment_dir(dir)?;
    let (stem, ext) = safe_attachment_name(name)?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(FsError::TooLarge);
    }
    let abs_dir = confine_write(root, dir)?;
    // A link planted in the path must not lead into a system folder or out of a resources folder.
    let resolved = to_rel(root, &abs_dir)?;
    check_attachment_dir(&resolved)?;
    std::fs::create_dir_all(&abs_dir)?;
    for k in 0..=99u32 {
        let file = if k == 0 { format!("{stem}{ext}") } else { format!("{stem} {k}{ext}") };
        let rel = format!("{dir}/{file}");
        if create_new_image(locks, root, &rel, bytes)? {
            return Ok(rel);
        }
    }
    Err(FsError::Exists)
}

/// Larger files are not read into the webview (`TooLarge`); the viewers show
/// the file card instead (plan ruling R6).
pub const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;

/// The bytes of one regular vault file for the in-app viewers (CSV/TSV and
/// the like). Confined to the vault (links resolved first), never a folder,
/// at most `MAX_READ_BYTES`. Reading runs nothing, so no extension check.
pub fn read_bytes(locks: &PathLocks, root: &Path, rel: &str) -> Result<Vec<u8>, FsError> {
    locks.with(root, rel, || {
        let abs = confine(root, rel)?;
        let meta = std::fs::metadata(&abs)?;
        if !meta.is_file() {
            return Err(bad(format!("{rel}: not a file")));
        }
        if meta.len() > MAX_READ_BYTES {
            return Err(FsError::TooLarge);
        }
        let bytes = std::fs::read(&abs)?;
        // The file may have grown between the check and the read.
        if bytes.len() as u64 > MAX_READ_BYTES {
            return Err(FsError::TooLarge);
        }
        Ok(bytes)
    })
}

/// What actually opens things; a trait so tests never launch anything.
pub trait Opener {
    fn open_path(&self, abs: &Path) -> Result<(), String>;
    fn reveal(&self, abs: &Path) -> Result<(), String>;
}

fn opener_error(e: String) -> FsError {
    FsError::Io(std::io::Error::other(e))
}

/// The absolute path of an existing regular vault file that may be opened.
fn openable(root: &Path, rel: &str) -> Result<PathBuf, FsError> {
    let abs = confine(root, rel)?;
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if !is_openable_name(name) {
        return Err(FsError::BadInput(format!("{name}: this kind of file is not opened from labnoteO")));
    }
    if !std::fs::metadata(&abs)?.is_file() {
        return Err(FsError::BadInput(format!("{name}: not a file")));
    }
    Ok(abs)
}

/// Open a vault file with the default app. Only allowlisted document and data
/// types are opened (executables and scripts never), and never folders, missing files and anything outside the vault.
pub fn open_default(root: &Path, rel: &str, opener: &dyn Opener) -> Result<(), FsError> {
    let abs = openable(root, rel)?;
    opener.open_path(&abs).map_err(opener_error)
}

/// Show a vault file or folder selected in Explorer. Only the containment
/// check applies: revealing runs nothing.
pub fn reveal(root: &Path, rel: &str, opener: &dyn Opener) -> Result<(), FsError> {
    let abs = confine(root, rel)?;
    std::fs::metadata(&abs)?;
    opener.reveal(&abs).map_err(opener_error)
}

/// The real opener: `tauri-plugin-opener` from Rust (no JS scope involved).
struct AppOpener<'a, R: tauri::Runtime>(&'a tauri::AppHandle<R>);

impl<R: tauri::Runtime> Opener for AppOpener<'_, R> {
    fn open_path(&self, abs: &Path) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        let shown = super::path::strip_verbatim(abs);
        self.0.opener().open_path(shown, None::<&str>).map_err(|e| e.to_string())
    }
    fn reveal(&self, abs: &Path) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        let shown = PathBuf::from(super::path::strip_verbatim(abs));
        self.0.opener().reveal_item_in_dir(shown).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn vault_open_default<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, super::VaultState>,
    path: String,
) -> Result<(), FsError> {
    let root = state.root()?;
    open_default(&root, &path, &AppOpener(&app))
}

#[tauri::command]
pub async fn vault_reveal<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, super::VaultState>,
    path: String,
) -> Result<(), FsError> {
    let root = state.root()?;
    reveal(&root, &path, &AppOpener(&app))
}

/// The raw bytes of a vault file for the CSV and file viewers (`read_bytes`).
/// Like `vault_read_image`, the bytes go back as a raw IPC response
/// (an `ArrayBuffer` in JS), off the main thread.
#[tauri::command]
pub async fn vault_read_bytes(
    state: tauri::State<'_, super::VaultState>,
    path: String,
) -> Result<tauri::ipc::Response, FsError> {
    let root = state.root()?;
    let locks = Arc::clone(&state.locks);
    let bytes = tauri::async_runtime::spawn_blocking(move || read_bytes(&locks, &root, &path))
        .await
        .map_err(join_error)??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Paste and drop of a non-image file: the raw protocol of `vault_write_image`
/// (bytes as the raw body, percent-encoded `x-lno-dir` and `x-lno-name`
/// headers). Returns the vault path written.
#[tauri::command]
pub async fn vault_write_attachment(
    state: tauri::State<'_, super::VaultState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, FsError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(bad("the attachment must be sent as raw bytes"));
    };
    let dir = header(&request, "x-lno-dir")?;
    let name = header(&request, "x-lno-name")?;
    let bytes = bytes.clone();
    let root = state.root()?;
    let locks = Arc::clone(&state.locks);
    tauri::async_runtime::spawn_blocking(move || write_attachment(&locks, &root, &dir, &name, &bytes))
        .await
        .map_err(join_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-attach-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(std::fs::canonicalize(&p).unwrap())
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Default)]
    struct Spy {
        opened: RefCell<Vec<PathBuf>>,
        revealed: RefCell<Vec<PathBuf>>,
    }
    impl Opener for Spy {
        fn open_path(&self, abs: &Path) -> Result<(), String> {
            self.opened.borrow_mut().push(abs.to_path_buf());
            Ok(())
        }
        fn reveal(&self, abs: &Path) -> Result<(), String> {
            self.revealed.borrow_mut().push(abs.to_path_buf());
            Ok(())
        }
    }

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    #[test]
    fn reads_the_bytes_of_any_vault_file_within_the_cap() {
        let t = Tmp::new();
        let l = PathLocks::default();
        std::fs::create_dir_all(t.0.join("exp/resources")).unwrap();
        let body = b"\xEF\xBB\xBFa,b\n1,2";
        std::fs::write(t.0.join("exp/resources/plate.csv"), body).unwrap();
        assert_eq!(read_bytes(&l, &t.0, "exp/resources/plate.csv").unwrap(), body);
        std::fs::write(t.0.join("run.exe"), b"MZ").unwrap();
        // reading runs nothing: any regular file inside the vault may be read
        assert_eq!(read_bytes(&l, &t.0, "run.exe").unwrap(), b"MZ");
    }

    #[test]
    fn read_bytes_refuses_escapes_folders_missing_files_and_oversize() {
        let t = Tmp::new();
        let l = PathLocks::default();
        let root = t.0.join("vault");
        std::fs::create_dir_all(root.join("dir")).unwrap();
        std::fs::write(t.0.join("outside.csv"), b"x").unwrap();
        for p in ["../outside.csv", "/outside.csv", r"C:\outside.csv", "dir/../../outside.csv"] {
            assert!(matches!(read_bytes(&l, &root, p), Err(FsError::Vault(_))), "{p}");
        }
        assert!(matches!(read_bytes(&l, &root, "dir"), Err(FsError::BadInput(_))));
        assert!(matches!(read_bytes(&l, &root, "missing.csv"), Err(FsError::Io(_))));
        let big = std::fs::File::create(root.join("big.csv")).unwrap();
        big.set_len(MAX_READ_BYTES + 1).unwrap();
        drop(big);
        assert!(matches!(read_bytes(&l, &root, "big.csv"), Err(FsError::TooLarge)));
        let edge = std::fs::File::create(root.join("edge.csv")).unwrap();
        edge.set_len(MAX_READ_BYTES).unwrap();
        drop(edge);
        assert_eq!(read_bytes(&l, &root, "edge.csv").unwrap().len() as u64, MAX_READ_BYTES);
    }

    #[cfg(windows)]
    #[test]
    fn read_bytes_refuses_a_junction_out_of_the_vault() {
        let t = Tmp::new();
        let l = PathLocks::default();
        let root = t.0.join("vault");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(t.0.join("outside")).unwrap();
        std::fs::write(t.0.join("outside/y.csv"), b"x").unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("out"))
            .arg(t.0.join("outside"))
            .output()
            .unwrap();
        if !status.status.success() {
            return;
        }
        assert!(matches!(read_bytes(&l, &root, "out/y.csv"), Err(FsError::Vault(_))));
        let _ = std::fs::remove_dir(root.join("out"));
    }

    #[test]
    fn opens_a_vault_file_with_the_default_app() {
        let t = Tmp::new();
        touch(&t.0, "exp/resources/gel.png");
        let spy = Spy::default();
        open_default(&t.0, "exp/resources/gel.png", &spy).unwrap();
        assert_eq!(*spy.opened.borrow(), vec![t.0.join("exp").join("resources").join("gel.png")]);
    }

    #[test]
    fn refuses_executables_scripts_folders_missing_files_and_escapes() {
        let t = Tmp::new();
        for name in ["run.exe", "a.ps1", "b.BAT", "c.lnk", "d.js", "e.hta"] {
            touch(&t.0, name);
        }
        std::fs::create_dir_all(t.0.join("folder")).unwrap();
        let spy = Spy::default();
        for rel in ["run.exe", "a.ps1", "b.BAT", "c.lnk", "d.js", "e.hta"] {
            assert!(matches!(open_default(&t.0, rel, &spy), Err(FsError::BadInput(_))), "{rel}");
        }
        assert!(matches!(open_default(&t.0, "folder", &spy), Err(FsError::BadInput(_))));
        assert!(matches!(open_default(&t.0, "missing.pdf", &spy), Err(FsError::Io(_))));
        assert!(matches!(open_default(&t.0, "../x.pdf", &spy), Err(FsError::Vault(_))));
        assert!(matches!(open_default(&t.0, "/etc/x.pdf", &spy), Err(FsError::Vault(_))));
        assert!(spy.opened.borrow().is_empty());
    }

    #[test]
    fn reveals_files_and_folders_inside_the_vault_only() {
        let t = Tmp::new();
        touch(&t.0, "exp/run.exe");
        let spy = Spy::default();
        // revealing runs nothing: an executable may be shown in its folder
        reveal(&t.0, "exp/run.exe", &spy).unwrap();
        reveal(&t.0, "exp", &spy).unwrap();
        assert!(matches!(reveal(&t.0, "../x", &spy), Err(FsError::Vault(_))));
        assert!(matches!(reveal(&t.0, "nope.csv", &spy), Err(FsError::Io(_))));
        assert_eq!(spy.revealed.borrow().len(), 2);
    }

    #[test]
    fn refuses_interpreter_scripts_and_unknown_types() {
        let t = Tmp::new();
        let names = ["x.py", "x.sh", "x.pyw", "x.rb", "x.pl", "x.wsc", "x.theme", "x.rdp", "x.xlsm", "x.html", "x.svg", "noext"];
        for name in names {
            touch(&t.0, name);
        }
        let spy = Spy::default();
        for rel in names {
            assert!(matches!(open_default(&t.0, rel, &spy), Err(FsError::BadInput(_))), "{rel}");
        }
        assert!(spy.opened.borrow().is_empty());
        for ok in ["plate.CSV", "report.pdf", "gel.tif", "data.xlsx", "seq.fasta"] {
            touch(&t.0, ok);
            open_default(&t.0, ok, &spy).unwrap();
        }
        assert_eq!(spy.opened.borrow().len(), 5);
    }

    #[test]
    fn blocked_list_covers_interpreters_and_high_risk_types() {
        for name in ["a.py", "a.sh", "a.bash", "a.pyz", "a.ps1xml", "a.msu", "a.cab", "a.xll", "a.jnlp", "a.accde", "a.searchconnector-ms"] {
            assert!(is_blocked_name(name), "{name}");
            assert!(!is_openable_name(name), "{name}");
        }
        for name in OPENABLE_EXTS {
            assert!(!BLOCKED_EXTS.contains(name), "{name} is both openable and blocked");
        }
    }

    #[test]
    fn blocked_names_are_case_insensitive_and_use_the_last_extension() {
        assert!(is_blocked_name("Setup.EXE"));
        assert!(is_blocked_name("x.tar.ps1"));
        assert!(!is_blocked_name("plate.csv"));
        assert!(!is_blocked_name("exe"));
        assert!(!is_blocked_name("report.pdf"));
    }

    #[test]
    fn writes_attachments_into_resources_and_never_overwrites() {
        let t = Tmp::new();
        let l = PathLocks::default();
        assert_eq!(write_attachment(&l, &t.0, "exp/resources", "plate.csv", b"a,b").unwrap(), "exp/resources/plate.csv");
        assert_eq!(write_attachment(&l, &t.0, "exp/resources", "plate.csv", b"c,d").unwrap(), "exp/resources/plate 1.csv");
        assert_eq!(std::fs::read(t.0.join("exp/resources/plate.csv")).unwrap(), b"a,b");
        assert_eq!(std::fs::read(t.0.join("exp/resources/plate 1.csv")).unwrap(), b"c,d");
        // a vault-root note's folder, a name without an extension, Korean names
        assert_eq!(write_attachment(&l, &t.0, "resources", "README", b"x").unwrap(), "resources/README");
        assert_eq!(write_attachment(&l, &t.0, "resources", "README", b"y").unwrap(), "resources/README 1");
        assert_eq!(write_attachment(&l, &t.0, "exp/resources", "결과.xlsx", b"x").unwrap(), "exp/resources/결과.xlsx");
    }

    #[test]
    fn gives_up_after_99_suffixes() {
        let t = Tmp::new();
        let l = PathLocks::default();
        for _ in 0..100 {
            write_attachment(&l, &t.0, "exp/resources", "x.csv", b"1").unwrap();
        }
        assert!(matches!(write_attachment(&l, &t.0, "exp/resources", "x.csv", b"1"), Err(FsError::Exists)));
    }

    #[test]
    fn refuses_system_folders_other_folders_blocked_types_escapes_and_oversize() {
        let t = Tmp::new();
        let l = PathLocks::default();
        let refused = |dir: &str, name: &str| write_attachment(&l, &t.0, dir, name, b"x").is_err();
        assert!(refused("exp/resources/labsamples", "x.json"));
        assert!(refused("resources/workflows", "x.json"));
        assert!(refused("resources/Workflows/resources", "x.json"));
        assert!(refused("exp/Resources/LabSamples/resources", "x.json"));
        assert!(refused("exp/images", "plate.csv"));
        assert!(refused("exp", "plate.csv"));
        assert!(refused("", "plate.csv"));
        assert!(refused("../resources", "x.csv"));
        assert!(refused("exp/resources", "../x.csv"));
        assert!(refused("exp/resources", "a/b.csv"));
        assert!(refused(".obsidian/resources", "x.csv"));
        for name in ["run.exe", "a.ps1", "b.BAT", "c.lnk", "d.js", "e.mjs", "f.html", "g.htm", "h.hta", "i.msi", "j.reg", "k.jar", "l.py"] {
            assert!(matches!(write_attachment(&l, &t.0, "exp/resources", name, b"x"), Err(FsError::BadInput(_))), "{name}");
        }
        for name in [".hidden", "CON.csv", "a:b.csv", "x.csv.", "x.csv ", "a|b.csv"] {
            assert!(refused("exp/resources", name), "{name}");
        }
        let big = vec![0u8; MAX_ATTACHMENT_BYTES as usize + 1];
        assert!(matches!(write_attachment(&l, &t.0, "exp/resources", "big.zip", &big), Err(FsError::TooLarge)));
        // nothing was created by the refusals
        assert!(!t.0.join("exp/resources").exists() || std::fs::read_dir(t.0.join("exp/resources")).unwrap().next().is_none());
        assert!(!t.0.join("resources").exists());
    }

    #[cfg(windows)]
    #[test]
    fn refuses_a_junction_into_a_system_folder() {
        let t = Tmp::new();
        let l = PathLocks::default();
        std::fs::create_dir_all(t.0.join("resources/labsamples")).unwrap();
        std::fs::create_dir_all(t.0.join("exp")).unwrap();
        let link = t.0.join("exp").join("resources");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(t.0.join("resources").join("labsamples"))
            .output()
            .unwrap();
        if !status.status.success() {
            return; // no junctions on this file system
        }
        assert!(write_attachment(&l, &t.0, "exp/resources", "x.json", b"x").is_err());
        assert!(std::fs::read_dir(t.0.join("resources/labsamples")).unwrap().next().is_none());
        let _ = std::fs::remove_dir(&link);
    }

}
