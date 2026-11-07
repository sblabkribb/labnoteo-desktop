//! Keeps the caches honest when the folder changes underneath the app (a git
//! pull, a sync client, Obsidian on the same folder, Explorer): every change is
//! turned into a `vault://changed` event for the tree and an index update.
//!
//! The raw OS events are only a hint that *something at this path* happened.
//! What is reported is decided after the burst has settled, by looking at the
//! file system as it is then, so the order the OS delivered events in (a rename
//! is a remove plus a create, a save is create-temp / write / rename / delete)
//! cannot leave the tree or the index disagreeing with the disk.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use serde::Serialize;

use super::path::{strip_verbatim, to_rel};
use super::tree::{is_listed_path, is_sample_registry_path};

/// The event the frontend listens for.
pub const EVENT: &str = "vault://changed";
/// The event for sample registries (`<…>/labsamples/<name>.json`). They are not
/// notes, so they are not in the tree or the index and never go out on `EVENT`;
/// the samples store listens for this one to re-read a registry edited outside
/// the app. Same `Change` payload.
pub const LABSAMPLES_EVENT: &str = "vault://labsamples-changed";

/// How long the folder must be quiet before a burst is reported.
const QUIET: Duration = Duration::from_millis(200);
/// A burst is reported at the latest this long after its first event, however
/// busy the folder stays (an endless stream of writes must not hold back the
/// tree and the index forever).
const MAX_WAIT: Duration = Duration::from_millis(1000);
/// A flush with more vault changes than this (counted after paths that are not
/// part of the vault, such as `.git/` and non-notes, are dropped) is reported as
/// one `Rescan` instead of one change per path. A git pull or a sync of thousands of files would
/// otherwise cost a `stat`, a note read, an emit and a window refresh each,
/// with every search waiting behind them; one rebuild (chunked, so searches
/// still get in) does the same job. 500 is well above what a person produces by
/// hand (a handful) and above what an editor, Obsidian or a plugin touches in
/// one go, and low enough that the batched path below it stays under a second.
pub const RESCAN_ABOVE: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Created,
    Modified,
    Removed,
}

/// Payload of `vault://changed`. `path` is vault-relative POSIX. A removed
/// folder is reported as one removal of the folder path (and of each note the
/// OS also names). `path == ""` with `Modified` means "something changed and the
/// OS lost track of what: look at everything again".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    pub path: String,
    pub kind: Kind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delta {
    Change(Change),
    /// A sample registry JSON changed (reported on `LABSAMPLES_EVENT`).
    Labsamples(Change),
    /// The OS dropped events (buffer overflow on a huge burst) or failed: the
    /// listener cannot trust incremental updates and must rescan.
    Rescan,
}

/// A running watch of one vault. Dropping it stops it: the worker thread
/// delivers nothing more and exits, and its closure (and what it captured) is
/// released.
pub struct Watcher {
    stopped: Arc<AtomicBool>,
    _os: RecommendedWatcher,
}

impl Drop for Watcher {
    fn drop(&mut self) {
        // Set before the OS watcher (and with it the channel sender) goes away,
        // so a flush already under way does not deliver into the next vault.
        self.stopped.store(true, Ordering::SeqCst);
    }
}

impl Watcher {
    /// Watch `root` (a canonical vault root) recursively; `sink` is called on
    /// the worker thread, once per settled burst, with everything it changed.
    pub fn start(root: &Path, sink: impl FnMut(Vec<Delta>) + Send + 'static) -> notify::Result<Watcher> {
        let (tx, rx) = channel();
        let mut os = notify::recommended_watcher(move |ev| {
            let _ = tx.send(ev);
        })?;
        os.watch(root, RecursiveMode::Recursive)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let (root, flag) = (root.to_path_buf(), stopped.clone());
        let mut sink = sink;
        std::thread::Builder::new()
            .name("labnoteo-watcher".into())
            .spawn(move || run_with(rx, &root, &flag, &mut sink, QUIET, MAX_WAIT))
            .map_err(notify::Error::io)?;
        Ok(Watcher { stopped, _os: os })
    }
}

