//! Tauri v2 shell for langloom.
//!
//! The reusable domain logic lives in `langloom-core`; this crate is the
//! IPC/service boundary that the Svelte frontend talks to.

use std::sync::Mutex;

use langloom_core::global::GlobalConfig;
use langloom_core::WorkspaceEntry;

/// Shared application state owned by the Tauri runtime.
#[derive(Default)]
pub struct AppState {
    /// App-global workspace registry.
    pub global: GlobalConfig,
}

/// Liveness probe for the frontend.
#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

/// Registered workspaces (name + path).
#[tauri::command]
fn workspace_list(state: tauri::State<'_, Mutex<AppState>>) -> Vec<WorkspaceEntry> {
    state
        .lock()
        .map(|state| state.global.workspaces.clone())
        .unwrap_or_default()
}

/// The last-opened workspace path, if any.
#[tauri::command]
fn workspace_current(state: tauri::State<'_, Mutex<AppState>>) -> Option<String> {
    state
        .lock()
        .ok()
        .and_then(|state| state.global.last.clone())
        .map(|path| path.display().to_string())
}

/// Build and run the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState {
        global: GlobalConfig::load_default(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(state))
        .invoke_handler(tauri::generate_handler![
            ping,
            workspace_list,
            workspace_current
        ])
        .run(tauri::generate_context!())
        .expect("error while running langloom");
}
