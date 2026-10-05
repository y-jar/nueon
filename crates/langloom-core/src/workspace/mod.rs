//! A user-designated workspace directory: tables, notes, and config.

mod note;
mod storage;

pub use note::NoteFile;
pub use storage::{StorageError, CONFIG_DIR, DICTIONARY_DIR, NOTES_DIR};

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::config::{
    GrammarConfig, GridViewState, LanguageConfig, TranslationConfig, TranslationOptions, UiLayout,
    WorkspaceSettings,
};
use crate::model::{
    Dictionary, FieldType, FieldValue, TagDef, TagFormat, TagKindChange, TagRemoval, WordEntry,
    DEFINITION_TAG,
};
use crate::translation::SyntaxGrid;
use crate::vcs::{AutoCheckin, GitRepo, GitStatus, VcsError};

/// The physical workspace directory and everything loaded from it.
#[derive(Debug)]
pub struct Workspace {
    /// Root of the workspace on the user's machine.
    pub root_path: PathBuf,
    /// The in-memory dictionary (all tables).
    pub dictionary: Dictionary,
    /// Raw Markdown notes.
    pub notes: Vec<NoteFile>,
    /// Language metadata.
    pub language: LanguageConfig,
    /// Grammar rules.
    pub grammar: GrammarConfig,
    /// Translation configuration.
    pub translation: TranslationConfig,
    /// User settings.
    pub settings: WorkspaceSettings,
    /// Detected version-control state.
    pub vcs: GitStatus,
    auto: AutoCheckin,
    history: History,
}

/// A bounded stack of whole-dictionary snapshots for undo/redo.
#[derive(Debug)]
struct History {
    undo: Vec<Dictionary>,
    redo: Vec<Dictionary>,
}

impl History {
    /// Maximum number of retained undo snapshots.
    const LIMIT: usize = 50;

    fn new() -> Self {
        Self {
            undo: Vec::new(),
            redo: Vec::new(),
        }
    }

    fn record(&mut self, snapshot: Dictionary) {
        self.undo.push(snapshot);
        if self.undo.len() > Self::LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
}

impl Workspace {
    /// Create an empty workspace, creating the directory layout on disk.
    ///
    /// Git is opt-in and is *not* initialized here; watch [`Workspace::vcs`]
    /// and call [`Workspace::init_git`] after prompting the user.
    pub fn new(root_path: impl Into<PathBuf>) -> Result<Self, StorageError> {
        let root_path = root_path.into();
        storage::ensure_dirs(&root_path)?;
        storage::ensure_gitignore(&root_path)?;
        storage::ensure_config_files(&root_path)?;

        let settings = WorkspaceSettings::default();
        let auto = AutoCheckin::new(
            settings.auto_checkin,
            Duration::from_secs(settings.auto_checkin_secs),
        );
        let vcs = GitStatus::detect(&root_path);

        Ok(Self {
            root_path,
            dictionary: Dictionary::new(),
            notes: Vec::new(),
            language: LanguageConfig::default(),
            grammar: GrammarConfig::default(),
            translation: TranslationConfig::default(),
            settings,
            vcs,
            auto,
            history: History::new(),
        })
    }

    /// Open an existing workspace, erroring instead of fabricating one when
    /// `root_path` does not exist on disk.
    pub fn open(root_path: impl Into<PathBuf>) -> Result<Self, StorageError> {
        let root_path = root_path.into();
        if !root_path.is_dir() {
            return Err(StorageError::NotFound(root_path));
        }
        Self::load(root_path)
    }

    /// Load an existing workspace, creating the layout if it is missing.
    pub fn load(root_path: impl Into<PathBuf>) -> Result<Self, StorageError> {
        let root_path = root_path.into();
        storage::ensure_dirs(&root_path)?;
        storage::ensure_gitignore(&root_path)?;
        storage::ensure_config_files(&root_path)?;

        let mut dictionary = Dictionary::new();
        for table in storage::scan_tables(&root_path.join(DICTIONARY_DIR))? {
            dictionary.tables.insert(table.name.clone(), table);
        }

        let notes = storage::scan_notes(&root_path.join(NOTES_DIR))?;

        let config_dir = root_path.join(CONFIG_DIR);
        let language =
            storage::load_json(&config_dir.join(storage::LANGUAGE_FILE))?.unwrap_or_default();
        let grammar =
            storage::load_json(&config_dir.join(storage::GRAMMAR_FILE))?.unwrap_or_default();
        let translation =
            storage::load_json(&config_dir.join(storage::TRANSLATION_FILE))?.unwrap_or_default();
        let settings: WorkspaceSettings =
            storage::load_json(&config_dir.join(storage::SETTINGS_FILE))?.unwrap_or_default();

        let auto = AutoCheckin::new(
            settings.auto_checkin,
            Duration::from_secs(settings.auto_checkin_secs),
        );
        let vcs = GitStatus::detect(&root_path);

        Ok(Self {
            root_path,
            dictionary,
            notes,
            language,
            grammar,
            translation,
            settings,
            vcs,
            auto,
            history: History::new(),
        })
    }

    /// The `dictionary/` directory.
    pub fn dictionary_dir(&self) -> PathBuf {
        self.root_path.join(DICTIONARY_DIR)
    }

    /// The `notes/` directory.
    pub fn notes_dir(&self) -> PathBuf {
        self.root_path.join(NOTES_DIR)
    }

    /// The `config/` directory.
    pub fn config_dir(&self) -> PathBuf {
        self.root_path.join(CONFIG_DIR)
    }

