//! The visual translation / syntax builder model.

use serde::{Deserialize, Serialize};

/// A saved drag-and-drop clause structure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyntaxGrid {
    /// The user-facing preset name, e.g. "Standard SVO".
    pub preset_name: String,
    /// The ordered slots the user dragged into the grid.
    #[serde(default)]
    pub slots: Vec<ClauseSlot>,
}

impl SyntaxGrid {
    /// Create an empty preset.
    pub fn new(preset_name: impl Into<String>) -> Self {
        Self {
            preset_name: preset_name.into(),
            slots: Vec::new(),
        }
    }
}

/// The building blocks of the translation grid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClauseSlot {
    /// Looks for a word carrying a specific user-defined tag, e.g. "Subject".
    RequiredTag { tag: String },
    /// A hardcoded conlang particle that must always appear in this slot.
    Literal { text: String },
    /// A flexible space where untagged or secondary words fall.
    Wildcard,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn syntax_grid_round_trips() {
        let grid = SyntaxGrid {
            preset_name: "Standard SVO".into(),
            slots: vec![
                ClauseSlot::RequiredTag {
                    tag: "Subject".into(),
                },
                ClauseSlot::Literal { text: "ka".into() },
                ClauseSlot::RequiredTag { tag: "Verb".into() },
                ClauseSlot::Wildcard,
            ],
        };

        let json = serde_json::to_string(&grid).unwrap();
        let back: SyntaxGrid = serde_json::from_str(&json).unwrap();
        assert_eq!(back, grid);
    }
}
