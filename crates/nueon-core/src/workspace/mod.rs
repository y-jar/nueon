//! A user-designated workspace directory: tables, notes, and config.

mod assets;
mod entries;
mod lifecycle;
mod note;
mod notes;
mod settings;
mod storage;
mod table_files;
mod tables;
mod tags;
mod translation;
mod trash;

pub use assets::{AssetKind, ImportedAsset, ASSETS_DIR};
pub use note::NoteFile;
pub use storage::{StorageError, CONFIG_DIR, DICTIONARY_DIR, NOTES_DIR};
pub use table_files::QuarantineWarning;
pub use trash::{Restored, TrashKind, TrashRecord, RETENTION_DAYS, TRASH_DIR};

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use uuid::Uuid;

use self::table_files::TableFiles;

use crate::config::{
    AffixRule, GrammarConfig, GridViewState, LanguageConfig, LayoutState, MorphemeRef, Morphology,
    PhonologyConfig, Profile, TableRole, TableRoleConfig, TilingLayout, TranslationConfig,
    TranslationMode, TranslationOptions, UiLayout, WindowGeometry, WorkspaceSettings,
};
use crate::export_table::TableFormat;
use crate::model::translate::{dictionary_affixes, dictionary_morphemes, Morpheme};
use crate::model::{
    Dictionary, FieldType, FieldValue, TagDef, TagFormat, TagKindChange, TagRemoval, WordEntry,
    DEFINITION_TAG, WORDNAME_TAG,
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
    /// Phoneme inventory and syllable shapes.
    pub phonology: PhonologyConfig,
    /// User settings.
    pub settings: WorkspaceSettings,
    /// Detected version-control state.
    pub vcs: GitStatus,
    /// Resolved, stable filenames for every table (see [`table_files`]).
    table_files: TableFiles,
    /// Files under `dictionary/` that exist but could not be loaded.
    pub quarantine: Vec<QuarantineWarning>,
    auto: AutoCheckin,
    history: History,
}

/// A bounded stack of whole-dictionary snapshots for undo/redo.
#[derive(Debug)]
pub(crate) struct History {
    undo: Vec<Dictionary>,
    redo: Vec<Dictionary>,
}

impl History {
    /// Maximum number of retained undo snapshots.
    const LIMIT: usize = 50;

    pub(crate) fn new() -> Self {
        Self {
            undo: Vec::new(),
            redo: Vec::new(),
        }
    }

    pub(crate) fn record(&mut self, snapshot: Dictionary) {
        self.undo.push(snapshot);
        if self.undo.len() > Self::LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    pub(crate) fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub(crate) fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
}

impl Workspace {
    // -- undo / redo ----------------------------------------------------

    /// Snapshot the dictionary before a mutation.
    pub(crate) fn record(&mut self) {
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
        // Touch the disk first: if that fails the snapshot goes back on the
        // stack and memory is unchanged.
        let before = self.dictionary.clone();
        if let Err(err) = self.write_dictionary_diff(&before, &previous) {
            self.history.undo.push(previous);
            return Err(err);
        }
        let current = std::mem::replace(&mut self.dictionary, previous);
        self.history.redo.push(current);
        self.mark_change(Instant::now(), "nueon: undo");
        Ok(true)
    }

    /// Re-apply the next dictionary snapshot and persist it.
    pub fn redo(&mut self) -> Result<bool, StorageError> {
        let Some(next) = self.history.redo.pop() else {
            return Ok(false);
        };
        let before = self.dictionary.clone();
        if let Err(err) = self.write_dictionary_diff(&before, &next) {
            self.history.redo.push(next);
            return Err(err);
        }
        let current = std::mem::replace(&mut self.dictionary, next);
        self.history.undo.push(current);
        self.mark_change(Instant::now(), "nueon: redo");
        Ok(true)
    }

    /// Bring the table files in line with a restored snapshot by touching
    /// **only the tables that differ** between `before` and `after`.
    ///
    /// Undo and redo own exactly the table files the app has written. They
    /// never list `dictionary/`, so a README, a `.tmp` leftover, a hand-edited
    /// table they did not change, or any other file is left strictly alone.
    /// Filenames are never recomputed: an unchanged name reuses its existing
    /// file, and a name reappearing after a delete resolves a fresh one only
    /// because its old mapping was released when it was removed.
    pub(crate) fn write_dictionary_diff(
        &mut self,
        before: &Dictionary,
        after: &Dictionary,
    ) -> Result<(), StorageError> {
        let dir = self.dictionary_dir();
        for table in after.tables() {
            if before.table(&table.name) != Some(table) {
                let filename = match self.table_files.filename(&table.name) {
                    Some(filename) => filename.to_string(),
                    None => self.table_files.resolve_new(&table.name),
                };
                storage::write_table_file(&dir.join(filename), table)?;
                // Brought back: a trash copy of this exact table is redundant.
                trash::consume_table(&self.root_path, table);
            }
        }
        for table in before.tables() {
            if after.table(&table.name).is_none() {
                let Some(filename) = self.table_files.remove(&table.name) else {
                    continue;
                };
                // An empty table undone/redone away (typically straight after
                // its own creation) is not worth a trash entry: there is
                // nothing in it to lose, and it would otherwise clutter the
                // trash on every "create table" + Ctrl+Z.
                if table.entries.is_empty() {
                    let _ = storage::remove_silently(&dir.join(&filename));
                    continue;
                }
                // Even undo/redo never deletes a table file outright: it goes
                // to the trash, where it can still be restored.
                let file = dir.join(&filename);
                trash::trash_table(&self.root_path, table, &file)?;
            }
        }
        Ok(())
    }

    // -- check-ins ------------------------------------------------------

    /// Commit all pending changes immediately with an explicit message.
    pub fn checkin(&mut self, message: &str) -> Result<Option<String>, VcsError> {
        self.auto.cancel();
        self.force_checkin(message)
    }

