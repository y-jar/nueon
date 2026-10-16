//! Workspace registry commands.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use nueon_core::{
    LayoutState, Profile, StorageError, TilingLayout, UiLayout, WindowGeometry, Workspace,
    WorkspaceEntry,
};

use super::{changed, destroy_windows, secondary_labels};
use crate::security::{
    pick_directory, pick_open_file, pick_save_file, read_text_capped, write_bytes_checked,
};
use crate::state::{default_name, refresh_asset_scope, AppState};

/// Record a recently opened note or table (`note:<path>` / `table:<name>`).
#[tauri::command]
pub fn recent_record(state: State<'_, Shared>, entry: String) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state.global.record_recent(entry);
    let _ = state.global.save();
    Ok(())
}

/// The recently opened items, newest first.
#[tauri::command]
pub fn recent_list(state: State<'_, Shared>) -> Result<Vec<String>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.global.recent.clone())
}

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
pub fn workspace_list(state: State<'_, Shared>) -> Result<Vec<WorkspaceEntry>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.global.workspaces.clone())
}

/// The root path of the currently open workspace, if any.
#[tauri::command]
pub fn workspace_current(state: State<'_, Shared>) -> Result<Option<String>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state
        .workspace
        .as_ref()
        .map(|workspace| workspace.root_path.display().to_string()))
}

/// Open (and register) an existing workspace directory chosen in a dialog
/// run on the Rust side. A path string from JavaScript is never trusted.
#[tauri::command]
pub async fn workspace_open_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
) -> Result<String, String> {
    let Some(path) = pick_directory(&app).await? else {
        return Err("cancelled".to_string());
    };
    workspace_open_path(app, state, path.display().to_string())
}

/// Refuse a path that is not a registered workspace: the registry list the
/// UI shows comes from the backend, and destructive registry operations must
/// stay on it.
fn require_registered(state: &AppState, path: &Path) -> Result<(), String> {
    if state.global.workspaces.iter().any(|w| w.path == path) {
        return Ok(());
    }
    Err(format!(
        "that folder is not a registered workspace: {}",
        path.display()
    ))
}

/// Open a workspace from the registry list the backend produced. The path
/// must name a registered workspace; anything else must come through
/// [`workspace_open_dialog`].
#[tauri::command]
pub fn workspace_open(
    app: AppHandle,
    state: State<'_, Shared>,
    path: String,
) -> Result<String, String> {
    workspace_open_path(app, state, path)
}

