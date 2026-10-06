//! Importing files dropped from the OS into the workspace.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};

use nueon_core::{ImportedAsset, Workspace};

use super::changed;
use crate::state::AppState;

type Shared = Mutex<AppState>;

/// Copy a file into the workspace's `assets/` directory.
#[tauri::command]
pub fn import_asset(state: State<'_, Shared>, path: String) -> Result<ImportedAsset, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .import_asset(PathBuf::from(path))
        .map_err(|err| err.to_string())
}

/// What a drop on the explorer produced.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DropImport {
    /// A text/Markdown file became a note.
    Note { path: String },
    /// Any other file was copied into `assets/`.
    Asset { asset: ImportedAsset },
}

/// Import a file dropped on the explorer: text and Markdown files become
/// notes inside `folder`; everything else is stored as an asset.
#[tauri::command]
pub fn import_drop(
    app: AppHandle,
    state: State<'_, Shared>,
    folder: String,
    path: String,
) -> Result<DropImport, String> {
    let source = PathBuf::from(path);
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace_mut()?;

    if Workspace::is_note_source(&source) {
        let note = workspace
            .import_note_file(folder.trim_matches('/'), &source)
            .map_err(|err| err.to_string())?;
        drop(state);
        changed(&app, "notes");
        Ok(DropImport::Note {
            path: note.to_string_lossy().replace('\\', "/"),
        })
    } else {
        let asset = workspace
            .import_asset(&source)
            .map_err(|err| err.to_string())?;
        Ok(DropImport::Asset { asset })
    }
}
