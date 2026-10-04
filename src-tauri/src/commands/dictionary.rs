//! Dictionary commands (editor aid + queries).

use std::collections::BTreeMap;
use std::sync::Mutex;

use tauri::State;

use langloom_core::WordHit;

use crate::state::AppState;

type Shared = Mutex<AppState>;

/// The lowercased wordname → entries index used by the editor's
/// highlight/hover features.
#[tauri::command]
pub fn word_index(state: State<'_, Shared>) -> Result<BTreeMap<String, Vec<WordHit>>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    Ok(workspace.dictionary.word_index())
}
