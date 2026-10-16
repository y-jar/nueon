//! Importing words from delimited text: detection, preview and apply.
//!
//! The heavy lifting lives in `nueon-core`'s `import` module. These
//! commands are thin IPC wrappers: detection and preview only read, so they
//! hold the state lock immutably and write nothing; apply takes the lock
//! mutably and tells the frontend the dictionary and notes changed.

use std::sync::Mutex;

use tauri::{AppHandle, State};

use nueon_core::import as core;
use nueon_core::{AnkiExportOptions, Detection, ImportOptions, ImportPlan, ImportReport, Preview};

use super::changed;
use crate::security::{pick_open_file, pick_save_file, read_text_capped};
use crate::state::AppState;

type Shared = Mutex<AppState>;

/// What the pick returns: the file's base name (for a default table name)
/// and its detected shape. The host path itself never crosses to JavaScript.
#[derive(serde::Serialize)]
pub struct DetectResult {
    path: String,
    detection: Detection,
}

/// Pick the import file in a dialog run on the Rust side, read it under the
/// cap, and detect its shape. The chosen path is stashed for the preview and
/// apply steps; a path string from JavaScript is never trusted with a read.
#[tauri::command]
pub async fn import_pick_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
    options: ImportOptions,
) -> Result<DetectResult, String> {
    let filters = [("Importable text", ["csv", "tsv", "txt", "tab"].as_slice())];
    let Some(path) = pick_open_file(&app, &filters).await? else {
        return Err("cancelled".to_string());
    };
    let text = read_text_capped(&path)?;
    let detection = core::detect(&text, &options);
    let base = path
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "imported".to_string());
    {
        let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
        state.pending_import = Some(path);
    }
    Ok(DetectResult {
        path: base,
        detection,
    })
}

/// Re-detect the stashed import file's shape (options may have changed).
#[tauri::command]
pub fn import_detect_again(
    state: State<'_, Shared>,
    options: ImportOptions,
) -> Result<DetectResult, String> {
    let path = {
        let state = state.lock().map_err(|_| "state poisoned".to_string())?;
        state
            .pending_import
            .clone()
            .ok_or("no import file picked")?
    };
    let text = read_text_capped(&path)?;
    let detection = core::detect(&text, &options);
    let base = path
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "imported".to_string());
    Ok(DetectResult {
        path: base,
        detection,
    })
}

/// Parse the stashed import file and report what importing it would do.
/// Writes nothing.
#[tauri::command]
pub fn import_preview_stashed(
    state: State<'_, Shared>,
    options: ImportOptions,
) -> Result<Preview, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    let path = state
        .pending_import
        .clone()
        .ok_or("no import file picked")?;
    core::import_preview(workspace, &path, &options).map_err(|err| err.to_string())
}

/// Forget the stashed import file (the wizard was cancelled).
#[tauri::command]
pub fn import_cancel(state: State<'_, Shared>) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state.pending_import = None;
    Ok(())
}

/// Apply a reviewed import plan, then refresh the dictionary and notes.
#[tauri::command]
pub fn import_apply(
    app: AppHandle,
    state: State<'_, Shared>,
    plan: ImportPlan,
) -> Result<ImportReport, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    // The plan's `source` is ignored and replaced with the stashed path the
    // Rust-run dialog chose, so a path from JavaScript never reaches a read.
    let source = state
        .pending_import
        .clone()
        .ok_or("no import file picked")?;
    let plan = ImportPlan { source, ..plan };
    let report =
        core::import_apply(state.workspace_mut()?, &plan).map_err(|err| err.to_string())?;
    state.pending_import = None;
    drop(state);
    changed(&app, "dictionary");
    changed(&app, "notes");
    Ok(report)
}

/// Export a table to a file whose path is chosen in a dialog run on the
/// Rust side (CSV, TSV, or a lossless JSON snapshot). A path string from
/// JavaScript is never trusted with a write.
#[tauri::command]
pub async fn export_table_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
    name: String,
    format: nueon_core::TableFormat,
) -> Result<String, String> {
    let (label, ext) = match format {
        nueon_core::TableFormat::Csv => ("CSV", "csv"),
        nueon_core::TableFormat::Tsv => ("TSV", "tsv"),
        nueon_core::TableFormat::Json => ("JSON snapshot", "json"),
    };
    let exts = [ext];
    let filters = [(label, exts.as_slice())];
    let default_name = format!("{name}.{ext}");
    let Some(destination) = pick_save_file(&app, &filters, Some(&default_name)).await? else {
        return Err("cancelled".to_string());
    };
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .export_table(&name, format, &destination)
        .map_err(|err| err.to_string())?;
    Ok(destination.display().to_string())
}

/// Export a table as an Anki-importable text file whose path is chosen in a
/// dialog run on the Rust side.
#[tauri::command]
pub async fn export_anki_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
    name: String,
    options: AnkiExportOptions,
) -> Result<String, String> {
    let filters = [("Anki text", ["txt"].as_slice())];
    let default_name = format!("{name}.txt");
    let Some(destination) = pick_save_file(&app, &filters, Some(&default_name)).await? else {
        return Err("cancelled".to_string());
    };
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .export_anki(&name, &options, &destination)
        .map_err(|err| err.to_string())?;
    Ok(destination.display().to_string())
}