    /// Commit pending changes when the application is closing.
    pub fn close_checkin(&mut self) -> Result<Option<String>, VcsError> {
        self.auto.cancel();
        self.force_checkin("nueon: session check-in")
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

    /// Confirm-dialog kinds the user asked not to see again.
    pub fn suppressed_confirms(&self) -> Vec<String> {
        self.settings.suppressed_confirms.clone()
    }

    /// Whether a confirm kind has been silenced.
    pub fn is_confirm_suppressed(&self, kind: &str) -> bool {
        self.settings
            .suppressed_confirms
            .iter()
            .any(|item| item == kind)
    }

    /// Silence a confirm kind and persist the preference.
    pub fn suppress_confirm(&mut self, kind: &str) -> Result<(), StorageError> {
        if !self.is_confirm_suppressed(kind) {
            self.settings.suppressed_confirms.push(kind.to_string());
        }
        self.save_settings()
    }

    /// Un-silence one confirm kind, or every kind when `kind` is `None`.
    pub fn unsuppress_confirm(&mut self, kind: Option<&str>) -> Result<(), StorageError> {
        match kind {
            Some(kind) => self
                .settings
                .suppressed_confirms
                .retain(|item| item != kind),
            None => self.settings.suppressed_confirms.clear(),
        }
        self.save_settings()
    }

    /// Whether the Markdown editor shows line numbers.
    pub fn editor_line_numbers(&self) -> bool {
        self.settings.editor_line_numbers
    }

    /// Persist the editor's line-number preference.
    pub fn set_editor_line_numbers(&mut self, show: bool) -> Result<(), StorageError> {
        self.settings.editor_line_numbers = show;
        self.save_settings()
    }

    /// Commit the pending auto-check-in if the workspace has been idle long
    /// enough. Intended to be called from the UI event loop.
    pub fn pump_auto_checkin(&mut self, now: Instant) -> Result<Option<String>, VcsError> {
        if !self.auto.due(now) {
            return Ok(None);
        }
        let Some(message) = self.auto.take() else {
            return Ok(None);
        };
        let Some(repo) = self.vcs.repo() else {
            return Ok(None);
        };
        repo.commit_all(&message)
    }

    pub(crate) fn mark_change(&mut self, now: Instant, message: impl Into<String>) {
        if self.settings.auto_checkin && self.vcs.is_ready() {
            self.auto.mark(now, message);
        }
    }

    pub(crate) fn force_checkin(&mut self, message: &str) -> Result<Option<String>, VcsError> {
        match self.vcs.repo() {
            Some(repo) => repo.commit_all(message),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AffixKind, GridViewState, MorphemeRef, Paradigm, ParadigmRow, Phoneme, PhonemeKind,
        PhonologyConfig, TableRole, POS_TAG,
    };
    use crate::model::{FieldType, FieldValue};
    use crate::vcs::git_available;
    use crate::WORDNAME_TAG;
    use std::collections::BTreeMap;

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

        let committed = ws
            .pump_auto_checkin(Instant::now() + Duration::from_secs(1))
            .unwrap();
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
            .unwrap()
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
    fn loading_never_renames_files() {
        let dir = tempfile::tempdir().unwrap();
        drop(Workspace::new(dir.path()).unwrap());
        let notes = dir.path().join("notes");
        std::fs::write(notes.join("extensionless"), "hello").unwrap();
        std::fs::write(notes.join("old.txt"), "world").unwrap();

        let ws = Workspace::load(dir.path()).unwrap();
        // Names are preserved exactly; nothing is converted to `.md`.
        assert!(notes.join("extensionless").exists());
        assert!(notes.join("old.txt").exists());
        assert!(!notes.join("old.md").exists());
        assert_eq!(ws.notes.len(), 2);
    }

    #[test]
    fn reload_picks_up_files_changed_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        ws.create_note("n").unwrap();
        assert!(ws.can_undo());

        // A checkout replaces files behind the app's back.
        let mut other = Workspace::load(dir.path()).unwrap();
        other.create_table("nouns").unwrap();
        std::fs::write(dir.path().join("notes/n.md"), "from disk").unwrap();

        ws.reload_disk_state().unwrap();
        assert!(ws.dictionary.table("nouns").is_some());
        assert_eq!(ws.read_note("n.md").unwrap(), "from disk");
        assert!(!ws.can_undo());
    }

    /// Entry directories under `.trash/`.
    fn trash_entries(root: &std::path::Path) -> Vec<std::path::PathBuf> {
        let Ok(read) = std::fs::read_dir(root.join(".trash")) else {
            return Vec::new();
        };
        let mut entries: Vec<_> = read
            .map(|e| e.unwrap().path())
            .filter(|p| p.is_dir())
            .collect();
        entries.sort();
        entries
    }

    #[test]
    fn deleting_a_note_moves_it_to_trash_with_a_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_note("lore/intro").unwrap();
        ws.save_note(&NoteFile::new("lore/intro.md", "precious"))
            .unwrap();

        ws.delete_note("lore/intro.md").unwrap();

        assert!(!dir.path().join("notes/lore/intro.md").exists());
        let entries = trash_entries(dir.path());
        assert_eq!(entries.len(), 1, "exactly one trash entry");
        let manifest = std::fs::read_to_string(entries[0].join("manifest.json")).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(manifest["kind"], "note");
        assert_eq!(manifest["original"], "lore/intro.md");
        // The content is preserved byte for byte.
        assert_eq!(
            std::fs::read_to_string(entries[0].join("item")).unwrap(),
            "precious"
        );
    }

    fn git_ok() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    fn git_out(root: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn auto_checkin_never_commits_trash_contents() {
        if !git_ok() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.init_git().unwrap();
        ws.create_note("keep").unwrap();
        ws.create_note("doomed").unwrap();
        ws.create_table("verbs").unwrap();
        ws.checkin("nueon: baseline").unwrap();

        ws.delete_note("doomed.md").unwrap();
        ws.delete_table("verbs").unwrap();
        assert!(!trash_entries(dir.path()).is_empty());
        ws.checkin("nueon: after deletes").unwrap();
        // Trash again after a commit, then commit again.
        ws.create_note("second").unwrap();
        ws.delete_note("second.md").unwrap();
        ws.checkin("nueon: after more deletes").unwrap();

        let tracked = git_out(dir.path(), &["ls-files"]);
        assert!(!tracked.contains(".trash"), "tracked files: {tracked}");
        let history = git_out(dir.path(), &["log", "--name-only", "--pretty=format:"]);
        assert!(
            !history.contains(".trash"),
            "history touched .trash: {history}"
        );
        let status = git_out(dir.path(), &["status", "--porcelain"]);
        assert!(!status.contains(".trash"), "status shows .trash: {status}");
        // The deletions themselves are committed as deletions.
        assert!(!tracked.contains("doomed.md"));
        assert!(tracked.contains("keep.md"));
    }

    #[test]
    fn deleting_a_table_trashes_it_and_dictionary_undo_restores_it_without_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        let id = ws.create_entry("verbs", "kala").unwrap().unwrap();

        let record = ws.delete_table("verbs").unwrap().expect("table existed");
        assert_eq!(record.kind, TrashKind::Table);
        assert!(!dir.path().join("dictionary/verbs").exists());
        assert_eq!(trash_entries(dir.path()).len(), 1);
        assert!(ws.delete_table("verbs").unwrap().is_none());

        // Undo is an ordinary dictionary step and drops the redundant copy.
        assert!(ws.undo().unwrap());
        assert!(dir.path().join("dictionary/verbs").exists());
        assert!(ws
            .dictionary
            .table("verbs")
            .unwrap()
            .entries
            .iter()
            .any(|e| e.id == id));
        assert!(
            trash_entries(dir.path()).is_empty(),
            "no duplicate left in the trash"
        );

        // Redo deletes again, and even that goes to the trash, not nowhere.
        assert!(ws.redo().unwrap());
        assert!(!dir.path().join("dictionary/verbs").exists());
        assert_eq!(trash_entries(dir.path()).len(), 1);
        let restored = Workspace::load(dir.path()).unwrap();
        assert!(restored.dictionary.table("verbs").is_none());
        assert_eq!(restored.list_trash().len(), 1);
    }

