use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct CleanResult {
    pub path: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Move the given paths to the OS trash/recycle bin. Each path is canonicalized
/// and checked against the backend allowlist before deletion, so a compromised
/// WebView cannot trash arbitrary user data through this command. Per-path
/// errors are captured rather than aborting the batch.
pub fn clean_paths(paths: Vec<String>, allow: &HashSet<PathBuf>) -> Vec<CleanResult> {
    paths.into_iter().map(|p| clean_one(p, allow)).collect()
}

fn clean_one(input: String, allow: &HashSet<PathBuf>) -> CleanResult {
    let raw = Path::new(&input);
    let canonical = match std::fs::canonicalize(raw) {
        Ok(c) => c,
        Err(e) => {
            return CleanResult {
                path: input,
                ok: false,
                error: Some(format!("Cannot resolve path: {e}")),
            };
        }
    };

    if !allow.contains(&canonical) {
        return CleanResult {
            path: input,
            ok: false,
            error: Some("Path not produced by a recent scan; refusing to delete".into()),
        };
    }

    match trash::delete(&canonical) {
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
