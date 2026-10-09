//! Persisted tiling layout: tab groups, split trees and secondary windows.
//!
//! Tabs only record *what* they show (a note path or a table name), never the
//! document contents, so a layout is restored by reopening those references.

use serde::{Deserialize, Serialize};

/// What a tab displays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TabKind {
    Note,
    File,
    Table,
    Translation,
    Phonology,
}

/// One persisted tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabLayout {
    pub kind: TabKind,
    /// Note path or table name; absent for the translation tool.
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    pub title: String,
}

/// A pane of tabs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupLayout {
    pub id: String,
    pub tabs: Vec<TabLayout>,
    /// Index into `tabs` of the active tab.
    #[serde(default)]
    pub active: Option<usize>,
}

/// Direction in which a split lays out its children.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitDirection {
    /// Side by side.
    Row,
    /// Stacked.
    Column,
}

/// A node of the recursive split layout.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SplitLayout {
    Leaf {
        group: String,
    },
    Split {
        direction: SplitDirection,
        children: Vec<SplitLayout>,
        /// Child sizes in percent; empty means equal.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        sizes: Vec<f64>,
    },
}

/// The tab groups and split tree of one window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TilingLayout {
    pub groups: Vec<GroupLayout>,
    pub root: SplitLayout,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_group: Option<String>,
}

impl TilingLayout {
    /// Whether the layout holds no tabs at all.
    pub fn is_empty(&self) -> bool {
        self.groups.iter().all(|group| group.tabs.is_empty())
    }
}

/// Window position and size in physical pixels (best effort on Wayland).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowGeometry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    pub width: u32,
    pub height: u32,
}

/// A torn-off window with its own tiling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SecondaryWindow {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry: Option<WindowGeometry>,
    pub tiling: TilingLayout,
}

/// All persisted tiling state for a workspace.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LayoutState {
    /// Tiling of the main window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main: Option<TilingLayout>,
    /// Secondary windows to respawn.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<SecondaryWindow>,
}

impl LayoutState {
    /// Whether nothing is stored.
    pub fn is_empty(&self) -> bool {
        self.main.is_none() && self.windows.is_empty()
    }

    /// Insert or replace a secondary window, keeping its stored geometry when
    /// the caller has none.
    pub fn upsert_window(
        &mut self,
        label: &str,
        geometry: Option<WindowGeometry>,
        tiling: TilingLayout,
    ) {
        match self.windows.iter_mut().find(|window| window.label == label) {
            Some(existing) => {
                if geometry.is_some() {
                    existing.geometry = geometry;
                }
                existing.tiling = tiling;
            }
            None => self.windows.push(SecondaryWindow {
                label: label.to_string(),
                geometry,
                tiling,
            }),
        }
    }

    /// Update only the geometry of a known secondary window.
    pub fn set_window_geometry(&mut self, label: &str, geometry: WindowGeometry) -> bool {
        match self.windows.iter_mut().find(|window| window.label == label) {
            Some(existing) if existing.geometry != Some(geometry) => {
                existing.geometry = Some(geometry);
                true
            }
            _ => false,
        }
    }

    /// Forget a secondary window. Returns whether it existed.
    pub fn remove_window(&mut self, label: &str) -> bool {
        let before = self.windows.len();
        self.windows.retain(|window| window.label != label);
        self.windows.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> TilingLayout {
        TilingLayout {
            groups: vec![
                GroupLayout {
                    id: "g1".into(),
                    tabs: vec![
                        TabLayout {
                            kind: TabKind::Table,
                            reference: Some("roots".into()),
                            title: "roots".into(),
                        },
                        TabLayout {
                            kind: TabKind::Translation,
                            reference: None,
                            title: "Translation".into(),
                        },
                    ],
                    active: Some(1),
                },
                GroupLayout {
                    id: "g2".into(),
                    tabs: vec![TabLayout {
                        kind: TabKind::Note,
                        reference: Some("lore/intro.md".into()),
                        title: "intro.md".into(),
                    }],
                    active: Some(0),
                },
            ],
            root: SplitLayout::Split {
                direction: SplitDirection::Row,
                children: vec![
                    SplitLayout::Leaf { group: "g1".into() },
                    SplitLayout::Leaf { group: "g2".into() },
                ],
                sizes: vec![60.0, 40.0],
            },
            active_group: Some("g2".into()),
        }
    }

    #[test]
    fn tiling_round_trips_through_json() {
        let layout = sample();
        let json = serde_json::to_string(&layout).unwrap();
        assert!(json.contains("\"ref\":\"roots\""));
        assert!(json.contains("\"type\":\"split\""));
        let back: TilingLayout = serde_json::from_str(&json).unwrap();
        assert_eq!(back, layout);
    }

    #[test]
    fn upsert_keeps_geometry_and_remove_forgets_window() {
        let mut state = LayoutState::default();
        assert!(state.is_empty());

        let geometry = WindowGeometry {
            x: Some(10),
            y: None,
            width: 800,
            height: 600,
        };
        state.upsert_window("tear-1", Some(geometry), sample());
        state.upsert_window(
            "tear-1",
            None,
            TilingLayout {
                active_group: None,
                ..sample()
            },
        );
        assert_eq!(state.windows.len(), 1);
        assert_eq!(state.windows[0].geometry, Some(geometry));
        assert_eq!(state.windows[0].tiling.active_group, None);

        let moved = WindowGeometry {
            width: 900,
            ..geometry
        };
        assert!(state.set_window_geometry("tear-1", moved));
        assert!(!state.set_window_geometry("tear-1", moved));
        assert!(!state.set_window_geometry("missing", moved));

        assert!(state.remove_window("tear-1"));
        assert!(!state.remove_window("tear-1"));
        assert!(state.is_empty());
    }
}
