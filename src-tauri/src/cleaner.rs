use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct CleanResult {
    pub path: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Move the given paths to the OS trash/recycle bin. Each path is normalized
/// (without following symlinks) and checked against the scan-session
/// allowlist before deletion, so a compromised WebView cannot trash arbitrary
/// user data through this command. Symlinks and Windows reparse points
/// (junctions) are explicitly rejected: deleting them with `trash::delete`
/// would risk trashing the link target rather than the link itself. Per-path
/// errors are captured rather than aborting the batch.
pub fn clean_paths(paths: Vec<String>, allow: &HashSet<PathBuf>) -> Vec<CleanResult> {
    paths.into_iter().map(|p| clean_one(p, allow)).collect()
}

fn clean_one(input: String, allow: &HashSet<PathBuf>) -> CleanResult {
    let raw = Path::new(&input);

    let normalized = match std::path::absolute(raw) {
        Ok(n) => n,
        Err(e) => {
            return CleanResult {
                path: input,
                ok: false,
                error: Some(format!("Cannot resolve path: {e}")),
            };
        }
    };

    if !allow.contains(&normalized) {
        return CleanResult {
            path: input,
            ok: false,
            error: Some("Path not produced by this scan session; refusing to delete".into()),
        };
    }

    if is_reparse_or_symlink(&normalized) {
        return CleanResult {
            path: input,
            ok: false,
            error: Some(
                "Path is a symlink or reparse point; refusing to delete to avoid affecting its target"
                    .into(),
            ),
        };
    }

    match trash::delete(&normalized) {
        Ok(()) => CleanResult {
            path: input,
            ok: true,
            error: None,
        },
        Err(e) => CleanResult {
            path: input,
            ok: false,
            error: Some(e.to_string()),
        },
    }
}

/// Return true if `path` is a symbolic link or, on Windows, any other reparse
/// point such as a directory junction. `symlink_metadata` is used so we
/// inspect the link itself rather than its target.
pub(crate) fn is_reparse_or_symlink(path: &Path) -> bool {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow_with(paths: &[&Path]) -> HashSet<PathBuf> {
        paths.iter().map(|p| p.to_path_buf()).collect()
    }

    #[test]
    fn rejects_path_outside_allowlist() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("not-allowed");
        std::fs::create_dir(&target).unwrap();
        let allow = allow_with(&[]);

        let r = clean_one(target.to_string_lossy().into_owned(), &allow);
        assert!(!r.ok);
        let err = r.error.expect("error message");
        assert!(err.contains("refusing to delete"));
        assert!(target.exists(), "rejected paths must not be deleted");
    }

    #[test]
    fn rejects_unresolvable_path() {
        let allow = allow_with(&[]);
        let r = clean_one(String::new(), &allow);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("Cannot resolve path"));
    }

    #[test]
    fn deletes_allowlisted_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("allowed");
        std::fs::create_dir(&target).unwrap();
        let normalized = std::path::absolute(&target).unwrap();
        let allow = allow_with(&[normalized.as_path()]);

        let r = clean_one(target.to_string_lossy().into_owned(), &allow);
        assert!(r.ok, "expected ok, got error: {:?}", r.error);
        assert!(!target.exists(), "target must be moved to trash");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_even_when_allowlisted() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = tmp.path().join("link");
        symlink(&real, &link).unwrap();
        let normalized_link = std::path::absolute(&link).unwrap();
        let allow = allow_with(&[normalized_link.as_path()]);

        let r = clean_one(link.to_string_lossy().into_owned(), &allow);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("symlink"));
        assert!(link.exists(), "link must remain");
        assert!(real.exists(), "link target must remain");
    }
}
