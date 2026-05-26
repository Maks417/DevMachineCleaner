pub mod ai_caches;
pub mod stacks;

use std::path::Path;
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
}