    #[test]
    fn restoring_a_trashed_table_is_undoable_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        ws.create_entry("verbs", "kala").unwrap();
        let record = ws.delete_table("verbs").unwrap().unwrap();

        // A new table took the name in the meantime.
        ws.create_table("verbs").unwrap();
        ws.create_entry("verbs", "newer").unwrap();

        let restored = ws.restore_trash(&record.id).unwrap();
        assert_eq!(restored.name, "verbs (restored)");
        assert_eq!(
            ws.dictionary.table("verbs").unwrap().entries[0].wordname,
            "newer"
        );
        assert_eq!(
            ws.dictionary.table("verbs (restored)").unwrap().entries[0].wordname,
            "kala"
        );
        assert!(ws.list_trash().is_empty());

        assert!(ws.undo().unwrap(), "restoring is an undoable step");
        assert!(ws.dictionary.table("verbs (restored)").is_none());
    }

    #[test]
    fn deleting_and_restoring_notes_and_folders_through_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_folder("lore").unwrap();
        ws.create_note_with_content("lore/a", "A").unwrap();
        ws.create_note_with_content("lore/b", "B").unwrap();
        assert_eq!(ws.count_notes("lore").unwrap(), 2);

        let record = ws.delete_note("lore").unwrap();
        assert_eq!((record.kind, record.count), (TrashKind::Folder, 2));
        assert!(ws.notes.is_empty());
        assert!(
            ws.delete_note("").is_err(),
            "the notes root cannot be deleted"
        );
        assert!(ws.delete_note("../x").is_err());

