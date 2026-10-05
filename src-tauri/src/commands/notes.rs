//! Notes tree and extensionless note IO commands.
//!
//! All paths are workspace-relative and validated by `langloom-core`'s path
//! guard (`safe_join`), which rejects absolute paths and `..` escapes. Writes
//! are atomic (temp file + rename) inside the core storage layer.

use std::sync::Mutex;

use tauri::{AppHandle, State};

use langloom_core::NoteFile;

use super::changed;
use crate::state::AppState;
use crate::tree::{self, NoteNode};

type Shared = Mutex<AppState>;

/// The notes directory tree (hidden entries are skipped).
#[tauri::command]
pub fn list_workspace(state: State<'_, Shared>) -> Result<Vec<NoteNode>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    tree::scan(&workspace.notes_dir()).map_err(|err| err.to_string())
}

/// Read a note's raw text.
#[tauri::command]
pub fn read_note(state: State<'_, Shared>, rel_path: String) -> Result<String, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    workspace
        .read_note(&rel_path)
        .map_err(|err| err.to_string())
}

/// Save a note's raw text (atomic write).
#[tauri::command]
pub fn save_note(
    state: State<'_, Shared>,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace_mut()?;
    workspace
        .save_note(&NoteFile::new(&rel_path, content))
        .map_err(|err| err.to_string())
}

/// Create an empty note and refresh the tree.
#[tauri::command]
pub fn create_note(
    app: AppHandle,
    state: State<'_, Shared>,
    rel_path: String,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .create_note(&rel_path)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "notes");
    Ok(())
}

/// Create a notes folder and refresh the tree.
#[tauri::command]
pub fn create_folder(
    app: AppHandle,
    state: State<'_, Shared>,
    rel_path: String,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .create_folder(&rel_path)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "notes");
    Ok(())
}

/// Move or rename a note/folder and refresh the tree.
#[tauri::command]
pub fn move_or_rename_note(
    app: AppHandle,
    state: State<'_, Shared>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let old_path = old_path.trim_matches('/').to_string();
    let new_path = new_path.trim_matches('/').to_string();
    if new_path.is_empty() {
        return Err("target path is empty".to_string());
    }
    // Cycle prevention: a folder cannot be moved into itself or a subfolder.
    if new_path == old_path || new_path.starts_with(&format!("{old_path}/")) {
        return Err("cannot move a folder into itself or its own subfolder".to_string());
    }
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .rename_note(&old_path, &new_path)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "notes");
    Ok(())
}

/// Delete a note/folder (recursively) and refresh the tree.
#[tauri::command]
pub fn delete_note(
    app: AppHandle,
    state: State<'_, Shared>,
    rel_path: String,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .delete_note(&rel_path)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "notes");
    Ok(())
}
