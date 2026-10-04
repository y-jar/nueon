//! Dictionary word index for highlighting in the notes editor.

use std::collections::HashMap;

use uuid::Uuid;

use crate::model::{Dictionary, WordEntry, DEFINITION_TAG, PARENT_TAG};

/// A dictionary entry matching a spelling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WordHit {
    pub id: Uuid,
    pub table: String,
    pub tooltip: String,
}

/// A lookup from a lowercased conlang spelling to matching entries.
#[derive(Debug, Clone, Default)]
pub(crate) struct WordIndex {
    map: HashMap<String, Vec<WordHit>>,
}

impl WordIndex {
    /// Build the index from every entry in the dictionary.
    pub fn build(dict: &Dictionary) -> Self {
        let mut map: HashMap<String, Vec<WordHit>> = HashMap::new();
        for table in dict.tables() {
            for entry in &table.entries {
                map.entry(entry.wordname.to_lowercase())
                    .or_default()
                    .push(WordHit {
                        id: entry.id,
                        table: table.name.clone(),
                        tooltip: tooltip_for(&table.name, entry),
                    });
            }
        }
        Self { map }
    }

    /// All entries matching a spelling (case-insensitive).
    pub fn hits(&self, word: &str) -> Option<&[WordHit]> {
        self.map.get(&word.to_lowercase()).map(Vec::as_slice)
    }

    /// The first entry matching a spelling.
    pub fn get(&self, word: &str) -> Option<&WordHit> {
        self.hits(word).and_then(|hits| hits.first())
    }
}

fn tooltip_for(table: &str, entry: &WordEntry) -> String {
    let mut lines = vec![entry.wordname.clone()];
    if let Some(senses) = entry.definition() {
        if !senses.is_empty() {
            lines.push(senses.join("; "));
        }
    }
    lines.push(format!("table: {table}"));
    let tags: Vec<&str> = entry
        .values
        .keys()
        .map(String::as_str)
        .filter(|name| *name != DEFINITION_TAG && *name != PARENT_TAG)
        .collect();
    if !tags.is_empty() {
        lines.push(format!("tags: {}", tags.join(", ")));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FieldValue, WordEntry};

    fn dict_with_homographs() -> Dictionary {
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

        // keep ids referenced so the test is explicit
        assert_ne!(aid, bid);
        dict
    }

    #[test]
    fn groups_homographs_case_insensitively() {
        let index = WordIndex::build(&dict_with_homographs());
        let hits = index.hits("kala").unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(index.get("KALA").unwrap().id, hits[0].id);
        assert!(index.get("missing").is_none());
    }

    #[test]
    fn tooltip_contains_sense_and_table() {
        let index = WordIndex::build(&dict_with_homographs());
        let hit = index.get("kala").unwrap();
        assert!(hit.tooltip.contains("to speak"));
        assert!(hit.tooltip.contains("table: lexicon"));
        assert!(hit.tooltip.contains("pos"));
    }
}
