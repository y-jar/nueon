//! Pure sort/filter query logic for the dictionary grid.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use uuid::Uuid;

use super::dictionary::Dictionary;
use super::entry::WordEntry;
use super::field::FieldValue;
use super::table::WordTable;
use super::tag::{PARENT_TAG, WORDNAME_TAG};

/// Sort direction for a single column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDir {
    Asc,
    Desc,
}

/// Per-column filter state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ColumnFilter {
    /// `Some(true)` = must have a value; `Some(false)` = must not.
    pub presence: Option<bool>,
    /// Boolean-column match.
    pub boolean: Option<bool>,
    /// Case-insensitive "contains" match on the cell text.
    pub text: String,
}

impl ColumnFilter {
    /// Whether this filter imposes no constraints.
    pub fn is_empty(&self) -> bool {
        self.presence.is_none() && self.boolean.is_none() && self.text.trim().is_empty()
    }
}

/// The sort and filter state for one table view.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TableQuery {
    pub sort: Option<(String, SortDir)>,
    pub filters: BTreeMap<String, ColumnFilter>,
}

/// The ordered ids of the rows matching `query`.
///
/// Filters combine with AND. Missing values always sort last.
pub fn ordered_ids(dict: &Dictionary, table: &WordTable, query: &TableQuery) -> Vec<Uuid> {
    let mut entries: Vec<&WordEntry> = table
        .entries
        .iter()
        .filter(|entry| {
            query
                .filters
                .iter()
                .all(|(column, filter)| matches_filter(dict, entry, column, filter))
        })
        .collect();

    if let Some((column, dir)) = &query.sort {
        entries.sort_by(|a, b| compare_entries(dict, a, b, column, *dir));
    }

    entries.into_iter().map(|entry| entry.id).collect()
}

fn matches_filter(
    dict: &Dictionary,
    entry: &WordEntry,
    column: &str,
    filter: &ColumnFilter,
) -> bool {
    if filter.is_empty() {
        return true;
    }
    if let Some(want) = filter.presence {
        let has = column == WORDNAME_TAG || entry.has(column);
        if has != want {
            return false;
        }
    }
    if let Some(want) = filter.boolean {
        let actual = matches!(entry.get(column), Some(FieldValue::Boolean(b)) if *b == want);
        if !actual {
            return false;
        }
    }
    let needle = filter.text.trim().to_lowercase();
    if !needle.is_empty() && !text_matches(dict, entry, column, &needle) {
        return false;
    }
    true
}

fn text_matches(dict: &Dictionary, entry: &WordEntry, column: &str, needle: &str) -> bool {
    if column == WORDNAME_TAG {
        return entry.wordname.to_lowercase().contains(needle);
    }
    if column == PARENT_TAG {
        return entry
            .parents()
            .iter()
            .any(|id| name_contains(dict, *id, needle));
    }
    match entry.get(column) {
        Some(FieldValue::Text(text)) => text.to_lowercase().contains(needle),
        Some(FieldValue::TagList(list)) => list
            .iter()
            .any(|value| value.to_lowercase().contains(needle)),
        Some(FieldValue::Reference(id)) => name_contains(dict, *id, needle),
        Some(FieldValue::References(ids)) => ids.iter().any(|id| name_contains(dict, *id, needle)),
        Some(FieldValue::Boolean(_)) | None => false,
    }
}

fn name_contains(dict: &Dictionary, id: Uuid, needle: &str) -> bool {
    dict.find_entry(id)
        .is_some_and(|(_, entry)| entry.wordname.to_lowercase().contains(needle))
}

#[derive(Debug)]
enum SortKey {
    Text(String),
    Bool(bool),
    Missing,
}

fn sort_key(dict: &Dictionary, entry: &WordEntry, column: &str) -> SortKey {
    if column == WORDNAME_TAG {
        return SortKey::Text(entry.wordname.to_lowercase());
    }
    if column == PARENT_TAG {
        return first_name(dict, &entry.parents());
    }
    match entry.get(column) {
        Some(FieldValue::Text(text)) => SortKey::Text(text.to_lowercase()),
        Some(FieldValue::TagList(list)) => SortKey::Text(list.join(" ").to_lowercase()),
        Some(FieldValue::Boolean(flag)) => SortKey::Bool(*flag),
        Some(FieldValue::Reference(id)) => first_name(dict, &[*id]),
        Some(FieldValue::References(ids)) => first_name(dict, ids),
        None => SortKey::Missing,
    }
}

fn first_name(dict: &Dictionary, ids: &[Uuid]) -> SortKey {
    match ids.first() {
        Some(id) => dict
            .find_entry(*id)
            .map(|(_, entry)| SortKey::Text(entry.wordname.to_lowercase()))
            .unwrap_or(SortKey::Missing),
        None => SortKey::Missing,
    }
}

fn compare_entries(
    dict: &Dictionary,
    a: &WordEntry,
    b: &WordEntry,
    column: &str,
    dir: SortDir,
) -> Ordering {
    compare_keys(&sort_key(dict, a, column), &sort_key(dict, b, column), dir)
        .then_with(|| a.wordname.cmp(&b.wordname))
}

