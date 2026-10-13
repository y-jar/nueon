//! Writing-system commands: per-glyph outline load and save.

use std::sync::Mutex;

use tauri::{AppHandle, State};

use nueon_core::config::GlyphOutline;
use nueon_core::model::BooleanOp;

use crate::state::AppState;

use super::changed;

type Shared = Mutex<AppState>;

/// Load one glyph's outline, or `None` when it has not been written yet.
#[tauri::command]
pub fn writing_glyph_get(
    state: State<'_, Shared>,
    id: String,
) -> Result<Option<GlyphOutline>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .load_glyph(&id)
        .map_err(|err| err.to_string())
}

/// Save one glyph's outline, rejecting acyclic-component violations.
#[tauri::command]
pub fn writing_glyph_set(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
    outline: GlyphOutline,
) -> Result<(), String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .save_glyph(&id, &outline)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "writing");
    Ok(())
}

/// Apply a pathfinder boolean to a glyph's contours.
#[tauri::command]
pub fn writing_path_operation(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
    operation: String,
) -> Result<(), String> {
    let op = match operation.as_str() {
        "union" => BooleanOp::Union,
        "difference" => BooleanOp::Difference,
        "intersect" => BooleanOp::Intersect,
        "exclude" => BooleanOp::Exclude,
        other => return Err(format!("unknown pathfinder operation: {other}")),
    };
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .apply_pathfinder(&id, op)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "writing");
    Ok(())
}

/// One glyph as a standalone SVG document.
#[tauri::command]
pub fn writing_export_svg(state: State<'_, Shared>, id: String) -> Result<String, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .export_glyph_svg(&id)
        .map_err(|err| err.to_string())
}

/// Every glyph as one `<symbol>` sprite sheet.
#[tauri::command]
pub fn writing_export_sprite(state: State<'_, Shared>) -> Result<String, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .export_sprite_svg()
        .map_err(|err| err.to_string())
}

/// Replace a glyph's contours from SVG text; returns how many were imported.
#[tauri::command]
pub fn writing_import_svg(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
    svg: String,
) -> Result<usize, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let count = state
        .workspace()?
        .import_glyph_svg(&id, &svg)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "writing");
    Ok(count)
}

/// Read a user-chosen text file (SVG import); the path comes from a dialog.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 8 * 1024 * 1024;
    let meta = std::fs::metadata(&path).map_err(|err| err.to_string())?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {path}"));
    }
    if meta.len() > MAX_BYTES {
        return Err("file is too large to import".to_string());
    }
    std::fs::read_to_string(&path).map_err(|err| err.to_string())
}

/// Write text to a user-chosen path (SVG export); the path comes from a dialog.
#[tauri::command]
pub fn write_text_file(path: String, text: String) -> Result<(), String> {
    std::fs::write(&path, text).map_err(|err| err.to_string())
}

/// What a font export wrote.
#[derive(serde::Serialize)]
pub struct FontExport {
    pub glyphs: usize,
    pub mapped: usize,
    pub bytes: usize,
}

/// Compile the writing system to a TrueType font, verify it by reading it
/// back, and write it to a path chosen in a save dialog.
#[tauri::command]
pub fn writing_export_font(state: State<'_, Shared>, path: String) -> Result<FontExport, String> {
    let (bytes, report) = {
        let state = state.lock().map_err(|_| "state poisoned".to_string())?;
        state
            .workspace()?
            .compile_writing_font()
            .map_err(|err| err.to_string())?
    };
    std::fs::write(&path, &bytes).map_err(|err| err.to_string())?;
    Ok(FontExport {
        glyphs: report.glyphs,
        mapped: report.mapped,
        bytes: report.bytes,
    })
}
