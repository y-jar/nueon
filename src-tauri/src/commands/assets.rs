//! Importing files dropped from the OS into the workspace.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, State};

use nueon_core::ImportedAsset;

use super::changed;
use crate::state::AppState;

type Shared = Mutex<AppState>;

/// Copy a file into the workspace's `notes/assets/` directory (editor inserts).
#[tauri::command]
pub fn import_asset(state: State<'_, Shared>, path: String) -> Result<ImportedAsset, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .import_asset(PathBuf::from(path))
        .map_err(|err| err.to_string())
}

/// Copy a file dropped on the explorer into `folder` of `notes/`, keeping its
/// own name. Returns the new path relative to `notes/`.
#[tauri::command]
pub fn copy_into_notes(
    app: AppHandle,
    state: State<'_, Shared>,
    folder: String,
    path: String,
) -> Result<String, String> {
    let source = PathBuf::from(path);
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let relative = state
        .workspace_mut()?
        .copy_file_into(folder.trim_matches('/'), &source)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "notes");
    Ok(relative.to_string_lossy().replace('\\', "/"))
}
