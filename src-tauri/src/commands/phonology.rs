//! Phonology commands: batched phonotactic checks and the sound change engine.

use std::sync::Mutex;

use tauri::{AppHandle, State};

use nueon_core::config::{apply_rules, segments, Segment, Violation};

use crate::state::AppState;

use super::changed;

type Shared = Mutex<AppState>;

/// Check each word against the workspace's phoneme inventory and syllable
/// shapes. Non-blocking: empty inventories produce no violations.
#[tauri::command]
pub fn phonology_check_words(
    state: State<'_, Shared>,
    words: Vec<String>,
) -> Result<Vec<Vec<Violation>>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let config = &state.workspace()?.phonology;
    Ok(words
        .iter()
        .map(|word| nueon_core::config::check_word(word, config))
        .collect())
}

/// The word split into inventory phonemes, marking unknown characters.
#[tauri::command]
pub fn phonology_segments(state: State<'_, Shared>, word: String) -> Result<Vec<Segment>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let config = &state.workspace()?.phonology;
    Ok(segments(&word, config))
}

/// The intermediate results of applying every sound change to `word`.
#[tauri::command]
pub fn phonology_apply_word(state: State<'_, Shared>, word: String) -> Result<Vec<String>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let config = &state.workspace()?.phonology;
    Ok(apply_rules(&word, config))
}

/// Apply every sound change to a table's wordnames (one undo step). Returns
/// how many words were renamed.
#[tauri::command]
pub fn phonology_apply_table(
    app: AppHandle,
    state: State<'_, Shared>,
    table: String,
) -> Result<usize, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let renamed = state
        .workspace_mut()?
        .apply_sound_changes(&table)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "dictionary");
    changed(&app, "notes");
    Ok(renamed)
}
