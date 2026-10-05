//! Tauri v2 shell for langloom.
//!
//! The reusable domain logic lives in `langloom-core`; this crate is the
//! IPC/service boundary that the Svelte frontend talks to.

mod commands;
mod state;
mod tree;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

use state::AppState;

/// Liveness probe for the frontend.
#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

/// Background auto-check-in pump.
///
/// Sleeps, briefly locks the state only for the pump call (never during I/O
/// with the UI), and notifies the frontend when a commit lands. Because note
/// saves and the pump both take the same mutex, they serialize cleanly against
/// the debounced autosave.
fn background_pump(handle: tauri::AppHandle) {
    loop {
        std::thread::sleep(Duration::from_secs(5));
        let committed = {
            let state = handle.state::<Mutex<AppState>>();
            let mut guard = match state.lock() {
                Ok(guard) => guard,
                Err(_) => continue,
            };
            match guard.workspace.as_mut() {
                Some(workspace) => workspace.pump_auto_checkin(Instant::now()).is_some(),
                None => false,
            }
        };
        if committed {
            let _ = handle.emit("data-changed", serde_json::json!({ "scope": "vcs" }));
        }
    }
}

/// Build and run the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(AppState::load()))
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || background_pump(handle));

            if let Some(window) = app.get_webview_window("main") {
                let state = app.state::<Mutex<AppState>>();
                let guard = match state.lock() {
                    Ok(guard) => guard,
                    Err(_) => return Ok(()),
                };
                let layout = guard.global.window.clone();
                drop(guard);
                let _ = window.set_size(tauri::PhysicalSize::new(layout.width, layout.height));
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                let app_state = window.state::<Mutex<AppState>>();
                let mut guard = match app_state.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                if let Some(workspace) = guard.workspace.as_mut() {
                    let _ = workspace.close_checkin();
                }
            }
            tauri::WindowEvent::Resized(size) => {
                let app_state = window.state::<Mutex<AppState>>();
                let mut guard = match app_state.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                guard.global.set_window_size(size.width, size.height);
                let _ = guard.global.save();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            commands::workspace_list,
            commands::workspace_current,
            commands::workspace_open,
            commands::workspace_create,
            commands::workspace_remove,
            commands::workspace_rename,
            commands::workspace_set_path,
            commands::workspace_delete_from_disk,
            commands::config_get,
            commands::config_set,
            commands::layout_get,
            commands::layout_set_git_panel,
            commands::list_workspace,
            commands::read_note,
            commands::save_note,
            commands::create_note,
            commands::create_folder,
            commands::move_or_rename_note,
            commands::delete_note,
            commands::word_index,
            commands::list_tables,
            commands::get_table,
            commands::create_table,
            commands::delete_table,
            commands::rename_table,
            commands::create_word,
            commands::save_word_entry,
            commands::delete_word,
            commands::move_word,
            commands::add_tag,
            commands::remove_tag_preview,
            commands::remove_tag,
            commands::set_tag_kind,
            commands::set_tag_format,
            commands::known_tag_names,
            commands::grid_view_get,
            commands::grid_view_set,
            commands::history_status,
            commands::undo,
            commands::redo,
            commands::warning_dismissed,
            commands::dismiss_warning,
            commands::set_parent,
            commands::remove_parent,
            commands::reparent_word,
            commands::parent_candidates,
            commands::derivation_tree,
            commands::derivation_graph,
            commands::list_presets,
            commands::save_preset,
            commands::delete_preset,
            commands::execute_translation,
            commands::create_translation_word,
            commands::translation_options,
            commands::set_translation_options,
            commands::export_presets,
            commands::import_presets,
            commands::vcs_state,
            commands::vcs_status,
            commands::vcs_log,
            commands::vcs_diff,
            commands::vcs_show,
            commands::vcs_branches,
            commands::vcs_checkout,
            commands::vcs_create_branch,
            commands::git_prompt_dismissed,
            commands::git_prompt_dismissed_set,
            commands::vcs_commit,
            commands::vcs_init,
            commands::vcs_revert_file,
            commands::autocheckin_get,
            commands::autocheckin_set,
            commands::autocheckin_pump,
        ])
        .run(tauri::generate_context!())
        .expect("error while running langloom");
}
