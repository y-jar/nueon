//! Tauri v2 shell for nueon.
//!
//! The reusable domain logic lives in `nueon-core`; this crate is the
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
/// Sleeps, briefly locks the state for the pump call (which performs the git
/// commit), and notifies the frontend when a commit lands. Because note saves
/// and the pump both take the same mutex, they serialize cleanly against the
/// debounced autosave.
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
                Some(workspace) => match workspace.pump_auto_checkin(Instant::now()) {
                    Ok(id) => id.is_some(),
                    Err(err) => {
                        eprintln!("auto check-in failed: {err}");
                        false
                    }
                },
                None => false,
            }
        };
        if committed {
            let _ = handle.emit("data-changed", serde_json::json!({ "scope": "vcs" }));
        }
    }
}

/// Persist secondary windows' geometry, then close them so quitting the main
/// window ends the whole app while their layout stays saved for next launch.
fn quit_secondary_windows(app: &tauri::AppHandle) {
    let labels = commands::secondary_labels(app);
    if labels.is_empty() {
        return;
    }
    {
        let state = app.state::<Mutex<AppState>>();
        let Ok(mut guard) = state.lock() else {
            return;
        };
        for label in &labels {
            if let Some(geometry) = commands::window_geometry(app, label) {
                if let Some(workspace) = guard.workspace.as_mut() {
                    let _ = workspace.set_window_geometry(label, geometry);
                }
            }
            guard.silent_close.insert(label.clone());
        }
    }
    commands::destroy_windows(app, &labels);
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
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            match event {
                tauri::WindowEvent::CloseRequested { .. } if label == "main" => {
                    quit_secondary_windows(window.app_handle());
                    let app_state = window.state::<Mutex<AppState>>();
                    let mut guard = match app_state.lock() {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
                    if let Some(workspace) = guard.workspace.as_mut() {
                        if let Err(err) = workspace.close_checkin() {
                            eprintln!("close check-in failed: {err}");
                        }
                    }
                }
                tauri::WindowEvent::Resized(size) if label == "main" => {
                    let app_state = window.state::<Mutex<AppState>>();
                    let mut guard = match app_state.lock() {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
                    guard.global.set_window_size(size.width, size.height);
                    let _ = guard.global.save();
                }
                // A secondary window the user closed is forgotten; ones the
                // app closes itself (quit, workspace switch) stay saved.
                tauri::WindowEvent::Destroyed if label != "main" => {
                    let app_state = window.state::<Mutex<AppState>>();
                    let mut guard = match app_state.lock() {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
                    if guard.silent_close.remove(&label) {
                        return;
                    }
                    if let Some(workspace) = guard.workspace.as_mut() {
                        let _ = workspace.remove_window_layout(&label);
                    }
                }
                _ => {}
            }
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
            commands::ui_layout_get,
            commands::ui_layout_set,
            commands::layout_state_get,
            commands::tiling_save,
            commands::export_document,
            commands::import_detect,
            commands::import_preview,
            commands::import_apply,
            commands::export_table,
            commands::import_asset,
            commands::import_drop,
            commands::window_spawn,
            commands::window_close_self,
            commands::windows_restore,
            commands::list_workspace,
            commands::read_note,
            commands::save_note,
            commands::create_note_with_content,
            commands::create_note,
            commands::create_folder,
            commands::move_or_rename_note,
            commands::delete_note,
            commands::note_count,
            commands::trash_list,
            commands::trash_restore,
            commands::trash_purge,
            commands::trash_empty,
            commands::word_index,
            commands::list_tables,
            commands::quarantine_warnings,
            commands::get_table,
            commands::create_table,
            commands::delete_table,
            commands::rename_table,
            commands::create_word,
            commands::save_word_entry,
            commands::set_word_value,
            commands::set_word_definition,
            commands::rename_word,
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
            commands::execute_translation_direct,
            commands::create_translation_word,
            commands::translation_suggest,
            commands::phonology_check_words,
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
        .expect("error while running nueon");
}
