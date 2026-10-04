//! The in-memory dictionary: a set of independent word tables.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::entry::WordEntry;
use super::field::FieldValue;
use super::table::{TagRemoval, WordTable};
use super::tag::{TagDef, WORDNAME_TAG};

/// The master database held in memory during runtime.
///
/// Tables are independent logical containers; a word lives in exactly one
/// table. Tags are scoped to the table that declares them.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Dictionary {
    #[serde(default)]
    pub tables: BTreeMap<String, WordTable>,
}

impl Dictionary {
    /// An empty dictionary.
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up a table by name.
    pub fn table(&self, name: &str) -> Option<&WordTable> {
        self.tables.get(name)
    }

    /// Mutably look up a table by name.
    pub fn table_mut(&mut self, name: &str) -> Option<&mut WordTable> {
        self.tables.get_mut(name)
    }

    /// Iterate over every table.
    pub fn tables(&self) -> impl Iterator<Item = &WordTable> {
        self.tables.values()
    }

    /// Iterate over every entry in every table.
    pub fn all_entries(&self) -> impl Iterator<Item = &WordEntry> {
        self.tables.values().flat_map(|t| t.entries.iter())
    }

    /// Table names in sorted order.
    pub fn table_names(&self) -> Vec<&str> {
        self.tables.keys().map(String::as_str).collect()
    }

    /// Create a table. Returns `false` if the name is already taken.
    pub fn add_table(&mut self, name: impl Into<String>) -> bool {
        let name = name.into();
        if self.tables.contains_key(&name) {
            return false;
        }
        self.tables.insert(name.clone(), WordTable::new(name));
        true
    }

    /// Remove a table and all of its words.
    pub fn remove_table(&mut self, name: &str) -> Option<WordTable> {
        self.tables.remove(name)
    }

    /// Ensure a table exists, creating it if needed, and return it.
    pub fn ensure_table(&mut self, name: &str) -> &mut WordTable {
        self.tables
            .entry(name.to_string())
            .or_insert_with(|| WordTable::new(name))
    }

    /// Insert a word into a table.
    pub fn add_entry(&mut self, table: &str, entry: WordEntry) -> Option<Uuid> {
        let table = self.tables.get_mut(table)?;
        let id = entry.id;
        table.add_entry(entry);
        Some(id)
    }

    /// Remove a word from a table.
    pub fn remove_entry(&mut self, table: &str, id: Uuid) -> Option<WordEntry> {
        self.tables.get_mut(table)?.remove(id)
    }

    /// Look up a word within a table.
    pub fn get_entry(&self, table: &str, id: Uuid) -> Option<&WordEntry> {
        self.tables.get(table)?.get(id)
    }

    /// Mutably look up a word within a table.
    pub fn get_entry_mut(&mut self, table: &str, id: Uuid) -> Option<&mut WordEntry> {
        self.tables.get_mut(table)?.get_mut(id)
    }

    /// Find a word anywhere, returning its table name and the entry.
    pub fn find_entry(&self, id: Uuid) -> Option<(&str, &WordEntry)> {
        for (name, table) in &self.tables {
            if let Some(entry) = table.get(id) {
                return Some((name.as_str(), entry));
            }
        }
        None
    }

    /// Move a word between tables. Returns `false` if either table is missing.
    pub fn move_entry(&mut self, from: &str, to: &str, id: Uuid) -> bool {
        if from == to || !self.tables.contains_key(to) {
            return false;
        }
        let entry = match self.tables.get_mut(from).and_then(|t| t.remove(id)) {
            Some(entry) => entry,
            None => return false,
        };
        self.tables
            .get_mut(to)
            .expect("destination checked above")
            .add_entry(entry);
        true
    }

    /// Add a column to a table.
    pub fn add_tag(&mut self, table: &str, tag: TagDef) -> bool {
        self.tables
            .get_mut(table)
            .map(|t| t.add_tag(tag))
            .unwrap_or(false)
    }

    /// Remove a column from a table, stripping its values from its words.
    pub fn remove_tag(&mut self, table: &str, name: &str) -> Option<TagRemoval> {
        self.tables.get_mut(table)?.remove_tag(name)
    }

    /// Every non-builtin tag name used across all tables, for suggestions.
    pub fn known_tag_names(&self) -> BTreeSet<String> {
        self.tables
            .values()
            .flat_map(|t| t.tags.iter())
            .map(|tag| tag.name.clone())
            .filter(|name| name != WORDNAME_TAG)
            .collect()
    }

    /// Words in a table that have a value applied for `tag`.
    pub fn entries_with_tag(&self, table: &str, tag: &str) -> Vec<&WordEntry> {
        match self.tables.get(table) {
            Some(table) => table.entries.iter().filter(|e| e.has(tag)).collect(),
            None => Vec::new(),
        }
    }

    /// Words in a table carrying an exact value under `tag`.
    pub fn entries_with_value(
        &self,
        table: &str,
        tag: &str,
        value: &FieldValue,
    ) -> Vec<&WordEntry> {
        match self.tables.get(table) {
            Some(table) => table
                .entries
                .iter()
                .filter(|e| e.get(tag) == Some(value))
                .collect(),
            None => Vec::new(),
        }
    }