#[derive(Default)]
struct Pending {
    /// Paths named by events; `true` when one of them said the path appeared.
    paths: BTreeMap<PathBuf, bool>,
    rescan: bool,
}

impl Pending {
    fn add(&mut self, ev: notify::Result<Event>) {
        use notify::event::{ModifyKind, RenameMode};
        let ev = match ev {
            Ok(ev) => ev,
            Err(_) => {
                self.rescan = true;
                return;
            }
        };
        if ev.need_rescan() {
            self.rescan = true;
        }
        let appeared = match ev.kind {
            EventKind::Access(_) => return,
            EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(RenameMode::To)) => true,
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
                // `[from, to]`: only the destination appeared.
                if let Some(to) = ev.paths.last() {
                    self.paths.insert(to.clone(), true);
                }
                false
            }
            _ => false,
        };
        for p in ev.paths {
            *self.paths.entry(p).or_default() |= appeared;
        }
    }
}

/// Worker: wait for a first event, then keep collecting until the folder has
/// been quiet for `quiet` or `max_wait` has passed since that first event, then
/// report. Ends when the OS watcher (the sender) is gone.
fn run_with(
    rx: Receiver<notify::Result<Event>>,
    root: &Path,
    stopped: &AtomicBool,
    sink: &mut dyn FnMut(Vec<Delta>),
    quiet: Duration,
    max_wait: Duration,
) {
    while let Ok(first) = rx.recv() {
        let mut pending = Pending::default();
        pending.add(first);
        let hard = Instant::now() + max_wait;
        let mut gone = false;
        loop {
            let wait = quiet.min(hard.saturating_duration_since(Instant::now()));
            if wait.is_zero() {
                break;
            }
            match rx.recv_timeout(wait) {
                Ok(ev) => pending.add(ev),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    gone = true;
                    break;
                }
            }
        }
        if stopped.load(Ordering::SeqCst) {
            return;
        }
        flush(root, pending, stopped, sink);
        if gone {
            return;
        }
    }
}

fn is_link(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
}

fn flush(root: &Path, pending: Pending, stopped: &AtomicBool, sink: &mut dyn FnMut(Vec<Delta>)) {
    if pending.rescan {
        sink(vec![Delta::Rescan]);
        return;
    }
    let mut links = HashMap::new();
    let mut out = Vec::new();
    for (abs, appeared) in pending.paths {
        if stopped.load(Ordering::SeqCst) {
            return;
        }
        out.extend(classify(root, &abs, appeared, &mut links));
    }
    // Counted after `classify`: thousands of writes under `.git/` (a git pull)
    // or `node_modules/` are not changes to the vault and must cost nothing.
    if out.len() > RESCAN_ABOVE {
        sink(vec![Delta::Rescan]);
    } else if !out.is_empty() {
        sink(out);
    }
}

/// Decide what, if anything, a path named by the OS means for the vault.
/// `None` for everything that is not part of it. Name rules come first and are
/// the shared `is_listed_path`, so an excluded path (`.obsidian/...`) is dropped
/// before the file system is touched at all; then the link rule that
/// `is_listed_path` leaves to the watcher: nothing at or below a symlink or
/// junction is part of the vault (the walk does not follow them), so a link
/// pointing out cannot make the app index or show anything from outside.
/// A path that is gone is a removal whatever it was (a note or a folder; the
/// OS no longer says which, and removing an unknown path is harmless).
/// A sample registry (`is_sample_registry_path`) passes the same link rule and
/// is tagged `Delta::Labsamples` instead, also when it is gone.
fn classify(root: &Path, abs: &Path, appeared: bool, links: &mut HashMap<String, bool>) -> Option<Delta> {
    let rel = to_rel(root, abs).ok()?;
    if rel.is_empty() || !is_listed_path(&rel, true) {
        return None;
    }
    let registry = is_sample_registry_path(&rel);
    let mut prefix = String::new();
    for part in rel.split('/') {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(part);
        // Cached by lower-cased prefix, as NTFS compares: a burst under one
        // folder checks that folder once.
        let linked = *links.entry(prefix.to_lowercase()).or_insert_with(|| is_link(&root.join(&prefix)));
        if linked {
            return None;
        }
    }
    match std::fs::symlink_metadata(root.join(&rel)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let c = Change { path: rel, kind: Kind::Removed };
            Some(if registry { Delta::Labsamples(c) } else { Delta::Change(c) })
        }
        Err(_) => None,
        // A folder's own timestamp moves whenever something inside it does:
        // only its appearing matters (its notes are reported on their own).
        Ok(m) if m.is_dir() => appeared.then(|| Delta::Change(Change { path: rel, kind: Kind::Created })),
        Ok(m) if m.is_file() && (registry || is_listed_path(&rel, false)) => {
            let c = Change { path: rel, kind: if appeared { Kind::Created } else { Kind::Modified } };
            Some(if registry { Delta::Labsamples(c) } else { Delta::Change(c) })
        }
        Ok(_) => None,
    }
}