        // Something now sits at the original path: restore beside it.
        ws.create_folder("lore").unwrap();
        let restored = ws.restore_trash(&record.id).unwrap();
        assert_eq!(restored.name, "lore (restored)");
        assert_eq!(ws.read_note("lore (restored)/b.md").unwrap(), "B");
        assert!(ws.list_trash().is_empty());
    }

    #[test]
    fn opening_a_workspace_prunes_expired_trash_only() {
        let dir = tempfile::tempdir().unwrap();
        drop(Workspace::new(dir.path()).unwrap());
        let trash = dir.path().join(".trash");
        let now = super::trash::now_secs();
        let old = format!("{}-{}", now - 31 * 86_400, "e".repeat(32));
        let fresh = format!("{}-{}", now - 86_400, "f".repeat(32));
        super::trash::write_entry_for_test(dir.path(), &old, "note", "old.md", b"o");
        super::trash::write_entry_for_test(dir.path(), &fresh, "note", "fresh.md", b"f");
        std::fs::create_dir_all(trash.join("not-an-entry")).unwrap();
        std::fs::write(trash.join("not-an-entry/keep"), "k").unwrap();

        drop(Workspace::load(dir.path()).unwrap());

        assert!(!trash.join(&old).exists());
        assert!(trash.join(&fresh).exists());
        assert!(trash.join("not-an-entry/keep").exists());
    }

    #[test]
    fn gitignore_excludes_trash_and_never_clobbers_user_lines() {
        let dir = tempfile::tempdir().unwrap();
        // A new workspace ignores the trash from the start.
        let ws = Workspace::new(dir.path().join("fresh")).unwrap();
        let fresh = std::fs::read_to_string(ws.root_path.join(".gitignore")).unwrap();
        assert!(fresh.lines().any(|l| l.trim() == ".trash/"));

        // An existing workspace keeps its own lines and gains `.trash/`.
        let existing = dir.path().join("existing");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join(".gitignore"), "# mine\nsecret/\n*.tmp").unwrap();
        drop(Workspace::load(&existing).unwrap());
        let text = std::fs::read_to_string(existing.join(".gitignore")).unwrap();
        assert!(text.starts_with("# mine\nsecret/\n*.tmp\n"));
        assert_eq!(text.lines().filter(|l| l.trim() == ".trash/").count(), 1);

        // Opening again does not append it twice.
        drop(Workspace::load(&existing).unwrap());
        let again = std::fs::read_to_string(existing.join(".gitignore")).unwrap();
        assert_eq!(again.lines().filter(|l| l.trim() == ".trash/").count(), 1);
    }

    #[test]
    fn config_set_settings_is_rejected_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.set_grid_view(
            "verbs",
            GridViewState {
                search: "keep me".into(),
                ..Default::default()
            },
        )
        .unwrap_or(());
        let before = std::fs::read(dir.path().join("config/settings")).ok();

        let wipe = serde_json::json!({ "auto_checkin": false });
        assert!(ws.set_config_json("settings", wipe).is_err());
        assert_eq!(
            std::fs::read(dir.path().join("config/settings")).ok(),
            before
        );
        assert!(ws.settings.auto_checkin);
    }

    #[test]
    fn renaming_a_table_to_a_case_or_punctuation_variant_keeps_its_file() {
        for (from, to) in [("Roots", "roots"), ("a b", "a_b")] {
            let dir = tempfile::tempdir().unwrap();
            let mut ws = Workspace::new(dir.path()).unwrap();
            ws.create_table(from).unwrap();
            let id = ws.create_entry(from, "kala").unwrap().unwrap();

            assert!(ws.rename_table(from, to).unwrap());

            // The table's file must still exist and still hold its words.
            let reloaded = Workspace::load(dir.path()).unwrap();
            let table = reloaded.dictionary.table(to).unwrap_or_else(|| {
                panic!("table {to:?} vanished from disk after renaming {from:?}")
            });
            assert!(table.entries.iter().any(|e| e.id == id));
        }
    }

    #[test]
    fn undoing_a_slug_variant_rename_keeps_the_tables_file() {
        for (from, to) in [("Roots", "roots"), ("a b", "a_b")] {
            let dir = tempfile::tempdir().unwrap();
            let mut ws = Workspace::new(dir.path()).unwrap();
            ws.create_table(from).unwrap();
            let id = ws.create_entry(from, "kala").unwrap().unwrap();
            ws.rename_table(from, to).unwrap();

            assert!(ws.undo().unwrap()); // back to the original name

            let reloaded = Workspace::load(dir.path()).unwrap();
            let table = reloaded.dictionary.table(from).unwrap_or_else(|| {
                panic!("table {from:?} vanished from disk after undoing the rename")
            });
            assert!(table.entries.iter().any(|e| e.id == id));
        }
    }

    #[test]
    fn undo_and_redo_only_touch_files_they_own() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        ws.create_table("nouns").unwrap();
        ws.create_entry("verbs", "kala").unwrap();

        // Files the app does not own live in dictionary/ too.
        let unknown = dir.path().join("dictionary/README.txt");
        let stray = dir.path().join("dictionary/verbs_old.tmp");
        std::fs::write(&unknown, "notes about the dictionary").unwrap();
        std::fs::write(&stray, "half-written").unwrap();

        // A table the app is not undoing, edited by hand on disk.
        let nouns_before = std::fs::read(dir.path().join("dictionary/nouns")).unwrap();

        assert!(ws.undo().unwrap()); // un-add "kala"
        assert!(ws.undo().unwrap()); // un-create "nouns" (deletes its file)
        assert!(ws.redo().unwrap());
        assert!(ws.redo().unwrap());

        assert_eq!(
            std::fs::read_to_string(&unknown).unwrap(),
            "notes about the dictionary"
        );
        assert_eq!(std::fs::read_to_string(&stray).unwrap(), "half-written");
        assert_eq!(
            std::fs::read(dir.path().join("dictionary/nouns")).unwrap(),
            nouns_before
        );
        assert_eq!(ws.dictionary.table("verbs").unwrap().entries.len(), 1);
    }

    #[test]
    fn undo_does_not_rewrite_tables_it_did_not_change() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        ws.create_table("nouns").unwrap();
        ws.create_entry("verbs", "kala").unwrap();

        // Someone edits an unrelated table's file by hand.
        let nouns = dir.path().join("dictionary/nouns");
        std::fs::write(&nouns, r#"{"name":"nouns","tags":[],"entries":[]}  "#).unwrap();
        let hand_edited = std::fs::read(&nouns).unwrap();

        assert!(ws.undo().unwrap()); // only "verbs" changes
        assert_eq!(std::fs::read(&nouns).unwrap(), hand_edited);
    }

    #[test]
    fn failed_reload_leaves_memory_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        ws.create_note("n").unwrap();
        ws.language.name = "In Memory".into();

        // Disk now disagrees with memory everywhere, and one config file is
        // unreadable, so the reload must fail without applying any of it.
        let config = dir.path().join("config");
        std::fs::write(config.join("language"), r#"{"name":"On Disk"}"#).unwrap();
        std::fs::write(config.join("grammar"), "{ not json").unwrap();
        std::fs::write(dir.path().join("notes/n.md"), "from disk").unwrap();
        std::fs::write(dir.path().join("dictionary/extra"), r#"{"name":"extra"}"#).unwrap();

        assert!(ws.reload_disk_state().is_err());
        assert_eq!(ws.language.name, "In Memory");
        assert!(ws.dictionary.table("extra").is_none());
        assert!(ws.dictionary.table("verbs").is_some());
        assert!(ws.can_undo(), "history survives a failed reload");
    }

    #[test]
    fn unreadable_dictionary_file_is_quarantined_not_fatal_on_reload() {
        // A stray unreadable file in dictionary/ must never stop a reload
        // (e.g. after a git checkout): it is reported and left alone, and
        // every good table still loads.
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        ws.create_note("n").unwrap();

        std::fs::write(dir.path().join("dictionary/broken"), "{ not json").unwrap();
        std::fs::write(dir.path().join("notes/n.md"), "from disk").unwrap();
        let broken_before = std::fs::read(dir.path().join("dictionary/broken")).unwrap();

        ws.reload_disk_state().unwrap();
        assert!(ws.dictionary.table("verbs").is_some());
        assert_eq!(ws.notes.len(), 1);
        assert_eq!(ws.notes[0].raw_content, "from disk");
        assert_eq!(ws.quarantine.len(), 1);
        assert_eq!(ws.quarantine[0].file_name, "broken");
        assert_eq!(
            std::fs::read(dir.path().join("dictionary/broken")).unwrap(),
            broken_before,
            "the bad file is never touched"
        );
        // Reload clears undo history (its snapshots predate the disk change).
        assert!(!ws.can_undo());
    }

    #[test]
    fn whole_entry_replace_from_a_stale_view_clobbers_a_newer_field() {
        // This documents *why* field-level patches exist: two editors (Grid
        // and Inspector) each hold their own snapshot of a word. If "save"
        // means "overwrite the whole entry", the second save to land always
        // wins completely, discarding the first save's field even though it
        // was never touched by the second editor.
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        let id = ws.create_entry("verbs", "kala").unwrap().unwrap();

        // Both editors load the same starting snapshot.
        let snapshot = ws.dictionary.get_entry("verbs", id).unwrap().clone();
        let mut from_grid = snapshot.clone();
        let mut from_inspector = snapshot;

        // Grid edits field "pos"; Inspector (unaware) edits "usage".
        from_grid.set("pos", FieldValue::Text("verb".into()));
        from_inspector.set("usage", FieldValue::Text("formal".into()));

        assert!(ws.replace_entry("verbs", from_grid).unwrap());
        assert!(ws.replace_entry("verbs", from_inspector).unwrap());

        let final_entry = ws.dictionary.get_entry("verbs", id).unwrap();
        // Inspector's whole-entry save wins completely: Grid's edit to "pos"
        // is gone, even though Inspector never touched that field.
        assert!(
            final_entry.get("pos").is_none(),
            "whole-entry replace clobbers a field it never touched"
        );
        assert!(final_entry.get("usage").is_some());
    }

    #[test]
    fn field_patches_from_stale_views_never_clobber_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        let id = ws.create_entry("verbs", "kala").unwrap().unwrap();

        // Both "editors" start from the same stale snapshot, then patch
        // different fields — the exact scenario that clobbers above.
        ws.set_value("verbs", id, "pos", Some(FieldValue::Text("verb".into())))
            .unwrap();
        ws.set_value(
            "verbs",
            id,
            "usage",
            Some(FieldValue::Text("formal".into())),
        )
        .unwrap();
        ws.rename_word("verbs", id, "kalai").unwrap();

        let entry = ws.dictionary.get_entry("verbs", id).unwrap();
        assert_eq!(entry.wordname, "kalai");
        assert_eq!(entry.get("pos"), Some(&FieldValue::Text("verb".into())));
        assert_eq!(entry.get("usage"), Some(&FieldValue::Text("formal".into())));

        // Reload from disk: every field actually persisted.
        let reloaded = Workspace::load(dir.path()).unwrap();
        let entry = reloaded.dictionary.get_entry("verbs", id).unwrap();
        assert_eq!(entry.wordname, "kalai");
        assert_eq!(entry.get("pos"), Some(&FieldValue::Text("verb".into())));
        assert_eq!(entry.get("usage"), Some(&FieldValue::Text("formal".into())));
    }

    #[test]
    fn set_definition_is_sparse_and_removable() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        let id = ws.create_entry("verbs", "kala").unwrap().unwrap();

        ws.set_definition("verbs", id, vec!["to speak".into(), "to say".into()])
            .unwrap();
        let entry = ws.dictionary.get_entry("verbs", id).unwrap();
        assert_eq!(
            entry.get(DEFINITION_TAG),
            Some(&FieldValue::TagList(vec![
                "to speak".into(),
                "to say".into()
            ]))
        );

        // Clearing it removes the tag entirely rather than storing `[]`.
        ws.set_definition("verbs", id, vec![]).unwrap();
        let entry = ws.dictionary.get_entry("verbs", id).unwrap();
        assert!(entry.get(DEFINITION_TAG).is_none());
        assert!(entry.values.is_empty());
    }

    #[test]
    fn set_value_rejects_the_wordname_tag_and_unknown_words() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        let id = ws.create_entry("verbs", "kala").unwrap().unwrap();

        assert!(!ws
            .set_value(
                "verbs",
                id,
                "wordname",
                Some(FieldValue::Text("nope".into()))
            )
            .unwrap());
        assert_eq!(
            ws.dictionary.get_entry("verbs", id).unwrap().wordname,
            "kala"
        );

        // Removing a tag the word never had is a harmless no-op — the word
        // was still found, so this reports success.
        assert!(ws.set_value("verbs", id, "pos", None).unwrap());

        let missing = Uuid::new_v4();
        assert!(!ws
            .set_value("verbs", missing, "pos", Some(FieldValue::Text("x".into())))
            .unwrap());
        assert!(!ws.rename_word("verbs", missing, "x").unwrap());
        assert!(!ws
            .set_definition("verbs", missing, vec!["x".into()])
            .unwrap());
    }

    #[test]
    fn set_values_batches_and_one_undo_restores_all() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        let a = ws.create_entry("verbs", "a").unwrap().unwrap();
        let b = ws.create_entry("verbs", "b").unwrap().unwrap();
        let c = ws.create_entry("verbs", "c").unwrap().unwrap();
        let missing = Uuid::new_v4();

        let changed = ws
            .set_values(
                "verbs",
                &[a, b, c, missing],
                "pos",
                Some(FieldValue::Text("verb".into())),
            )
            .unwrap();
        assert_eq!(changed, 3);
        for id in [a, b, c] {
            assert_eq!(
                ws.dictionary.get_entry("verbs", id).unwrap().get("pos"),
                Some(&FieldValue::Text("verb".into()))
            );
        }

        // `wordname` is rejected, like the single-value path.
        assert_eq!(
            ws.set_values(
                "verbs",
                &[a],
                "wordname",
                Some(FieldValue::Text("x".into()))
            )
            .unwrap(),
            0
        );

        // A single undo reverts the whole batch.
        assert!(ws.undo().unwrap());
        for id in [a, b, c] {
            assert!(ws
                .dictionary
                .get_entry("verbs", id)
                .unwrap()
                .get("pos")
                .is_none());
        }
    }

    #[test]
    fn delete_entry_with_reassigns_or_orphans_children() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("t").unwrap();
        let root = ws.create_entry("t", "kala").unwrap().unwrap();
        let child_a = ws.create_entry("t", "kalator").unwrap().unwrap();
        let child_b = ws.create_entry("t", "kalora").unwrap().unwrap();
        let other = ws.create_entry("t", "velo").unwrap().unwrap();
        ws.add_parent("t", child_a, root).unwrap();
        ws.add_parent("t", child_b, root).unwrap();

        let mut reassign = BTreeMap::new();
        reassign.insert(child_a, Some(other));
        reassign.insert(child_b, None);
        assert_eq!(
            ws.delete_entry_with("t", root, &reassign, false).unwrap(),
            1
        );

        assert!(ws.dictionary.get_entry("t", root).is_none());
        assert_eq!(
            ws.dictionary.get_entry("t", child_a).unwrap().parents(),
            vec![other]
        );
        assert!(!ws.dictionary.get_entry("t", child_b).unwrap().has_parent());

        // One undo restores every change at once.
        assert!(ws.undo().unwrap());
        assert!(ws.dictionary.get_entry("t", root).is_some());
        assert_eq!(
            ws.dictionary.get_entry("t", child_a).unwrap().parents(),
            vec![root]
        );
        assert_eq!(
            ws.dictionary.get_entry("t", child_b).unwrap().parents(),
            vec![root]
        );
    }

    #[test]
    fn delete_entry_with_cascade_removes_the_subtree() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("t").unwrap();
        let root = ws.create_entry("t", "kala").unwrap().unwrap();
        let child = ws.create_entry("t", "kalator").unwrap().unwrap();
        let grandchild = ws.create_entry("t", "kalator-mini").unwrap().unwrap();
        let other = ws.create_entry("t", "velo").unwrap().unwrap();
        ws.add_parent("t", child, root).unwrap();
        ws.add_parent("t", grandchild, child).unwrap();

        let removed = ws
            .delete_entry_with("t", root, &BTreeMap::new(), true)
            .unwrap();
        assert_eq!(removed, 3);
        assert!(ws.dictionary.get_entry("t", root).is_none());
        assert!(ws.dictionary.get_entry("t", child).is_none());
        assert!(ws.dictionary.get_entry("t", grandchild).is_none());
        assert!(ws.dictionary.get_entry("t", other).is_some());
    }

    #[test]
    fn set_class_declares_the_pos_column_and_sets_the_value() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        let id = ws.create_entry("verbs", "velo").unwrap().unwrap();

        assert!(!ws.dictionary.table("verbs").unwrap().has_tag(POS_TAG));
        assert!(ws.set_class("verbs", id, Some("verb")).unwrap());
        assert!(ws.dictionary.table("verbs").unwrap().has_tag(POS_TAG));
        assert_eq!(
            ws.dictionary.get_entry("verbs", id).unwrap().get(POS_TAG),
            Some(&FieldValue::TagList(vec!["verb".into()]))
        );

        // Blank clears the class rather than storing an empty string.
        assert!(ws.set_class("verbs", id, Some("  ")).unwrap());
        assert!(ws
            .dictionary
            .get_entry("verbs", id)
            .unwrap()
            .get(POS_TAG)
            .is_none());

        let missing = Uuid::new_v4();
        assert!(!ws.set_class("verbs", missing, Some("verb")).unwrap());
    }

    #[test]
    fn normalizing_class_values_strips_a_leading_hash() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("lex").unwrap();
        ws.dictionary
            .add_tag("lex", TagDef::new("type", FieldType::TagList));
        let id = ws.create_entry("lex", "nau").unwrap().unwrap();
        ws.set_value(
            "lex",
            id,
            "type",
            Some(FieldValue::TagList(vec!["#noun".into()])),
        )
        .unwrap();

        assert_eq!(ws.normalize_class_values("type").unwrap(), 1);
        assert_eq!(
            ws.dictionary.get_entry("lex", id).unwrap().get("type"),
            Some(&FieldValue::TagList(vec!["noun".into()]))
        );
        // Running it again is a no-op.
        assert_eq!(ws.normalize_class_values("type").unwrap(), 0);
    }

    #[test]
    fn set_table_role_records_and_clears_the_designation() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("fixes").unwrap();

        assert!(ws.table_roles().is_empty());
        assert!(ws
            .set_table_role("fixes", TableRole::Fixes, Some("english".into()), None)
            .unwrap());
        let saved = ws.table_roles().get("fixes").unwrap();
        assert_eq!(saved.role, TableRole::Fixes);
        assert_eq!(saved.trigger.as_deref(), Some("english"));

        // Vocab with no columns removes the entry: vocab is the default.
        assert!(ws
            .set_table_role("fixes", TableRole::Vocab, None, None)
            .unwrap());
        assert!(ws.table_roles().is_empty());

        assert!(!ws
            .set_table_role("missing", TableRole::Fixes, None, None)
            .unwrap());
    }

    #[test]
    fn editor_line_numbers_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        assert!(ws.editor_line_numbers());
        ws.set_editor_line_numbers(false).unwrap();
        assert!(!ws.editor_line_numbers());
        ws.set_editor_line_numbers(true).unwrap();
        assert!(ws.editor_line_numbers());
    }

    #[test]
    fn suppressed_confirms_silence_and_clear() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        assert!(ws.suppressed_confirms().is_empty());
        assert!(!ws.is_confirm_suppressed("delete-note"));

        ws.suppress_confirm("delete-note").unwrap();
        ws.suppress_confirm("delete-table").unwrap();
        ws.suppress_confirm("delete-note").unwrap(); // idempotent
        assert_eq!(
            ws.suppressed_confirms(),
            vec!["delete-note".to_string(), "delete-table".to_string()]
        );

        ws.unsuppress_confirm(Some("delete-note")).unwrap();
        assert!(!ws.is_confirm_suppressed("delete-note"));
        assert!(ws.is_confirm_suppressed("delete-table"));

        ws.unsuppress_confirm(None).unwrap();
        assert!(ws.suppressed_confirms().is_empty());
    }

    #[test]
    fn a_profile_round_trips_through_apply() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("lex").unwrap();
        let mut language = ws.language.clone();
        language.name = "Vokala".into();
        ws.language = language;
        ws.phonology.phonemes.push(Phoneme {
            symbol: "k".into(),
            kind: PhonemeKind::Consonant,
        });
        let profile = ws.profile();
        assert_eq!(profile.language.name, "Vokala");

        // Wipe the live config, then restore it from the profile.
        ws.language = LanguageConfig::default();
        ws.phonology = PhonologyConfig::default();
        ws.apply_profile(profile).unwrap();
        assert_eq!(ws.profile().language.name, "Vokala");
        assert_eq!(ws.profile().phonology.phonemes.len(), 1);
    }

    #[test]
    fn table_filename_migration_runs_once_behind_a_revertible_git_checkpoint() {
        if !git_ok() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.init_git().unwrap();

        // A pre-existing on-disk collision, as if from before this fix: two
        // files whose *content* both claim the name "roots" — the real,
        // silent-data-loss case migration exists to fix. Written directly so
        // `Workspace::load`'s own automatic (and here, already-consumed-by
        // `new`) migration does not pre-empt the explicit call below.
        std::fs::write(
            dir.path().join("dictionary/file_a"),
            r#"{"name":"roots","tags":[],"entries":[{"id":"00000000-0000-0000-0000-000000000001","wordname":"a"}]}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("dictionary/file_b"),
            r#"{"name":"roots","tags":[],"entries":[{"id":"00000000-0000-0000-0000-000000000002","wordname":"b"}]}"#,
        )
        .unwrap();

        let report = ws.migrate_table_filenames().unwrap();
        assert_eq!(report.renamed_tables.len(), 1);

        assert!(ws.dictionary.table("roots").is_some());
        assert!(ws.dictionary.table("roots (duplicate)").is_some());

        let log = git_out(dir.path(), &["log", "--oneline"]);
        assert!(log.contains("CAN REVERT"));
        assert!(git_out(dir.path(), &["status", "--porcelain"])
            .trim()
            .is_empty());

        // Running it again is a true no-op: no new commit, nothing renamed.
        let before_head = git_out(dir.path(), &["rev-parse", "HEAD"]);
        let second = ws.migrate_table_filenames().unwrap();
        assert!(second.is_empty());
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), before_head);
    }

    #[test]
    fn workspace_load_quarantines_one_bad_file_and_loads_everything_else() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        ws.create_entry("verbs", "kala").unwrap();
        let dict = dir.path().join("dictionary");
        std::fs::write(dict.join("corrupt"), "{ not json").unwrap();
        std::fs::write(dict.join("leftover.tmp"), "half-written").unwrap();
        std::fs::write(dict.join("README.txt"), "notes for humans, not JSON").unwrap();
        let (corrupt_before, tmp_before, readme_before) = (
            std::fs::read(dict.join("corrupt")).unwrap(),
            std::fs::read(dict.join("leftover.tmp")).unwrap(),
            std::fs::read(dict.join("README.txt")).unwrap(),
        );

        let loaded = Workspace::load(dir.path()).unwrap();
        assert_eq!(loaded.dictionary.table("verbs").unwrap().entries.len(), 1);
        // Only the two genuinely-unparseable files are reported; the `.tmp`
        // leftover is debris, skipped silently rather than quarantined.
        let mut warned: Vec<&str> = loaded
            .quarantine
            .iter()
            .map(|w| w.file_name.as_str())
            .collect();
        warned.sort_unstable();
        assert_eq!(warned, ["README.txt", "corrupt"]);

        assert_eq!(std::fs::read(dict.join("corrupt")).unwrap(), corrupt_before);
        assert_eq!(
            std::fs::read(dict.join("leftover.tmp")).unwrap(),
            tmp_before
        );
        assert_eq!(
            std::fs::read(dict.join("README.txt")).unwrap(),
            readme_before
        );
    }

    #[test]
    fn colliding_table_names_never_overwrite_each_others_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("Roots").unwrap();
        ws.create_entry("Roots", "one").unwrap();

        // "roots" slugifies identically to "Roots"; it must not collide.
        ws.create_table("roots").unwrap();
        ws.create_entry("roots", "two").unwrap();

        let dict = dir.path().join("dictionary");
        let files: std::collections::BTreeSet<String> = std::fs::read_dir(&dict)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files.len(), 2, "two distinct files: {files:?}");

        let reloaded = Workspace::load(dir.path()).unwrap();
        assert_eq!(
            reloaded.dictionary.table("Roots").unwrap().entries[0].wordname,
            "one"
        );
        assert_eq!(
            reloaded.dictionary.table("roots").unwrap().entries[0].wordname,
            "two"
        );

        // Deleting one never touches the other's file.
        ws.delete_table("Roots").unwrap();
        assert!(ws.dictionary.table("roots").is_some());
        let reloaded = Workspace::load(dir.path()).unwrap();
        assert!(reloaded.dictionary.table("Roots").is_none());
        assert_eq!(
            reloaded.dictionary.table("roots").unwrap().entries[0].wordname,
            "two"
        );
    }

    #[test]
    fn renaming_onto_a_colliding_slug_is_rejected_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("a b").unwrap();
        ws.create_entry("a b", "x").unwrap();
        ws.create_table("a_b").unwrap();
        ws.create_entry("a_b", "y").unwrap();

        // Same display-name collision as above, but via rename instead of
        // create: renaming "a b" to the literal name "a_b" must be rejected
        // (that name is taken), never silently overwrite its file.
        assert!(!ws.rename_table("a b", "a_b").unwrap());
        assert_eq!(ws.dictionary.table("a b").unwrap().entries[0].wordname, "x");
        assert_eq!(ws.dictionary.table("a_b").unwrap().entries[0].wordname, "y");
    }

    #[test]
    fn undo_and_redo_of_a_rename_keep_the_tables_file_on_a_slug_collision() {
        for (from, to) in [("Roots", "roots"), ("a b", "a_b")] {
            let dir = tempfile::tempdir().unwrap();
            let mut ws = Workspace::new(dir.path()).unwrap();
            ws.create_table(from).unwrap();
            let id = ws.create_entry(from, "kala").unwrap().unwrap();

            assert!(ws.rename_table(from, to).unwrap());
            assert!(ws.undo().unwrap());
            assert!(ws.dictionary.table(from).is_some());
            assert!(ws
                .dictionary
                .table(from)
                .unwrap()
                .entries
                .iter()
                .any(|e| e.id == id));
            let reloaded = Workspace::load(dir.path()).unwrap();
            assert!(reloaded
                .dictionary
                .table(from)
                .unwrap()
                .entries
                .iter()
                .any(|e| e.id == id));

            assert!(ws.redo().unwrap());
            assert_eq!(ws.dictionary.table(to).unwrap().entries[0].id, id);
            let reloaded = Workspace::load(dir.path()).unwrap();
            assert!(reloaded
                .dictionary
                .table(to)
                .unwrap()
                .entries
                .iter()
                .any(|e| e.id == id));
        }
    }

    #[test]
    fn undo_and_redo_of_a_delete_keep_using_the_same_file_across_a_collision() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("Roots").unwrap();
        ws.create_entry("Roots", "one").unwrap();
        ws.create_table("roots").unwrap();
        ws.create_entry("roots", "two").unwrap();

        ws.delete_table("roots").unwrap();
        assert!(ws.undo().unwrap());
        assert_eq!(
            ws.dictionary.table("Roots").unwrap().entries[0].wordname,
            "one"
        );
        assert_eq!(
            ws.dictionary.table("roots").unwrap().entries[0].wordname,
            "two"
        );
        let reloaded = Workspace::load(dir.path()).unwrap();
        assert_eq!(
            reloaded.dictionary.table("Roots").unwrap().entries[0].wordname,
            "one"
        );
        assert_eq!(
            reloaded.dictionary.table("roots").unwrap().entries[0].wordname,
            "two"
        );

        assert!(ws.redo().unwrap());
        assert!(ws.dictionary.table("roots").is_none());
        assert_eq!(
            ws.dictionary.table("Roots").unwrap().entries[0].wordname,
            "one"
        );
    }

    #[test]
    fn undo_of_an_empty_tables_creation_skips_the_trash() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("fresh").unwrap();

        assert!(ws.undo().unwrap());
        assert!(ws.dictionary.table("fresh").is_none());
        assert!(
            ws.list_trash().is_empty(),
            "an empty table is not worth a trash entry"
        );

        // A table that actually holds a word is still trashed on undo.
        ws.create_table("has-words").unwrap();
        ws.create_entry("has-words", "kala").unwrap();
        assert!(ws.undo().unwrap()); // un-add "kala"
        assert!(ws.undo().unwrap()); // un-create "has-words"
        assert_eq!(
            ws.list_trash().len(),
            0,
            "still empty when the word-add was also undone"
        );

        ws.create_table("stays").unwrap();
        ws.create_entry("stays", "kala").unwrap();
        let _ = ws.redo(); // no-op, nothing to redo
        assert!(ws.delete_table("stays").unwrap().is_some());
        assert!(ws.undo().unwrap()); // un-delete: brings it back
        assert_eq!(
            ws.list_trash().len(),
            0,
            "undo of a real delete consumes its own trash copy"
        );
    }

    #[test]
    fn saving_never_resurrects_a_deleted_or_renamed_note() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_note("a").unwrap();
        ws.create_note("b").unwrap();

        // A stale editor buffer saving to a deleted note must fail, not
        // recreate the file.
        ws.delete_note("a.md").unwrap();
        assert!(ws.save_note(&NoteFile::new("a.md", "stale")).is_err());
        assert!(!dir.path().join("notes/a.md").exists());

        // Same for the old path after a rename.
        ws.rename_note("b.md", "c").unwrap();
        assert!(ws.save_note(&NoteFile::new("b.md", "stale")).is_err());
        assert!(!dir.path().join("notes/b.md").exists());
        assert!(dir.path().join("notes/c.md").exists());
    }

    #[test]
    fn note_crud_refreshes_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();

        ws.create_folder("Grammar").unwrap();
        let created = ws.create_note("Grammar/phonology").unwrap();
        assert_eq!(created, PathBuf::from("Grammar/phonology.md"));
        assert_eq!(ws.notes.len(), 1);
        assert_eq!(ws.notes[0].path, PathBuf::from("Grammar/phonology.md"));

        ws.rename_note("Grammar/phonology.md", "Grammar/sounds")
            .unwrap();
        assert_eq!(ws.notes[0].path, PathBuf::from("Grammar/sounds.md"));

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
            column_order: vec!["wordname".into(), "def".into(), "parent".into()],
            column_widths: [("def".to_string(), 240)].into_iter().collect(),
            ..Default::default()
        };
        ws.set_grid_view("verbs", view.clone()).unwrap();

        let reloaded = Workspace::load(dir.path()).unwrap();
        assert_eq!(reloaded.grid_view("verbs"), view);
        assert_eq!(reloaded.grid_view("missing"), GridViewState::default());
    }

    #[test]
    fn grid_view_column_widths_persist_per_table_across_reload() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("roots").unwrap();
        ws.create_table("verbs").unwrap();

        // Every column, including an odd pixel width, for both tables.
        let roots_widths = BTreeMap::from([
            ("wordname".to_string(), 220u32),
            ("def".to_string(), 317),
            ("parent".to_string(), 61),
        ]);
        let verbs_widths = BTreeMap::from([("wordname".to_string(), 180u32)]);
        ws.set_grid_view(
            "roots",
            GridViewState {
                column_widths: roots_widths.clone(),
                ..Default::default()
            },
        )
        .unwrap();
        ws.set_grid_view(
            "verbs",
            GridViewState {
                column_widths: verbs_widths.clone(),
                ..Default::default()
            },
        )
        .unwrap();

        let reloaded = Workspace::load(dir.path()).unwrap();
        assert_eq!(reloaded.grid_view("roots").column_widths, roots_widths);
        assert_eq!(reloaded.grid_view("verbs").column_widths, verbs_widths);

        // Resizing one table's columns must not disturb another table's.
        let mut widened = roots_widths.clone();
        widened.insert("def".to_string(), 400);
        ws.set_grid_view(
            "roots",
            GridViewState {
                column_widths: widened.clone(),
                ..Default::default()
            },
        )
        .unwrap();
        let reloaded = Workspace::load(dir.path()).unwrap();
        assert_eq!(reloaded.grid_view("roots").column_widths, widened);
        assert_eq!(reloaded.grid_view("verbs").column_widths, verbs_widths);
    }

    #[test]
    fn set_tag_suggest_persists() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("verbs").unwrap();
        ws.add_tag("verbs", TagDef::new("type", FieldType::TagList))
            .unwrap();

        assert!(ws.set_tag_suggest("verbs", "type", true).unwrap());
        assert!(!ws.set_tag_suggest("verbs", "missing", true).unwrap());

        let reloaded = Workspace::load(dir.path()).unwrap();
        let tag = reloaded
            .dictionary
            .table("verbs")
            .unwrap()
            .tag("type")
            .unwrap();
        assert!(tag.suggest);
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
    fn set_tag_kind_commits_a_revertible_change() {
        if !git_ok() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.init_git().unwrap();
        ws.create_table("verbs").unwrap();
        ws.add_tag("verbs", TagDef::new("flag", FieldType::Text))
            .unwrap();
        ws.checkin("nueon: baseline").unwrap();

        assert!(ws
            .set_tag_kind("verbs", "flag", FieldType::Boolean)
            .unwrap()
            .is_some());

        let log = git_out(dir.path(), &["log", "--oneline"]);
        assert!(log.contains("CAN REVERT"), "commit log: {log}");
        assert!(git_out(dir.path(), &["status", "--porcelain"])
            .trim()
            .is_empty());
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
        use crate::config::{AffixKind, AffixRule, TranslationMode};

        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        assert_eq!(
            ws.translation_options().mode,
            TranslationMode::Direct,
            "word-for-word is the default"
        );
        ws.set_translation_options(TranslationOptions {
            separator: "".into(),
            affixes: vec![AffixRule {
                kind: AffixKind::Suffix,
                english: "s".into(),
                conlang: "i".into(),
            }],
            mode: TranslationMode::Grid,
        })
        .unwrap();

        let reloaded = Workspace::load(dir.path()).unwrap();
        let options = reloaded.translation_options();
        assert_eq!(options.separator, " ", "empty separator resets to default");
        assert_eq!(options.affixes.len(), 1);
        assert_eq!(options.affixes[0].conlang, "i");
        assert_eq!(options.mode, TranslationMode::Grid);
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

        assert!(ws.close_checkin().unwrap().is_some());
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

        // The table keeps its one and only file (just rewritten with the new
        // name) rather than deleting the old slug and writing a new one — the
        // same slug would otherwise delete the file out from under a rename
        // like "Roots" -> "roots" (see `renaming_a_table_to_a_case_or_...`).
        assert!(dir.path().join("dictionary").join("verbs").exists());
        assert!(!dir.path().join("dictionary").join("actions").exists());
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
    fn renaming_a_table_rekeys_roles_and_morpheme_refs() {
        use std::collections::BTreeMap;

        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("fixes").unwrap();
        ws.set_table_role("fixes", TableRole::Fixes, None, None)
            .unwrap();
        let id = ws.create_entry("fixes", "-yu").unwrap().unwrap();
        ws.translation.morphology.paradigms.push(Paradigm {
            class: "noun".into(),
            rows: vec![ParadigmRow {
                when: BTreeMap::from([("number".to_string(), "plural".to_string())]),
                surface: String::new(),
                kind: AffixKind::Suffix,
                slot: None,
                order: 0,
                morpheme: Some(MorphemeRef::Ref {
                    table: "fixes".into(),
                    id: id.to_string(),
                }),
                zero: false,
            }],
        });

        ws.set_grid_view(
            "fixes",
            GridViewState {
                search: "x".into(),
                ..GridViewState::default()
            },
        )
        .unwrap();

        assert!(ws.rename_table("fixes", "affixes").unwrap());
        assert!(ws.translation.table_roles.contains_key("affixes"));
        assert!(!ws.translation.table_roles.contains_key("fixes"));
        assert_eq!(
            ws.translation.morphology.paradigms[0].rows[0].morpheme,
            Some(MorphemeRef::Ref {
                table: "affixes".into(),
                id: id.to_string(),
            })
        );
        // Grid view state follows the table too.
        assert_eq!(ws.grid_view("affixes").search, "x");
        assert!(!ws.settings.grid_views.contains_key("fixes"));
    }

    #[test]
    fn deleting_a_table_drops_grid_views_but_keeps_config() {
        use std::collections::BTreeMap;

        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        ws.create_table("fixes").unwrap();
        ws.set_table_role("fixes", TableRole::Fixes, None, None)
            .unwrap();
        let id = ws.create_entry("fixes", "-yu").unwrap().unwrap();
        ws.set_grid_view(
            "fixes",
            GridViewState {
                search: "x".into(),
                ..GridViewState::default()
            },
        )
        .unwrap();
        ws.translation.morphology.paradigms.push(Paradigm {
            class: "noun".into(),
            rows: vec![ParadigmRow {
                when: BTreeMap::from([("number".to_string(), "plural".to_string())]),
                surface: String::new(),
                kind: AffixKind::Suffix,
                slot: None,
                order: 0,
                morpheme: Some(MorphemeRef::Ref {
                    table: "fixes".into(),
                    id: id.to_string(),
                }),
                zero: false,
            }],
        });

        assert!(ws.delete_table("fixes").unwrap().is_some());
        // View state is dropped with the table...
        assert!(!ws.settings.grid_views.contains_key("fixes"));
        // ...but roles and morpheme references are kept (broken until restored).
        assert!(ws.translation.table_roles.contains_key("fixes"));
        assert_eq!(
            ws.translation.morphology.paradigms[0].rows[0].morpheme,
            Some(MorphemeRef::Ref {
                table: "fixes".into(),
                id: id.to_string(),
            })
        );
    }

    #[test]
    fn tiling_layout_persists_with_windows() {
        use crate::{GroupLayout, SplitLayout, TabKind, TabLayout};

        let tiling = |table: &str| TilingLayout {
            groups: vec![GroupLayout {
                id: "g".into(),
                tabs: vec![TabLayout {
                    kind: TabKind::Table,
                    reference: Some(table.into()),
                    title: table.into(),
                }],
                active: Some(0),
            }],
            root: SplitLayout::Leaf { group: "g".into() },
            active_group: Some("g".into()),
        };

        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new(dir.path()).unwrap();
        assert!(ws.layout_state().is_empty());

        ws.set_main_tiling(tiling("roots")).unwrap();
        let geometry = WindowGeometry {
            x: Some(40),
            y: Some(60),
            width: 700,
            height: 500,
        };
        ws.set_window_tiling("tear-a", Some(geometry), tiling("verbs"))
            .unwrap();
        ws.set_window_tiling("tear-b", None, tiling("nouns"))
            .unwrap();
        ws.remove_window_layout("tear-b").unwrap();

        let reloaded = Workspace::load(dir.path()).unwrap();
        let state = reloaded.layout_state();
        assert_eq!(state.main, Some(tiling("roots")));
        assert_eq!(state.windows.len(), 1);
        assert_eq!(state.windows[0].label, "tear-a");
        assert_eq!(state.windows[0].geometry, Some(geometry));
        assert_eq!(state.windows[0].tiling, tiling("verbs"));
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
