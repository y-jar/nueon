//! Workspace registry commands.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, State};

use langloom_core::{Workspace, WorkspaceEntry};

use super::changed;
use crate::state::{default_name, AppState};

type Shared = Mutex<AppState>;

/// Registered workspaces (name + path).
#[tauri::command]
pub fn workspace_list(state: State<'_, Shared>) -> Vec<WorkspaceEntry> {
    state
        .lock()
        .map(|state| state.global.workspaces.clone())
        .unwrap_or_default()
}

/// The root path of the currently open workspace, if any.
#[tauri::command]
pub fn workspace_current(state: State<'_, Shared>) -> Option<String> {
    state.lock().ok().and_then(|state| {
        state
            .workspace
            .as_ref()
            .map(|workspace| workspace.root_path.display().to_string())
    })
}

/// Open (and register) an existing workspace directory.
#[tauri::command]
pub fn workspace_open(
    app: AppHandle,
    state: State<'_, Shared>,
    path: String,
) -> Result<String, String> {
    let workspace = Workspace::load(&path).map_err(|err| err.to_string())?;
    let root = workspace.root_path.display().to_string();

    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state.workspace = Some(workspace);
    let path = PathBuf::from(path);
    state.global.add(path.clone(), default_name(&path));
    state.global.last = Some(path);
    let _ = state.global.save();
    drop(state);

    changed(&app, "workspace");
    changed(&app, "notes");
    Ok(root)
}

/// Create a new workspace at `destination/name` and open it.
#[tauri::command]
pub fn workspace_create(
    app: AppHandle,
    state: State<'_, Shared>,
    name: String,
    destination: String,
) -> Result<String, String> {
    let target = PathBuf::from(destination).join(&name);
    let workspace = Workspace::new(&target).map_err(|err| err.to_string())?;
    let root = workspace.root_path.display().to_string();

    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state.workspace = Some(workspace);
    state.global.add(target.clone(), name);
    state.global.last = Some(target);
    let _ = state.global.save();
    drop(state);

    changed(&app, "workspace");
    changed(&app, "notes");
    Ok(root)
}

/// Remove a workspace from the registry (does not touch disk).
#[tauri::command]
pub fn workspace_remove(
    app: AppHandle,
    state: State<'_, Shared>,
    path: String,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state.global.remove(&path);
    if state
        .workspace
        .as_ref()
        .is_some_and(|workspace| workspace.root_path == path)
    {
        state.workspace = None;
    }
    let _ = state.global.save();
    drop(state);

    changed(&app, "workspace");
    Ok(())
}

/// Rename a workspace's display name.
#[tauri::command]
pub fn workspace_rename(
    app: AppHandle,
    state: State<'_, Shared>,
    path: String,
    name: String,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state.global.rename(&PathBuf::from(path), name);
    let _ = state.global.save();
    drop(state);

    changed(&app, "workspace");
    Ok(())
}

/// Re-point a workspace to a new location.
#[tauri::command]
pub fn workspace_set_path(
    app: AppHandle,
    state: State<'_, Shared>,
    from: String,
    to: String,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .global
        .set_path(&PathBuf::from(from), PathBuf::from(to));
    let _ = state.global.save();
    drop(state);

    changed(&app, "workspace");
    Ok(())
}

/// Delete a workspace directory from disk and unregister it.
#[tauri::command]
pub fn workspace_delete_from_disk(
    app: AppHandle,
    state: State<'_, Shared>,
    path: String,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    std::fs::remove_dir_all(&path).map_err(|err| err.to_string())?;

    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state.global.remove(&path);
    if state
        .workspace
        .as_ref()
        .is_some_and(|workspace| workspace.root_path == path)
    {
        state.workspace = None;
    }
    let _ = state.global.save();
    drop(state);

    changed(&app, "workspace");
    Ok(())
}
