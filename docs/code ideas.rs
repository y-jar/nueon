//! Design sketch of the nueon data model.
//!
//! This is a **reference sketch**, not compiled code. The authoritative
//! definitions live in `crates/nueon-core/src/model/` and
//! `crates/nueon-core/src/translation/`; keep this file in sync with them when
//! the model changes.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use uuid::Uuid;

// ==========================================
// 1. DYNAMIC DICTIONARY & ENTRIES
// ==========================================

/// The master database held in memory during runtime.
///
/// Tables are independent logical containers; a word lives in exactly one
/// table. Tags are scoped to the table that declares them.
pub struct Dictionary {
    /// Tables keyed by their stable file key.
    pub tables: BTreeMap<String, WordTable>,
}

/// A user-created bin of words, stored as one extensionless JSON file.
pub struct WordTable {
    /// Display name, e.g. `all words` or `verbs`.
    pub name: String,
    /// The table's columns. Always contains the builtin `wordname` tag first.
    pub tags: Vec<TagDef>,
    pub entries: Vec<WordEntry>,
}

/// A tag is a column in a table's database view.
pub struct TagDef {
    /// Column name, e.g. `wordname`, `part of speech`.
    pub name: String,
    pub description: String,
    pub color: Option<String>,
    /// The value type stored under this tag.
    pub kind: FieldType,
    /// Whether the app owns this tag (e.g. `wordname`), preventing removal.
    pub builtin: bool,
    /// Optional widget/formatting hint for the UI.
    pub format: TagFormat,
}

/// Widget/formatting hints for how a tag's value should be edited.
pub enum TagFormat {
    Default,
    Multiline,
    Date,
    Measurement,
}

/// A single conlang word entry.
///
/// `wordname` is stored explicitly; every other tag lives in the sparse
/// `values` map. A tag is present only once a value has actually been applied.
pub struct WordEntry {
    /// Hidden unique identifier that keeps homographs distinct.
    pub id: Uuid,
    /// The builtin starting tag. Always present.
    pub wordname: String,
    /// Sparse map of tag name to applied value.
    pub values: BTreeMap<String, FieldValue>,
}

// ==========================================
// 2. DYNAMIC FIELD HANDLING
// ==========================================

/// The data type of a [`TagDef`].
pub enum FieldType {
    Text,
    Boolean,
    TagList,
    /// A pointer to another word's UUID.
    Reference,
    /// A list of pointers to other words' UUIDs (used by `parent`).
    References,
}

/// Holds the actual data stored for a tag on a [`WordEntry`].
pub enum FieldValue {
    Text(String),
    Boolean(bool),
    TagList(Vec<String>),
    Reference(Uuid),
    References(Vec<Uuid>),
}

// ==========================================
// 3. WORKSPACE & NOTES
// ==========================================

/// Represents the physical workspace directory on the user's machine.
pub struct Workspace {
    pub root_path: PathBuf,
    pub dictionary: Dictionary,
    pub notes: Vec<NoteFile>,
    pub language: LanguageConfig,
    pub grammar: GrammarConfig,
    pub translation: TranslationConfig,
    pub settings: Settings,
}

/// A single Markdown note file (`.md`).
pub struct NoteFile {
    /// Path relative to the workspace `notes/` directory, e.g. `Grammar/phonology.md`.
    pub path: PathBuf,
    /// The raw Markdown text to be fed into the live-preview renderer.
    pub raw_content: String,
}

/// Per-conlang metadata (name, script, direction).
pub struct LanguageConfig {
    pub name: String,
    pub script: Option<String>,
    pub direction: TextDirection,
}

pub enum TextDirection {
    LeftToRight,
    RightToLeft,
}

pub struct GrammarConfig {
    pub rules: HashMap<String, String>,
}

pub struct Settings {
    pub values: HashMap<String, String>,
}

// ==========================================
// 4. VISUAL TRANSLATION ENGINE
// ==========================================

/// A saved drag-and-drop clause structure.
pub struct SyntaxGrid {
    pub preset_name: String,
    /// The ordered slots the user dragged into the grid.
    pub slots: Vec<ClauseSlot>,
}

/// The building blocks of the translation grid.
pub enum ClauseSlot {
    /// Looks for a word carrying a specific user-defined tag, e.g. "Subject".
    RequiredTag { tag: String },
    /// A hardcoded conlang particle that must always appear in this slot.
    Literal { text: String },
    /// A flexible space where untagged or secondary words fall.
    Wildcard,
    /// A between-word spacing / join rule; optional custom surface overrides
    /// the global separator.
    Spacer { text: Option<String> },
}
