//! Core data model, storage, configuration, and version control for langloom.

pub mod app;
pub mod config;
pub mod model;
pub mod translation;
pub mod vcs;
pub mod workspace;

pub use config::{
    GrammarConfig, GrammarRule, LanguageConfig, TextDirection, TranslationConfig, WorkspaceSettings,
};
pub use model::{
    Dictionary, FieldType, FieldValue, TagDef, TagRemoval, WordEntry, WordTable, DEFINITION_TAG,
    PARENT_TAG, WORDNAME_TAG,
};
pub use translation::{ClauseSlot, SyntaxGrid};
pub use vcs::{AutoCheckin, Commit, GitRepo, GitStatus, StatusEntry, VcsError};
pub use workspace::{NoteFile, StorageError, Workspace};
