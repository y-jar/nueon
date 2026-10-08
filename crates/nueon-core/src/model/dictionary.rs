//! The in-memory dictionary: a set of independent word tables.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::entry::WordEntry;
use super::field::FieldValue;
use super::table::{TagRemoval, WordTable};
use super::tag::{TagDef, DEFINITION_TAG, PARENT_TAG, WORDNAME_TAG};

/// A dictionary entry matching a spelling, for editor highlighting/hover.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WordHit {
    pub id: Uuid,
    pub table: String,
    pub wordname: String,
    /// English senses (`definition` tag).
    pub senses: Vec<String>,
    /// Non-reserved tag names applied to the entry.
    pub tags: Vec<String>,
}

impl WordHit {
    /// Build a hit for `entry`, which lives in `table`.
    pub fn from_entry(table: &str, entry: &WordEntry) -> Self {
        Self {
            id: entry.id,
            table: table.to_string(),
            wordname: entry.wordname.clone(),
            senses: entry
                .definition()
                .map(<[String]>::to_vec)
                .unwrap_or_default(),
            tags: entry
                .values
                .keys()
                .filter(|name| *name != DEFINITION_TAG && *name != PARENT_TAG)
                .cloned()
                .collect(),
        }
    }
}

fn word_hit(table: &str, entry: &WordEntry) -> WordHit {
    WordHit::from_entry(table, entry)
}

