//! Morphology commands: the fixes-table morpheme inventory and the lexicon
//! picker. Both are read-only views over the current workspace.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use nueon_core::model::translate::inherent_values;
use nueon_core::{
    AffixKind, ComposePiece, FieldValue, Inflection, Morpheme, ParadigmGrid, WordEntry,
};

use super::changed;
use crate::state::AppState;

type Shared = Mutex<AppState>;

/// One morpheme from a `Fixes` table, for the palette and slot references.
#[derive(Debug, Clone, Serialize)]
pub struct MorphemeInfo {
    pub table: String,
    /// The morpheme row's stable id (the word entry's uuid).
    pub id: String,
    pub wordname: String,
    pub surface: String,
    pub kind: AffixKind,
    pub gloss: String,
    /// English triggers (morpheme keys minus the wordname).
    pub triggers: Vec<String>,
}

/// One word from a `Vocab` table, for the lexicon picker.
#[derive(Debug, Clone, Serialize)]
pub struct LexiconWord {
    pub table: String,
    pub id: String,
    pub wordname: String,
    pub class: Option<String>,
    /// The first definition sense (for display).
    pub gloss: String,
    /// Every definition sense (for searching).
    pub senses: Vec<String>,
}

/// The configured/auto-detected class column, and the columns to offer.
#[derive(Debug, Clone, Serialize)]
pub struct ClassColumnInfo {
    /// The configured column, or `None` when auto-detected.
    pub configured: Option<String>,
    /// The column the engine actually reads.
    pub resolved: String,
    /// Every column name across the tables (for the picker).
    pub candidates: Vec<String>,
}

/// A word's class, from the first sense of `column` (a leading `#` dropped).
fn class_of(entry: &WordEntry, column: &str) -> Option<String> {
    let value = match entry.values.get(column) {
        Some(FieldValue::TagList(list)) => list.first().cloned(),
        Some(FieldValue::Text(text)) => Some(text.clone()),
        _ => None,
    }?;
    Some(value.strip_prefix('#').unwrap_or(&value).to_string())
}

/// Every morpheme supplied by tables designated `Fixes`.
#[tauri::command]
pub fn list_morphemes(state: State<'_, Shared>) -> Result<Vec<MorphemeInfo>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    Ok(workspace
        .translation_morphemes()
        .into_iter()
        .map(|morpheme| {
            let triggers = morpheme
                .keys
                .iter()
                .filter(|key| **key != morpheme.wordname)
                .cloned()
                .collect();
            MorphemeInfo {
                table: morpheme.table,
                id: morpheme.id,
                wordname: morpheme.wordname,
                surface: morpheme.surface,
                kind: morpheme.kind,
                gloss: morpheme.gloss,
                triggers,
            }
        })
        .collect())
}

/// Every word in a `Vocab` table (fixes tables are morphemes, not roots).
#[tauri::command]
pub fn lexicon(state: State<'_, Shared>) -> Result<Vec<LexiconWord>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    let fixes = workspace.fixes_tables();
    let column = workspace.class_column();
    let mut words = Vec::new();
    for table in workspace.dictionary.tables() {
        if fixes.contains(&table.name) {
            continue;
        }
        for entry in &table.entries {
            let senses: Vec<String> = entry.definition().unwrap_or(&[]).to_vec();
            words.push(LexiconWord {
                table: table.name.clone(),
                id: entry.id.to_string(),
                wordname: entry.wordname.clone(),
                class: class_of(entry, &column),
                gloss: senses.first().cloned().unwrap_or_default(),
                senses,
            });
        }
    }
    Ok(words)
}

/// The current class column (configured or auto-detected) and column options.
#[tauri::command]
pub fn class_column_get(state: State<'_, Shared>) -> Result<ClassColumnInfo, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    let mut candidates: BTreeSet<String> = BTreeSet::new();
    for table in workspace.dictionary.tables() {
        for tag in &table.tags {
            candidates.insert(tag.name.clone());
        }
    }
    Ok(ClassColumnInfo {
        configured: workspace.translation.morphology.class_column.clone(),
        resolved: workspace.class_column(),
        candidates: candidates.into_iter().collect(),
    })
}

/// Strip a leading `#` from the class column's values across every table.
#[tauri::command]
pub fn normalize_class_values(
    app: AppHandle,
    state: State<'_, Shared>,
    column: Option<String>,
) -> Result<usize, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace_mut()?;
    let column = column.unwrap_or_else(|| workspace.class_column());
    let changed_count = workspace
        .normalize_class_values(&column)
        .map_err(|err| err.to_string())?;
    drop(state);
    if changed_count > 0 {
        changed(&app, "dictionary");
    }
    Ok(changed_count)
}

/// Inflect one word: its root with feature-driven paradigm affixes and any
/// manually selected fixes-table morphemes, composed and broken down.
#[tauri::command]
pub fn inflect_word(
    state: State<'_, Shared>,
    id: String,
    selections: Option<HashMap<String, String>>,
    morphemes: Option<Vec<String>>,
) -> Result<Inflection, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    let id = Uuid::parse_str(&id).map_err(|err| format!("bad uuid: {err}"))?;
    let selections: BTreeMap<String, String> = selections.unwrap_or_default().into_iter().collect();

    let lexicon = workspace.translation_morphemes();
    let manual: Vec<Morpheme> = morphemes
        .unwrap_or_default()
        .iter()
        .filter_map(|reference| {
            lexicon
                .iter()
                .find(|morpheme| morpheme.matches(reference))
                .cloned()
        })
        .collect();

    Ok(nueon_core::model::translate::inflect(
        &workspace.dictionary,
        id,
        &workspace.translation.morphology,
        &lexicon,
        &selections,
        &manual,
    ))
}

/// The distinct values in a table column, for an inherent feature's options.
#[tauri::command]
pub fn feature_values(
    state: State<'_, Shared>,
    table: String,
    column: String,
) -> Result<Vec<String>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    Ok(inherent_values(&workspace.dictionary, &table, &column))
}

/// The endings coverage grid for a word class.
#[tauri::command]
pub fn paradigm_grid(state: State<'_, Shared>, class: String) -> Result<ParadigmGrid, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    let morphemes = workspace.translation_morphemes();
    Ok(nueon_core::model::translate::paradigm_grid(
        &workspace.dictionary,
        &workspace.translation.morphology,
        &morphemes,
        &class,
    ))
}

/// Compose an ordered sequence of roots and morphemes into a word.
#[tauri::command]
pub fn compose(state: State<'_, Shared>, pieces: Vec<ComposePiece>) -> Result<Inflection, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    let lexicon = workspace.translation_morphemes();
    Ok(nueon_core::model::translate::compose(
        &workspace.dictionary,
        &lexicon,
        &pieces,
    ))
}
