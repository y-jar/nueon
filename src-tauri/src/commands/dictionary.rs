//! Dictionary commands: tables, entries, tags, etymology, editor aid.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use langloom_core::model::{derivation, RelatedWord};
use langloom_core::{FieldType, TagDef, WordEntry, WordHit, WordTable};

use super::changed;
use crate::state::AppState;

type Shared = Mutex<AppState>;

/// Summary of a table for the grid's table picker.
#[derive(Debug, Clone, Serialize)]
pub struct TableSummary {
    pub name: String,
    pub word_count: usize,
    pub tags: Vec<TagDef>,
}

/// Etymology tree around a word.
#[derive(Debug, Clone, Serialize)]
pub struct DerivationTree {
    pub ancestors: Vec<RelatedWord>,
    pub children: Vec<RelatedWord>,
    pub descendants: Vec<RelatedWord>,
}

fn parse_id(id: &str) -> Result<Uuid, String> {
    Uuid::parse_str(id).map_err(|err| format!("invalid id: {err}"))
}

/// The lowercased wordname → entries index used by the editor.
#[tauri::command]
pub fn word_index(state: State<'_, Shared>) -> Result<BTreeMap<String, Vec<WordHit>>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    Ok(workspace.dictionary.word_index())
}

/// Summaries of every table.
#[tauri::command]
pub fn list_tables(state: State<'_, Shared>) -> Result<Vec<TableSummary>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    Ok(workspace
        .dictionary
        .tables()
        .map(|table| TableSummary {
            name: table.name.clone(),
            word_count: table.entries.len(),
            tags: table.tags.clone(),
        })
        .collect())
}

/// Load one table in full.
#[tauri::command]
pub fn get_table(state: State<'_, Shared>, table: String) -> Result<WordTable, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    workspace
        .dictionary
        .table(&table)
        .cloned()
        .ok_or_else(|| format!("no such table: {table}"))
}

#[tauri::command]
pub fn create_table(
    app: AppHandle,
    state: State<'_, Shared>,
    name: String,
) -> Result<bool, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let created = state
        .workspace_mut()?
        .create_table(&name)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "dictionary");
    Ok(created)
}

#[tauri::command]
pub fn delete_table(
    app: AppHandle,
    state: State<'_, Shared>,
    name: String,
) -> Result<bool, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let deleted = state
        .workspace_mut()?
        .delete_table(&name)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "dictionary");
    Ok(deleted)
}

#[tauri::command]
pub fn create_word(
    app: AppHandle,
    state: State<'_, Shared>,
    table: String,
    wordname: String,
) -> Result<Option<Uuid>, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let id = state
        .workspace_mut()?
        .create_entry(&table, wordname)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "dictionary");
    Ok(id)
}

#[tauri::command]
pub fn save_word_entry(
    app: AppHandle,
    state: State<'_, Shared>,
    table: String,
    entry: WordEntry,
) -> Result<bool, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let saved = state
        .workspace_mut()?
        .replace_entry(&table, entry)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "dictionary");
    Ok(saved)
}

#[tauri::command]
pub fn delete_word(
    app: AppHandle,
    state: State<'_, Shared>,
    table: String,
    id: String,
) -> Result<bool, String> {
    let id = parse_id(&id)?;
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let removed = state
        .workspace_mut()?
        .delete_entry(&table, id)
        .map_err(|err| err.to_string())?
        .is_some();
    drop(state);
    changed(&app, "dictionary");
    Ok(removed)
}

#[tauri::command]
pub fn move_word(
    app: AppHandle,
    state: State<'_, Shared>,
    from: String,
    to: String,
    id: String,
) -> Result<bool, String> {
    let id = parse_id(&id)?;
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let moved = state
        .workspace_mut()?
        .move_entry(&from, &to, id)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "dictionary");
    Ok(moved)
}

#[tauri::command]
pub fn add_tag(
    app: AppHandle,
    state: State<'_, Shared>,
    table: String,
    name: String,
    kind: FieldType,
) -> Result<bool, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let added = state
        .workspace_mut()?
        .add_tag(&table, TagDef::new(name, kind))
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "dictionary");
    Ok(added)
}

#[tauri::command]
pub fn remove_tag_preview(
    state: State<'_, Shared>,
    table: String,
    tag: String,
) -> Result<usize, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    Ok(workspace.preview_remove_tag(&table, &tag))
}

#[tauri::command]
pub fn remove_tag(
    app: AppHandle,
    state: State<'_, Shared>,
    table: String,
    tag: String,
) -> Result<bool, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let removed = state
        .workspace_mut()?
        .remove_tag(&table, &tag)
        .map_err(|err| err.to_string())?
        .is_some();
    drop(state);
    changed(&app, "dictionary");
    Ok(removed)
}

#[tauri::command]
pub fn set_parent(
    app: AppHandle,
    state: State<'_, Shared>,
    table: String,
    child: String,
    parent: String,
) -> Result<bool, String> {
    let child = parse_id(&child)?;
    let parent = parse_id(&parent)?;
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let added = state
        .workspace_mut()?
        .add_parent(&table, child, parent)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "dictionary");
    Ok(added)
}

#[tauri::command]
pub fn remove_parent(
    app: AppHandle,
    state: State<'_, Shared>,
    table: String,
    child: String,
    parent: String,
) -> Result<bool, String> {
    let child = parse_id(&child)?;
    let parent = parse_id(&parent)?;
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let removed = state
        .workspace_mut()?
        .remove_parent(&table, child, parent)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "dictionary");
    Ok(removed)
}

#[tauri::command]
pub fn parent_candidates(
    state: State<'_, Shared>,
    child: String,
) -> Result<Vec<RelatedWord>, String> {
    let child = parse_id(&child)?;
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    Ok(derivation::parent_candidates(&workspace.dictionary, child))
}

#[tauri::command]
pub fn derivation_tree(state: State<'_, Shared>, id: String) -> Result<DerivationTree, String> {
    let id = parse_id(&id)?;
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    let dictionary = &workspace.dictionary;
    let children = dictionary
        .children_of(id)
        .into_iter()
        .filter_map(|entry| {
            dictionary
                .find_entry(entry.id)
                .map(|(table, found)| RelatedWord {
                    table: table.to_string(),
                    id: found.id,
                    wordname: found.wordname.clone(),
                })
        })
        .collect();
    Ok(DerivationTree {
        ancestors: derivation::ancestors(dictionary, id),
        children,
        descendants: derivation::descendants(dictionary, id),
    })
}