    /// The active repository, if git is ready.
    pub fn git(&self) -> Option<&GitRepo> {
        self.vcs.repo()
    }

    /// Initialize a git repository and replace the detected state.
    pub fn init_git(&mut self) -> Result<(), VcsError> {
        let repo = GitRepo::init(&self.root_path)?;
        self.vcs = GitStatus::Ready(repo);
        Ok(())
    }

    /// Configure the automatic check-in toggle and idle debounce.
    pub fn set_auto_checkin(&mut self, enabled: bool, secs: u64) {
        self.settings.auto_checkin = enabled;
        self.settings.auto_checkin_secs = secs;
        self.auto.set_enabled(enabled);
        self.auto.set_debounce(Duration::from_secs(secs));
    }

    // -- tables ---------------------------------------------------------

    /// Create a table and persist it.
    pub fn create_table(&mut self, name: &str) -> Result<bool, StorageError> {
        if self.dictionary.table(name).is_some() {
            return Ok(false);
        }
        self.record();
        self.dictionary.add_table(name);
        self.save_table(name)?;
        self.mark_change(Instant::now(), format!("langloom: create table \"{name}\""));
        Ok(true)
    }

    /// Delete a table and its backing file.
    pub fn delete_table(&mut self, name: &str) -> Result<bool, StorageError> {
        if self.dictionary.table(name).is_none() {
            return Ok(false);
        }
        self.record();
        self.dictionary.remove_table(name);
        storage::delete_table(&self.dictionary_dir(), name)?;
        self.mark_change(Instant::now(), format!("langloom: delete table \"{name}\""));
        Ok(true)
    }

    /// Rename a table, moving its backing file to the new slug.
    pub fn rename_table(&mut self, from: &str, to: &str) -> Result<bool, StorageError> {
        if from == to
            || to.trim().is_empty()
            || self.dictionary.table(from).is_none()
            || self.dictionary.table(to).is_some()
        {
            return Ok(false);
        }
        self.record();
        let mut table = self
            .dictionary
            .remove_table(from)
            .expect("existence checked above");
        table.name = to.to_string();
        self.dictionary.tables.insert(to.to_string(), table);
        self.save_table(to)?;
        storage::delete_table(&self.dictionary_dir(), from)?;
        self.mark_change(
            Instant::now(),
            format!("langloom: rename table \"{from}\" to \"{to}\""),
        );
        Ok(true)
    }

    /// Write a table to disk.
    pub fn save_table(&self, name: &str) -> Result<(), StorageError> {
        let table = self
            .dictionary
            .table(name)
            .ok_or_else(|| StorageError::TableMissing(name.to_string()))?;
        storage::write_table(&self.dictionary_dir(), table)
    }

    /// Persist in-place edits to the words of a table.
    pub fn save_table_edits(&mut self, table: &str) -> Result<(), StorageError> {
        self.save_table(table)?;
        self.mark_change(Instant::now(), format!("langloom: edit table \"{table}\""));
        Ok(())
    }

    // -- words ----------------------------------------------------------

    /// Create and persist a new word in a table.
    pub fn create_entry(
        &mut self,
        table: &str,
        wordname: impl Into<String>,
    ) -> Result<Option<Uuid>, StorageError> {
        if self.dictionary.table(table).is_none() {
            return Ok(None);
        }
        self.record();
        let entry = WordEntry::new(wordname);
        let id = entry.id;
        let wordname = entry.wordname.clone();
        self.dictionary.add_entry(table, entry);
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("langloom: add word \"{wordname}\" to table \"{table}\""),
        );
        Ok(Some(id))
    }

