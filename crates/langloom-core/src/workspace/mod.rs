//! A user-designated workspace directory: tables, notes, and config.

mod assets;
mod note;
mod storage;
mod table_files;
mod trash;

pub use assets::{AssetKind, ImportedAsset, ASSETS_DIR};
pub use note::NoteFile;
pub use storage::{StorageError, CONFIG_DIR, DICTIONARY_DIR, NOTES_DIR};
pub use table_files::QuarantineWarning;
pub use trash::{Restored, TrashKind, TrashRecord, RETENTION_DAYS, TRASH_DIR};

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use uuid::Uuid;

use self::table_files::TableFiles;

use crate::config::{
    GrammarConfig, GridViewState, LanguageConfig, LayoutState, TilingLayout, TranslationConfig,
    TranslationOptions, UiLayout, WindowGeometry, WorkspaceSettings,
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
    /// Resolved, stable filenames for every table (see [`table_files`]).
    table_files: TableFiles,
    /// Files under `dictionary/` that exist but could not be loaded.
    pub quarantine: Vec<QuarantineWarning>,
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
            table_files: TableFiles::default(),
            quarantine: Vec::new(),
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

        let scan = table_files::scan_tables_tolerant(&root_path.join(DICTIONARY_DIR))?;
        let mut dictionary = Dictionary::new();
        for table in scan.tables {
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

        let mut workspace = Self {
            root_path,
            dictionary,
            notes,
            language,
            grammar,
            translation,
            settings,
            vcs,
            table_files: scan.files,
            quarantine: scan.warnings,
            auto,
            history: History::new(),
        };
        // Best effort: a failed migration retries on the next open.
        let _ = workspace.migrate_notes_if_needed();
        // Expired trash is cleared on open; never a reason to fail opening.
        trash::prune(&workspace.root_path, trash::now_secs(), RETENTION_DAYS);
        Ok(workspace)
    }

    /// Re-read tables, notes and config from disk after files changed behind
    /// the app's back (a git checkout or revert). Without this the in-memory
    /// copy would overwrite the restored files on the next save. Undo history
    /// is dropped, since its snapshots predate the change.
    ///
    /// Everything is read into locals first and only assigned once all of it
    /// succeeded, so a failure partway leaves memory exactly as it was.
    pub fn reload_disk_state(&mut self) -> Result<(), StorageError> {
        let scan = table_files::scan_tables_tolerant(&self.dictionary_dir())?;
        let mut dictionary = Dictionary::new();
        for table in scan.tables {
            dictionary.tables.insert(table.name.clone(), table);
        }
        let notes = storage::scan_notes(&self.notes_dir())?;
        let config_dir = self.config_dir();
        let language =
            storage::load_json(&config_dir.join(storage::LANGUAGE_FILE))?.unwrap_or_default();
        let grammar =
            storage::load_json(&config_dir.join(storage::GRAMMAR_FILE))?.unwrap_or_default();
        let translation =
            storage::load_json(&config_dir.join(storage::TRANSLATION_FILE))?.unwrap_or_default();
        let settings =
            storage::load_json(&config_dir.join(storage::SETTINGS_FILE))?.unwrap_or_default();

        self.dictionary = dictionary;
        self.notes = notes;
        self.language = language;
        self.grammar = grammar;
        self.translation = translation;
        self.settings = settings;
        self.table_files = scan.files;
        self.quarantine = scan.warnings;
        self.history = History::new();
        Ok(())
    }

    /// One-time conversion of extensionless and `.txt` notes to `.md`.
    fn migrate_notes_if_needed(&mut self) -> Result<(), StorageError> {
        if self.settings.notes_migrated {
            return Ok(());
        }
        let renamed = storage::migrate_to_markdown(&self.notes_dir())?;
        self.refresh_notes()?;
        self.settings.notes_migrated = true;
        self.save_settings()?;
        if !renamed.is_empty() {
            self.mark_change(
                Instant::now(),
                format!("langloom: migrate {} notes to .md", renamed.len()),
            );
        }
        Ok(())
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
        self.table_files.resolve_new(name);
        self.record();
        self.dictionary.add_table(name);
        self.save_table(name)?;
        self.mark_change(Instant::now(), format!("langloom: create table \"{name}\""));
        Ok(true)
    }

    /// Delete a table by moving its file to the trash. Returns the trash
    /// record, or `None` if there is no such table.
    ///
    /// This is also an undoable dictionary step: Ctrl+Z brings the table back
    /// and drops the now-redundant trash copy, while the trash's own Restore
    /// is the route that survives a restart.
    pub fn delete_table(&mut self, name: &str) -> Result<Option<TrashRecord>, StorageError> {
        let Some(table) = self.dictionary.table(name).cloned() else {
            return Ok(None);
        };
        // The map, never a fresh slug: this is the one and only file this
        // table has ever been resolved to.
        let filename = self
            .table_files
            .filename(name)
            .map(str::to_string)
            .unwrap_or_else(|| self.table_files.resolve_new(name));
        let file = self.dictionary_dir().join(&filename);
        // Trash first: if it fails, memory and disk are both unchanged.
        let record = trash::trash_table(&self.root_path, &table, &file)?;
        self.record();
        self.dictionary.remove_table(name);
        self.table_files.remove(name);
        self.mark_change(Instant::now(), format!("langloom: delete table \"{name}\""));
        Ok(Some(record))
    }

    /// Rename a table.
    ///
    /// The table keeps the exact file it already had — renaming only ever
    /// changes the `name` field inside that file. Earlier, a table's file was
    /// recomputed from its name on every save, so renaming a table to a name
    /// that slugifies the same way (`"Roots"` → `"roots"`, `"a b"` → `"a_b"`)
    /// silently deleted its own just-written file. Never recomputing avoids
    /// the whole class of bug.
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
        self.table_files.rename(from, to);
        self.save_table(to)?;
        self.mark_change(
            Instant::now(),
            format!("langloom: rename table \"{from}\" to \"{to}\""),
        );
        Ok(true)
    }

    /// Write a table to its already-resolved file.
    pub fn save_table(&mut self, name: &str) -> Result<(), StorageError> {
        let table = self
            .dictionary
            .table(name)
            .ok_or_else(|| StorageError::TableMissing(name.to_string()))?;
        let filename = match self.table_files.filename(name) {
            Some(filename) => filename.to_string(),
            None => self.table_files.resolve_new(name),
        };
        storage::write_table_file(&self.dictionary_dir().join(filename), table)
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
        self.save_note_checked(note, None).map(|_| ())
    }

    /// Overwrite an existing note, refusing if it changed on disk since
    /// `base_hash` was taken. Returns the new content hash.
    pub fn save_note_checked(
        &mut self,
        note: &NoteFile,
        base_hash: Option<&str>,
    ) -> Result<String, StorageError> {
        let (hash, wrote) = storage::write_existing_note(
            &self.notes_dir(),
            &note.path,
            &note.raw_content,
            base_hash,
        )?;
        if wrote {
            match self.notes.iter_mut().find(|n| n.path == note.path) {
                Some(existing) => *existing = note.clone(),
                None => self.notes.push(note.clone()),
            }
            self.mark_change(
                Instant::now(),
                format!("langloom: update note \"{}\"", note.path.display()),
            );
        }
        Ok(hash)
    }

    /// A note's content together with its hash (the base for later saves).
    pub fn read_note_snapshot(
        &self,
        relative: impl AsRef<Path>,
    ) -> Result<(String, String), StorageError> {
        storage::read_note_snapshot(&self.notes_dir(), relative.as_ref())
    }

    /// Copy an external file into `assets/` under a short content hash.
    pub fn import_asset(
        &mut self,
        source: impl AsRef<Path>,
    ) -> Result<ImportedAsset, StorageError> {
        let imported = assets::import_asset(&self.root_path, source.as_ref())?;
        if !imported.existed {
            self.mark_change(
                Instant::now(),
                format!("langloom: import asset \"{}\"", imported.name),
            );
        }
        Ok(imported)
    }

    /// Import a text/Markdown file as a note inside `folder` of `notes/`.
    pub fn import_note_file(
        &mut self,
        folder: impl AsRef<Path>,
        source: impl AsRef<Path>,
    ) -> Result<PathBuf, StorageError> {
        let relative = assets::import_note(&self.notes_dir(), folder.as_ref(), source.as_ref())?;
        self.refresh_notes()?;
        self.mark_change(
            Instant::now(),
            format!("langloom: import note \"{}\"", relative.display()),
        );
        Ok(relative)
    }

    /// Whether a dropped file should be imported as a note.
    pub fn is_note_source(source: impl AsRef<Path>) -> bool {
        assets::is_note_source(source.as_ref())
    }

    /// Read a note's raw content from `notes/<relative>`.
    pub fn read_note(&self, relative: impl AsRef<Path>) -> Result<String, StorageError> {
        storage::read_note(&self.notes_dir(), relative.as_ref())
    }

    /// Create an empty note and refresh the note list. A name without an
    /// extension gets `.md`; the final relative path is returned.
    pub fn create_note(&mut self, relative: impl AsRef<Path>) -> Result<PathBuf, StorageError> {
        let relative = storage::with_note_extension(relative.as_ref());
        storage::create_note(&self.notes_dir(), &relative)?;
        self.refresh_notes()?;
        self.mark_change(
            Instant::now(),
            format!("langloom: create note \"{}\"", relative.display()),
        );
        Ok(relative)
    }

    /// Create a new note holding `content`. Like [`Workspace::create_note`] it
    /// refuses to overwrite anything and returns the final path.
    pub fn create_note_with_content(
        &mut self,
        relative: impl AsRef<Path>,
        content: &str,
    ) -> Result<PathBuf, StorageError> {
        let created = self.create_note(relative)?;
        self.save_note(&NoteFile::new(&created, content))?;
        Ok(created)
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
    ) -> Result<PathBuf, StorageError> {
        let from = from.as_ref();
        let to = storage::rename_path(&self.notes_dir(), from, to.as_ref())?;
        self.refresh_notes()?;
        self.mark_change(
            Instant::now(),
            format!(
                "langloom: rename \"{}\" to \"{}\"",
                from.display(),
                to.display()
            ),
        );
        Ok(to)
    }

    /// Delete a note or folder by moving it to the trash (nothing is ever
    /// removed outright). Returns the trash record for Undo/Restore.
    pub fn delete_note(&mut self, relative: impl AsRef<Path>) -> Result<TrashRecord, StorageError> {
        let relative = relative.as_ref();
        if relative.as_os_str().is_empty() {
            return Err(StorageError::UnsafePath(relative.to_path_buf()));
        }
        let source = storage::safe_join(&self.notes_dir(), relative)?;
        let meta = std::fs::symlink_metadata(&source)
            .map_err(|_| StorageError::NotFound(relative.to_path_buf()))?;
        let (kind, count) = if meta.is_dir() {
            (TrashKind::Folder, trash::count_files(&source))
        } else {
            (TrashKind::Note, 1)
        };
        let original = relative
            .to_string_lossy()
            .replace('\\', "/")
            .trim_matches('/')
            .to_string();
        let record = trash::trash_path(&self.root_path, &source, kind, original, count)?;
        self.refresh_notes()?;
        self.mark_change(
            Instant::now(),
            format!("langloom: delete \"{}\"", relative.display()),
        );
        Ok(record)
    }

    /// How many files a note path covers (1 for a note, N for a folder); used
    /// by the delete confirmation.
    pub fn count_notes(&self, relative: impl AsRef<Path>) -> Result<usize, StorageError> {
        let source = storage::safe_join(&self.notes_dir(), relative.as_ref())?;
        Ok(trash::count_files(&source))
    }

    /// Everything currently in the trash, newest first.
    pub fn list_trash(&self) -> Vec<TrashRecord> {
        trash::list(&self.root_path)
    }

    /// Restore a trashed item. Notes and folders return to their original
    /// path (or a unique name if it is taken); tables return under their name
    /// (or a unique one) as an undoable step.
    pub fn restore_trash(&mut self, id: &str) -> Result<Restored, StorageError> {
        let record = self
            .list_trash()
            .into_iter()
            .find(|r| r.id == id)
            .ok_or_else(|| StorageError::NotFound(PathBuf::from(id)))?;
        match record.kind {
            TrashKind::Note | TrashKind::Folder => {
                let path = trash::restore_notes(&self.root_path, &self.notes_dir(), id)?;
                self.refresh_notes()?;
                self.mark_change(
                    Instant::now(),
                    format!("langloom: restore \"{}\"", path.display()),
                );
                Ok(Restored {
                    kind: record.kind,
                    name: path.to_string_lossy().replace('\\', "/"),
                })
            }
            TrashKind::Table => {
                let mut table = trash::read_table(&self.root_path, id)?;
                let base = table.name.clone();
                let mut attempt = 0;
                while self.dictionary.table(&table.name).is_some() {
                    attempt += 1;
                    table.name = if attempt == 1 {
                        format!("{base} (restored)")
                    } else {
                        format!("{base} (restored {attempt})")
                    };
                }
                let name = table.name.clone();
                self.record();
                self.dictionary.tables.insert(name.clone(), table);
                if let Err(err) = self.save_table(&name) {
                    // Roll back: the entry stays in the trash.
                    self.dictionary.tables.remove(&name);
                    self.history.undo.pop();
                    return Err(err);
                }
                trash::purge(&self.root_path, id)?;
                self.mark_change(
                    Instant::now(),
                    format!("langloom: restore table \"{name}\""),
                );
                Ok(Restored {
                    kind: TrashKind::Table,
                    name,
                })
            }
        }
    }

    /// Delete one trash entry permanently.
    pub fn purge_trash(&self, id: &str) -> Result<(), StorageError> {
        trash::purge(&self.root_path, id)
    }

    /// Delete everything in the trash permanently.
    pub fn empty_trash(&self) -> usize {
        trash::empty(&self.root_path)
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

    /// The persisted tiling layout (main window + secondary windows).
    pub fn layout_state(&self) -> LayoutState {
        self.settings.layout.clone()
    }

    /// Persist the main window's tiling. Skips the write when unchanged.
    pub fn set_main_tiling(&mut self, tiling: TilingLayout) -> Result<(), StorageError> {
        if self.settings.layout.main.as_ref() == Some(&tiling) {
            return Ok(());
        }
        self.settings.layout.main = Some(tiling);
        self.save_settings()
    }

    /// Persist one secondary window's tiling (and geometry, when known).
    pub fn set_window_tiling(
        &mut self,
        label: &str,
        geometry: Option<WindowGeometry>,
        tiling: TilingLayout,
    ) -> Result<(), StorageError> {
        self.settings.layout.upsert_window(label, geometry, tiling);
        self.save_settings()
    }

    /// Record a secondary window's geometry. Returns whether anything changed.
    pub fn set_window_geometry(
        &mut self,
        label: &str,
        geometry: WindowGeometry,
    ) -> Result<bool, StorageError> {
        if !self.settings.layout.set_window_geometry(label, geometry) {
            return Ok(false);
        }
        self.save_settings()?;
        Ok(true)
    }

    /// Forget one secondary window.
    pub fn remove_window_layout(&mut self, label: &str) -> Result<(), StorageError> {
        if self.settings.layout.remove_window(label) {
            self.save_settings()?;
        }
        Ok(())
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
            // The settings file also holds grid views, layout and migration
            // flags. Replacing it wholesale from the UI could wipe all of that,
            // so it is only ever changed through the dedicated methods.
            "settings" => {
                return Err(StorageError::Config(
                    "settings".to_string(),
                    "the settings file cannot be replaced wholesale".to_string(),
                ))
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
        // Touch the disk first: if that fails the snapshot goes back on the
        // stack and memory is unchanged.
        let before = self.dictionary.clone();
        if let Err(err) = self.write_dictionary_diff(&before, &previous) {
            self.history.undo.push(previous);
            return Err(err);
        }
        let current = std::mem::replace(&mut self.dictionary, previous);
        self.history.redo.push(current);
        self.mark_change(Instant::now(), "langloom: undo");
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
        self.mark_change(Instant::now(), "langloom: redo");
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
    fn write_dictionary_diff(
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
    fn legacy_notes_migrate_to_markdown_once_on_load() {
        let dir = tempfile::tempdir().unwrap();
        drop(Workspace::new(dir.path()).unwrap());
        let notes = dir.path().join("notes");
        std::fs::write(notes.join("lorum"), "hello").unwrap();
        std::fs::write(notes.join("old.txt"), "world").unwrap();

        let ws = Workspace::load(dir.path()).unwrap();
        assert!(notes.join("lorum.md").exists());
        assert!(notes.join("old.md").exists());
        assert_eq!(ws.notes.len(), 2);
        assert!(ws.settings.notes_migrated);

        // A note the user later names without an extension is left alone.
        std::fs::write(notes.join("later"), "x").unwrap();
        let again = Workspace::load(dir.path()).unwrap();
        assert!(notes.join("later").exists());
        assert!(again.settings.notes_migrated);
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
        ws.checkin("langloom: baseline");

        ws.delete_note("doomed.md").unwrap();
        ws.delete_table("verbs").unwrap();
        assert!(!trash_entries(dir.path()).is_empty());
        ws.checkin("langloom: after deletes");
        // Trash again after a commit, then commit again.
        ws.create_note("second").unwrap();
        ws.delete_note("second.md").unwrap();
        ws.checkin("langloom: after more deletes");

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
