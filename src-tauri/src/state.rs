use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

/// Process-wide deletion allowlist. The frontend can only request cleanup of
/// paths that the backend itself produced during a recent scan, which makes
/// `clean_paths` safe to call even if the WebView is compromised.
///
/// Entries are canonical absolute paths. We do not prune the set on successful
/// deletion: stale entries are harmless because `trash::delete` will fail on a
/// missing path.
#[derive(Default)]
pub struct AppState {
    allowlist: Mutex<HashSet<PathBuf>>,
}

impl AppState {
    /// Add a batch of canonical paths to the allowlist. Non-canonicalizable
    /// inputs are silently ignored; the scanner is expected to filter beforehand.
    pub fn extend_allowlist<I>(&self, paths: I)
    where
        I: IntoIterator<Item = PathBuf>,
    {
        if let Ok(mut set) = self.allowlist.lock() {
            set.extend(paths);
        }
    }

    /// Take a cheap clone of the current allowlist for use inside a
    /// `spawn_blocking` task; avoids holding the Mutex across `.await`.
    pub fn snapshot(&self) -> HashSet<PathBuf> {
        self.allowlist
            .lock()
            .map(|set| set.clone())
            .unwrap_or_default()
    }
}
