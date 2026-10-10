//! Workspace lifecycle: create, load, reload, migrate, directories and git.

use super::*;

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
            phonology: PhonologyConfig::default(),
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
        let phonology =
            storage::load_json(&config_dir.join(storage::PHONOLOGY_FILE))?.unwrap_or_default();
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
            phonology,
            settings,
            vcs,
            table_files: scan.files,
            quarantine: scan.warnings,
            auto,
            history: History::new(),
        };
        // Best effort: a failed migration retries on the next open.
        let _ = workspace.migrate_table_filenames_if_needed();
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
        let phonology =
            storage::load_json(&config_dir.join(storage::PHONOLOGY_FILE))?.unwrap_or_default();
        let settings =
            storage::load_json(&config_dir.join(storage::SETTINGS_FILE))?.unwrap_or_default();

        self.dictionary = dictionary;
        self.notes = notes;
        self.language = language;
        self.grammar = grammar;
        self.translation = translation;
        self.phonology = phonology;
        self.settings = settings;
        self.table_files = scan.files;
        self.quarantine = scan.warnings;
        self.history = History::new();
        Ok(())
    }

    /// One-time repair of on-disk table-filename collisions, gated by
    /// [`WorkspaceSettings::table_filenames_migrated`] so it only scans once.
    pub(crate) fn migrate_table_filenames_if_needed(&mut self) -> Result<(), StorageError> {
        if self.settings.table_filenames_migrated {
            return Ok(());
        }
        self.migrate_table_filenames()?;
        self.settings.table_filenames_migrated = true;
        self.save_settings()?;
        Ok(())
    }

    /// Detect and fix on-disk table-filename collisions (see
    /// [`table_files::migrate_collisions`]): a case-insensitive filename
    /// clash, or two files whose content shares one table name. Runs behind
    /// a git checkpoint commit when git is ready, so it is always
    /// revertible, and commits again afterwards with a `<CAN REVERT>`
    /// message — only if it actually changed anything. Exposed directly (in
    /// addition to the once-only [`Self::migrate_table_filenames_if_needed`])
    /// so callers (and tests) can prove it idempotent on demand.
    pub fn migrate_table_filenames(
        &mut self,
    ) -> Result<table_files::MigrationReport, StorageError> {
        // A checkpoint is a no-op commit when nothing is pending, so it is
        // always safe to take one before a risky, file-touching repair. The
        // repair already happened, so a failed commit is best-effort.
        let _ = self.force_checkin("nueon: checkpoint before table filename migration");
        let report = table_files::migrate_collisions(&self.dictionary_dir())?;
        if !report.is_empty() {
            self.refresh_dictionary_from_disk()?;
            let _ = self.force_checkin(&format!(
                "nueon: migrated {} table file(s) <CAN REVERT>",
                report.renamed_tables.len()
            ));
        }
        Ok(report)
    }

    /// Re-read `dictionary/` (tables, filenames and quarantine warnings)
    /// without touching notes, config or undo history.
    pub(crate) fn refresh_dictionary_from_disk(&mut self) -> Result<(), StorageError> {
        let scan = table_files::scan_tables_tolerant(&self.dictionary_dir())?;
        let mut dictionary = Dictionary::new();
        for table in scan.tables {
            dictionary.tables.insert(table.name.clone(), table);
        }
        self.dictionary = dictionary;
        self.table_files = scan.files;
        self.quarantine = scan.warnings;
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
}
