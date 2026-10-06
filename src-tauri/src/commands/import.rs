//! Importing words from delimited text: detection, preview and apply.
//!
//! The heavy lifting lives in `langloom-core`'s `import` module. These
//! commands are thin IPC wrappers: detection and preview only read, so they
//! hold the state lock immutably and write nothing; apply takes the lock
//! mutably and tells the frontend the dictionary and notes changed.

use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, State};

use langloom_core::import as core;
use langloom_core::{Detection, ImportOptions, ImportPlan, ImportReport, Preview};

use super::changed;
use crate::state::AppState;

type Shared = Mutex<AppState>;

/// Guess a file's delimiter, whether it has a header, and a role per column.
///
/// Pure analysis of the file on disk; no workspace state is touched.
#[tauri::command]
pub fn import_detect(path: String, options: ImportOptions) -> Result<Detection, String> {
    let text =
        std::fs::read_to_string(&path).map_err(|err| format!("could not read {path}: {err}"))?;
    Ok(core::detect(&text, &options))
}

/// Parse a file and report what importing it would do. Writes nothing.
#[tauri::command]
pub fn import_preview(
    state: State<'_, Shared>,
    path: String,
    options: ImportOptions,
) -> Result<Preview, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    core::import_preview(workspace, Path::new(&path), &options).map_err(|err| err.to_string())
}

/// Apply a reviewed import plan, then refresh the dictionary and notes.
#[tauri::command]
pub fn import_apply(
    app: AppHandle,
    state: State<'_, Shared>,
    plan: ImportPlan,
) -> Result<ImportReport, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let report =
        core::import_apply(state.workspace_mut()?, &plan).map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "dictionary");
    changed(&app, "notes");
    Ok(report)
}

/// Export a table to a file (CSV, TSV, or a lossless JSON snapshot).
#[tauri::command]
pub fn export_table(
    state: State<'_, Shared>,
    name: String,
    format: langloom_core::TableFormat,
    destination: String,
) -> Result<String, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .export_table(&name, format, Path::new(&destination))
        .map_err(|err| err.to_string())?;
    Ok(destination)
}
