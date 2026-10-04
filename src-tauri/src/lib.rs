//! Tauri v2 shell for langloom.
//!
//! The reusable domain logic lives in `langloom-core`; this crate is the
//! IPC/service boundary that the Svelte frontend talks to.

mod commands;
mod state;
mod tree;

use std::sync::Mutex;

use state::AppState;

/// Liveness probe for the frontend.
#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

/// Build and run the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(AppState::load()))
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
            commands::create_word,
            commands::save_word_entry,
            commands::delete_word,
            commands::move_word,
            commands::add_tag,
            commands::remove_tag_preview,
            commands::remove_tag,
            commands::set_parent,
            commands::remove_parent,
            commands::parent_candidates,
            commands::derivation_tree,
            commands::list_presets,
            commands::save_preset,
            commands::delete_preset,
            commands::execute_translation,
            commands::create_translation_word,
        ])
        .run(tauri::generate_context!())
        .expect("error while running langloom");
}
