//! Pacing for the literature sources (spec §8.1, §8.2): per source, one
//! request in flight and requests spaced at least `1 / rate` apart (a token
//! bucket of one token, so a burst is spread out rather than sent at once).
//!
//! The clock is tokio's, so the tests run it paused (a fake clock).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use tokio::time::Instant;

/// The gap between two requests to a source paced at `rate_per_s` (at least
/// 1 per second is assumed for a rate of 0).
pub fn interval(rate_per_s: u32) -> Duration {
    Duration::from_secs(1) / rate_per_s.max(1)
}

/// One source's gate: the lock is the one request in flight, and it guards
/// the earliest time the next request may start.
type Gate = Arc<AsyncMutex<Option<Instant>>>;

/// Every source's gate, created on first use.
#[derive(Default)]
pub struct Limiter {
    gates: Mutex<HashMap<&'static str, Gate>>,
}

/// Held while a request to the source is in flight; dropping it lets the
/// next one through (no earlier than its slot).
pub struct Permit {
    _guard: OwnedMutexGuard<Option<Instant>>,
}

impl Limiter {
    /// The limiter the commands share (one for the app).
    pub fn global() -> &'static Limiter {
        static LIMITER: OnceLock<Limiter> = OnceLock::new();
        LIMITER.get_or_init(Limiter::default)
    }

    fn gate(&self, source: &'static str) -> Gate {
        let mut gates = self.gates.lock().unwrap_or_else(|e| e.into_inner());
        gates.entry(source).or_default().clone()
    }

    /// Waits until no other request to `source` is in flight and its next
    /// slot has come, then books the slot after it. The rate is read on every
    /// call, so an NCBI key saved meanwhile speeds up the next request.
    pub async fn acquire(&self, source: &'static str, rate_per_s: u32) -> Permit {
        let mut guard = self.gate(source).lock_owned().await;
        let now = Instant::now();
        let start = guard.map_or(now, |next| next.max(now));
        *guard = Some(start + interval(rate_per_s));
        tokio::time::sleep_until(start).await;
        Permit { _guard: guard }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// When each of `n` back-to-back acquires got through, from the start.
    async fn times(lim: &Limiter, source: &'static str, rate: u32, n: usize) -> Vec<Duration> {
        let t0 = Instant::now();
        let mut out = Vec::new();
        for _ in 0..n {
            let permit = lim.acquire(source, rate).await;
            out.push(t0.elapsed());
            drop(permit);
        }
        out
    }

    fn ms(d: &[Duration]) -> Vec<u128> {
        d.iter().map(Duration::as_millis).collect()
    }

    #[tokio::test(start_paused = true)]
    async fn three_per_second_without_a_key() {
        let lim = Limiter::default();
        assert_eq!(ms(&times(&lim, "pubmed", 3, 4).await), vec![0, 334, 667, 1000], "spaced 1/3 s apart (tokio rounds timers up to the ms)");
    }

    #[tokio::test(start_paused = true)]
    async fn ten_per_second_with_a_key() {
        let lim = Limiter::default();
        assert_eq!(ms(&times(&lim, "pubmed", 10, 4).await), vec![0, 100, 200, 300]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_is_spaced_and_a_pause_refills_the_slot() {
        let lim = Limiter::default();
        let first = times(&lim, "biorxiv", 1, 3).await;
        assert_eq!(ms(&first), vec![0, 1000, 2000]);
        // Long after the last slot, the next request goes at once.
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(ms(&times(&lim, "biorxiv", 1, 1).await), vec![0]);
    }

    #[tokio::test(start_paused = true)]
    async fn sources_are_paced_separately() {
        let lim = Limiter::default();
        let _a = lim.acquire("pubmed", 3).await;
        let t0 = Instant::now();
        let _b = lim.acquire("crossref", 5).await;
        assert_eq!(t0.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn one_request_in_flight_per_source() {
        let lim = Limiter::default();
        let held = lim.acquire("crossref", 5).await;
        let waited = tokio::time::timeout(Duration::from_secs(30), lim.acquire("crossref", 5)).await;
        assert!(waited.is_err(), "a second request waited for the first one to end");
        drop(held);
        let t0 = Instant::now();
        let _next = lim.acquire("crossref", 5).await;
        assert_eq!(t0.elapsed(), Duration::ZERO, "its slot had long passed");
    }

    #[test]
    fn interval_of_a_rate() {
        assert_eq!(interval(3), Duration::from_nanos(333_333_333));
        assert_eq!(interval(10), Duration::from_millis(100));
        assert_eq!(interval(0), Duration::from_secs(1));
    }
}
