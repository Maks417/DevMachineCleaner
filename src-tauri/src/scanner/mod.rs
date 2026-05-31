pub mod ai_caches;
pub mod stacks;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;
use walkdir::WalkDir;

/// Sum of all file sizes under `path` plus a count of entries that could not
/// be inspected (permission denied, broken symlinks, transient I/O failures).
/// Returning the error count lets callers tell users when reported totals may
/// be conservative.
#[derive(Debug, Default, Clone, Copy)]
pub struct SizeStats {
    pub bytes: u64,
    pub errors: u64,
}

/// Sum the sizes of all files under `path`. Returns zeros for missing paths.
pub fn dir_size(path: &Path) -> SizeStats {
    if !path.exists() {
        return SizeStats::default();
    }
    let mut stats = SizeStats::default();
    for entry in WalkDir::new(path).follow_links(false) {
        match entry {
            Ok(e) => {
                if e.file_type().is_file() {
                    match e.metadata() {
                        Ok(meta) => {
                            stats.bytes = stats.bytes.saturating_add(meta.len());
                        }
                        Err(_) => {
                            stats.errors = stats.errors.saturating_add(1);
                        }
                    }
                }
            }
            Err(_) => {
                stats.errors = stats.errors.saturating_add(1);
            }
        }
    }
    stats
}

/// In-memory cache of directory sizes keyed by path plus the directory's own
/// modification time. Lets repeat scans skip re-walking large trees (e.g.
/// `node_modules`) that have not changed between scans. Held in `AppState` so
/// it persists across scan commands for the life of the process.
///
/// Caveat: a directory's mtime only changes when its *direct* entries are added
/// or removed. Deeply nested writes that do not touch the top-level directory
/// will not invalidate the cached size, so a cached total can lag reality
/// between scans. This only affects the displayed estimate — deletion still
/// removes the whole tree, and every clean is followed by a fresh re-scan.
#[derive(Default)]
pub struct SizeCache {
    inner: Mutex<HashMap<PathBuf, CacheEntry>>,
}

#[derive(Clone, Copy)]
struct CacheEntry {
    mtime: SystemTime,
    bytes: u64,
    errors: u64,
}

impl SizeCache {
    /// Return the size of `path`, reusing a cached value when the directory's
    /// mtime is unchanged since it was last measured. Falls back to a full
    /// [`dir_size`] walk on a miss and records the fresh result.
    pub fn measure(&self, path: &Path) -> SizeStats {
        let mtime = std::fs::metadata(path).ok().and_then(|m| m.modified().ok());
        if let Some(mt) = mtime {
            if let Ok(map) = self.inner.lock() {
                if let Some(e) = map.get(path) {
                    if e.mtime == mt {
                        return SizeStats {
                            bytes: e.bytes,
                            errors: e.errors,
                        };
                    }
                }
            }
        }
        let stats = dir_size(path);
        if let Some(mt) = mtime {
            if let Ok(mut map) = self.inner.lock() {
                map.insert(
                    path.to_path_buf(),
                    CacheEntry {
                        mtime: mt,
                        bytes: stats.bytes,
                        errors: stats.errors,
                    },
                );
            }
        }
        stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn dir_size_returns_zero_for_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        let stats = dir_size(&missing);
        assert_eq!(stats.bytes, 0);
        assert_eq!(stats.errors, 0);
    }

    #[test]
    fn dir_size_sums_file_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.bin"), vec![0u8; 1024]).unwrap();
        fs::create_dir(tmp.path().join("sub")).unwrap();
        fs::write(tmp.path().join("sub/b.bin"), vec![0u8; 512]).unwrap();
        let stats = dir_size(tmp.path());
        assert_eq!(stats.bytes, 1024 + 512);
        assert_eq!(stats.errors, 0);
    }

    #[test]
    fn size_cache_matches_dir_size_and_serves_repeat_calls() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.bin"), vec![0u8; 2048]).unwrap();
        let cache = SizeCache::default();
        let first = cache.measure(tmp.path());
        let second = cache.measure(tmp.path());
        assert_eq!(first.bytes, 2048);
        assert_eq!(second.bytes, first.bytes);
        assert_eq!(second.errors, first.errors);
        // Matches a direct walk.
        assert_eq!(first.bytes, dir_size(tmp.path()).bytes);
    }

    #[test]
    fn size_cache_recomputes_after_direct_change() {
        use std::time::{Duration, Instant};

        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.bin"), vec![0u8; 1000]).unwrap();
        let cache = SizeCache::default();
        let baseline = fs::metadata(tmp.path()).unwrap().modified().unwrap();
        assert_eq!(cache.measure(tmp.path()).bytes, 1000);

        // Adding a direct child makes the cached size stale, but the cache only
        // notices once the directory's mtime advances. Filesystem timestamp
        // granularity varies (sub-second on ext4/NTFS, up to 2s on FAT), so a
        // single write can land in the same tick as the baseline and leave the
        // mtime unchanged. Touch the directory until the kernel reports a newer
        // mtime instead of racing a single write (the original cause of the
        // flaky CI failure).
        fs::write(tmp.path().join("b.bin"), vec![0u8; 500]).unwrap();
        let nudge = tmp.path().join("nudge.tmp");
        let start = Instant::now();
        while fs::metadata(tmp.path()).unwrap().modified().unwrap() == baseline {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "directory mtime never advanced after a direct change"
            );
            std::thread::sleep(Duration::from_millis(20));
            fs::write(&nudge, b"x").unwrap();
            fs::remove_file(&nudge).unwrap();
        }

        assert_eq!(cache.measure(tmp.path()).bytes, 1500);
    }
}
