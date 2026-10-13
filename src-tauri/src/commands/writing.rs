//! Writing-system commands: per-glyph outline load and save.

use std::sync::Mutex;

use tauri::{AppHandle, State};

use nueon_core::config::GlyphOutline;

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