fn compare_keys(a: &SortKey, b: &SortKey, dir: SortDir) -> Ordering {
    use SortKey::{Bool, Missing, Text};
    match (a, b) {
        (Missing, Missing) => Ordering::Equal,
        (Missing, _) => Ordering::Greater,
        (_, Missing) => Ordering::Less,
        _ => {
            let order = match (a, b) {
                (Text(x), Text(y)) => x.cmp(y),
                (Bool(x), Bool(y)) => x.cmp(y),
                _ => Ordering::Equal,
            };
            if dir == SortDir::Desc {
                order.reverse()
            } else {
                order
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FieldType, TagDef};

    fn build() -> Dictionary {
        let mut dict = Dictionary::new();
        dict.add_table("t");
        dict.add_tag("t", TagDef::new("pos", FieldType::Text));
        dict.add_tag("t", TagDef::new("favorite", FieldType::Boolean));

        let mut a = WordEntry::new("alpha");
        a.set("pos", FieldValue::Text("noun".into()));
        a.set("favorite", FieldValue::Boolean(true));
        let a_id = a.id;
        dict.add_entry("t", a);

        let mut b = WordEntry::new("Bravo");
        b.set("pos", FieldValue::Text("verb".into()));
        dict.add_entry("t", b);

        let c = WordEntry::new("charlie");
        let c_id = c.id;
        dict.add_entry("t", c);

        // charlie's parent is alpha
        dict.get_entry_mut("t", c_id).unwrap().add_parent(a_id);
        dict
    }

    fn ids(dict: &Dictionary, query: &TableQuery) -> Vec<String> {
        let table = dict.table("t").unwrap();
        ordered_ids(dict, table, query)
            .into_iter()
            .map(|id| dict.find_entry(id).unwrap().1.wordname.clone())
            .collect()
    }

    fn filter(column: &str, f: ColumnFilter) -> TableQuery {
        let mut query = TableQuery::default();
        query.filters.insert(column.to_string(), f);
        query
    }

    fn sorted(column: &str, dir: SortDir) -> TableQuery {
        TableQuery {
            sort: Some((column.to_string(), dir)),
            filters: BTreeMap::new(),
        }
    }

    #[test]
    fn sorts_by_wordname_both_directions() {
        let dict = build();
        assert_eq!(
            ids(&dict, &sorted("wordname", SortDir::Asc)),
            ["alpha", "Bravo", "charlie"]
        );
        assert_eq!(
            ids(&dict, &sorted("wordname", SortDir::Desc)),
            ["charlie", "Bravo", "alpha"]
        );
    }

    #[test]
    fn missing_values_sort_last_in_both_directions() {
        let dict = build();
        // "favorite" is set only on alpha; empty is falsy so presence filter first
        let order = ids(&dict, &sorted("favorite", SortDir::Asc));
        assert_eq!(order.first().unwrap(), "alpha");
        assert_eq!(order.last().unwrap(), "charlie", "missing values last");

        let order = ids(&dict, &sorted("favorite", SortDir::Desc));
        assert_eq!(order.first().unwrap(), "alpha", "missing still last");
    }

    #[test]
    fn presence_filter_finds_unset_columns() {
        let dict = build();
        let present = ids(
            &dict,
            &filter(
                "pos",
                ColumnFilter {
                    presence: Some(true),
                    ..Default::default()
                },
            ),
        );
        assert_eq!(present, ["alpha", "Bravo"]);
    }

    #[test]
    fn parent_presence_filters_unparented() {
        let dict = build();
        let unparented = ids(
            &dict,
            &filter(
                PARENT_TAG,
                ColumnFilter {
                    presence: Some(false),
                    ..Default::default()
                },
            ),
        );
        assert_eq!(unparented.len(), 2);
        assert!(!unparented.contains(&"charlie".to_string()));
    }

    #[test]
    fn text_filter_and_wordname_search() {
        let dict = build();
        assert_eq!(
            ids(
                &dict,
                &filter(
                    "pos",
                    ColumnFilter {
                        text: "ver".into(),
                        ..Default::default()
                    }
                )
            ),
            ["Bravo"]
        );
        assert_eq!(
            ids(
                &dict,
                &filter(
                    WORDNAME_TAG,
                    ColumnFilter {
                        text: "ALP".into(),
                        ..Default::default()
                    }
                )
            ),
            ["alpha"]
        );
    }

    #[test]
    fn parent_sorts_by_first_linked_name() {
        let dict = build();
        // charlie has parent "alpha"; others missing => charlie first, missing last
        let order = ids(&dict, &sorted(PARENT_TAG, SortDir::Asc));
        assert_eq!(order.first().unwrap(), "charlie");
    }

    #[test]
    fn and_combining_filters() {
        let dict = build();
        let query = TableQuery {
            sort: None,
            filters: BTreeMap::from([
                (
                    "pos".to_string(),
                    ColumnFilter {
                        text: "noun".into(),
                        ..Default::default()
                    },
                ),
                (
                    WORDNAME_TAG.to_string(),
                    ColumnFilter {
                        text: "alp".into(),
                        ..Default::default()
                    },
                ),
            ]),
        };
        assert_eq!(ids(&dict, &query), ["alpha"]);
    }
}
