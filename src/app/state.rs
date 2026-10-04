//! UI state and pure navigation helpers.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use uuid::Uuid;

use crate::model::query::TableQuery;
use crate::model::FieldType;
use crate::translation::SyntaxGrid;

/// A tab in the central dock area.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Tab {
    Welcome,
    Notes(PathBuf),
    Dictionary(String),
    Translation,
}

impl Tab {
    /// Short title shown in the tab bar.
    pub fn title(&self) -> String {
        match self {
            Tab::Welcome => "Welcome".to_string(),
            Tab::Notes(path) => match path.file_name() {
                Some(name) => name.to_string_lossy().into_owned(),
                None => path.display().to_string(),
            },
            Tab::Dictionary(table) => table.clone(),
            Tab::Translation => "Translation".to_string(),
        }
    }
}

/// A parsed omni-search command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandFilter {
    /// Free-text search across all tables.
    Global(String),
    /// Entries carrying a given tag anywhere.
    Tag(String),
    /// Entries whose English definition matches the text.
    Definition(String),
}

/// Parse the command bar input, honoring `tag:` and `def:` prefixes.
pub fn parse_command(input: &str) -> Option<CommandFilter> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(value) = trimmed.strip_prefix("tag:") {
        let value = value.trim();
        return (!value.is_empty()).then(|| CommandFilter::Tag(value.to_string()));
    }
    if let Some(value) = trimmed.strip_prefix("def:") {
        let value = value.trim();
        return (!value.is_empty()).then(|| CommandFilter::Definition(value.to_string()));
    }
    Some(CommandFilter::Global(trimmed.to_string()))
}

/// A reference to a word within a table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WordRef {
    pub table: String,
    pub id: Uuid,
}

/// A pending confirmation to remove a tag column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagRemovalRequest {
    pub table: String,
    pub tag: String,
    pub affected: usize,
}

/// An in-progress raw edit of one region of a note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteEdit {
    /// The note this edit belongs to.
    pub note: PathBuf,
    /// Absolute byte offset where the edited region starts.
    pub start: usize,
    /// Absolute byte offset where the edited region ends.
    pub end: usize,
    /// The raw region buffer being edited.
    pub buffer: String,
}

/// An action requested by the UI to run against the workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitAction {
    Init,
    Checkin(String),
}

/// A structural word change that may have dependents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingChange {
    Rename {
        table: String,
        id: Uuid,
        old: String,
        new: String,
    },
    Delete {
        table: String,
        id: Uuid,
        name: String,
    },
}

impl PendingChange {
    /// The id of the word being changed.
    pub fn id(&self) -> Uuid {
        match self {
            PendingChange::Rename { id, .. } | PendingChange::Delete { id, .. } => *id,
        }
    }

    /// The table the changed word belongs to.
    pub fn table(&self) -> &str {
        match self {
            PendingChange::Rename { table, .. } | PendingChange::Delete { table, .. } => table,
        }
    }
}

/// A word that depends on the changed word.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependentInfo {
    pub table: String,
    pub id: Uuid,
    pub wordname: String,
}

/// A pending dependency warning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependencyPrompt {
    pub change: PendingChange,
    pub dependents: Vec<DependentInfo>,
}

/// One editable row of the manual-convert modal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualRow {
    pub table: String,
    pub id: Uuid,
    pub original: String,
    pub text: String,
    pub delete: bool,
}

/// State for the manual-convert modal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualConvert {
    pub change: PendingChange,
    pub rows: Vec<ManualRow>,
}

/// State for the parent picker modal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParentPicker {
    pub table: String,
    pub child: Uuid,
    pub filter: String,
}

/// An in-progress inline rename draft for a grid cell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftRename {
    pub base: String,
    pub text: String,
}

/// Per-table dictionary grid state: sort, filters, hidden columns, search.
#[derive(Debug, Clone, Default)]
pub struct GridView {
    pub query: TableQuery,
    pub hidden: HashSet<String>,
    pub search_open: Option<String>,
    pub focus_search: bool,
}

/// The drag payload carried by the translation builder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuilderPayload {
    Tag(String),
    Literal,
    Wildcard,
    Spacer,
    /// Move the slot at this index.
    Move(usize),
}

