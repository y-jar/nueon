//! Importing files into the workspace: picked in a Rust-run dialog, or
//! dropped from the OS onto a window (a one-use grant).

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, State};

use nueon_core::ImportedAsset;

use super::changed;
use crate::security::pick_open_file;
use crate::state::AppState;

type Shared = Mutex<AppState>;

/// Pick an image in a dialog run on the Rust side and copy it into the
/// workspace's `notes/assets/` (editor inserts). The path never crosses
/// from JavaScript.
#[tauri::command]
pub async fn asset_import_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
) -> Result<ImportedAsset, String> {
    let Some(path) = pick_open_file(
        &app,
        &[(
            "Images",
            &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"],
        )],
    )
    .await?
    else {
        return Err("cancelled".to_string());
    };
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let imported = state
        .workspace_mut()?
        .import_asset(path)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "notes");
    Ok(imported)
}

/// Copy an OS-dropped file onto an editor into `notes/assets/`. The path must
/// be one the OS handed the app (recorded as a one-use grant by the
/// drag-drop handler); a path JavaScript invented is refused.
#[tauri::command]
pub fn import_asset(
    app: AppHandle,
    state: State<'_, Shared>,
    path: String,
) -> Result<ImportedAsset, String> {
    let source = PathBuf::from(&path);
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    if !state.consume_grant(&source) {
        return Err("refusing a file path that was not dropped onto the app".to_string());
    }
    let imported = state
        .workspace_mut()?
        .import_asset(source)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "notes");
    Ok(imported)
}

/// Copy a file dropped on the explorer into `folder` of `notes/`, keeping its
/// own name. The path must be one the OS handed the app (a one-use grant).
/// Returns the new path relative to `notes/`.
#[tauri::command]
pub fn copy_into_notes(
    app: AppHandle,
    state: State<'_, Shared>,
    folder: String,
    path: String,
) -> Result<String, String> {
    let source = PathBuf::from(&path);
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    if !state.consume_grant(&source) {
        return Err("refusing a file path that was not dropped onto the app".to_string());
    }
    let relative = state
        .workspace_mut()?
        .copy_file_into(folder.trim_matches('/'), &source)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "notes");
    Ok(relative.to_string_lossy().replace('\\', "/"))
}
