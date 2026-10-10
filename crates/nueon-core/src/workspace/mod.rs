//! A user-designated workspace directory: tables, notes, and config.

mod assets;
mod entries;
mod history;
mod lifecycle;
mod links;
mod note;
mod notes;
mod settings;
mod storage;
mod table_files;
mod tables;
mod tags;
mod translation;
mod trash;
mod vcs;

pub use assets::{AssetKind, ImportedAsset, ASSETS_DIR};
pub use note::NoteFile;
pub use storage::{StorageError, CONFIG_DIR, DICTIONARY_DIR, NOTES_DIR};
pub use table_files::QuarantineWarning;
pub use trash::{Restored, TrashKind, TrashRecord, RETENTION_DAYS, TRASH_DIR};

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use uuid::Uuid;

use self::history::History;
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

#[cfg(test)]
mod tests;