/// State for the translation syntax-grid builder.
#[derive(Debug, Clone)]
pub struct TranslationState {
    /// The grid currently being edited.
    pub draft: SyntaxGrid,
    /// Name of the preset the draft was loaded from, if any.
    pub loaded: Option<String>,
    /// Text used when adding a literal slot.
    pub new_literal: String,
}

impl Default for TranslationState {
    fn default() -> Self {
        Self {
            draft: SyntaxGrid::new("New preset"),
            loaded: None,
            new_literal: String::new(),
        }
    }
}

/// Transient UI state, independent of the workspace.
#[derive(Debug, Default)]
pub struct UiState {
    /// Command bar text.
    pub command_query: String,
    /// Set to request focus on the command bar next frame.
    pub focus_command: bool,
    /// Whether the source-control panel is shown.
    pub git_panel_open: bool,
    /// Currently selected word, if any.
    pub selected_word: Option<WordRef>,
    /// Currently selected note, if any.
    pub selected_note: Option<PathBuf>,
    /// Active raw region edit in the notes view.
    pub note_edit: Option<NoteEdit>,
    /// Whether the notes view is in whole-note raw mode.
    pub raw_mode: bool,
    /// Set to request focus on the active note editor next frame.
    pub focus_edit: bool,
    /// Pending dependency warning.
    pub dependency_prompt: Option<DependencyPrompt>,
    /// Manual-convert modal state.
    pub manual_convert: Option<ManualConvert>,
    /// Parent picker modal state.
    pub parent_picker: Option<ParentPicker>,
    /// Pending parent removal as `(table, child, parent)`.
    pub remove_parent: Option<(String, Uuid, Uuid)>,
    /// Inline rename drafts keyed by `(table, id)`.
    pub rename_drafts: HashMap<(String, Uuid), DraftRename>,
    /// Per-table grid view state (sort, filter, hidden columns, search).
    pub grid_views: HashMap<String, GridView>,
    /// Translation syntax-grid builder state.
    pub translation: TranslationState,
    /// Pending tag-removal confirmation.
    pub pending_tag_removal: Option<TagRemovalRequest>,
    /// Whether the user dismissed the git init/install prompt.
    pub git_prompt_dismissed: bool,
    /// New table name input.
    pub new_table_name: String,
    /// New word name input (bound to the active table).
    pub new_wordname: String,
    /// New tag name input.
    pub new_tag_name: String,
    /// New tag kind.
    pub new_tag_kind: FieldType,
    /// Commit message input.
    pub commit_message: String,
    /// Requested git action.
    pub git_action: Option<GitAction>,
    /// Pending change to the auto-check-in setting (enabled, seconds).
    pub set_auto_checkin: Option<(bool, u64)>,
    /// Tabs requested to be opened by child views.
    pub open_tabs: Vec<Tab>,
    /// Last status message.
    pub status: Option<String>,
}

impl UiState {
    /// New state with sensible defaults.
    pub fn new() -> Self {
        Self {
            new_tag_kind: FieldType::Text,
            ..Default::default()
        }
    }

    /// Request a tab be opened (or focused) after this frame.
    pub fn request_tab(&mut self, tab: Tab) {
        if !self.open_tabs.contains(&tab) {
            self.open_tabs.push(tab);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_command_prefixes() {
        assert_eq!(parse_command(""), None);
        assert_eq!(parse_command("   "), None);
        assert_eq!(parse_command("tag:"), None);
        assert_eq!(
            parse_command("kala"),
            Some(CommandFilter::Global("kala".into()))
        );
        assert_eq!(
            parse_command("tag: verb "),
            Some(CommandFilter::Tag("verb".into()))
        );
        assert_eq!(
            parse_command("def: to speak"),
            Some(CommandFilter::Definition("to speak".into()))
        );
    }

    #[test]
    fn tab_titles_use_file_names() {
        assert_eq!(Tab::Welcome.title(), "Welcome");
        assert_eq!(
            Tab::Notes(PathBuf::from("Grammar/phonology")).title(),
            "phonology"
        );
        assert_eq!(Tab::Dictionary("verbs".into()).title(), "verbs");
    }

    #[test]
    fn request_tab_deduplicates() {
        let mut state = UiState::new();
        state.request_tab(Tab::Translation);
        state.request_tab(Tab::Translation);
        assert_eq!(state.open_tabs.len(), 1);
    }

    #[test]
    fn default_tag_kind_is_text() {
        assert_eq!(UiState::new().new_tag_kind, FieldType::Text);
    }
}
