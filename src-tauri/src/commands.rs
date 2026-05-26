use std::path::PathBuf;
use tauri::async_runtime::spawn_blocking;
use tauri::State;

use crate::cleaner::{self, CleanResult};
use crate::scanner::stacks::DetectedProject;
use crate::scanner::{ai_caches, ai_caches::AiCacheEntry, stacks};
use crate::state::AppState;

/// Hard ceiling on recursive scan depth. Anything deeper is almost certainly a
/// user error and would freeze the UI on a busy machine.
const MAX_SCAN_DEPTH: usize = 12;
const DEFAULT_SCAN_DEPTH: usize = 6;

#[tauri::command]
pub async fn scan_projects(
    root: String,
    max_depth: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<DetectedProject>, String> {
    let depth = max_depth
        .unwrap_or(DEFAULT_SCAN_DEPTH)
        .clamp(1, MAX_SCAN_DEPTH);

    let path = PathBuf::from(&root);
    match path.try_exists() {
        Ok(true) => {}
        Ok(false) => return Err(format!("Path does not exist: {root}")),
        Err(e) => return Err(format!("Cannot access {root}: {e}")),
    }
    if !path.is_dir() {
        return Err(format!("Not a directory: {root}"));
    }

    let projects = spawn_blocking(move || stacks::scan_projects(&path, depth))
        .await
        .map_err(|e| e.to_string())?;

    // Authorize every cleanable path we just produced. Anything outside this
    // set will be rejected by `clean_paths`.
    let allow_paths: Vec<PathBuf> = projects
        .iter()
        .flat_map(|p| p.cleanable.iter())
        .filter_map(|c| std::fs::canonicalize(&c.path).ok())
        .collect();
    state.extend_allowlist(allow_paths);

    Ok(projects)
}

#[tauri::command]
pub async fn scan_ai_caches(
    state: State<'_, AppState>,
) -> Result<Vec<AiCacheEntry>, String> {
    let entries = spawn_blocking(ai_caches::list_ai_caches)
        .await
        .map_err(|e| e.to_string())?;

    let allow_paths: Vec<PathBuf> = entries
        .iter()
        .filter(|e| e.exists)
        .filter_map(|e| std::fs::canonicalize(&e.path).ok())
        .collect();
    state.extend_allowlist(allow_paths);

    Ok(entries)
}

#[tauri::command]
pub async fn clean_paths(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<CleanResult>, String> {
    // Snapshot the allowlist into the blocking task so we don't hold the
    // Mutex across an await point.
    let allow = state.snapshot();
    spawn_blocking(move || cleaner::clean_paths(paths, &allow))
        .await
        .map_err(|e| e.to_string())
}
