//! A single dictionary entry (a word object).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::field::FieldValue;
use super::tag::{DEFINITION_TAG, PARENT_TAG, WORDNAME_TAG};

/// A single conlang word entry.
///
/// A word is defined by its tag values. `wordname` is the builtin starting tag
/// and is stored explicitly; every other tag lives in the sparse [`values`]
/// map. A tag is present only once a value has actually been applied, so a
/// word never carries empty tags.
///
/// [`values`]: WordEntry::values
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WordEntry {
    /// Hidden unique identifier that keeps homographs distinct.
    pub id: Uuid,
    /// The builtin starting tag. Always present.
    pub wordname: String,
    /// Sparse map of tag name to applied value.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub values: BTreeMap<String, FieldValue>,
}

impl WordEntry {
    /// Create a new entry with a fresh UUID.
    pub fn new(wordname: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            wordname: wordname.into(),
            values: BTreeMap::new(),
        }
    }

    /// The value applied under `tag`, if any (null otherwise).
    pub fn get(&self, tag: &str) -> Option<&FieldValue> {
        self.values.get(tag)
    }

    /// Apply a value under `tag`.
    ///
    /// `wordname` is stored separately; attempting to set it through this
    /// method returns `None` and leaves the entry unchanged.
    pub fn set(&mut self, tag: &str, value: FieldValue) -> Option<FieldValue> {
        if tag == WORDNAME_TAG {
            return None;
        }
        self.values.insert(tag.to_string(), value)
    }

    /// Remove a tag's value. Removing an absent tag is a no-op.
    pub fn remove(&mut self, tag: &str) -> Option<FieldValue> {
        self.values.remove(tag)
    }

    /// Whether the word has a value applied for `tag`.
    pub fn has(&self, tag: &str) -> bool {
        self.values.contains_key(tag)
    }

    /// The English definition senses, if applied.
    pub fn definition(&self) -> Option<&[String]> {
        match self.values.get(DEFINITION_TAG) {
            Some(FieldValue::TagList(senses)) => Some(senses),
            _ => None,
        }
    }

    /// The root/parent words this entry derives from (may be empty).
    ///
    /// Reads both the multi-value `References` form and the legacy single
    /// `Reference` form.
    pub fn parents(&self) -> Vec<Uuid> {
        match self.values.get(PARENT_TAG) {
            Some(FieldValue::Reference(id)) => vec![*id],
            Some(FieldValue::References(ids)) => ids.clone(),
            _ => Vec::new(),
        }
    }

    /// Replace the parent list. An empty list removes the tag (sparse).
    pub fn set_parents(&mut self, parents: &[Uuid]) {
        if parents.is_empty() {
            self.values.remove(PARENT_TAG);
        } else {
            self.values.insert(
                PARENT_TAG.to_string(),
                FieldValue::References(parents.to_vec()),
            );
        }
    }

    /// Add a parent if it is not already present.
    pub fn add_parent(&mut self, parent: Uuid) {
        let mut parents = self.parents();
        if !parents.contains(&parent) {
            parents.push(parent);
            self.set_parents(&parents);
        }
    }

    /// Remove a parent. Returns whether it was present.
    pub fn remove_parent(&mut self, parent: Uuid) -> bool {
        let mut parents = self.parents();
        let before = parents.len();
        parents.retain(|candidate| *candidate != parent);
        if parents.len() == before {
            return false;
        }
        self.set_parents(&parents);
        true
    }

    /// The first parent, if any. Convenience for single-parent callers.
    pub fn parent(&self) -> Option<Uuid> {
        self.parents().first().copied()
    }

    /// Set a single parent (replacing any existing parents).
    pub fn set_parent(&mut self, parent_id: Uuid) {
        self.set_parents(&[parent_id]);
    }

    /// Whether this entry is derived from one or more root/parent words.
    pub fn has_parent(&self) -> bool {
        !self.parents().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_are_sparse_and_wordname_is_protected() {
        let mut e = WordEntry::new("kala");
        assert!(e.values.is_empty());
        assert!(!e.has("definition"));

        assert!(e.set(WORDNAME_TAG, FieldValue::Text("x".into())).is_none());
        assert_eq!(e.wordname, "kala");

        e.set("part of speech", FieldValue::TagList(vec!["noun".into()]));
        assert!(e.has("part of speech"));
        assert_eq!(e.values.len(), 1);
    }

    #[test]
    fn serde_omits_empty_values() {
        let e = WordEntry::new("kala");
        let json = serde_json::to_string(&e).unwrap();
        assert!(!json.contains("values"));
    }

    #[test]
    fn parent_and_definition_helpers() {
        let mut e = WordEntry::new("kala");
        e.set(DEFINITION_TAG, FieldValue::TagList(vec!["to speak".into()]));
        assert_eq!(e.definition().unwrap(), ["to speak"]);

        let root = Uuid::new_v4();
        e.set_parent(root);
        assert_eq!(e.parent(), Some(root));
        assert!(e.has_parent());
    }

    #[test]
    fn multiple_parents_are_sparse() {
        let mut e = WordEntry::new("child");
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();

        e.add_parent(a);
        e.add_parent(a);
        e.add_parent(b);
        assert_eq!(e.parents(), vec![a, b]);

        assert!(e.remove_parent(a));
        assert_eq!(e.parents(), vec![b]);
        assert!(e.remove_parent(b));
        assert!(!e.has_parent());
        assert!(!e.values.contains_key(PARENT_TAG));
    }
}
