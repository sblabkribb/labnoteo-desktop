//! Every network request the app makes goes through this module (Rust only;
//! the webview never names a host). See the SP6 plan, decisions D6-D11.

pub mod config;
pub mod error;
pub mod http;
pub mod bfw;
pub mod llm;
pub mod partbank;
pub mod secrets;
pub use error::*;

#[cfg(test)]
pub mod testserver;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::State;
use tokio::sync::Notify;

/// How many cancels for not-yet-registered ids are remembered (D11).
const CANCELLED_EARLY_CAP: usize = 256;

/// Requests in flight, by the webview's `requestId`, plus the PartBank web
/// pacing gate (D11). Managed once for the app.
#[derive(Default)]
pub struct NetState {
    pending: Mutex<HashMap<String, Arc<Notify>>>,
    cancelled_early: Mutex<VecDeque<String>>,
    web_gate: tokio::sync::Mutex<Option<Instant>>,
}

impl NetState {
    /// Registers a request id. A cancel that arrived before this call answers
    /// `cancelled` here (and is used up), so nothing is sent. Lock order is
    /// always `pending`, then `cancelled_early`, here and in `cancel`, so a
    /// cancel can never fall between the two.
    pub fn register(&self, id: &str) -> Result<Arc<Notify>, NetError> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let mut early = self.cancelled_early.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = early.iter().position(|x| x == id) {
            early.remove(i);
            return Err(NetError::new(NetErrorKind::Cancelled, "cancelled"));
        }
        if pending.contains_key(id) {
            return Err(NetError::new(NetErrorKind::BadInput, "request id already in use"));
        }
        let notify = Arc::new(Notify::new());
        pending.insert(id.to_string(), notify.clone());
        Ok(notify)
    }

    /// Forgets a request id once its request ended, however it ended.
    pub fn finish(&self, id: &str) {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    /// Cancels a registered request (`true`). `notify_one` stores a permit, so
    /// a cancel that lands before the request polls `notified()` is not lost.
    /// An unknown id is remembered (at most 256, oldest dropped) so a request
    /// registered later with it answers `cancelled` without sending (`false`).
    pub fn cancel(&self, id: &str) -> bool {
        let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(notify) = pending.get(id) {
            notify.notify_one();
            return true;
        }
        let mut early = self.cancelled_early.lock().unwrap_or_else(|e| e.into_inner());
        if !early.iter().any(|x| x == id) {
            if early.len() >= CANCELLED_EARLY_CAP {
                early.pop_front();
            }
            early.push_back(id.to_string());
        }
        false
    }

    /// Waits until `gap` has passed since the previous slot. One shared gate,
    /// so concurrent callers queue up behind each other.
    pub async fn web_slot(&self, gap: Duration) {
        let mut last = self.web_gate.lock().await;
        if let Some(prev) = *last {
            let since = prev.elapsed();
            if since < gap {
                tokio::time::sleep(gap - since).await;
            }
        }
        *last = Some(Instant::now());
    }
}

/// Cancels the request the webview started with `requestId` (D11). `true` when
/// it was in flight; `false` when it is not registered yet (it will then
/// answer `cancelled` without sending) or already finished.
#[tauri::command]
pub fn net_cancel(net: State<NetState>, request_id: String) -> bool {
    net.cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn early_cancels_are_capped_at_256_oldest_first() {
        let net = NetState::default();
        for i in 0..300 {
            assert!(!net.cancel(&format!("id{i}")));
        }
        // The oldest 44 were dropped and register normally.
        assert!(net.register("id0").is_ok());
        assert_eq!(net.register("id299").unwrap_err().kind, NetErrorKind::Cancelled);
        assert_eq!(net.register("id44").unwrap_err().kind, NetErrorKind::Cancelled);
    }

    #[test]
    fn a_duplicate_request_id_is_refused() {
        let net = NetState::default();
        net.register("a").unwrap();
        assert_eq!(net.register("a").unwrap_err().kind, NetErrorKind::BadInput);
        net.finish("a");
        assert!(net.register("a").is_ok());
    }
}
