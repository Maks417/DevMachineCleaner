use std::path::PathBuf;
use tauri::async_runtime::spawn_blocking;

use crate::cleaner::{self, CleanResult};
use crate::scanner::{ai_caches::AiCacheEntry, ai_caches, stacks};
use crate::scanner::stacks::DetectedProject;

#[tauri::command]
pub async fn scan_projects(root: String, max_depth: Option<usize>) -> Result<Vec<DetectedProject>, String> {
    let depth = max_depth.unwrap_or(6);
    spawn_blocking(move || {
        let path = PathBuf::from(&root);
        if !path.exists() {
            return Err(format!("Path does not exist: {root}"));
        }
        Ok(stacks::scan_projects(&path, depth))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scan_ai_caches() -> Result<Vec<AiCacheEntry>, String> {
    spawn_blocking(|| Ok(ai_caches::list_ai_caches()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clean_paths(paths: Vec<String>) -> Result<Vec<CleanResult>, String> {
    spawn_blocking(move || Ok(cleaner::clean_paths(paths)))
        .await
        .map_err(|e| e.to_string())?
}
