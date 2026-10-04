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

    /// The root/parent word's id, if a `parent` reference is applied.
    pub fn parent(&self) -> Option<Uuid> {
        match self.values.get(PARENT_TAG) {
            Some(FieldValue::Reference(id)) => Some(*id),
            _ => None,
        }
    }

    /// Set the `parent` reference.
    pub fn set_parent(&mut self, parent_id: Uuid) {
        self.values
            .insert(PARENT_TAG.to_string(), FieldValue::Reference(parent_id));
    }

    /// Whether this entry is derived from a root/parent word.
    pub fn has_parent(&self) -> bool {
        self.parent().is_some()
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
}
