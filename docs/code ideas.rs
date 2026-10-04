use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;

// ==========================================
// 1. DYNAMIC DICTIONARY & ENTRIES
// ==========================================

/// The master database held in memory during runtime.
pub struct Dictionary {
    /// O(1) lookup by UUID. This solves the homograph problem.
    pub entries: HashMap<Uuid, WordEntry>,
    /// Tracks the custom categories the user has created (e.g., "Transitivity", "Formality")
    pub custom_schema: HashMap<String, FieldType>,
}

/// A single conlang word entry.
pub struct WordEntry {
    /// Hidden unique identifier to distinguish identical words.
    pub id: Uuid,
    /// The base conlang spelling.
    pub wordname: String,
    /// English definitions (checked against the misspelling guard).
    pub translations: Vec<String>,
    /// Etymology tracking. Links to the UUID of the root/parent word.
    pub parent_id: Option<Uuid>,
    /// The dynamic schema payload. Keys are category names (e.g., "PartOfSpeech").
    pub custom_fields: HashMap<String, FieldValue>,
}

// ==========================================
// 2. DYNAMIC FIELD HANDLING
// ==========================================

/// Defines the expected data type for a custom user category.
pub enum FieldType {
    Text,
    Boolean,
    TagList,
}

/// Holds the actual data for a custom field in a WordEntry.
pub enum FieldValue {
    Text(String),          // e.g., Notes: "Used only in formal settings"
    Boolean(bool),         // e.g., IsVulgar: true
    TagList(Vec<String>),  // e.g., Class: ["Verb", "Transitive"]
}

// ==========================================
// 3. WORKSPACE & NOTES
// ==========================================

/// Represents the physical workspace directory on the user's machine.
pub struct Workspace {
    pub root_path: PathBuf,
    pub dictionary: Dictionary,
    pub notes: Vec<NoteFile>,
    pub translation_presets: Vec<SyntaxGrid>,
}

/// A single extensionless note file.
pub struct NoteFile {
    /// The relative path/filename (e.g., "Grammar/phonology").
    pub path: PathBuf,
    /// The raw Markdown text to be fed into the live-preview renderer.
    pub raw_content: String,
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
    /// Looks for a word containing a specific user-defined tag (e.g., "Subject").
    RequiredTag(String),
    /// A hardcoded conlang particle that must always appear in this slot.
    Literal(String),
    /// A flexible space where untagged or secondary words fall.
    Wildcard,
}