/// Holds the one running watcher and moves it with the vault.
pub struct WatcherState {
    starter: Box<dyn Fn(&Path) -> Option<Watcher> + Send + Sync>,
    current: Mutex<Option<(String, Watcher)>>,
}

impl WatcherState {
    pub fn new(starter: impl Fn(&Path) -> Option<Watcher> + Send + Sync + 'static) -> Self {
        WatcherState { starter: Box::new(starter), current: Mutex::new(None) }
    }

    /// Watches nothing. For tests that need the state managed but no threads.
    pub fn inert() -> Self {
        Self::new(|_| None)
    }

    /// Make `root` the watched vault. The same vault again keeps the running
    /// watcher; another one stops the old watcher first, so at most one runs.
    pub fn follow(&self, root: &Path) {
        let key = strip_verbatim(root).to_lowercase();
        let mut cur = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if cur.as_ref().is_some_and(|(k, _)| *k == key) {
            return;
        }
        *cur = None;
        *cur = (self.starter)(root).map(|w| (key, w));
    }
}

/// Apply one settled burst to the search index. The files are the truth: a
/// rescan rebuilds; otherwise every change goes in one transaction, where a
/// created or modified note is re-read (its row dropped if it is gone) and a
/// removal drops the note or every note under a removed folder.
fn apply_to_index(ix: &crate::index::Index, root: &Path, deltas: &[Delta]) {
    let r = if deltas.contains(&Delta::Rescan) {
        ix.rebuild(root).map(|_| ())
    } else {
        let changes: Vec<(String, bool)> = deltas
            .iter()
            .filter_map(|d| match d {
                Delta::Change(c) => Some((c.path.clone(), c.kind == Kind::Removed)),
                Delta::Labsamples(_) | Delta::Rescan => None,
            })
            .collect();
        ix.apply(root, &changes)
    };
    if let Err(e) = r {
        eprintln!("labnoteO: index update after a file change failed: {e}");
    }
}

