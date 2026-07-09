mod cleaner;
mod commands;
mod scanner;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());

    // The updater plugin is desktop-only; this app only ships desktop bundles.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .invoke_handler(tauri::generate_handler![
            commands::scan_projects,
            commands::scan_ai_caches,
            commands::cancel_scan,
            commands::clean_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