/// Whether `needle` occurs in `haystack` as a whole word (an alphanumeric
/// boundary on each side), not merely as a substring. Used by the translator
/// so a one-letter token like `i` cannot match every gloss containing an "i".
pub(crate) fn contains_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let hay: Vec<char> = haystack.chars().collect();
    let nee: Vec<char> = needle.chars().collect();
    if nee.len() > hay.len() {
        return false;
    }
    let is_word = |c: char| c.is_alphanumeric();
    for start in 0..=(hay.len() - nee.len()) {
        if hay[start..start + nee.len()] == nee[..] {
            let before = start == 0 || !is_word(hay[start - 1]);
            let after = start + nee.len() == hay.len() || !is_word(hay[start + nee.len()]);
            if before && after {
                return true;
            }
        }
    }
    false
}

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

    /// The same search, as [`WordHit`]s (with table name and senses), for the
    /// translator's suggestions.
    pub fn search_hits(&self, query: &str) -> Vec<WordHit> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }
        let mut hits = Vec::new();
        for table in self.tables() {
            for entry in &table.entries {
                if entry_matches_word(entry, &needle) {
                    hits.push(word_hit(&table.name, entry));
                }
            }
        }
        hits
    }

    /// How many entries share this exact spelling across all tables.
    pub fn homograph_count(&self, wordname: &str) -> usize {
        self.all_entries()
            .filter(|entry| entry.wordname == wordname)
            .count()
    }

    /// Zero-based position of `id` among entries sharing its spelling,
    /// ordered by id. Used to render *word¹*, *word²*, … in editor views.
    pub fn homograph_index(&self, id: Uuid) -> Option<usize> {
        let wordname = &self.find_entry(id)?.1.wordname;
        let mut ids: Vec<Uuid> = self
            .all_entries()
            .filter(|entry| entry.wordname == *wordname)
            .map(|entry| entry.id)
            .collect();
        ids.sort_unstable();
        ids.iter().position(|candidate| *candidate == id)
    }

    /// All entries matching `wordname` (case-insensitive), ordered by id.
    pub fn word_hits(&self, wordname: &str) -> Vec<WordHit> {
        let needle = wordname.to_lowercase();
        let mut hits = Vec::new();
        for table in self.tables() {
            for entry in &table.entries {
                if entry.wordname.to_lowercase() == needle {
                    hits.push(word_hit(&table.name, entry));
                }
            }
        }
        hits.sort_by_key(|hit| hit.id);
        hits
    }

    /// Index from lowercased wordname to its entries (for the editor).
    pub fn word_index(&self) -> BTreeMap<String, Vec<WordHit>> {
        let mut map: BTreeMap<String, Vec<WordHit>> = BTreeMap::new();
        for table in self.tables() {
            for entry in &table.entries {
                map.entry(entry.wordname.to_lowercase())
                    .or_default()
                    .push(word_hit(&table.name, entry));
            }
        }
        for hits in map.values_mut() {
            hits.sort_by_key(|hit| hit.id);
        }
        map
    }

    /// Entries that directly list `parent_id` as a parent, across all tables.
    pub fn children_of(&self, parent_id: Uuid) -> Vec<&WordEntry> {
        self.all_entries()
            .filter(|entry| entry.parents().contains(&parent_id))
            .collect()
    }

    /// The parent ids of `child_id`.
    pub fn parents_of(&self, child_id: Uuid) -> Vec<Uuid> {
        self.find_entry(child_id)
            .map(|(_, entry)| entry.parents())
            .unwrap_or_default()
    }

    /// The parent entries of `child_id`, with their table names. Missing
    /// parents (dangling links) are skipped.
    pub fn parent_entries(&self, child_id: Uuid) -> Vec<(&str, &WordEntry)> {
        self.parents_of(child_id)
            .into_iter()
            .filter_map(|id| self.find_entry(id))
            .collect()
    }

    /// Every ancestor of `id`, cycle-safe.
    pub fn ancestors_of(&self, id: Uuid) -> Vec<&WordEntry> {
        let index: HashMap<Uuid, &WordEntry> = self.all_entries().map(|e| (e.id, e)).collect();

        let mut result = Vec::new();
        let mut visited = HashSet::new();
        visited.insert(id);

        let mut queue: VecDeque<Uuid> = index
            .get(&id)
            .map(|entry| entry.parents())
            .unwrap_or_default()
            .into();

        while let Some(parent_id) = queue.pop_front() {
            if !visited.insert(parent_id) {
                continue;
            }
            if let Some(entry) = index.get(&parent_id) {
                result.push(*entry);
                for parent in entry.parents() {
                    queue.push_back(parent);
                }
            }
        }

        result
    }

    /// Every descendant of `parent_id` across all parent branches, cycle-safe.
    pub fn descendants_of(&self, parent_id: Uuid) -> Vec<&WordEntry> {
        let index: HashMap<Uuid, &WordEntry> = self.all_entries().map(|e| (e.id, e)).collect();

        let mut result = Vec::new();
        let mut visited = HashSet::new();
        visited.insert(parent_id);

        let mut queue: VecDeque<Uuid> = index
            .values()
            .filter(|entry| entry.parents().contains(&parent_id))
            .map(|entry| entry.id)
            .collect();

        while let Some(id) = queue.pop_front() {
            if !visited.insert(id) {
                continue;
            }
            if let Some(entry) = index.get(&id) {
                result.push(*entry);
                for child in index.values().filter(|e| e.parents().contains(&id)) {
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

    /// Whether `parent_id` may be added as a parent of `child_id` without
    /// creating a cycle. A word cannot parent itself or its own descendant.
    pub fn can_be_parent(&self, child_id: Uuid, parent_id: Uuid) -> bool {
        if child_id == parent_id {
            return false;
        }
        !self
            .descendants_of(child_id)
            .iter()
            .any(|entry| entry.id == parent_id)
    }

    /// Add `parent_id` to `child_id`'s parents, rejecting cycles.
    pub fn add_parent(&mut self, table: &str, child_id: Uuid, parent_id: Uuid) -> bool {
        if !self.can_be_parent(child_id, parent_id) {
            return false;
        }
        match self.get_entry_mut(table, child_id) {
            Some(entry) => {
                entry.add_parent(parent_id);
                true
            }
            None => false,
        }
    }

    /// Remove `parent_id` from `child_id`'s parents.
    pub fn remove_parent(&mut self, table: &str, child_id: Uuid, parent_id: Uuid) -> bool {
        match self.get_entry_mut(table, child_id) {
            Some(entry) => entry.remove_parent(parent_id),
            None => false,
        }
    }
}

fn entry_matches(entry: &WordEntry, needle: &str) -> bool {
    if entry.wordname.to_lowercase().contains(needle) {
        return true;
    }
    entry.values.values().any(|value| match value {
        FieldValue::Text(text) => text.to_lowercase().contains(needle),
        FieldValue::TagList(list) => list.iter().any(|s| s.to_lowercase().contains(needle)),
        FieldValue::Boolean(_) | FieldValue::Reference(_) | FieldValue::References(_) => false,
    })
}

/// Whole-word version of [`entry_matches`], used for the translator's
/// suggestions so short queries don't match everything.
fn entry_matches_word(entry: &WordEntry, needle: &str) -> bool {
    if contains_word(&entry.wordname.to_lowercase(), needle) {
        return true;
    }
    entry.values.values().any(|value| match value {
        FieldValue::Text(text) => contains_word(&text.to_lowercase(), needle),
        FieldValue::TagList(list) => list
            .iter()
            .any(|sense| contains_word(&sense.to_lowercase(), needle)),
        FieldValue::Boolean(_) | FieldValue::Reference(_) | FieldValue::References(_) => false,
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

    #[test]
    fn multi_parent_union_and_ancestors() {
        let mut dict = Dictionary::new();
        dict.add_table("t");

        let a = WordEntry::new("a");
        let a_id = a.id;
        dict.add_entry("t", a);
        let b = WordEntry::new("b");
        let b_id = b.id;
        dict.add_entry("t", b);

        let mut c = WordEntry::new("c");
        let c_id = c.id;
        c.add_parent(a_id);
        c.add_parent(b_id);
        dict.add_entry("t", c);

        let mut d = WordEntry::new("d");
        let d_id = d.id;
        d.add_parent(c_id);
        dict.add_entry("t", d);

        assert_eq!(dict.descendants_of(a_id).len(), 2);
        assert_eq!(dict.descendants_of(b_id).len(), 2);
        assert_eq!(dict.ancestors_of(d_id).len(), 3);
        assert_eq!(dict.children_of(c_id).len(), 1);
        assert!(!dict.can_be_parent(a_id, d_id));
        assert!(dict.can_be_parent(d_id, a_id));
    }

    #[test]
    fn global_homograph_index_spans_tables() {
        let mut dict = Dictionary::new();
        dict.add_table("one");
        dict.add_table("two");
        let first = WordEntry::new("kala");
        let first_id = first.id;
        dict.add_entry("one", first);
        let second = WordEntry::new("kala");
        let second_id = second.id;
        dict.add_entry("two", second);

        assert_eq!(dict.homograph_count("kala"), 2);
        let mut indices = [
            dict.homograph_index(first_id),
            dict.homograph_index(second_id),
        ];
        indices.sort();
        assert_eq!(indices, [Some(0), Some(1)]);
        assert_eq!(dict.homograph_index(Uuid::new_v4()), None);
    }

    #[test]
    fn word_index_groups_senses_and_tags() {
        let mut dict = Dictionary::new();
        dict.add_table("lexicon");

        let mut a = WordEntry::new("kala");
        a.set(DEFINITION_TAG, FieldValue::TagList(vec!["to speak".into()]));
        a.set("pos", FieldValue::Text("verb".into()));
        let aid = a.id;
        dict.add_entry("lexicon", a);

        let b = WordEntry::new("Kala");
        let bid = b.id;
        dict.add_entry("lexicon", b);

        let index = dict.word_index();
        let hits = index.get("kala").expect("case-insensitive key");
        assert_eq!(hits.len(), 2);

        let mut ids = [hits[0].id, hits[1].id];
        ids.sort();
        let mut expected = [aid, bid];
        expected.sort();
        assert_eq!(ids, expected);

        let with_sense = hits.iter().find(|h| !h.senses.is_empty()).unwrap();
        assert_eq!(with_sense.senses, ["to speak"]);
        assert!(with_sense.tags.contains(&"pos".to_string()));
        assert_eq!(dict.word_hits("KALA").len(), 2);
    }
}
