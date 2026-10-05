//! Per-workspace application settings.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

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
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            auto_checkin: true,
            auto_checkin_secs: DEFAULT_AUTO_CHECKIN_SECS,
            default_table: None,
            grid_views: BTreeMap::new(),
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
            },
        );
        let json = serde_json::to_string(&settings).unwrap();
        let back: WorkspaceSettings = serde_json::from_str(&json).unwrap();
        let view = &back.grid_views["verbs"];
        assert_eq!(view.sorting[0].id, "wordname");
        assert_eq!(view.search, "ka");
        assert_eq!(view.hidden_columns, ["parent"]);
    }
}
