//! A word table: a logical container of words with its own tags (columns).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::entry::WordEntry;
use super::field::FieldType;
use super::tag::{reserved_kind, TagDef, WORDNAME_TAG};

/// The result of changing a tag's field type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagKindChange {
    /// The tag that was migrated.
    pub tag: String,
    /// The previous value type.
    pub from: FieldType,
    /// The new value type.
    pub to: FieldType,
    /// How many words carried a value for the tag.
    pub affected: usize,
    /// How many of those values could not be converted and were dropped.
    pub dropped: usize,
}

/// The result of stripping a tag from a table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagRemoval {
    /// The tag that was removed.
    pub tag: String,
    /// How many words had a value for that tag (now stripped).
    pub affected: usize,
}

/// A user-created bin of words, stored as one extensionless JSON file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WordTable {
    /// Display name, e.g. `all words` or `verbs`.
    pub name: String,
    /// The table's columns. Always contains the builtin `wordname` tag first.
    #[serde(default)]
    pub tags: Vec<TagDef>,
    #[serde(default)]
    pub entries: Vec<WordEntry>,
}

impl WordTable {
    /// Create an empty table containing only the builtin `wordname` tag.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            tags: vec![TagDef::wordname()],
            entries: Vec::new(),
        }
    }

    /// Guarantee the builtin `wordname` tag exists and comes first.
    pub fn ensure_wordname_tag(&mut self) {
        match self.tags.iter().position(|t| t.name == WORDNAME_TAG) {
            Some(0) => {}
            Some(index) => {
                let tag = self.tags.remove(index);
                self.tags.insert(0, tag);
            }
            None => self.tags.insert(0, TagDef::wordname()),
        }
    }

    /// Look up a tag definition by name.
    pub fn tag(&self, name: &str) -> Option<&TagDef> {
        self.tags.iter().find(|t| t.name == name)
    }

    /// Whether this table declares a tag with the given name.
    pub fn has_tag(&self, name: &str) -> bool {
        self.tag(name).is_some()
    }

    /// Add a column. Returns `false` if the table already declares it.
    pub fn add_tag(&mut self, tag: TagDef) -> bool {
        if self.has_tag(&tag.name) {
            return false;
        }
        self.tags.push(tag);
        true
    }

    /// Remove a column and strip its values from every word.
    ///
    /// Returns `None` for the builtin `wordname` tag or an unknown tag. No
    /// word is written unless it actually carried a value for the tag.
    pub fn remove_tag(&mut self, name: &str) -> Option<TagRemoval> {
        if name == WORDNAME_TAG || !self.has_tag(name) {
            return None;
        }

        self.tags.retain(|t| t.name != name);

        let mut affected = 0;
        for entry in &mut self.entries {
            if entry.remove(name).is_some() {
                affected += 1;
            }
        }

        Some(TagRemoval {
            tag: name.to_string(),
            affected,
        })
    }

    /// Change a tag's field type, converting each stored value where possible
    /// and dropping those that cannot be represented.
    ///
    /// Returns `None` for unknown/reserved tags or a no-op change.
    pub fn set_tag_kind(&mut self, name: &str, kind: FieldType) -> Option<TagKindChange> {
        if reserved_kind(name).is_some() {
            return None;
        }
        let from = self.tag(name)?.kind;
        if from == kind {
            return None;
        }
        if let Some(tag) = self.tags.iter_mut().find(|tag| tag.name == name) {
            tag.kind = kind;
        }

        let mut affected = 0;
        let mut dropped = 0;
        for entry in &mut self.entries {
            let Some(value) = entry.values.get(name).cloned() else {
                continue;
            };
            affected += 1;
            match value.coerce_to(kind) {
                Some(converted) => {
                    entry.set(name, converted);
                }
                None => {
                    entry.values.remove(name);
                    dropped += 1;
                }
            }
        }

        Some(TagKindChange {
            tag: name.to_string(),
            from,
            to: kind,
            affected,
            dropped,
        })
    }

    /// Insert an entry.
    pub fn add_entry(&mut self, entry: WordEntry) {
        self.entries.push(entry);
    }

    /// Look up an entry by id.
    pub fn get(&self, id: Uuid) -> Option<&WordEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// Mutably look up an entry by id.
    pub fn get_mut(&mut self, id: Uuid) -> Option<&mut WordEntry> {
        self.entries.iter_mut().find(|e| e.id == id)
    }

    /// Remove an entry by id.
    pub fn remove(&mut self, id: Uuid) -> Option<WordEntry> {
        let index = self.entries.iter().position(|e| e.id == id)?;
        Some(self.entries.remove(index))
    }

    /// How many entries share this exact spelling.
    pub fn homograph_count(&self, wordname: &str) -> usize {
        self.entries
            .iter()
            .filter(|e| e.wordname == wordname)
            .count()
    }

    /// Zero-based position of `id` among entries sharing its spelling.
    pub fn homograph_index(&self, id: Uuid) -> Option<usize> {
        let entry = self.get(id)?;
        let mut ids: Vec<Uuid> = self
            .entries
            .iter()
            .filter(|e| e.wordname == entry.wordname)
            .map(|e| e.id)
            .collect();
        ids.sort_unstable();
        ids.iter().position(|candidate| *candidate == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::field::FieldValue;

    #[test]
    fn new_table_starts_with_wordname() {
        let table = WordTable::new("verbs");
        assert_eq!(table.tags.len(), 1);
        assert_eq!(table.tags[0].name, WORDNAME_TAG);
        assert!(table.tags[0].builtin);
    }

    #[test]
    fn adding_a_column_writes_nothing() {
        let mut table = WordTable::new("verbs");
        let mut entry = WordEntry::new("kala");
        entry.set("transitivity", FieldValue::Text("intransitive".into()));
        table.add_entry(entry);

        table.add_tag(TagDef::new(
            "formality",
            crate::model::field::FieldType::Text,
        ));

        let entry = &table.entries[0];
        assert!(!entry.has("formality"));
        assert_eq!(entry.values.len(), 1);
    }

    #[test]
    fn removing_a_column_strips_values() {
        let mut table = WordTable::new("verbs");
        let mut a = WordEntry::new("kala");
        a.set("transitivity", FieldValue::Text("intransitive".into()));
        let b = WordEntry::new("velo");
        table.add_entry(a);
        table.add_entry(b);
        table.add_tag(TagDef::new(
            "transitivity",
            crate::model::field::FieldType::Text,
        ));

        let removal = table.remove_tag("transitivity").unwrap();
        assert_eq!(removal.affected, 1);
        assert!(!table.entries[0].has("transitivity"));
        assert!(!table.has_tag("transitivity"));
    }

    #[test]
    fn wordname_tag_cannot_be_removed() {
        let mut table = WordTable::new("verbs");
        assert!(table.remove_tag(WORDNAME_TAG).is_none());
        assert!(table.has_tag(WORDNAME_TAG));
    }

    #[test]
    fn homographs_stay_distinct() {
        let mut table = WordTable::new("all words");
        let a = WordEntry::new("kala");
        let b = WordEntry::new("kala");
        let aid = a.id;
        let bid = b.id;
        table.add_entry(a);
        table.add_entry(b);

        assert_eq!(table.homograph_count("kala"), 2);
        let mut indices = [table.homograph_index(aid), table.homograph_index(bid)];
        indices.sort();
        assert_eq!(indices, [Some(0), Some(1)]);
    }

    #[test]
    fn changing_tag_kind_migrates_values() {
        let mut table = WordTable::new("t");
        let mut entry = WordEntry::new("a");
        entry.set("flagged", FieldValue::Text("yes".into()));
        table.add_entry(entry);
        table.add_tag(TagDef::new("flagged", FieldType::Text));

        let change = table.set_tag_kind("flagged", FieldType::Boolean).unwrap();
        assert_eq!(change.affected, 1);
        assert_eq!(change.dropped, 0);
        assert_eq!(
            table.entries[0].get("flagged"),
            Some(&FieldValue::Boolean(true))
        );
        assert_eq!(table.tag("flagged").unwrap().kind, FieldType::Boolean);
    }

    #[test]
    fn unconvertible_values_are_dropped_on_kind_change() {
        let mut table = WordTable::new("t");
        let mut entry = WordEntry::new("a");
        entry.set("ref", FieldValue::Text("not-a-uuid".into()));
        table.add_entry(entry);
        table.add_tag(TagDef::new("ref", FieldType::Text));

        let change = table.set_tag_kind("ref", FieldType::Reference).unwrap();
        assert_eq!(change.affected, 1);
        assert_eq!(change.dropped, 1);
        assert!(!table.entries[0].has("ref"));
    }

    #[test]
    fn reserved_and_unknown_tags_cannot_change_kind() {
        let mut table = WordTable::new("t");
        assert!(table
            .set_tag_kind(WORDNAME_TAG, FieldType::Boolean)
            .is_none());
        assert!(table.set_tag_kind("missing", FieldType::Text).is_none());
    }
}
