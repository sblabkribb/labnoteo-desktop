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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Sender;

    fn modify() -> notify::Result<Event> {
        Ok(Event::new(EventKind::Modify(notify::event::ModifyKind::Any)))
    }

    fn spawn(quiet: Duration, max_wait: Duration) -> (Sender<notify::Result<Event>>, Receiver<()>, std::thread::JoinHandle<()>) {
        let (tx, rx) = channel();
        let (out_tx, out_rx) = channel();
        let h = std::thread::spawn(move || {
            let mut sink = move || {
                let _ = out_tx.send(());
            };
            run(rx, &mut sink, quiet, max_wait)
        });
        (tx, out_rx, h)
    }

    #[test]
    fn a_burst_settles_into_one_call_and_reads_are_ignored() {
        let (tx, out, h) = spawn(Duration::from_millis(50), Duration::from_secs(60));
        tx.send(Ok(Event::new(EventKind::Access(notify::event::AccessKind::Any)))).unwrap();
        for _ in 0..5 {
            tx.send(modify()).unwrap();
        }
        out.recv_timeout(Duration::from_secs(10)).expect("one call after the burst");
        assert!(out.recv_timeout(Duration::from_millis(200)).is_err(), "only one call");
        tx.send(modify()).unwrap();
        out.recv_timeout(Duration::from_secs(10)).expect("a later burst calls again");
        drop(tx);
        h.join().unwrap();
        assert!(out.try_recv().is_err());
    }

    #[test]
    fn a_burst_that_never_settles_is_cut_at_max_wait_and_a_close_mid_burst_is_silent() {
        let (tx, out, h) = spawn(Duration::from_secs(60), Duration::from_millis(50));
        tx.send(modify()).unwrap();
        out.recv_timeout(Duration::from_secs(10)).expect("max_wait ends the burst");
        let (tx2, out2, h2) = spawn(Duration::from_secs(60), Duration::from_secs(60));
        tx2.send(modify()).unwrap();
        drop(tx2);
        h2.join().unwrap();
        assert!(out2.try_recv().is_err());
        drop(tx);
        h.join().unwrap();
    }
}
