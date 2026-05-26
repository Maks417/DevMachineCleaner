use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Number of recent scan sessions retained in memory. Older sessions are
/// evicted on the next scan so a long-running app process does not accumulate
/// a stale union of every path ever advertised. Each panel only needs the
/// most recent scan to authorize a clean.
const MAX_SESSIONS: usize = 8;

/// A single scan's set of cleanable paths. Membership in this set is the
/// authorization gate for `clean_paths`.
struct ScanSession {
    paths: HashSet<PathBuf>,
}

/// Scan-session scoped deletion authorization plus an in-flight cancel flag.
///
/// Each scan command (`scan_projects`, `scan_ai_caches`) creates a fresh
/// session, records the canonicalized cleanable paths it advertised, and
/// returns the session id. The frontend echoes the id back when it calls
/// `clean_paths`, and only paths from that specific session are eligible for
/// deletion.
///
/// The `cancel` slot exposes a single `AtomicBool` that the most recent scan
/// is polling; `cancel_scan` flips it and the scanner short-circuits. We use
/// a single slot rather than per-scan because the UI only displays one scan
/// at a time and starting a new scan implicitly supersedes any prior one.
#[derive(Default)]
pub struct AppState {
    sessions: Mutex<HashMap<u64, ScanSession>>,
    counter: AtomicU64,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

impl AppState {
    /// Record a new scan session and return its id. The session id starts at
    /// 1 (never 0, so a defaulted/uninitialized client value is always
    /// rejected). Oldest sessions are evicted once `MAX_SESSIONS` is reached.
    pub fn record_session<I>(&self, paths: I) -> u64
    where
        I: IntoIterator<Item = PathBuf>,
    {
        let id = self
            .counter
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        let set: HashSet<PathBuf> = paths.into_iter().collect();
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(id, ScanSession { paths: set });
            if sessions.len() > MAX_SESSIONS {
                let mut ids: Vec<u64> = sessions.keys().copied().collect();
                ids.sort_unstable();
                let drop_count = sessions.len() - MAX_SESSIONS;
                for old in ids.into_iter().take(drop_count) {
                    sessions.remove(&old);
                }
            }
        }
        id
    }

    /// Clone the path set for the given scan session, or `None` if the
    /// session is unknown (never recorded or already evicted).
    pub fn session_paths(&self, id: u64) -> Option<HashSet<PathBuf>> {
        self.sessions.lock().ok()?.get(&id).map(|s| s.paths.clone())
    }

    /// Begin a new cancellable scan; returns the flag the scanner should
    /// poll. Replaces any existing flag, so a second concurrent scan would
    /// cause the first to lose its cancel handle. That is acceptable because
    /// the frontend only allows one scan at a time per panel.
    pub fn begin_scan(&self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut current) = self.cancel.lock() {
            *current = Some(Arc::clone(&flag));
        }
        flag
    }

    /// Request cancellation of the active scan (if any). No-op when no scan
    /// is in flight.
    pub fn cancel_active_scan(&self) {
        if let Ok(current) = self.cancel.lock() {
            if let Some(flag) = current.as_ref() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn record_session_returns_unique_ids() {
        let state = AppState::default();
        let a = state.record_session([p("/a")]);
        let b = state.record_session([p("/b")]);
        assert_ne!(a, b);
        assert!(a >= 1);
        assert!(b >= 1);
    }

    #[test]
    fn session_paths_returns_recorded_set() {
        let state = AppState::default();
        let id = state.record_session([p("/a"), p("/b")]);
        let paths = state.session_paths(id).expect("session present");
        assert!(paths.contains(&p("/a")));
        assert!(paths.contains(&p("/b")));
        assert_eq!(paths.len(), 2);
    }

    #[test]
    fn unknown_session_returns_none() {
        let state = AppState::default();
        assert!(state.session_paths(0).is_none());
        assert!(state.session_paths(999).is_none());
    }

    #[test]
    fn old_sessions_are_evicted_past_cap() {
        let state = AppState::default();
        let mut ids = Vec::new();
        for i in 0..(MAX_SESSIONS + 3) {
            ids.push(state.record_session([p(&format!("/p{i}"))]));
        }
        let kept = state.sessions.lock().unwrap().len();
        assert_eq!(kept, MAX_SESSIONS);
        for old in ids.iter().take(3) {
            assert!(
                state.session_paths(*old).is_none(),
                "expected session {old} to be evicted",
            );
        }
        for recent in ids.iter().skip(3) {
            assert!(
                state.session_paths(*recent).is_some(),
                "expected session {recent} to be retained",
            );
        }
    }

    #[test]
    fn cancel_flag_propagates_to_scan() {
        let state = AppState::default();
        let flag = state.begin_scan();
        assert!(!flag.load(Ordering::Relaxed));
        state.cancel_active_scan();
        assert!(flag.load(Ordering::Relaxed));
    }

    #[test]
    fn begin_scan_replaces_prior_flag() {
        let state = AppState::default();
        let first = state.begin_scan();
        let _second = state.begin_scan();
        state.cancel_active_scan();
        // Only the most recent flag is signalled. The first scan no longer has
        // a way to be cancelled through state, but that's fine: starting a new
        // scan supersedes the previous one.
        assert!(!first.load(Ordering::Relaxed));
    }
}
