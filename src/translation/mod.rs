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

    /// Insert a slot at `index`, clamped to the end.
    pub fn insert_slot(&mut self, index: usize, slot: ClauseSlot) {
        let index = index.min(self.slots.len());
        self.slots.insert(index, slot);
    }

    /// Remove the slot at `index`.
    pub fn remove_slot(&mut self, index: usize) -> Option<ClauseSlot> {
        (index < self.slots.len()).then(|| self.slots.remove(index))
    }

    /// Move the slot at `from` so it lands at gap `insert_index`.
    ///
    /// `insert_index` is a gap between slots (`0..=len`). When the source is
    /// before the gap, removing it shifts the target back by one.
    pub fn move_slot(&mut self, from: usize, insert_index: usize) {
        if from >= self.slots.len() {
            return;
        }
        let slot = self.slots.remove(from);
        let target = if insert_index > from {
            insert_index - 1
        } else {
            insert_index
        };
        let target = target.min(self.slots.len());
        self.slots.insert(target, slot);
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
    /// A between-word spacing / join rule.
    Spacer,
}

impl ClauseSlot {
    /// A short label for palette chips and slot cards.
    pub fn label(&self) -> String {
        match self {
            ClauseSlot::RequiredTag { tag } => format!("#{tag}"),
            ClauseSlot::Literal { text } => format!("\"{text}\""),
            ClauseSlot::Wildcard => "*".to_string(),
            ClauseSlot::Spacer => "␣".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(slots: Vec<ClauseSlot>) -> SyntaxGrid {
        SyntaxGrid {
            preset_name: "test".into(),
            slots,
        }
    }

    fn tag(name: &str) -> ClauseSlot {
        ClauseSlot::RequiredTag { tag: name.into() }
    }

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
                ClauseSlot::Spacer,
            ],
        };

        let json = serde_json::to_string(&grid).unwrap();
        let back: SyntaxGrid = serde_json::from_str(&json).unwrap();
        assert_eq!(back, grid);
    }

    #[test]
    fn labels_describe_slots() {
        assert_eq!(tag("Subject").label(), "#Subject");
        assert_eq!(ClauseSlot::Literal { text: "ka".into() }.label(), "\"ka\"");
        assert_eq!(ClauseSlot::Wildcard.label(), "*");
        assert_eq!(ClauseSlot::Spacer.label(), "␣");
    }

    #[test]
    fn insert_and_remove() {
        let mut g = grid(vec![tag("A"), tag("C")]);
        g.insert_slot(1, tag("B"));
        assert_eq!(g.slots, vec![tag("A"), tag("B"), tag("C")]);
        assert_eq!(g.remove_slot(0), Some(tag("A")));
        assert_eq!(g.remove_slot(9), None);
        g.insert_slot(99, tag("Z"));
        assert_eq!(g.slots, vec![tag("B"), tag("C"), tag("Z")]);
    }

    #[test]
    fn move_after_source_shifts_target() {
        let mut g = grid(vec![tag("A"), tag("B"), tag("C")]);
        // move A to the gap after C (index 3): becomes B, C, A
        g.move_slot(0, 3);
        assert_eq!(g.slots, vec![tag("B"), tag("C"), tag("A")]);
    }

    #[test]
    fn move_before_source() {
        let mut g = grid(vec![tag("A"), tag("B"), tag("C")]);
        // move C to the front (gap 0): C, A, B
        g.move_slot(2, 0);
        assert_eq!(g.slots, vec![tag("C"), tag("A"), tag("B")]);
    }

    #[test]
    fn move_into_own_gap_is_identity() {
        let mut g = grid(vec![tag("A"), tag("B"), tag("C")]);
        g.move_slot(1, 1);
        assert_eq!(g.slots, vec![tag("A"), tag("B"), tag("C")]);
        g.move_slot(1, 2);
        assert_eq!(g.slots, vec![tag("A"), tag("B"), tag("C")]);
    }
}
