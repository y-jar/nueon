//! User-level keybind overrides (stored in the app-global `config.toml`).

use std::collections::BTreeMap;
use std::sync::Mutex;

use tauri::State;

use crate::state::AppState;

type Shared = Mutex<AppState>;

/// Every command's key override (command id → CodeMirror combo).
#[tauri::command]
pub fn keybinds_get(state: State<'_, Shared>) -> Result<BTreeMap<String, String>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.global.keybinds.clone())
}

/// Set one command's override. `None` reverts the command to its default; an
/// empty string unbinds it.
#[tauri::command]
pub fn set_keybind(
    state: State<'_, Shared>,
    id: String,
    key: Option<String>,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    match key {
        Some(key) => {
            state.global.keybinds.insert(id, key);
        }
        None => {
            state.global.keybinds.remove(&id);
        }
    }
    state.global.save().map_err(|err| err.to_string())
}

/// Clear every override, restoring all defaults.
#[tauri::command]
pub fn reset_keybinds(state: State<'_, Shared>) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state.global.keybinds.clear();
    state.global.save().map_err(|err| err.to_string())
}
