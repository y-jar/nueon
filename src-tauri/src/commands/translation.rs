//! Translation commands: presets, execution, and inline word creation.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use tauri::{AppHandle, State};
use uuid::Uuid;

use nueon_core::model::TranslationReport;
use nueon_core::{Morphology, SyntaxGrid, TranslationOptions, WordHit};

use super::changed;
use crate::state::AppState;

type Shared = Mutex<AppState>;

/// Saved translation presets.
#[tauri::command]
pub fn list_presets(state: State<'_, Shared>) -> Result<Vec<SyntaxGrid>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.translation.grids.clone())
}

/// Insert or replace a preset and persist.
#[tauri::command]
pub fn save_preset(
    app: AppHandle,
    state: State<'_, Shared>,
    grid: SyntaxGrid,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .save_preset(grid)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "translation");
    Ok(())
}

/// Delete a preset by name and persist.
#[tauri::command]
pub fn delete_preset(
    app: AppHandle,
    state: State<'_, Shared>,
    name: String,
) -> Result<bool, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let removed = state
        .workspace_mut()?
        .delete_preset(&name)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "translation");
    Ok(removed)
}

/// Execute the translation engine. `choices` maps token index → entry UUID to
/// resolve homograph conflicts (JSON keys are strings).
#[tauri::command]
pub fn execute_translation(
    state: State<'_, Shared>,
    input_text: String,
    grid: SyntaxGrid,
    choices: Option<HashMap<String, String>>,
    selections: Option<HashMap<String, String>>,
) -> Result<TranslationReport, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;

    let mut resolved: HashMap<usize, Uuid> = HashMap::new();
    if let Some(choices) = choices {
        for (key, value) in choices {
            let index = key
                .parse::<usize>()
                .map_err(|err| format!("bad token index: {err}"))?;
            let id = Uuid::parse_str(&value).map_err(|err| format!("bad uuid: {err}"))?;
            resolved.insert(index, id);
        }
    }
    let features: BTreeMap<String, String> = selections.unwrap_or_default().into_iter().collect();

    let separator = workspace
        .translation
        .settings
        .get("word_separator")
        .map(String::as_str)
        .unwrap_or(" ");

    Ok(nueon_core::model::translate::translate_with(
        &workspace.dictionary,
        &grid,
        separator,
        &input_text,
        &resolved,
        &workspace.translation.affixes,
        &workspace.translation.morphology,
        &features,
    ))
}

/// Execute the word-for-word translator: each input word maps to its conlang
/// word in order, with no syntax grid. A token that already matches a
/// `wordname` passes through unchanged.
#[tauri::command]
pub fn execute_translation_direct(
    state: State<'_, Shared>,
    input_text: String,
    choices: Option<HashMap<String, String>>,
    selections: Option<HashMap<String, String>>,
) -> Result<TranslationReport, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;

    let mut resolved: HashMap<usize, Uuid> = HashMap::new();
    if let Some(choices) = choices {
        for (key, value) in choices {
            let index = key
                .parse::<usize>()
                .map_err(|err| format!("bad token index: {err}"))?;
            let id = Uuid::parse_str(&value).map_err(|err| format!("bad uuid: {err}"))?;
            resolved.insert(index, id);
        }
    }
    let features: BTreeMap<String, String> = selections.unwrap_or_default().into_iter().collect();

    let separator = workspace
        .translation
        .settings
        .get("word_separator")
        .map(String::as_str)
        .unwrap_or(" ");

    Ok(nueon_core::model::translate::translate_direct_with(
        &workspace.dictionary,
        separator,
        &input_text,
        &resolved,
        &workspace.translation.affixes,
        &workspace.translation.morphology,
        &features,
    ))
}

/// The feature paradigm definitions.
#[tauri::command]
pub fn translation_morphology(state: State<'_, Shared>) -> Result<Morphology, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.translation.morphology.clone())
}

/// Replace the feature paradigms and persist.
#[tauri::command]
pub fn set_translation_morphology(
    app: AppHandle,
    state: State<'_, Shared>,
    morphology: Morphology,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .set_translation_morphology(morphology)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "translation");
    Ok(())
}

/// Existing entries whose name or senses contain `token`, for the translator's
/// "search existing words" suggestions.
#[tauri::command]
pub fn translation_suggest(
    state: State<'_, Shared>,
    token: String,
) -> Result<Vec<WordHit>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.dictionary.search_hits(&token))
}

/// The separator and morphology rules the translation view edits.
#[tauri::command]
pub fn translation_options(state: State<'_, Shared>) -> Result<TranslationOptions, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.translation_options())
}

/// Replace the separator and morphology rules, then persist.
#[tauri::command]
pub fn set_translation_options(
    app: AppHandle,
    state: State<'_, Shared>,
    options: TranslationOptions,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .set_translation_options(options)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "translation");
    Ok(())
}

/// Write presets to a JSON file chosen by the user.
#[tauri::command]
pub fn export_presets(path: String, grids: Vec<SyntaxGrid>) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(&grids).map_err(|err| err.to_string())?;
    std::fs::write(&path, json).map_err(|err| err.to_string())
}

/// Read presets from a JSON file chosen by the user.
#[tauri::command]
pub fn import_presets(path: String) -> Result<Vec<SyntaxGrid>, String> {
    let bytes = std::fs::read(&path).map_err(|err| err.to_string())?;
    serde_json::from_slice(&bytes).map_err(|err| err.to_string())
}

/// Create a word from a missing translation token (writes to the dictionary and
/// notifies both the grid and the editor).
#[tauri::command]
pub fn create_translation_word(
    app: AppHandle,
    state: State<'_, Shared>,
    table: String,
    wordname: String,
    definition: String,
    tags: Vec<String>,
) -> Result<Option<Uuid>, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let id = state
        .workspace_mut()?
        .create_defined_entry(&table, wordname, &definition, &tags)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "dictionary");
    Ok(id)
}
