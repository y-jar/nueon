//! A user-designated workspace directory: tables, notes, and config.

mod note;
mod storage;

pub use note::NoteFile;
pub use storage::{StorageError, CONFIG_DIR, DICTIONARY_DIR, NOTES_DIR};

use std::path::PathBuf;
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::config::{GrammarConfig, LanguageConfig, TranslationConfig, WorkspaceSettings};
use crate::model::{
    Dictionary, FieldType, FieldValue, TagDef, TagRemoval, WordEntry, DEFINITION_TAG,
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
        })
    }

    /// Load an existing workspace, creating the layout if it is missing.
    pub fn load(root_path: impl Into<PathBuf>) -> Result<Self, StorageError> {
        let root_path = root_path.into();
        storage::ensure_dirs(&root_path)?;
        storage::ensure_gitignore(&root_path)?;

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
        if !self.dictionary.add_table(name) {
            return Ok(false);
        }
        self.save_table(name)?;
        self.mark_change(Instant::now(), format!("langjar: create table \"{name}\""));
        Ok(true)
    }

    /// Delete a table and its backing file.
    pub fn delete_table(&mut self, name: &str) -> Result<bool, StorageError> {
        if self.dictionary.remove_table(name).is_none() {
            return Ok(false);
        }
        storage::delete_table(&self.dictionary_dir(), name)?;
        self.mark_change(Instant::now(), format!("langjar: delete table \"{name}\""));
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
        self.mark_change(Instant::now(), format!("langjar: edit table \"{table}\""));
        Ok(())
    }

    // -- words ----------------------------------------------------------

    /// Create and persist a new word in a table.
    pub fn create_entry(
        &mut self,
        table: &str,
        wordname: impl Into<String>,
    ) -> Result<Option<Uuid>, StorageError> {
        let entry = WordEntry::new(wordname);
        let id = entry.id;
        let wordname = entry.wordname.clone();
        if self.dictionary.add_entry(table, entry).is_none() {
            return Ok(None);
        }
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("langjar: add word \"{wordname}\" to table \"{table}\""),
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
            format!("langjar: add word \"{wordname}\" (from translation) to table \"{table}\""),
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
            format!("langjar: update word \"{wordname}\" in table \"{table}\""),
        );
        Ok(true)
    }

    /// Remove a word from its table and persist the change.
    pub fn delete_entry(
        &mut self,
        table: &str,
        id: Uuid,
    ) -> Result<Option<WordEntry>, StorageError> {
        let removed = match self.dictionary.remove_entry(table, id) {
            Some(entry) => entry,
            None => return Ok(None),
        };
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!(
                "langjar: delete word \"{}\" from table \"{table}\"",
                removed.wordname
            ),
        );
        Ok(Some(removed))
    }

    // -- tags -----------------------------------------------------------

    /// Add a column to a table.
    pub fn add_tag(&mut self, table: &str, tag: TagDef) -> Result<bool, StorageError> {
        let name = tag.name.clone();
        if !self.dictionary.add_tag(table, tag) {
            return Ok(false);
        }
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("langjar: add tag \"{name}\" to table \"{table}\""),
        );
        Ok(true)
    }

    /// How many words would lose a value if `tag` were removed.
    pub fn preview_remove_tag(&self, table: &str, tag: &str) -> usize {
        self.dictionary.entries_with_tag(table, tag).len()
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
        let removal = match self.dictionary.remove_tag(table, tag) {
            Some(removal) => removal,
            None => return Ok(None),
        };
        self.save_table(table)?;
        let message = format!(
            "langjar: DELETED TAGS: {table}.{tag} ({} words) <CAN REVERT>",
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
            format!("langjar: update note \"{}\"", note.path.display()),
        );
        Ok(())
    }

    /// Add a translation preset and persist the translation config.
    pub fn add_preset(&mut self, grid: SyntaxGrid) -> Result<(), StorageError> {
        self.translation.grids.push(grid);
        storage::save_json(
            &self.config_dir().join(storage::TRANSLATION_FILE),
            &self.translation,
        )?;
        self.mark_change(Instant::now(), "langjar: update translation presets");
        Ok(())
    }

    /// Persist the translation configuration.
    pub fn save_translation(&mut self) -> Result<(), StorageError> {
        storage::save_json(
            &self.config_dir().join(storage::TRANSLATION_FILE),
            &self.translation,
        )?;
        self.mark_change(Instant::now(), "langjar: update translation presets");
        Ok(())
    }

    /// Persist all configuration files.
    pub fn save_config(&mut self) -> Result<(), StorageError> {
        let dir = self.config_dir();
        storage::save_json(&dir.join(storage::LANGUAGE_FILE), &self.language)?;
        storage::save_json(&dir.join(storage::GRAMMAR_FILE), &self.grammar)?;
        storage::save_json(&dir.join(storage::TRANSLATION_FILE), &self.translation)?;
        storage::save_json(&dir.join(storage::SETTINGS_FILE), &self.settings)?;
        self.mark_change(Instant::now(), "langjar: update config");
        Ok(())
    }

    // -- check-ins ------------------------------------------------------

    /// Commit all pending changes immediately with an explicit message.
    pub fn checkin(&mut self, message: &str) -> Option<String> {
        self.auto.cancel();
        self.force_checkin(message)
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

        let before = translate::translate(&ws.dictionary, &grid, " ", "dog", &HashMap::new());
        assert!(!before.complete);

        ws.create_defined_entry("lexicon", "kala", "dog", &["Subject".to_string()])
            .unwrap();

        let after = translate::translate(&ws.dictionary, &grid, " ", "dog", &HashMap::new());
        assert!(after.complete);
        assert_eq!(after.output, "kala");
    }
}
