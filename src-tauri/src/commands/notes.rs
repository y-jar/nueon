//! Notes tree and extensionless note IO commands.
//!
//! All paths are workspace-relative and validated by `nueon-core`'s path
//! guard (`safe_join`), which rejects absolute paths and `..` escapes. Writes
//! are atomic (temp file + rename) inside the core storage layer.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};

use nueon_core::{NoteFile, TrashRecord};

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

/// A note's text and the hash later saves are checked against.
#[derive(Debug, Clone, Serialize)]
pub struct NoteSnapshot {
    pub content: String,
    pub hash: String,
}

/// Read a note's raw text with its content hash.
#[tauri::command]
pub fn read_note(state: State<'_, Shared>, rel_path: String) -> Result<NoteSnapshot, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    let (content, hash) = workspace
        .read_note_snapshot(&rel_path)
        .map_err(|err| err.to_string())?;
    Ok(NoteSnapshot { content, hash })
}

/// Save an existing note (atomic write). Never creates a file, and fails with
/// a `conflict:` error if the note changed on disk since `base_hash`. Returns
/// the new content hash.
#[tauri::command]
pub fn save_note(
    state: State<'_, Shared>,
    rel_path: String,
    content: String,
    base_hash: Option<String>,
) -> Result<String, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace_mut()?;
    workspace
        .save_note_checked(&NoteFile::new(&rel_path, content), base_hash.as_deref())
        .map_err(|err| err.to_string())
}

/// Create an empty note (adding `.md` when the name has no extension),
/// refresh the tree, and return the final workspace-relative path.
#[tauri::command]
pub fn create_note(
    app: AppHandle,
    state: State<'_, Shared>,
    rel_path: String,
) -> Result<String, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let created = state
        .workspace_mut()?
        .create_note(&rel_path)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "notes");
    Ok(created.to_string_lossy().replace('\\', "/"))
}

/// Create a new note with initial content (never overwrites) and return its
/// final path.
#[tauri::command]
pub fn create_note_with_content(
    app: AppHandle,
    state: State<'_, Shared>,
    rel_path: String,
    content: String,
) -> Result<String, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let created = state
        .workspace_mut()?
        .create_note_with_content(&rel_path, &content)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "notes");
    Ok(created.to_string_lossy().replace('\\', "/"))
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

/// Move or rename a note/folder and refresh the tree. Returns the final
/// path (a file renamed to a bare name keeps its extension).
#[tauri::command]
pub fn move_or_rename_note(
    app: AppHandle,
    state: State<'_, Shared>,
    old_path: String,
    new_path: String,
) -> Result<String, String> {
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
    let renamed = state
        .workspace_mut()?
        .rename_note(&old_path, &new_path)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "notes");
    Ok(renamed.to_string_lossy().replace('\\', "/"))
}

/// Delete a note or folder by moving it to the trash. Returns the trash
/// record so the UI can offer Undo.
#[tauri::command]
pub fn delete_note(
    app: AppHandle,
    state: State<'_, Shared>,
    rel_path: String,
) -> Result<TrashRecord, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let record = state
        .workspace_mut()?
        .delete_note(&rel_path)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "notes");
    Ok(record)
}

/// How many files a note path covers (for the delete confirmation).
#[tauri::command]
pub fn note_count(state: State<'_, Shared>, rel_path: String) -> Result<usize, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .count_notes(&rel_path)
        .map_err(|err| err.to_string())
}
