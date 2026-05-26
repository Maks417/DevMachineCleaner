use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::async_runtime::spawn_blocking;
use tauri::{AppHandle, Emitter, State};

use crate::cleaner::{self, CleanResult};
use crate::scanner::stacks::{self, DetectedProject, ProgressFn, ProjectsScan, ScanProgress};
use crate::scanner::{ai_caches, ai_caches::AiCacheEntry};
use crate::state::AppState;

/// Hard ceiling on recursive scan depth. Anything deeper is almost certainly a
/// user error and would freeze the UI on a busy machine.
const MAX_SCAN_DEPTH: usize = 12;
const DEFAULT_SCAN_DEPTH: usize = 6;

/// Wrapped scan response: returns the list of items plus a session id the
/// frontend echoes back when calling `clean_paths`. Membership in this specific
/// session authorizes deletion; results from older or other sessions are
/// rejected.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectsScanResponse {
    pub scan_id: u64,
    pub projects: Vec<DetectedProject>,
    pub scan_errors: u64,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiCachesScanResponse {
    pub scan_id: u64,
    pub entries: Vec<AiCacheEntry>,
    pub scan_errors: u64,
    pub cancelled: bool,
}

/// Build a progress callback that emits Tauri events. The handle is cloned into
/// the closure so it can outlive the borrow on `app`. Failures to emit are
/// non-fatal — a missed progress event just means a slightly stale UI counter.
fn progress_emitter(app: AppHandle, event: &'static str) -> ProgressFn {
    Arc::new(move |p: ScanProgress| {
        let _ = app.emit(event, p);
    })
}

#[tauri::command]
pub async fn scan_projects(
    app: AppHandle,
    root: String,
    max_depth: Option<usize>,
    state: State<'_, AppState>,
) -> Result<ProjectsScanResponse, String> {
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

    let cancel = state.begin_scan();
    let cancel_clone = Arc::clone(&cancel);
    let progress = progress_emitter(app.clone(), "scan-projects:progress");
    let _ = app.emit("scan-projects:start", &root);

    let ProjectsScan {
        projects,
        scan_errors,
        cancelled,
    } = spawn_blocking(move || stacks::scan_projects(&path, depth, cancel_clone, progress))
        .await
        .map_err(|e| e.to_string())?;

    // Authorize every cleanable path we just produced. Anything outside this
    // session is rejected by `clean_paths`.
    let allow_paths: Vec<PathBuf> = projects
        .iter()
        .flat_map(|p| p.cleanable.iter())
        .map(|c| PathBuf::from(&c.path))
        .collect();
    let scan_id = state.record_session(allow_paths);

    let _ = app.emit("scan-projects:done", scan_id);

    Ok(ProjectsScanResponse {
        scan_id,
        projects,
        scan_errors,
        cancelled,
    })
}

#[tauri::command]
pub async fn scan_ai_caches(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AiCachesScanResponse, String> {
    let cancel = state.begin_scan();
    let cancel_clone = Arc::clone(&cancel);
    let progress = progress_emitter(app.clone(), "scan-ai:progress");
    let _ = app.emit("scan-ai:start", ());

    let scan = spawn_blocking(move || ai_caches::list_ai_caches(cancel_clone, progress))
        .await
        .map_err(|e| e.to_string())?;

    let allow_paths: Vec<PathBuf> = scan
        .entries
        .iter()
        .filter(|e| e.exists)
        .map(|e| PathBuf::from(&e.path))
        .collect();
    let scan_id = state.record_session(allow_paths);

    let _ = app.emit("scan-ai:done", scan_id);

    Ok(AiCachesScanResponse {
        scan_id,
        entries: scan.entries,
        scan_errors: scan.scan_errors,
        cancelled: scan.cancelled,
    })
}

/// Cancel the most recent in-flight scan, if any. The scan returns shortly
/// after with `cancelled: true` and a partial result set.
#[tauri::command]
pub async fn cancel_scan(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel_active_scan();
    Ok(())
}

#[tauri::command]
pub async fn clean_paths(
    scan_id: u64,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<CleanResult>, String> {
    // Resolve and snapshot the session into the blocking task; if the session
    // was evicted (or never existed), reject the whole batch up front.
    let allow = match state.session_paths(scan_id) {
        Some(set) => set,
        None => {
            return Err(format!(
                "Unknown or expired scan session ({scan_id}); please re-scan and try again",
            ));
        }
    };
    spawn_blocking(move || cleaner::clean_paths(paths, &allow))
        .await
        .map_err(|e| e.to_string())
}