/// Watch `root`, keep `index` in line when there is one, and hand every change
/// to `emit` with the event it goes out on (`EVENT` or `LABSAMPLES_EVENT`). The index is a cache and is best-effort here: a vault whose index
/// would not open still gets its watcher, because the tree refresh and the
/// editor's external-change check depend on the events, not on the cache.
fn start_watching(
    root: &Path,
    index: Option<Arc<crate::index::Index>>,
    emit: impl Fn(&'static str, Change) + Send + 'static,
) -> Option<Watcher> {
    let root_owned = root.to_path_buf();
    let sink = move |deltas: Vec<Delta>| {
        if let Some(ix) = &index {
            apply_to_index(ix, &root_owned, &deltas);
        }
        for delta in deltas {
            match delta {
                Delta::Change(c) => emit(EVENT, c),
                Delta::Labsamples(c) => emit(LABSAMPLES_EVENT, c),
                Delta::Rescan => emit(EVENT, Change { path: String::new(), kind: Kind::Modified }),
            }
        }
    };
    match Watcher::start(root, sink) {
        Ok(w) => Some(w),
        Err(e) => {
            eprintln!("labnoteO: could not watch the vault for changes: {e}");
            None
        }
    }
}

/// The app's starter: watch the vault, keep its index in line, tell the window.
pub fn app_starter<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> impl Fn(&Path) -> Option<Watcher> + Send + Sync + 'static {
    use tauri::{Emitter, Manager};
    move |root| {
        let index = match app.state::<crate::index::IndexState>().get(root) {
            Ok(ix) => Some(ix),
            Err(e) => {
                eprintln!("labnoteO: the search index would not open, watching without it: {e}");
                None
            }
        };
        let app = app.clone();
        start_watching(root, index, move |event, change| {
            let _ = app.emit(event, change);
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "labnoteo-watch-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            Scratch(std::fs::canonicalize(p).unwrap())
        }
        fn write(&self, rel: &str, text: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn junction(link: &Path, target: &Path) {
        let out = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
        assert!(out.status.success(), "mklink: {}", String::from_utf8_lossy(&out.stdout));
    }

    fn watch(root: &Path) -> (Watcher, Receiver<Delta>) {
        let (tx, rx) = channel();
        let w = Watcher::start(root, move |ds| ds.into_iter().for_each(|d| drop(tx.send(d)))).unwrap();
        (w, rx)
    }

    /// Everything delivered until the folder has been silent for `quiet`.
    fn drain(rx: &Receiver<Delta>, quiet: Duration) -> Vec<Delta> {
        let mut out = Vec::new();
        while let Ok(d) = rx.recv_timeout(quiet) {
            out.push(d);
        }
        out
    }

    fn change(path: &str, kind: Kind) -> Delta {
        Delta::Change(Change { path: path.into(), kind })
    }

    #[test]
    fn emits_modified_when_a_note_changes() {
        let s = Scratch::new();
        s.write("a.md", "one");
        let (_w, rx) = watch(&s.0);
        std::thread::sleep(Duration::from_millis(100));
        s.write("a.md", "two");
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), change("a.md", Kind::Modified));
        assert!(drain(&rx, Duration::from_millis(500)).is_empty(), "one change, one event");
    }

    fn labsamples(path: &str, kind: Kind) -> Delta {
        Delta::Labsamples(Change { path: path.into(), kind })
    }

    #[test]
    fn emits_labsamples_changed_when_a_registry_changes() {
        let s = Scratch::new();
        s.write("resources/labsamples/DNA.json", "{}");
        let (_w, rx) = watch(&s.0);
        std::thread::sleep(Duration::from_millis(100));
        s.write("resources/labsamples/DNA.json", "{\"a\":1}");
        s.write("resources/labsamples/DNA.json", "{\"a\":2}");
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            labsamples("resources/labsamples/DNA.json", Kind::Modified)
        );
        assert!(drain(&rx, Duration::from_millis(500)).is_empty(), "one change, one event, none on vault://changed");
    }

    #[test]
    fn a_registry_change_is_emitted_on_the_labsamples_event_only() {
        let s = Scratch::new();
        s.write("resources/labsamples/DNA.json", "{}");
        s.write("a.md", "x");
        let (tx, rx) = channel();
        let _w = start_watching(&s.0, None, move |event, c| drop(tx.send((event, c)))).expect("a watcher");
        std::thread::sleep(Duration::from_millis(100));
        s.write("resources/labsamples/DNA.json", "{\"a\":1}");
        s.write("a.md", "y");
        let mut got = Vec::new();
        while let Ok(x) = rx.recv_timeout(Duration::from_millis(700)) {
            got.push(x);
        }
        got.sort_by(|a, b| a.1.path.cmp(&b.1.path));
        assert_eq!(
            got,
            [
                (EVENT, Change { path: "a.md".into(), kind: Kind::Modified }),
                (LABSAMPLES_EVENT, Change { path: "resources/labsamples/DNA.json".into(), kind: Kind::Modified }),
            ]
        );
    }

    #[test]
    fn emits_created_for_a_new_note_and_removed_when_a_note_is_deleted() {
        let s = Scratch::new();
        s.write("sub/gone.md", "x");
        let (_w, rx) = watch(&s.0);
        std::thread::sleep(Duration::from_millis(100));
        s.write("sub/new.md", "y");
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), change("sub/new.md", Kind::Created));
        std::fs::remove_file(s.0.join("sub/gone.md")).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), change("sub/gone.md", Kind::Removed));
    }

    #[test]
    fn emits_removed_when_a_note_is_deleted() {
        let s = Scratch::new();
        s.write("a.md", "x");
        let (_w, rx) = watch(&s.0);
        std::thread::sleep(Duration::from_millis(100));
        std::fs::remove_file(s.0.join("a.md")).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), change("a.md", Kind::Removed));
    }

    #[test]
    fn ignores_changes_under_dot_obsidian() {
        let s = Scratch::new();
        s.write(".obsidian/workspace.md", "0");
        let (_w, rx) = watch(&s.0);
        std::thread::sleep(Duration::from_millis(100));
        s.write(".obsidian/workspace.md", "1");
        s.write(".obsidian/new.md", "1");
        s.write("sub/.obsidian/deep.md", "1");
        std::fs::remove_file(s.0.join(".obsidian/workspace.md")).unwrap();
        // A visible note after the hidden ones proves the watcher was alive and
        // delivering, so the absence above is the filter and not silence.
        s.write("visible.md", "1");
        let got = drain(&rx, Duration::from_millis(700));
        assert!(got.contains(&change("visible.md", Kind::Created)), "{got:?}");
        for d in &got {
            let Delta::Change(c) = d else { panic!("unexpected {d:?}") };
            assert!(!c.path.contains(".obsidian"), "{d:?}");
        }
    }

    #[test]
    fn coalesces_a_burst_of_writes_into_one_event() {
        let s = Scratch::new();
        s.write("a.md", "0");
        let (_w, rx) = watch(&s.0);
        std::thread::sleep(Duration::from_millis(100));
        // 15 writes 20 ms apart: every gap is far below the 200 ms quiet time.
        for i in 0..15 {
            s.write("a.md", &i.to_string());
            std::thread::sleep(Duration::from_millis(20));
        }
        let got = drain(&rx, Duration::from_millis(600));
        assert_eq!(got, [change("a.md", Kind::Modified)]);
    }

    #[test]
    fn a_rename_is_a_removal_of_the_old_name_and_an_appearance_of_the_new_one() {
        let s = Scratch::new();
        s.write("old.md", "needle");
        let (_w, rx) = watch(&s.0);
        std::thread::sleep(Duration::from_millis(100));
        std::fs::rename(s.0.join("old.md"), s.0.join("new.md")).unwrap();
        let got = drain(&rx, Duration::from_millis(600));
        assert!(got.contains(&change("old.md", Kind::Removed)), "{got:?}");
        assert!(got.contains(&change("new.md", Kind::Created)), "{got:?}");
        assert_eq!(got.len(), 2, "{got:?}");
    }

    #[test]
    fn a_renamed_note_ends_up_in_the_index_under_the_new_name_only() {
        let s = Scratch::new();
        s.write("old.md", "needle");
        let data = Scratch::new();
        let ix = Arc::new(crate::index::Index::open(&data.0.join("i.db")).unwrap());
        ix.rebuild(&s.0).unwrap();
        assert_eq!(ix.paths().unwrap(), ["old.md"]);
        let (ix2, root) = (ix.clone(), s.0.clone());
        let w = Watcher::start(&s.0, move |d| apply_to_index(&ix2, &root, &d)).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        std::fs::rename(s.0.join("old.md"), s.0.join("new.md")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while ix.paths().unwrap() != ["new.md"] && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(ix.paths().unwrap(), ["new.md"]);
        assert_eq!(ix.search("needle", 10).unwrap().hits.len(), 1);
        drop(w);
    }

    #[test]
    fn nothing_under_a_junction_is_part_of_the_vault() {
        let s = Scratch::new();
        let outside = Scratch::new();
        outside.write("secret.md", "x");
        outside.write("sub/deep.md", "x");
        s.write("in.md", "x");
        junction(&s.0.join("link"), &outside.0);
        let mut links = HashMap::new();
        // The classification itself: a note reached through the link, at any depth, and the link itself.
        for p in ["link/secret.md", "link/sub/deep.md", "link"] {
            assert_eq!(classify(&s.0, &s.0.join(p), true, &mut links), None, "{p}");
            assert_eq!(classify(&s.0, &s.0.join(p), false, &mut links), None, "{p}");
        }
        // A control through the same function: a real note is reported.
        assert_eq!(
            classify(&s.0, &s.0.join("in.md"), false, &mut links),
            Some(change("in.md", Kind::Modified))
        );
        // Liveness only, NOT link coverage: ReadDirectoryChangesW does not cross
        // a reparse point, so no event for the write outside is expected whether or
        // not the link check exists. The six `classify` calls above are the coverage;
        // this half only shows the watcher still reports a note inside the vault.
        let (_w, rx) = watch(&s.0);
        std::thread::sleep(Duration::from_millis(100));
        outside.write("secret.md", "changed");
        s.write("in.md", "changed");
        let got = drain(&rx, Duration::from_millis(700));
        assert_eq!(got, [change("in.md", Kind::Modified)]);
    }

    fn file_event(path: &Path) -> notify::Result<Event> {
        Ok(Event::new(EventKind::Modify(notify::event::ModifyKind::Any)).add_path(path.to_path_buf()))
    }

    #[test]
    fn a_never_ending_burst_is_still_reported_within_the_max_wait() {
        let s = Scratch::new();
        s.write("busy.md", "x");
        let (tx, rx) = channel();
        let (out_tx, out_rx) = channel();
        let root = s.0.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let flag = stopped.clone();
        std::thread::spawn(move || {
            run_with(
                rx,
                &root,
                &flag,
                &mut |d| drop(out_tx.send((Instant::now(), d))),
                Duration::from_millis(200),
                Duration::from_millis(600),
            )
        });
        let start = Instant::now();
        // An event every 50 ms for 2.5 s: the quiet time is never reached.
        let feeder = {
            let p = s.0.join("busy.md");
            std::thread::spawn(move || {
                for _ in 0..50 {
                    let _ = tx.send(file_event(&p));
                    std::thread::sleep(Duration::from_millis(50));
                }
            })
        };
        let (at, d) = out_rx.recv_timeout(Duration::from_secs(2)).expect("flushed while the burst was still going");
        assert_eq!(d, [change("busy.md", Kind::Modified)]);
        assert!(at - start < Duration::from_millis(1500), "{:?}", at - start);
        feeder.join().unwrap();
    }

    #[test]
    fn a_watcher_error_asks_for_a_rescan_instead_of_guessing() {
        let s = Scratch::new();
        let (tx, rx) = channel();
        let (out_tx, out_rx) = channel();
        let root = s.0.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        std::thread::spawn(move || {
            run_with(
                rx,
                &root,
                &stopped,
                &mut |d| drop(out_tx.send(d)),
                Duration::from_millis(20),
                Duration::from_millis(100),
            )
        });
        tx.send(Err(notify::Error::generic("buffer overflow"))).unwrap();
        assert_eq!(out_rx.recv_timeout(Duration::from_secs(2)).unwrap(), [Delta::Rescan]);
    }

    /// Run `events` through a worker and return what each flush delivered.
    fn flushes(root: &Path, events: Vec<notify::Result<Event>>) -> Vec<Vec<Delta>> {
        let (tx, rx) = channel();
        let (out_tx, out_rx) = channel();
        let root = root.to_path_buf();
        let stopped = Arc::new(AtomicBool::new(false));
        let worker = std::thread::spawn(move || {
            run_with(rx, &root, &stopped, &mut |d| drop(out_tx.send(d)), Duration::from_millis(30), Duration::from_millis(500))
        });
        for e in events {
            tx.send(e).unwrap();
        }
        drop(tx); // the sender going away ends the worker after its last flush
        worker.join().unwrap();
        out_rx.try_iter().collect()
    }

    #[test]
    fn an_event_the_os_flags_as_needing_a_rescan_asks_for_one() {
        let s = Scratch::new();
        // A *successful* event carrying the rescan flag (what the OS gives when it
        // drops events): the `need_rescan` path, not the error path.
        let flagged = Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);
        assert!(flagged.need_rescan());
        assert_eq!(flushes(&s.0, vec![Ok(flagged)]), [[Delta::Rescan]]);
    }

    #[test]
    fn a_big_burst_of_real_notes_becomes_one_rescan_and_a_small_one_stays_one_batch() {
        let s = Scratch::new();
        let notes = |n: usize| -> Vec<notify::Result<Event>> {
            (0..n)
                .map(|i| {
                    s.write(&format!("m{i}.md"), "x");
                    file_event(&s.0.join(format!("m{i}.md")))
                })
                .collect()
        };
        let got = flushes(&s.0, notes(3));
        assert_eq!(got.len(), 1, "one flush, one sink call: {got:?}");
        assert_eq!(got[0].len(), 3);
        // RESCAN_ABOVE notes is still a batch (all of them existing, so all real changes); one more is a rescan.
        let got = flushes(&s.0, notes(RESCAN_ABOVE));
        assert_eq!(got.iter().map(Vec::len).collect::<Vec<_>>(), [RESCAN_ABOVE]);
        assert!(got[0].iter().all(|d| matches!(d, Delta::Change(c) if c.kind == Kind::Modified)));
        assert_eq!(flushes(&s.0, notes(RESCAN_ABOVE + 1)), [[Delta::Rescan]]);
    }

    #[test]
    fn a_git_pull_inside_the_vault_costs_nothing() {
        let s = Scratch::new();
        // Thousands of writes under `.git/`, `node_modules/` and non-notes: none is
        // part of the vault, so no change, no rescan, no sink call at all.
        let mut events = Vec::new();
        for i in 0..RESCAN_ABOVE * 3 {
            let rel = match i % 3 {
                0 => format!(".git/objects/{i}"),
                1 => format!("node_modules/p/{i}.md"),
                _ => format!("data/{i}.csv"),
            };
            s.write(&rel, "x");
            events.push(file_event(&s.0.join(rel)));
        }
        assert_eq!(flushes(&s.0, events), Vec::<Vec<Delta>>::new());
        // And a few real notes among that noise are still reported, only they.
        s.write("real.md", "x");
        s.write(".git/HEAD", "x");
        let got = flushes(&s.0, vec![file_event(&s.0.join(".git/HEAD")), file_event(&s.0.join("real.md"))]);
        assert_eq!(got, [[change("real.md", Kind::Modified)]]);
    }

    #[test]
    fn a_watcher_without_an_index_still_reports_changes() {
        let s = Scratch::new();
        s.write("a.md", "one");
        let (tx, rx) = channel();
        let _w = start_watching(&s.0, None, move |_, c| drop(tx.send(c))).expect("a watcher without an index");
        std::thread::sleep(Duration::from_millis(100));
        s.write("a.md", "two");
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), Change { path: "a.md".into(), kind: Kind::Modified });
    }

    /// A sink holding a token: a worker that is gone has released it.
    fn probe() -> (Arc<()>, impl FnMut(Vec<Delta>) + Send + 'static) {
        let alive = Arc::new(());
        let held = alive.clone();
        (alive, move |_| {
            let _ = &held;
        })
    }

    fn wait_until(mut f: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        f()
    }

    #[test]
    fn dropping_the_watcher_ends_its_thread() {
        let s = Scratch::new();
        let (alive, sink) = probe();
        let w = Watcher::start(&s.0, sink).unwrap();
        assert_eq!(Arc::strong_count(&alive), 2);
        drop(w);
        assert!(wait_until(|| Arc::strong_count(&alive) == 1), "worker still holds its sink");
    }

    #[test]
    fn switching_vaults_leaves_exactly_one_watcher() {
        let (a, b, c) = (Scratch::new(), Scratch::new(), Scratch::new());
        let probes: Arc<Mutex<Vec<Arc<()>>>> = Arc::default();
        let log = probes.clone();
        let state = WatcherState::new(move |root| {
            let (alive, sink) = probe();
            log.lock().unwrap().push(alive);
            Watcher::start(root, sink).ok()
        });
        let running = || probes.lock().unwrap().iter().filter(|p| Arc::strong_count(p) > 1).count();
        state.follow(&a.0);
        state.follow(&a.0);
        assert_eq!(probes.lock().unwrap().len(), 1, "the same vault again keeps its watcher");
        state.follow(&b.0);
        state.follow(&c.0);
        assert_eq!(probes.lock().unwrap().len(), 3);
        assert!(wait_until(|| running() == 1), "{} watchers running", running());
        drop(state);
        assert!(wait_until(|| running() == 0), "closing leaves {} running", running());
    }
}
