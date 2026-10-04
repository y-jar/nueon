//! Core data model, storage, configuration, and version control for langloom.
//!
//! UI-agnostic: both the Tauri backend and the legacy egui UI build on this
//! crate.

pub mod config;
pub mod global;
pub mod model;
pub mod translation;
pub mod vcs;
pub mod workspace;

pub use config::{
    GrammarConfig, GrammarRule, LanguageConfig, TextDirection, TranslationConfig, WorkspaceSettings,
};
pub use global::{GlobalConfig, WorkspaceEntry};
pub use model::{
    Dictionary, FieldType, FieldValue, TagDef, TagRemoval, WordEntry, WordHit, WordTable,
    DEFINITION_TAG, PARENT_TAG, WORDNAME_TAG,
};
pub use translation::{ClauseSlot, SyntaxGrid};
pub use vcs::{AutoCheckin, Commit, GitRepo, GitStatus, StatusEntry, VcsError};
pub use workspace::{NoteFile, StorageError, Workspace};
