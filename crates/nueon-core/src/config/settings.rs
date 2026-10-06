//! Per-workspace application settings.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::layout::LayoutState;

/// Default auto-check-in interval, in seconds.
pub const DEFAULT_AUTO_CHECKIN_SECS: u64 = 60;

/// A single sort key applied to the dictionary grid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SortSpec {
    /// Column id (tag name).
    pub id: String,
    /// Whether the sort is descending.
    #[serde(default)]
    pub desc: bool,
}

/// Persisted presentation state for one table's grid.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GridViewState {
    /// Sort keys, in priority order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sorting: Vec<SortSpec>,
    /// Global search text.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub search: String,
    /// Per-column filter text, keyed by column id.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub column_filters: BTreeMap<String, String>,
    /// Column ids the user has hidden.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hidden_columns: Vec<String>,
    /// Column ids in the user's preferred display order; empty means default.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub column_order: Vec<String>,
    /// User-adjusted column widths in pixels, keyed by column id.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub column_widths: BTreeMap<String, u32>,
}

/// Persisted shell layout (activity, panels) for the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct UiLayout {
    /// Active activity ribbon item: `notes`, `dictionary`, `translation`, `git`.
    pub activity: String,
    /// Whether the sidebar is shown.
    pub sidebar_open: bool,
    /// Whether the inspector is shown.
    pub inspector_open: bool,
    /// Inspector dock side: `left` or `right`.
    pub inspector_dock: String,
}

impl Default for UiLayout {
    fn default() -> Self {
        Self {
            activity: "notes".to_string(),
            sidebar_open: true,
            inspector_open: false,
            inspector_dock: "right".to_string(),
        }
    }
}

/// User preferences stored in `config/settings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceSettings {
    /// Whether to automatically check changes into git.
    pub auto_checkin: bool,
    /// Idle debounce before an automatic check-in, in seconds.
    pub auto_checkin_secs: u64,
    /// Table to open by default, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_table: Option<String>,
    /// Per-table grid presentation state, keyed by table name.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub grid_views: BTreeMap<String, GridViewState>,
    /// Whether the user dismissed the git init/install prompt for good.
    pub git_prompt_dismissed: bool,
    /// Keys of one-time warnings the user silenced.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dismissed_warnings: Vec<String>,
    /// Persisted shell layout.
    pub ui: UiLayout,
    /// Whether legacy extensionless/`.txt` notes were converted to `.md`.
    pub notes_migrated: bool,
    /// Whether on-disk table-filename collisions (from before filenames were
    /// resolved once and kept stable) were checked for and repaired.
    pub table_filenames_migrated: bool,
    /// Persisted tab groups, splits and secondary windows.
    #[serde(skip_serializing_if = "LayoutState::is_empty")]
    pub layout: LayoutState,
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            auto_checkin: true,
            auto_checkin_secs: DEFAULT_AUTO_CHECKIN_SECS,
            default_table: None,
            grid_views: BTreeMap::new(),
            git_prompt_dismissed: false,
            dismissed_warnings: Vec::new(),
            ui: UiLayout::default(),
            notes_migrated: false,
            table_filenames_migrated: false,
            layout: LayoutState::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_apply() {
        let settings: WorkspaceSettings = serde_json::from_str("{}").unwrap();
        assert!(settings.auto_checkin);
        assert_eq!(settings.auto_checkin_secs, DEFAULT_AUTO_CHECKIN_SECS);
        assert!(settings.grid_views.is_empty());
    }

    #[test]
    fn grid_view_round_trips() {
        let mut settings = WorkspaceSettings::default();
        settings.grid_views.insert(
            "verbs".into(),
            GridViewState {
                sorting: vec![SortSpec {
                    id: "wordname".into(),
                    desc: true,
                }],
                search: "ka".into(),
                column_filters: BTreeMap::from([("pos".into(), "verb".into())]),
                hidden_columns: vec!["parent".into()],
                column_order: vec!["wordname".into(), "def".into()],
                column_widths: BTreeMap::from([("def".into(), 240)]),
            },
        );
        let json = serde_json::to_string(&settings).unwrap();
        let back: WorkspaceSettings = serde_json::from_str(&json).unwrap();
        let view = &back.grid_views["verbs"];
        assert_eq!(view.sorting[0].id, "wordname");
        assert_eq!(view.search, "ka");
        assert_eq!(view.hidden_columns, ["parent"]);
        assert_eq!(view.column_order, ["wordname", "def"]);
        assert_eq!(view.column_widths["def"], 240);
    }
}
