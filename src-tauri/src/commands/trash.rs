//! The workspace trash: list, restore, and permanently delete.

use std::sync::Mutex;

use tauri::{AppHandle, State};

use langloom_core::{Restored, TrashKind, TrashRecord};

use super::changed;
use crate::state::AppState;

type Shared = Mutex<AppState>;

/// Everything in the trash, newest first.
#[tauri::command]
pub fn trash_list(state: State<'_, Shared>) -> Result<Vec<TrashRecord>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.list_trash())
}

/// Restore a trashed note, folder or table. Never overwrites: a clash
/// restores under a unique name, reported in the result.
#[tauri::command]
pub fn trash_restore(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
) -> Result<Restored, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let restored = state
        .workspace_mut()?
        .restore_trash(&id)
        .map_err(|err| err.to_string())?;
    drop(state);
    match restored.kind {
        TrashKind::Table => changed(&app, "dictionary"),
        _ => changed(&app, "notes"),
    }
    Ok(restored)
}

/// Permanently delete one trash entry.
#[tauri::command]
pub fn trash_purge(state: State<'_, Shared>, id: String) -> Result<(), String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .purge_trash(&id)
        .map_err(|err| err.to_string())
}

/// Permanently delete everything in the trash; returns how many entries.
#[tauri::command]
pub fn trash_empty(state: State<'_, Shared>) -> Result<usize, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.empty_trash())
}
