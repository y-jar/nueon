//! UI state and pure navigation helpers.

use std::path::PathBuf;

use uuid::Uuid;

use crate::model::FieldType;

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

/// An action requested by the UI to run against the workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitAction {
    Init,
    Checkin(String),
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