/// Open (and register) an existing workspace directory.
fn workspace_open_path(
    app: AppHandle,
    state: State<'_, Shared>,
    path: String,
) -> Result<String, String> {
    {
        // A path from JavaScript is trusted only when it names a workspace
        // the registry already lists (the list the UI shows comes from the
        // backend); anything else must come through the Rust-run dialog.
        let guard = state.lock().map_err(|_| "state poisoned".to_string())?;
        let known = guard.global.workspaces.iter().any(|w| w.path == path);
        drop(guard);
        if !known {
            return Err("that folder is not a registered workspace".to_string());
        }
    }
    let workspace = match Workspace::open(&path) {
        Ok(workspace) => workspace,
        Err(err) => {
            // A vanished directory is dropped from the registry so the
            // stale entry does not linger in the workspace list.
            if matches!(err, StorageError::NotFound(_)) {
                let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
                state.global.remove(&PathBuf::from(&path));
                let _ = state.global.save();
                drop(state);
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
    refresh_asset_scope(&app, &mut state);
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

/// Create a new workspace at `destination/name` and open it. The destination
/// must be a parent directory the Rust-run dialog chose; kept as the inner
/// function so both entry points share one open path.
#[tauri::command]
pub async fn workspace_create(
    app: AppHandle,
    state: State<'_, Shared>,
    name: String,
    destination: String,
) -> Result<String, String> {
    workspace_create_inner(app, state, name, PathBuf::from(destination))
}

fn workspace_create_inner(
    app: AppHandle,
    state: State<'_, Shared>,
    name: String,
    destination: PathBuf,
) -> Result<String, String> {
    let target = destination.join(&name);
    let workspace = Workspace::new(&target).map_err(|err| err.to_string())?;
    let root = workspace.root_path.display().to_string();

    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let stale = retire_secondary_windows(&app, &mut state);
    state.workspace = Some(workspace);
    refresh_asset_scope(&app, &mut state);
    state.global.add(target.clone(), name);
    state.global.last = Some(target);
    let _ = state.global.save();
    drop(state);
    destroy_windows(&app, &stale);

    changed(&app, "workspace");
    changed(&app, "notes");
    Ok(root)
}

/// Create a new workspace named `name` inside a parent directory chosen in a
/// dialog run on the Rust side. A path string from JavaScript is never
/// trusted with the location.
#[tauri::command]
pub async fn workspace_create_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
    name: String,
) -> Result<String, String> {
    let Some(destination) = pick_directory(&app).await? else {
        return Err("cancelled".to_string());
    };
    workspace_create_inner(app, state, name, destination)
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
    require_registered(&state, &path)?;
    state.global.remove(&path);
    if state
        .workspace
        .as_ref()
        .is_some_and(|workspace| workspace.root_path == path)
    {
        state.workspace = None;
    }
    refresh_asset_scope(&app, &mut state);
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
    let path = PathBuf::from(path);
    require_registered(&state, &path)?;
    state.global.rename(&path, name);
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
///
/// Refuses any path that is not a registered workspace, and any filesystem
/// root, so a bad argument cannot remove an arbitrary directory.
#[tauri::command]
pub fn workspace_delete_from_disk(
    app: AppHandle,
    state: State<'_, Shared>,
    path: String,
) -> Result<(), String> {
    let path = PathBuf::from(path);

    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    require_registered(&state, &path)?;
    if path.parent().is_none() {
        return Err(format!(
            "refusing to delete filesystem root: {}",
            path.display()
        ));
    }
    if !state.global.contains(&path) {
        return Err(format!(
            "refusing to delete unregistered workspace: {}",
            path.display()
        ));
    }

    std::fs::remove_dir_all(&path).map_err(|err| err.to_string())?;
    state.global.remove(&path);
    if state
        .workspace
        .as_ref()
        .is_some_and(|workspace| workspace.root_path == path)
    {
        state.workspace = None;
    }
    refresh_asset_scope(&app, &mut state);
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

/// Write the current conlang profile (language, phonology, grammar,
/// translation setup) to a JSON file whose path is chosen in a dialog run on
/// the Rust side. A path string from JavaScript is never trusted with a write.
#[tauri::command]
pub async fn profile_export_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
) -> Result<String, String> {
    let json = {
        let state = state.lock().map_err(|_| "state poisoned".to_string())?;
        let profile = state.workspace()?.profile();
        serde_json::to_vec_pretty(&profile).map_err(|err| err.to_string())?
    };
    let Some(path) = pick_save_file(
        &app,
        &[("Nueon profile", &["json"])],
        Some("profile.nueon.json"),
    )
    .await?
    else {
        return Err("cancelled".to_string());
    };
    write_bytes_checked(&path, &json, "json").map(|p| p.display().to_string())
}

/// Read a profile from a JSON file whose path is chosen in a dialog run on
/// the Rust side, and apply it to the workspace config.
#[tauri::command]
pub async fn profile_import_dialog(app: AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    let Some(path) = pick_open_file(&app, &[("Nueon profile", &["json"])]).await? else {
        return Err("cancelled".to_string());
    };
    let json = read_text_capped(&path)?;
    let profile: Profile = serde_json::from_str(&json).map_err(|err| err.to_string())?;
    profile.validate()?;
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .apply_profile(profile)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "config");
    Ok(())
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

/// Undo the last revertible dictionary edit; returns `false` if none.
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

/// Redo the last undone dictionary edit; returns `false` if none.
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

/// Whether the one-time warning `key` has been silenced.
#[tauri::command]
pub fn warning_dismissed(state: State<'_, Shared>, key: String) -> Result<bool, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.is_warning_dismissed(&key))
}

/// Persist the "don't show this warning again" choice.
#[tauri::command]
pub fn dismiss_warning(state: State<'_, Shared>, key: String) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .dismiss_warning(&key)
        .map_err(|err| err.to_string())
}

/// Confirm-dialog kinds the user has silenced.
#[tauri::command]
pub fn suppressed_confirms(state: State<'_, Shared>) -> Result<Vec<String>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.suppressed_confirms())
}

/// Silence one confirm-dialog kind.
#[tauri::command]
pub fn suppress_confirm(state: State<'_, Shared>, kind: String) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .suppress_confirm(&kind)
        .map_err(|err| err.to_string())
}

/// Clear every silenced confirm kind.
#[tauri::command]
pub fn clear_suppressed_confirms(state: State<'_, Shared>) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .unsuppress_confirm(None)
        .map_err(|err| err.to_string())
}

/// Zip the whole workspace into a path chosen in a dialog run on the Rust
/// side, excluding `.git`. A path string from JavaScript is never trusted
/// with a write.
#[tauri::command]
pub async fn export_workspace_zip_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
) -> Result<String, String> {
    let root = {
        let state = state.lock().map_err(|_| "state poisoned".to_string())?;
        state.workspace()?.root_path.clone()
    };
    let base = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace".to_string());
    let default_name = format!("{base}.zip");
    let Some(path) =
        pick_save_file(&app, &[("Zip archive", &["zip"])], Some(&default_name)).await?
    else {
        return Err("cancelled".to_string());
    };
    // Zip to a temp file beside the chosen destination, then move it into
    // place so a cancelled or failed run never leaves a half-written archive
    // under the chosen name.
    let temp = path.with_extension("zip.partial");
    nueon_core::archive::zip_workspace(&root, &temp).map_err(|err| err.to_string())?;
    std::fs::rename(&temp, &path).map_err(|err| err.to_string())?;
    Ok(path.display().to_string())
}

/// Extract a workspace zip chosen in a dialog run on the Rust side into a
/// parent directory also chosen there, and open it, registering it like a
/// freshly opened workspace.
#[tauri::command]
pub async fn workspace_import_zip_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
) -> Result<String, String> {
    let Some(zip_path) = pick_open_file(&app, &[("Zip archive", &["zip"])]).await? else {
        return Err("cancelled".to_string());
    };
    let Some(parent) = pick_directory(&app).await? else {
        return Err("cancelled".to_string());
    };
    let base = zip_path
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "restored".to_string());
    let dest = parent.join(base);

    nueon_core::archive::unzip_workspace(&zip_path, &dest).map_err(|err| err.to_string())?;

    let workspace = Workspace::open(&dest).map_err(|err| err.to_string())?;
    let root = workspace.root_path.display().to_string();
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let stale = retire_secondary_windows(&app, &mut state);
    state.workspace = Some(workspace);
    refresh_asset_scope(&app, &mut state);
    state.global.add(dest.clone(), default_name(&dest));
    state.global.last = Some(dest);
    let _ = state.global.save();
    drop(state);
    destroy_windows(&app, &stale);

    changed(&app, "workspace");
    changed(&app, "notes");
    Ok(root)
}

/// Whether the Markdown editor shows line numbers.
#[tauri::command]
pub fn editor_line_numbers(state: State<'_, Shared>) -> Result<bool, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.editor_line_numbers())
}

/// Persist the editor's line-number preference.
#[tauri::command]
pub fn set_editor_line_numbers(state: State<'_, Shared>, show: bool) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .set_editor_line_numbers(show)
        .map_err(|err| err.to_string())
}
