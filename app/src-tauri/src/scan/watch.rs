//! Watches the scan folder (top level only) and calls a sink once per settled
//! burst, debounced like the vault watcher (`QUIET`, `MAX_WAIT`). The event
//! carries nothing: the webview's watcher lists the folder through Rust and
//! decides what is new. It also polls, because cloud drives and SMB shares
//! may raise no events at all.
//!
//! The vault watcher is not reused: it is vault-scoped and drops non-note
//! files. Dropping the returned `RecommendedWatcher` drops the channel
//! sender, which ends the worker thread; a burst cut short that way is not
//! reported.

use std::path::Path;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};

use crate::vault::watcher::{MAX_WAIT, QUIET};

pub fn start(dir: &Path, sink: impl FnMut() + Send + 'static) -> notify::Result<RecommendedWatcher> {
    let (tx, rx) = channel();
    let mut os = notify::recommended_watcher(move |ev| {
        let _ = tx.send(ev);
    })?;
    os.watch(dir, RecursiveMode::NonRecursive)?;
    let mut sink = sink;
    std::thread::Builder::new()
        .name("labnoteo-scan-watcher".into())
        .spawn(move || run(rx, &mut sink, QUIET, MAX_WAIT))
        .map_err(notify::Error::io)?;
    Ok(os)
}

/// Reads never change the folder; everything else (and an error) may have.
fn counts(ev: &notify::Result<Event>) -> bool {
    !matches!(ev, Ok(Event { kind: EventKind::Access(_), .. }))
}

fn run(rx: Receiver<notify::Result<Event>>, sink: &mut dyn FnMut(), quiet: Duration, max_wait: Duration) {
    while let Ok(first) = rx.recv() {
        if !counts(&first) {
            continue;
        }
        let hard = Instant::now() + max_wait;
        loop {
            let wait = quiet.min(hard.saturating_duration_since(Instant::now()));
            if wait.is_zero() {
                break;
            }
            match rx.recv_timeout(wait) {
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        sink();
    }
}
