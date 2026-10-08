//! Core data model, storage, configuration, and version control for nueon.
//!
//! UI-agnostic: both the Tauri backend and its Svelte frontend build on this
//! crate.

pub mod config;
pub mod export;
pub mod export_table;
pub mod global;
pub mod import;
pub mod model;
pub mod translation;
pub mod vcs;
pub mod workspace;

pub use config::{
    AffixKind, AffixRule, Feature, FeatureValue, GrammarConfig, GrammarRule, GridViewState,
    GroupLayout, LanguageConfig, LayoutState, Morphology, Paradigm, ParadigmRow, SecondaryWindow,
    SortSpec, SplitDirection, SplitLayout, TabKind, TabLayout, TextDirection, TilingLayout,
    TranslationConfig, TranslationOptions, UiLayout, WindowGeometry, WorkspaceSettings,
};
pub use export_table::{export_columns, export_delimited, export_table, ExportColumn, TableFormat};
pub use global::{GlobalConfig, WindowLayout, WorkspaceEntry};
pub use import::{
    detect, import_apply, import_preview, ColumnProposal, ColumnRole, Detection, DuplicateConflict,
    DuplicatePolicy, ImportError, ImportOptions, ImportPlan, ImportReport, LinkChoice, LinkReport,
    LinkSyntax, Preview, SuspiciousRow, TagProposal,
};
pub use model::{
    Dictionary, FieldType, FieldValue, GlossMorpheme, InterlinearGloss, TagDef, TagFormat,
    TagKindChange, TagRemoval, WordEntry, WordHit, WordTable, DEFINITION_TAG, PARENT_TAG,
    WORDNAME_TAG,
};
pub use translation::{ClauseSlot, SyntaxGrid};
pub use vcs::{AutoCheckin, Commit, GitRepo, GitStatus, StatusEntry, VcsError};
pub use workspace::{
    AssetKind, ImportedAsset, NoteFile, QuarantineWarning, Restored, StorageError, TrashKind,
    TrashRecord, Workspace, ASSETS_DIR,
};
