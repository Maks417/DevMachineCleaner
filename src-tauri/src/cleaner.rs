use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct CleanResult {
    pub path: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Move the given paths to the OS trash/recycle bin. Errors on individual
/// paths are captured per-entry rather than aborting the batch.
pub fn clean_paths(paths: Vec<String>) -> Vec<CleanResult> {
    paths
        .into_iter()
        .map(|p| {
            let path = Path::new(&p);
            if !path.exists() {
                return CleanResult {
                    path: p,
                    ok: false,
                    error: Some("Path does not exist".into()),
                };
            }
            match trash::delete(path) {
                Ok(()) => CleanResult {
                    path: p,
                    ok: true,
                    error: None,
                },
                Err(e) => CleanResult {
                    path: p,
                    ok: false,
                    error: Some(e.to_string()),
                },
            }
        })
        .collect()
}