    /// Case-insensitive search across spelling and text/tag-list values.
    pub fn search_in_table(&self, table: &str, query: &str) -> Vec<&WordEntry> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }
        match self.tables.get(table) {
            Some(table) => table
                .entries
                .iter()
                .filter(|e| entry_matches(e, &needle))
                .collect(),
            None => Vec::new(),
        }
    }

    /// Case-insensitive search across every table.
    pub fn search(&self, query: &str) -> Vec<&WordEntry> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }
        self.all_entries()
            .filter(|e| entry_matches(e, &needle))
            .collect()
    }

    /// Direct children derived from `parent_id`, across all tables.
    pub fn children_of(&self, parent_id: Uuid) -> Vec<&WordEntry> {
        self.all_entries()
            .filter(|e| e.parent() == Some(parent_id))
            .collect()
    }

    /// Every descendant derived from `parent_id`, cycle-safe.
    pub fn descendants_of(&self, parent_id: Uuid) -> Vec<&WordEntry> {
        let index: HashMap<Uuid, &WordEntry> = self.all_entries().map(|e| (e.id, e)).collect();

        let mut result = Vec::new();
        let mut visited = HashSet::new();
        visited.insert(parent_id);

        let mut queue: VecDeque<Uuid> = index
            .values()
            .filter(|e| e.parent() == Some(parent_id))
            .map(|e| e.id)
            .collect();

        while let Some(id) = queue.pop_front() {
            if !visited.insert(id) {
                continue;
            }
            if let Some(entry) = index.get(&id) {
                result.push(*entry);
                for child in index.values().filter(|e| e.parent() == Some(id)) {
                    queue.push_back(child.id);
                }
            }
        }

        result
    }

    /// How many words derive from `id` (directly or transitively).
    pub fn dependent_count(&self, id: Uuid) -> usize {
        self.descendants_of(id).len()
    }
}

fn entry_matches(entry: &WordEntry, needle: &str) -> bool {
    if entry.wordname.to_lowercase().contains(needle) {
        return true;
    }
    entry.values.values().any(|value| match value {
        FieldValue::Text(text) => text.to_lowercase().contains(needle),
        FieldValue::TagList(list) => list.iter().any(|s| s.to_lowercase().contains(needle)),
        FieldValue::Boolean(_) | FieldValue::Reference(_) => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::field::FieldType;

    fn seeded() -> Dictionary {
        let mut dict = Dictionary::new();
        dict.add_table("all words");
        dict.add_table("verbs");

        let mut kala = WordEntry::new("kala");
        kala.set("definition", FieldValue::TagList(vec!["to speak".into()]));
        let kala_id = kala.id;
        dict.add_entry("all words", kala);

        let mut velo = WordEntry::new("velo");
        velo.set_parent(kala_id);
        velo.set("transitivity", FieldValue::Text("intransitive".into()));
        dict.add_entry("verbs", velo);
        dict.add_tag("verbs", TagDef::new("transitivity", FieldType::Text));

        dict
    }

    #[test]
    fn tables_are_independent_and_tags_are_not_shared() {
        let mut dict = seeded();
        dict.add_tag("verbs", TagDef::new("formality", FieldType::Text));

        assert!(dict.table("verbs").unwrap().has_tag("formality"));
        assert!(!dict.table("all words").unwrap().has_tag("formality"));
    }

    #[test]
    fn known_tag_names_are_suggested_across_tables() {
        let mut dict = seeded();
        dict.add_tag("verbs", TagDef::new("formality", FieldType::Text));

        let names = dict.known_tag_names();
        assert!(names.contains("formality"));
        assert!(names.contains("transitivity"));
        assert!(!names.contains(WORDNAME_TAG));
    }

    #[test]
    fn derivation_spans_tables() {
        let dict = seeded();
        let kala = dict
            .table("all words")
            .unwrap()
            .entries
            .iter()
            .find(|e| e.wordname == "kala")
            .unwrap();
        assert_eq!(dict.children_of(kala.id).len(), 1);
        assert_eq!(dict.dependent_count(kala.id), 1);
    }

    #[test]
    fn move_entry_between_tables() {
        let mut dict = seeded();
        let id = dict.table("verbs").unwrap().entries[0].id;

        assert!(dict.move_entry("verbs", "all words", id));
        assert!(dict.table("verbs").unwrap().entries.is_empty());
        assert!(dict.get_entry("all words", id).is_some());
        assert!(!dict.move_entry("verbs", "missing", id));
    }

    #[test]
    fn search_matches_wordname_and_values() {
        let dict = seeded();
        assert_eq!(dict.search("kala").len(), 1);
        assert_eq!(dict.search("speak").len(), 1);
        assert_eq!(dict.search("intransitive").len(), 1);
        assert_eq!(dict.search("missing").len(), 0);
        assert_eq!(dict.search("  ").len(), 0);
    }

    #[test]
    fn removing_tag_reports_affected_words() {
        let mut dict = seeded();
        let removal = dict.remove_tag("verbs", "transitivity").unwrap();
        assert_eq!(removal.affected, 1);
        assert!(!dict.table("verbs").unwrap().has_tag("transitivity"));
    }
}
