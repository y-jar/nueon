//! Phonology commands: batched phonotactic checks for word names.

use std::sync::Mutex;

use tauri::State;

use nueon_core::config::Violation;

use crate::state::AppState;

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