    /// Create a word with an English definition and optional tags.
    ///
    /// Tags that are not yet columns in the table are declared as Boolean
    /// columns. Used by the translation view's inline missing-word creation.
    pub fn create_defined_entry(
        &mut self,
        table: &str,
        wordname: impl Into<String>,
        definition: &str,
        tags: &[String],
    ) -> Result<Option<Uuid>, StorageError> {
        if self.dictionary.table(table).is_none() {
            return Err(StorageError::TableMissing(table.to_string()));
        }
        self.record();
        for tag in tags {
            let declared = self.dictionary.table(table).is_some_and(|t| t.has_tag(tag));
            if !declared {
                self.dictionary
                    .add_tag(table, TagDef::new(tag.clone(), FieldType::Boolean));
            }
        }

        let mut entry = WordEntry::new(wordname);
        let id = entry.id;
        if !definition.trim().is_empty() {
            entry.set(
                DEFINITION_TAG,
                FieldValue::TagList(vec![definition.trim().to_string()]),
            );
        }
        for tag in tags {
            entry.set(tag, FieldValue::Boolean(true));
        }
        let wordname = entry.wordname.clone();
        self.dictionary.add_entry(table, entry);
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("langloom: add word \"{wordname}\" (from translation) to table \"{table}\""),
        );
        Ok(Some(id))
    }

    /// Persist an existing word after it has been edited.
    pub fn save_entry(&mut self, table: &str, id: Uuid) -> Result<bool, StorageError> {
        let wordname = match self.dictionary.get_entry(table, id) {
            Some(entry) => entry.wordname.clone(),
            None => return Ok(false),
        };
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("langloom: update word \"{wordname}\" in table \"{table}\""),
        );
        Ok(true)
    }

    /// Replace an existing word's data and persist it.
    pub fn replace_entry(&mut self, table: &str, entry: WordEntry) -> Result<bool, StorageError> {
        let id = entry.id;
        if self.dictionary.get_entry(table, id).is_none() {
            return Ok(false);
        }
        self.record();
        if let Some(existing) = self.dictionary.get_entry_mut(table, id) {
            *existing = entry;
        }
        self.save_entry(table, id)
    }

    /// Move a word to another table and persist both tables.
    pub fn move_entry(&mut self, from: &str, to: &str, id: Uuid) -> Result<bool, StorageError> {
        if from == to
            || self.dictionary.table(to).is_none()
            || self.dictionary.get_entry(from, id).is_none()
        {
            return Ok(false);
        }
        self.record();
        self.dictionary.move_entry(from, to, id);
        self.save_table(from)?;
        self.save_table(to)?;
        self.mark_change(
            Instant::now(),
            format!("langloom: move word between \"{from}\" and \"{to}\""),
        );
        Ok(true)
    }

    /// Add a parent link (rejecting cycles) and persist the table.
    pub fn add_parent(
        &mut self,
        table: &str,
        child: Uuid,
        parent: Uuid,
    ) -> Result<bool, StorageError> {
        if !self.dictionary.can_be_parent(child, parent)
            || self.dictionary.get_entry(table, child).is_none()
        {
            return Ok(false);
        }
        self.record();
        self.dictionary.add_parent(table, child, parent);
        self.save_table_edits(table)?;
        Ok(true)
    }

    /// Remove a parent link and persist the table.
    pub fn remove_parent(
        &mut self,
        table: &str,
        child: Uuid,
        parent: Uuid,
    ) -> Result<bool, StorageError> {
        if self.dictionary.get_entry(table, child).is_none() {
            return Ok(false);
        }
        self.record();
        if !self.dictionary.remove_parent(table, child, parent) {
            self.history.undo.pop();
            return Ok(false);
        }
        self.save_table_edits(table)?;
        Ok(true)
    }

    /// Replace a word's parents with the single given parent, in one step.
    ///
    /// Rejects cycles (the parent may not be the word or its descendant).
    pub fn set_parent_only(
        &mut self,
        table: &str,
        child: Uuid,
        parent: Uuid,
    ) -> Result<bool, StorageError> {
        if !self.dictionary.can_be_parent(child, parent) {
            return Ok(false);
        }
        if self.dictionary.get_entry(table, child).is_none() {
            return Ok(false);
        }
        self.record();
        if let Some(entry) = self.dictionary.get_entry_mut(table, child) {
            entry.set_parents(&[parent]);
        }
        self.save_table_edits(table)?;
        Ok(true)
    }

    /// Remove a word from its table and persist the change.
    pub fn delete_entry(
        &mut self,
        table: &str,
        id: Uuid,
    ) -> Result<Option<WordEntry>, StorageError> {
        if self.dictionary.get_entry(table, id).is_none() {
            return Ok(None);
        }
        self.record();
        let removed = match self.dictionary.remove_entry(table, id) {
            Some(entry) => entry,
            None => return Ok(None),
        };
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!(
                "langloom: delete word \"{}\" from table \"{table}\"",
                removed.wordname
            ),
        );
        Ok(Some(removed))
    }

    // -- tags -----------------------------------------------------------

    /// Add a column to a table.
    pub fn add_tag(&mut self, table: &str, tag: TagDef) -> Result<bool, StorageError> {
        let name = tag.name.clone();
        let exists = self
            .dictionary
            .table(table)
            .is_some_and(|t| t.has_tag(&name));
        if exists || self.dictionary.table(table).is_none() {
            return Ok(false);
        }
        self.record();
        self.dictionary.add_tag(table, tag);
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("langloom: add tag \"{name}\" to table \"{table}\""),
        );
        Ok(true)
    }

    /// Every non-builtin tag name used across all tables, for suggestions.
    pub fn known_tag_names(&self) -> Vec<String> {
        self.dictionary.known_tag_names().into_iter().collect()
    }

    /// Change a tag's field type, migrating stored values where possible.
    pub fn set_tag_kind(
        &mut self,
        table: &str,
        tag: &str,
        kind: FieldType,
    ) -> Result<Option<TagKindChange>, StorageError> {
        self.record();
        let change = match self
            .dictionary
            .table_mut(table)
            .and_then(|t| t.set_tag_kind(tag, kind))
        {
            Some(change) => change,
            None => {
                self.history.undo.pop();
                return Ok(None);
            }
        };
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("langloom: change type of tag \"{tag}\" in table \"{table}\""),
        );
        Ok(Some(change))
    }

    /// How many words would lose a value if `tag` were removed.
    pub fn preview_remove_tag(&self, table: &str, tag: &str) -> usize {
        self.dictionary.entries_with_tag(table, tag).len()
    }

    /// Set a tag's widget/format hint.
    pub fn set_tag_format(
        &mut self,
        table: &str,
        tag: &str,
        format: TagFormat,
    ) -> Result<bool, StorageError> {
        let exists = self.dictionary.table(table).is_some_and(|t| t.has_tag(tag));
        if !exists {
            return Ok(false);
        }
        self.record();
        self.dictionary
            .table_mut(table)
            .expect("checked above")
            .set_tag_format(tag, format);
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("langloom: change format of tag \"{tag}\" in table \"{table}\""),
        );
        Ok(true)
    }

    /// Remove a column, strip its values, and force a revertible check-in.
    ///
    /// The check-in is committed immediately (regardless of the auto-check-in
    /// toggle) so the destructive change can be reverted from the git panel.
    pub fn remove_tag(
        &mut self,
        table: &str,
        tag: &str,
    ) -> Result<Option<TagRemoval>, StorageError> {
        self.record();
        let removal = match self.dictionary.remove_tag(table, tag) {
            Some(removal) => removal,
            None => {
                self.history.undo.pop();
                return Ok(None);
            }
        };
        self.save_table(table)?;
        let message = format!(
            "langloom: DELETED TAGS: {table}.{tag} ({} words) <CAN REVERT>",
            removal.affected
        );
        self.force_checkin(&message);
        Ok(Some(removal))
    }

    // -- notes & config -------------------------------------------------

    /// Persist a note's raw content and refresh the in-memory copy.
    pub fn save_note(&mut self, note: &NoteFile) -> Result<(), StorageError> {
        storage::write_note(&self.notes_dir(), note)?;
        match self.notes.iter_mut().find(|n| n.path == note.path) {
            Some(existing) => *existing = note.clone(),
            None => self.notes.push(note.clone()),
        }
        self.mark_change(
            Instant::now(),
            format!("langloom: update note \"{}\"", note.path.display()),
        );
        Ok(())
    }

    /// Read a note's raw content from `notes/<relative>`.
    pub fn read_note(&self, relative: impl AsRef<Path>) -> Result<String, StorageError> {
        storage::read_note(&self.notes_dir(), relative.as_ref())
    }

    /// Create an empty note and refresh the note list.
    pub fn create_note(&mut self, relative: impl AsRef<Path>) -> Result<(), StorageError> {
        let relative = relative.as_ref();
        storage::create_note(&self.notes_dir(), relative)?;
        self.refresh_notes()?;
        self.mark_change(
            Instant::now(),
            format!("langloom: create note \"{}\"", relative.display()),
        );
        Ok(())
    }

    /// Create a notes folder.
    pub fn create_folder(&mut self, relative: impl AsRef<Path>) -> Result<(), StorageError> {
        let relative = relative.as_ref();
        storage::create_folder(&self.notes_dir(), relative)?;
        self.mark_change(
            Instant::now(),
            format!("langloom: create folder \"{}\"", relative.display()),
        );
        Ok(())
    }

    /// Rename a note or folder and refresh the note list.
    pub fn rename_note(
        &mut self,
        from: impl AsRef<Path>,
        to: impl AsRef<Path>,
    ) -> Result<(), StorageError> {
        let from = from.as_ref();
        let to = to.as_ref();
        storage::rename_path(&self.notes_dir(), from, to)?;
        self.refresh_notes()?;
        self.mark_change(
            Instant::now(),
            format!(
                "langloom: rename \"{}\" to \"{}\"",
                from.display(),
                to.display()
            ),
        );
        Ok(())
    }

    /// Delete a note or folder (recursively) and refresh the note list.
    pub fn delete_note(&mut self, relative: impl AsRef<Path>) -> Result<(), StorageError> {
        let relative = relative.as_ref();
        storage::remove_path(&self.notes_dir(), relative)?;
        self.refresh_notes()?;
        self.mark_change(
            Instant::now(),
            format!("langloom: delete \"{}\"", relative.display()),
        );
        Ok(())
    }

    fn refresh_notes(&mut self) -> Result<(), StorageError> {
        self.notes = storage::scan_notes(&self.notes_dir())?;
        Ok(())
    }

    /// Add a translation preset and persist the translation config.
    pub fn add_preset(&mut self, grid: SyntaxGrid) -> Result<(), StorageError> {
        self.translation.grids.push(grid);
        storage::save_json(
            &self.config_dir().join(storage::TRANSLATION_FILE),
            &self.translation,
        )?;
        self.mark_change(Instant::now(), "langloom: update translation presets");
        Ok(())
    }

    /// Persist the translation configuration.
    pub fn save_translation(&mut self) -> Result<(), StorageError> {
        storage::save_json(
            &self.config_dir().join(storage::TRANSLATION_FILE),
            &self.translation,
        )?;
        self.mark_change(Instant::now(), "langloom: update translation presets");
        Ok(())
    }

    /// The separator and morphology rules the translation view edits.
    pub fn translation_options(&self) -> TranslationOptions {
        TranslationOptions {
            separator: self
                .translation
                .settings
                .get("word_separator")
                .cloned()
                .unwrap_or_else(|| " ".to_string()),
            affixes: self.translation.affixes.clone(),
        }
    }

    /// Replace the separator and morphology rules, then persist.
    pub fn set_translation_options(
        &mut self,
        options: TranslationOptions,
    ) -> Result<(), StorageError> {
        if options.separator.is_empty() {
            self.translation.settings.remove("word_separator");
        } else {
            self.translation
                .settings
                .insert("word_separator".to_string(), options.separator);
        }
        self.translation.affixes = options.affixes;
        self.save_translation()
    }

    /// Insert or replace a translation preset by name, then persist.
    pub fn save_preset(&mut self, grid: SyntaxGrid) -> Result<(), StorageError> {
        match self
            .translation
            .grids
            .iter_mut()
            .find(|existing| existing.preset_name == grid.preset_name)
        {
            Some(existing) => *existing = grid,
            None => self.translation.grids.push(grid),
        }
        self.save_translation()
    }

    /// Delete a translation preset by name, then persist.
    pub fn delete_preset(&mut self, name: &str) -> Result<bool, StorageError> {
        let before = self.translation.grids.len();
        self.translation
            .grids
            .retain(|grid| grid.preset_name != name);
        let removed = self.translation.grids.len() != before;
        if removed {
            self.save_translation()?;
        }
        Ok(removed)
    }

    /// Persist all configuration files.
    pub fn save_config(&mut self) -> Result<(), StorageError> {
        let dir = self.config_dir();
        storage::save_json(&dir.join(storage::LANGUAGE_FILE), &self.language)?;
        storage::save_json(&dir.join(storage::GRAMMAR_FILE), &self.grammar)?;
        storage::save_json(&dir.join(storage::TRANSLATION_FILE), &self.translation)?;
        storage::save_json(&dir.join(storage::SETTINGS_FILE), &self.settings)?;
        self.mark_change(Instant::now(), "langloom: update config");
        Ok(())
    }

    /// Persist the workspace settings file.
    pub fn save_settings(&mut self) -> Result<(), StorageError> {
        storage::save_json(
            &self.config_dir().join(storage::SETTINGS_FILE),
            &self.settings,
        )
    }

    /// The persisted grid presentation state for a table (default empty).
    pub fn grid_view(&self, table: &str) -> GridViewState {
        self.settings
            .grid_views
            .get(table)
            .cloned()
            .unwrap_or_default()
    }

    /// Persist the grid presentation state for a table.
    ///
    /// Presentation-only: does not schedule a content check-in.
    pub fn set_grid_view(&mut self, table: &str, view: GridViewState) -> Result<(), StorageError> {
        if view == GridViewState::default() {
            self.settings.grid_views.remove(table);
        } else {
            self.settings.grid_views.insert(table.to_string(), view);
        }
        self.save_settings()
    }

    /// The persisted shell layout.
    pub fn ui_layout(&self) -> UiLayout {
        self.settings.ui.clone()
    }

    /// Persist the shell layout (activity, panel visibility, inspector dock).
    pub fn set_ui_layout(&mut self, layout: UiLayout) -> Result<(), StorageError> {
        self.settings.ui = layout;
        self.save_settings()
    }

    /// Read a config section (`language`, `grammar`, `translation`, `settings`)
    /// as JSON.
    pub fn config_json(&self, section: &str) -> Result<serde_json::Value, StorageError> {
        let value = match section {
            "language" => serde_json::to_value(&self.language),
            "grammar" => serde_json::to_value(&self.grammar),
            "translation" => serde_json::to_value(&self.translation),
            "settings" => serde_json::to_value(&self.settings),
            other => {
                return Err(StorageError::Config(
                    other.to_string(),
                    "unknown config section".to_string(),
                ))
            }
        };
        value.map_err(|err| StorageError::Config(section.to_string(), err.to_string()))
    }

    /// Replace a config section from JSON and persist it.
    pub fn set_config_json(
        &mut self,
        section: &str,
        value: serde_json::Value,
    ) -> Result<(), StorageError> {
        let dir = self.config_dir();
        let invalid =
            |err: serde_json::Error| StorageError::Config(section.to_string(), err.to_string());
        match section {
            "language" => {
                self.language = serde_json::from_value(value).map_err(invalid)?;
                storage::save_json(&dir.join(storage::LANGUAGE_FILE), &self.language)?;
            }
            "grammar" => {
                self.grammar = serde_json::from_value(value).map_err(invalid)?;
                storage::save_json(&dir.join(storage::GRAMMAR_FILE), &self.grammar)?;
            }
            "translation" => {
                self.translation = serde_json::from_value(value).map_err(invalid)?;
                storage::save_json(&dir.join(storage::TRANSLATION_FILE), &self.translation)?;
            }
            "settings" => {
                self.settings = serde_json::from_value(value).map_err(invalid)?;
                storage::save_json(&dir.join(storage::SETTINGS_FILE), &self.settings)?;
            }
            other => {
                return Err(StorageError::Config(
                    other.to_string(),
                    "unknown config section".to_string(),
                ))
            }
        }
        self.mark_change(Instant::now(), format!("langloom: update {section} config"));
        Ok(())
    }

    // -- undo / redo ----------------------------------------------------

    /// Snapshot the dictionary before a mutation.
    fn record(&mut self) {
        self.history.record(self.dictionary.clone());
    }

    /// Whether an undo step is available.
    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    /// Whether a redo step is available.
    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    /// Restore the previous dictionary snapshot and persist it.
    pub fn undo(&mut self) -> Result<bool, StorageError> {
        let Some(previous) = self.history.undo.pop() else {
            return Ok(false);
        };
        let current = std::mem::replace(&mut self.dictionary, previous);
        self.history.redo.push(current);
        self.persist_dictionary()?;
        self.mark_change(Instant::now(), "langloom: undo");
        Ok(true)
    }

    /// Re-apply the next dictionary snapshot and persist it.
    pub fn redo(&mut self) -> Result<bool, StorageError> {
        let Some(next) = self.history.redo.pop() else {
            return Ok(false);
        };
        let current = std::mem::replace(&mut self.dictionary, next);
        self.history.undo.push(current);
        self.persist_dictionary()?;
        self.mark_change(Instant::now(), "langloom: redo");
        Ok(true)
    }

    /// Write every table to disk and remove files for tables that vanished.
    fn persist_dictionary(&self) -> Result<(), StorageError> {
        let dir = self.dictionary_dir();
        let mut keep = std::collections::HashSet::new();
        for table in self.dictionary.tables() {
            storage::write_table(&dir, table)?;
            keep.insert(storage::table_path(&dir, &table.name));
        }
        for path in storage::list_files(&dir)? {
            if !keep.contains(&path) {
                storage::remove_file(&path)?;
            }
        }
        Ok(())
    }

    // -- check-ins ------------------------------------------------------

    /// Commit all pending changes immediately with an explicit message.
    pub fn checkin(&mut self, message: &str) -> Option<String> {
        self.auto.cancel();
        self.force_checkin(message)
    }

    /// Commit pending changes when the application is closing.
    pub fn close_checkin(&mut self) -> Option<String> {
        self.auto.cancel();
        self.force_checkin("langloom: session check-in")
    }

    /// Persist the "don't show the git prompt again" preference.
    pub fn set_git_prompt_dismissed(&mut self, dismissed: bool) -> Result<(), StorageError> {
        self.settings.git_prompt_dismissed = dismissed;
        self.save_settings()
    }

    /// Whether a one-time warning has been silenced.
    pub fn is_warning_dismissed(&self, key: &str) -> bool {
        self.settings
            .dismissed_warnings
            .iter()
            .any(|item| item == key)
    }

    /// Silence a one-time warning and persist the preference.
    pub fn dismiss_warning(&mut self, key: &str) -> Result<(), StorageError> {
        if !self.is_warning_dismissed(key) {
            self.settings.dismissed_warnings.push(key.to_string());
        }
        self.save_settings()
    }

    /// Commit the pending auto-check-in if the workspace has been idle long
    /// enough. Intended to be called from the UI event loop.
    pub fn pump_auto_checkin(&mut self, now: Instant) -> Option<String> {
        if !self.auto.due(now) {
            return None;
        }
        let message = self.auto.take()?;
        let repo = self.vcs.repo()?;
        repo.commit_all(&message).ok().flatten()
    }

    fn mark_change(&mut self, now: Instant, message: impl Into<String>) {
        if self.settings.auto_checkin && self.vcs.is_ready() {
            self.auto.mark(now, message);
        }
    }

    fn force_checkin(&mut self, message: &str) -> Option<String> {
        let repo = self.vcs.repo()?;
        repo.commit_all(message).ok().flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FieldType, FieldValue};
    use crate::vcs::git_available;
    use crate::WORDNAME_TAG;

    fn sample_workspace(dir: &std::path::Path) -> Workspace {
        let mut ws = Workspace::new(dir).unwrap();
        ws.create_table("all words").unwrap();
        ws.create_table("verbs").unwrap();

        let id = ws.create_entry("all words", "kala").unwrap().unwrap();
        ws.dictionary
            .get_entry_mut("all words", id)
            .unwrap()
            .set("definition", FieldValue::TagList(vec!["to speak".into()]));
        ws.save_entry("all words", id).unwrap();

        ws.add_tag(
            "all words",
            TagDef::new("part of speech", FieldType::TagList),
        )
        .unwrap();
        ws.add_preset(SyntaxGrid {
            preset_name: "Standard SVO".into(),
            slots: vec![],
        })
        .unwrap();
        ws
    }

    #[test]
    fn workspace_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        sample_workspace(dir.path());

        let reloaded = Workspace::load(dir.path()).unwrap();
        assert_eq!(reloaded.dictionary.tables.len(), 2);
        assert!(reloaded
            .dictionary
            .table("all words")
            .unwrap()
            .has_tag("part of speech"));
        assert_eq!(reloaded.dictionary.search("speak").len(), 1);
        assert_eq!(reloaded.translation.grids[0].preset_name, "Standard SVO");
        assert!(dir.path().join("dictionary").join("all_words").is_file());
        assert!(dir.path().join("dictionary").join("verbs").is_file());
    }

    #[test]
    fn sparse_tag_application_writes_only_that_word() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        let a = ws.create_entry("verbs", "kala").unwrap().unwrap();
        ws.create_entry("verbs", "velo").unwrap().unwrap();

        ws.add_tag("verbs", TagDef::new("transitivity", FieldType::Text))
            .unwrap();
        ws.dictionary
            .get_entry_mut("verbs", a)
            .unwrap()
            .set("transitivity", FieldValue::Text("intransitive".into()));
        ws.save_entry("verbs", a).unwrap();

        let reloaded = Workspace::load(dir.path()).unwrap();
        assert!(reloaded
            .dictionary
            .get_entry("verbs", a)
            .unwrap()
            .has("transitivity"));
        let count = reloaded
            .dictionary
            .entries_with_tag("verbs", "transitivity");
        assert_eq!(count.len(), 1);
    }

    #[test]
    fn git_is_opt_in_until_initialized() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        assert!(!ws.vcs.is_ready());
    }

    #[test]
    fn auto_checkin_commits_after_idle() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.init_git().unwrap();
        ws.set_auto_checkin(true, 0);

        ws.create_table("verbs").unwrap();
        ws.create_entry("verbs", "kala").unwrap();

        let committed = ws.pump_auto_checkin(Instant::now() + Duration::from_secs(1));
        assert!(committed.is_some());
        assert!(ws.git().unwrap().is_clean().unwrap());

        let log = ws.git().unwrap().log(10).unwrap();
        assert_eq!(log.len(), 2, "initial commit + one auto check-in");
    }

    #[test]
    fn auto_checkin_disabled_does_not_commit() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.init_git().unwrap();
        ws.set_auto_checkin(false, 0);

        ws.create_table("verbs").unwrap();
        assert!(ws
            .pump_auto_checkin(Instant::now() + Duration::from_secs(1))
            .is_none());
        assert!(!ws.git().unwrap().is_clean().unwrap());
    }

    #[test]
    fn removing_a_tag_commits_a_revertible_message() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.init_git().unwrap();
        ws.set_auto_checkin(true, 0);

        ws.create_table("verbs").unwrap();
        let id = ws.create_entry("verbs", "kala").unwrap().unwrap();
        ws.add_tag("verbs", TagDef::new("transitivity", FieldType::Text))
            .unwrap();
        ws.dictionary
            .get_entry_mut("verbs", id)
            .unwrap()
            .set("transitivity", FieldValue::Text("intransitive".into()));
        ws.save_entry("verbs", id).unwrap();

        let removal = ws.remove_tag("verbs", "transitivity").unwrap().unwrap();
        assert_eq!(removal.affected, 1);
        assert!(ws.git().unwrap().is_clean().unwrap());

        let latest = &ws.git().unwrap().log(1).unwrap()[0];
        assert!(latest.summary.contains("DELETED TAGS"));
        assert!(latest.summary.contains("CAN REVERT"));
    }

    #[test]
    fn create_defined_entry_sets_fields_and_declares_columns() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("lexicon").unwrap();

        let id = ws
            .create_defined_entry("lexicon", "kala", "dog", &["Subject".to_string()])
            .unwrap()
            .unwrap();

        let entry = ws.dictionary.get_entry("lexicon", id).unwrap();
        assert_eq!(entry.definition().unwrap(), ["dog"]);
        assert!(entry.has("Subject"));
        assert!(ws.dictionary.table("lexicon").unwrap().has_tag("Subject"));

        let reloaded = Workspace::load(dir.path()).unwrap();
        let entry = reloaded.dictionary.get_entry("lexicon", id).unwrap();
        assert_eq!(entry.wordname, "kala");
        assert!(entry.has("Subject"));
    }

    #[test]
    fn created_word_completes_a_translation() {
        use crate::model::translate;
        use crate::translation::{ClauseSlot, SyntaxGrid};
        use std::collections::HashMap;

        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("lexicon").unwrap();

        let grid = SyntaxGrid {
            preset_name: "s".into(),
            slots: vec![ClauseSlot::RequiredTag {
                tag: "Subject".into(),
            }],
        };

        let before = translate::translate(&ws.dictionary, &grid, " ", "dog", &HashMap::new(), &[]);
        assert!(!before.complete);

        ws.create_defined_entry("lexicon", "kala", "dog", &["Subject".to_string()])
            .unwrap();

        let after = translate::translate(&ws.dictionary, &grid, " ", "dog", &HashMap::new(), &[]);
        assert!(after.complete);
        assert_eq!(after.output, "kala");
    }

    #[test]
    fn note_crud_refreshes_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();

        ws.create_folder("Grammar").unwrap();
        ws.create_note("Grammar/phonology").unwrap();
        assert_eq!(ws.notes.len(), 1);
        assert_eq!(ws.notes[0].path, PathBuf::from("Grammar/phonology"));

        ws.rename_note("Grammar/phonology", "Grammar/sounds")
            .unwrap();
        assert_eq!(ws.notes[0].path, PathBuf::from("Grammar/sounds"));

        ws.delete_note("Grammar").unwrap();
        assert!(ws.notes.is_empty());
    }

    #[test]
    fn grid_view_state_persists_across_reload() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();

        let view = GridViewState {
            sorting: vec![crate::config::SortSpec {
                id: "wordname".into(),
                desc: true,
            }],
            search: "ka".into(),
            hidden_columns: vec!["parent".into()],
            ..Default::default()
        };
        ws.set_grid_view("verbs", view.clone()).unwrap();

        let reloaded = Workspace::load(dir.path()).unwrap();
        assert_eq!(reloaded.grid_view("verbs"), view);
        assert_eq!(reloaded.grid_view("missing"), GridViewState::default());
    }

    #[test]
    fn set_tag_kind_migrates_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        let id = ws.create_entry("verbs", "kala").unwrap().unwrap();
        ws.add_tag("verbs", TagDef::new("flag", FieldType::Text))
            .unwrap();
        ws.dictionary
            .get_entry_mut("verbs", id)
            .unwrap()
            .set("flag", FieldValue::Text("yes".into()));
        ws.save_entry("verbs", id).unwrap();

        let change = ws
            .set_tag_kind("verbs", "flag", FieldType::Boolean)
            .unwrap()
            .unwrap();
        assert_eq!(change.affected, 1);
        assert_eq!(change.dropped, 0);
        assert!(ws
            .set_tag_kind("verbs", WORDNAME_TAG, FieldType::Boolean)
            .unwrap()
            .is_none());

        let reloaded = Workspace::load(dir.path()).unwrap();
        assert_eq!(
            reloaded
                .dictionary
                .get_entry("verbs", id)
                .unwrap()
                .get("flag"),
            Some(&FieldValue::Boolean(true))
        );
    }

    #[test]
    fn set_parent_only_replaces_and_guards_cycles() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("words").unwrap();
        let root = ws.create_entry("words", "root").unwrap().unwrap();
        let other = ws.create_entry("words", "other").unwrap().unwrap();
        let child = ws.create_entry("words", "child").unwrap().unwrap();

        ws.add_parent("words", child, root).unwrap();
        assert!(ws.set_parent_only("words", child, other).unwrap());
        assert_eq!(ws.dictionary.parents_of(child), vec![other]);

        // A word cannot become the parent of its own descendant.
        let grandchild = ws.create_entry("words", "grandchild").unwrap().unwrap();
        ws.add_parent("words", grandchild, child).unwrap();
        assert!(!ws.set_parent_only("words", child, grandchild).unwrap());
    }

    #[test]
    fn translation_options_persist() {
        use crate::config::{AffixKind, AffixRule};

        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.set_translation_options(TranslationOptions {
            separator: "".into(),
            affixes: vec![AffixRule {
                kind: AffixKind::Suffix,
                english: "s".into(),
                conlang: "i".into(),
            }],
        })
        .unwrap();

        let reloaded = Workspace::load(dir.path()).unwrap();
        let options = reloaded.translation_options();
        assert_eq!(options.separator, " ", "empty separator resets to default");
        assert_eq!(options.affixes.len(), 1);
        assert_eq!(options.affixes[0].conlang, "i");
    }

    #[test]
    fn git_prompt_dismissal_persists() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        assert!(!ws.settings.git_prompt_dismissed);
        ws.set_git_prompt_dismissed(true).unwrap();

        let reloaded = Workspace::load(dir.path()).unwrap();
        assert!(reloaded.settings.git_prompt_dismissed);
    }

    #[test]
    fn close_checkin_commits_pending_changes() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.init_git().unwrap();
        ws.set_auto_checkin(false, 60);
        ws.create_table("verbs").unwrap();

        assert!(ws.close_checkin().is_some());
        assert!(ws.git().unwrap().is_clean().unwrap());
    }

    #[test]
    fn config_sections_round_trip_through_json() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();

        let mut value = ws.config_json("language").unwrap();
        value["name"] = serde_json::json!("Kalan");
        ws.set_config_json("language", value).unwrap();
        assert_eq!(ws.config_json("language").unwrap()["name"], "Kalan");

        let grammar = serde_json::json!({
            "rules": [{
                "name": "SVO",
                "description": "",
                "slots": [{ "kind": "required_tag", "tag": "Subject" }]
            }]
        });
        ws.set_config_json("grammar", grammar).unwrap();
        assert_eq!(ws.grammar.rules.len(), 1);

        assert!(ws.config_json("nope").is_err());
        assert!(ws.set_config_json("nope", serde_json::json!({})).is_err());
    }

    #[test]
    fn undo_and_redo_restore_dictionary_and_persist() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        ws.create_entry("verbs", "kala").unwrap();
        assert!(ws.can_undo());
        assert!(!ws.can_redo());

        assert!(ws.undo().unwrap());
        assert!(ws.dictionary.table("verbs").unwrap().entries.is_empty());
        assert!(ws.can_redo());

        assert!(ws.redo().unwrap());
        assert_eq!(ws.dictionary.table("verbs").unwrap().entries.len(), 1);

        let reloaded = Workspace::load(dir.path()).unwrap();
        assert_eq!(reloaded.dictionary.table("verbs").unwrap().entries.len(), 1);
    }

    #[test]
    fn undo_restores_a_deleted_table_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        ws.delete_table("verbs").unwrap();
        assert!(ws.dictionary.table("verbs").is_none());

        assert!(ws.undo().unwrap());
        assert!(ws.dictionary.table("verbs").is_some());
        let reloaded = Workspace::load(dir.path()).unwrap();
        assert!(reloaded.dictionary.table("verbs").is_some());
    }

    #[test]
    fn rename_table_moves_contents_and_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        ws.create_entry("verbs", "kala").unwrap();

        assert!(ws.rename_table("verbs", "actions").unwrap());
        assert!(ws.dictionary.table("verbs").is_none());
        let table = ws.dictionary.table("actions").unwrap();
        assert_eq!(table.name, "actions");
        assert_eq!(table.entries.len(), 1);

        // Old backing file is gone; new one exists and reloads with words.
        assert!(!dir.path().join("dictionary").join("verbs").exists());
        assert!(dir.path().join("dictionary").join("actions").exists());
        let reloaded = Workspace::load(dir.path()).unwrap();
        assert_eq!(
            reloaded.dictionary.table("actions").unwrap().entries.len(),
            1
        );

        // Rejects collisions and unknown sources.
        ws.create_table("nouns").unwrap();
        assert!(!ws.rename_table("actions", "nouns").unwrap());
        assert!(!ws.rename_table("missing", "x").unwrap());
    }

    #[test]
    fn ui_layout_persists() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        assert_eq!(ws.ui_layout(), UiLayout::default());

        ws.set_ui_layout(UiLayout {
            activity: "dictionary".into(),
            sidebar_open: false,
            inspector_open: true,
            inspector_dock: "left".into(),
        })
        .unwrap();

        let reloaded = Workspace::load(dir.path()).unwrap();
        let layout = reloaded.ui_layout();
        assert_eq!(layout.activity, "dictionary");
        assert!(!layout.sidebar_open);
        assert!(layout.inspector_open);
        assert_eq!(layout.inspector_dock, "left");
    }

    #[test]
    fn open_rejects_missing_directory_without_creating_it() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone");

        assert!(matches!(
            Workspace::open(&missing),
            Err(StorageError::NotFound(_))
        ));
        assert!(!missing.exists(), "open must not scaffold a missing dir");
    }

    #[test]
    fn open_loads_an_existing_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("nouns").unwrap();

        let opened = Workspace::open(dir.path()).unwrap();
        assert!(opened.dictionary.tables.contains_key("nouns"));
    }
}
