//! Workspace registry commands.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use nueon_core::{
    LayoutState, StorageError, TilingLayout, UiLayout, WindowGeometry, WindowLayout, Workspace,
    WorkspaceEntry,
};

use super::{changed, destroy_windows, secondary_labels};
use crate::state::{default_name, AppState};

type Shared = Mutex<AppState>;

/// Mark every secondary window as app-closed (so its saved layout survives)
/// and return the labels to destroy once the state lock is released.
fn retire_secondary_windows(app: &AppHandle, state: &mut AppState) -> Vec<String> {
    let labels = secondary_labels(app);
    state.silent_close.extend(labels.iter().cloned());
    labels
}

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
    let workspace = match Workspace::open(&path) {
        Ok(workspace) => workspace,
        Err(err) => {
            // A vanished directory is dropped from the registry so the
            // stale entry does not linger in the workspace list.
            if matches!(err, StorageError::NotFound(_)) {
                if let Ok(mut state) = state.lock() {
                    state.global.remove(&PathBuf::from(&path));
                    let _ = state.global.save();
                }
                changed(&app, "workspace");
                return Err(format!("workspace folder not found: {path}"));
            }
            return Err(err.to_string());
        }
    };
    let root = workspace.root_path.display().to_string();

    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let stale = retire_secondary_windows(&app, &mut state);
    state.workspace = Some(workspace);
    let path = PathBuf::from(path);
    state.global.add(path.clone(), default_name(&path));
    state.global.last = Some(path);
    let _ = state.global.save();
    drop(state);
    destroy_windows(&app, &stale);

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
    let stale = retire_secondary_windows(&app, &mut state);
    state.workspace = Some(workspace);
    state.global.add(target.clone(), name);
    state.global.last = Some(target);
    let _ = state.global.save();
    drop(state);
    destroy_windows(&app, &stale);

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

/// Read a per-conlang config section (`language`, `grammar`, `translation`,
/// `settings`) as JSON.
#[tauri::command]
pub fn config_get(state: State<'_, Shared>, section: String) -> Result<serde_json::Value, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .config_json(&section)
        .map_err(|err| err.to_string())
}

/// Replace a per-conlang config section from JSON and persist it.
#[tauri::command]
pub fn config_set(
    app: AppHandle,
    state: State<'_, Shared>,
    section: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .set_config_json(&section, value)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "config");
    Ok(())
}

/// The persisted window geometry and dock layout.
#[tauri::command]
pub fn layout_get(state: State<'_, Shared>) -> Result<WindowLayout, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.global.window.clone())
}

/// Persist whether the git pane is open.
#[tauri::command]
pub fn layout_set_git_panel(state: State<'_, Shared>, open: bool) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state.global.set_git_panel_open(open);
    state.global.save().map_err(|err| err.to_string())
}

/// The persisted shell layout for the current workspace.
#[tauri::command]
pub fn ui_layout_get(state: State<'_, Shared>) -> Result<UiLayout, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.ui_layout())
}

/// Persist the shell layout for the current workspace.
#[tauri::command]
pub fn ui_layout_set(state: State<'_, Shared>, layout: UiLayout) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .set_ui_layout(layout)
        .map_err(|err| err.to_string())
}

/// The persisted tiling layout (main window and secondary windows).
#[tauri::command]
pub fn layout_state_get(state: State<'_, Shared>) -> Result<LayoutState, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.layout_state())
}

/// Current geometry of a live window, in physical pixels.
pub(crate) fn window_geometry(app: &AppHandle, label: &str) -> Option<WindowGeometry> {
    let window = app.get_webview_window(label)?;
    let size = window.inner_size().ok()?;
    let position = window.outer_position().ok();
    Some(WindowGeometry {
        x: position.map(|p| p.x),
        y: position.map(|p| p.y),
        width: size.width,
        height: size.height,
    })
}

/// Persist one window's tiling. `main` is the primary window; any other label
/// is a secondary window whose geometry is recorded alongside.
#[tauri::command]
pub fn tiling_save(
    app: AppHandle,
    state: State<'_, Shared>,
    label: String,
    tiling: TilingLayout,
) -> Result<(), String> {
    let geometry = if label == "main" {
        None
    } else {
        window_geometry(&app, &label)
    };
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace_mut()?;
    if label == "main" {
        workspace.set_main_tiling(tiling)
    } else {
        workspace.set_window_tiling(&label, geometry, tiling)
    }
    .map_err(|err| err.to_string())
}

/// Whether dictionary undo/redo steps are available.
#[derive(Debug, Clone, Serialize)]
pub struct HistoryStatus {
    pub can_undo: bool,
    pub can_redo: bool,
}

#[tauri::command]
pub fn history_status(state: State<'_, Shared>) -> Result<HistoryStatus, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    Ok(HistoryStatus {
        can_undo: workspace.can_undo(),
        can_redo: workspace.can_redo(),
    })
}

#[tauri::command]
pub fn undo(app: AppHandle, state: State<'_, Shared>) -> Result<bool, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let did = state
        .workspace_mut()?
        .undo()
        .map_err(|err| err.to_string())?;
    drop(state);
    if did {
        changed(&app, "dictionary");
    }
    Ok(did)
}

#[tauri::command]
pub fn redo(app: AppHandle, state: State<'_, Shared>) -> Result<bool, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let did = state
        .workspace_mut()?
        .redo()
        .map_err(|err| err.to_string())?;
    drop(state);
    if did {
        changed(&app, "dictionary");
    }
    Ok(did)
}

#[tauri::command]
pub fn warning_dismissed(state: State<'_, Shared>, key: String) -> Result<bool, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.is_warning_dismissed(&key))
}

#[tauri::command]
pub fn dismiss_warning(state: State<'_, Shared>, key: String) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .dismiss_warning(&key)
        .map_err(|err| err.to_string())
}
