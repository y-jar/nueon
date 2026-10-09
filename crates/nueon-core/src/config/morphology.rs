//! Feature-based morphology: paradigm tables that realize a combination of
//! selected grammatical features as an affix on a word class.
//!
//! A word's class comes from its `pos` tag (a `TagList`; the first sense).
//! Each [`Paradigm`] belongs to one class; a [`ParadigmRow`] applies when every
//! feature/value in its `when` matches the clause's feature selection, and the
//! row with the most conditions wins. This models fusional languages, where one
//! ending realizes several features at once.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::translation::AffixKind;

/// The tag that records a word's class (`verb`, `noun`, …).
pub const POS_TAG: &str = "pos";

/// One value of a feature, e.g. `past`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeatureValue {
    pub id: String,
    pub label: String,
}

/// A binding of a feature to a table column, making it **inherent**: its
/// value belongs to the word (read from the column), rather than being chosen
/// when the word is used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeatureColumn {
    pub table: String,
    pub column: String,
}

/// A grammatical feature, e.g. `tense` with present/past/future.
///
/// An *inflectional* feature is chosen when a word is used. A feature with a
/// [`FeatureColumn`] is *inherent*: its values come from a table column and are
/// read from each word's row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Feature {
    pub id: String,
    pub label: String,
    pub values: Vec<FeatureValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<FeatureColumn>,
}

/// A reference to a morpheme in a `Fixes` table.
///
/// New references use the stable `{ table, id }` form; a bare string is the
/// legacy key form, matched by wordname or trigger. Resolution tries the id
/// first, then falls back to the key, so old and new configs both load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MorphemeRef {
    Ref { table: String, id: String },
    Key(String),
}

/// One ending in a paradigm, realised when `when` matches the selection.
///
/// Rows sharing a `slot` are alternatives for the same position; the
/// most-specific match wins. Rows with no `slot` share one implicit slot, so a
/// legacy single-row paradigm still realises exactly one affix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParadigmRow {
    /// feature id -> value id, all of which must match the selection.
    #[serde(default)]
    pub when: BTreeMap<String, String>,
    pub surface: String,
    #[serde(default)]
    pub kind: AffixKind,
    /// Which ordered slot this ending occupies (`None` = the implicit slot).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
    /// Sort key among slots, ascending.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub order: i32,
    /// A morpheme in a `Fixes` table supplying the surface and gloss; the
    /// inline `surface` is the fallback when this is unset (or unresolvable).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub morpheme: Option<MorphemeRef>,
    /// An explicit zero ending: it matches and counts as defined, but emits
    /// nothing. Takes precedence over `surface`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub zero: bool,
}

fn is_zero(value: &i32) -> bool {
    *value == 0
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// The endings for one word class.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paradigm {
    pub class: String,
    #[serde(default)]
    pub rows: Vec<ParadigmRow>,
}

/// The conlang's features and paradigms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Morphology {
    pub features: Vec<Feature>,
    pub paradigms: Vec<Paradigm>,
}

fn feature(id: &str, label: &str, values: &[&str]) -> Feature {
    Feature {
        id: id.to_string(),
        label: label.to_string(),
        values: values
            .iter()
            .map(|value| FeatureValue {
                id: value.to_string(),
                label: titlecase(value),
            })
            .collect(),
        column: None,
    }
}

fn titlecase(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

impl Default for Morphology {
    fn default() -> Self {
        Self {
            features: vec![
                feature("tense", "Tense", &["present", "past", "future"]),
                feature("aspect", "Aspect", &["perfective", "imperfective"]),
                feature("number", "Number", &["singular", "plural"]),
            ],
            paradigms: Vec::new(),
        }
    }
}

/// One slot's resolution: the winning row and any equal-specificity ties.
#[derive(Debug)]
pub struct SlotResolution<'a> {
    pub slot: Option<&'a str>,
    pub winner: &'a ParadigmRow,
    pub ambiguous: Vec<&'a ParadigmRow>,
}

impl Morphology {
    /// The most specific row whose conditions all match `selections`.
    pub fn affix_for(
        &self,
        class: &str,
        selections: &BTreeMap<String, String>,
    ) -> Option<&ParadigmRow> {
        let paradigm = self.paradigms.iter().find(|p| p.class == class)?;
        let mut best: Option<&ParadigmRow> = None;
        for row in &paradigm.rows {
            if row.when.is_empty() {
                continue;
            }
            let matches = row
                .when
                .iter()
                .all(|(feature, value)| selections.get(feature) == Some(value));
            if matches && best.is_none_or(|current| row.when.len() > current.when.len()) {
                best = Some(row);
            }
        }
        best
    }

    /// The most-specific matching row per slot, ordered by [`ParadigmRow::order`].
    ///
    /// Rows are grouped by `slot`; rows with no slot share one implicit slot.
    /// Within a group the row with the most matching conditions wins (ties keep
    /// the first declared), so a legacy single-row paradigm yields one row.
    pub fn rows_for<'a>(
        &'a self,
        class: &str,
        selections: &BTreeMap<String, String>,
    ) -> Vec<&'a ParadigmRow> {
        self.resolve_slots(class, selections)
            .into_iter()
            .map(|resolution| resolution.winner)
            .collect()
    }

    /// The winning row per slot, plus any equal-specificity ties that could
    /// also match (an "ambiguous" cell). `affix_for`/`rows_for` keep the
    /// most-specific-wins, first-declared behavior; this exposes the ties for
    /// the editor to flag.
    pub fn resolve_slots<'a>(
        &'a self,
        class: &str,
        selections: &BTreeMap<String, String>,
    ) -> Vec<SlotResolution<'a>> {
        let Some(paradigm) = self.paradigms.iter().find(|p| p.class == class) else {
            return Vec::new();
        };
        let mut groups: Vec<(Option<&str>, Vec<&ParadigmRow>)> = Vec::new();
        for row in &paradigm.rows {
            if row.when.is_empty() {
                continue;
            }
            let matches = row
                .when
                .iter()
                .all(|(feature, value)| selections.get(feature) == Some(value));
            if !matches {
                continue;
            }
            let slot = row.slot.as_deref();
            match groups.iter_mut().find(|(existing, _)| *existing == slot) {
                Some((_, rows)) => rows.push(row),
                None => groups.push((slot, vec![row])),
            }
        }
        let mut out: Vec<SlotResolution> = groups
            .into_iter()
            .map(|(slot, rows)| {
                let max = rows.iter().map(|row| row.when.len()).max().unwrap_or(0);
                let mut top: Vec<&ParadigmRow> = rows
                    .into_iter()
                    .filter(|row| row.when.len() == max)
                    .collect();
                let winner = top.remove(0);
                SlotResolution {
                    slot,
                    winner,
                    ambiguous: top,
                }
            })
            .collect();
        // A stable sort keeps first-declared order among equal `order`s.
        out.sort_by_key(|resolution| resolution.winner.order);
        out
    }

    /// Upper-cased labels for a row's conditions (for the interlinear gloss).
    pub fn labels_for(&self, row: &ParadigmRow) -> Vec<String> {
        row.when
            .iter()
            .map(|(feature, value)| {
                self.features
                    .iter()
                    .find(|candidate| &candidate.id == feature)
                    .and_then(|candidate| candidate.values.iter().find(|item| &item.id == value))
                    .map(|item| item.label.to_uppercase())
                    .unwrap_or_else(|| value.to_uppercase())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(when: &[(&str, &str)], surface: &str) -> ParadigmRow {
        ParadigmRow {
            when: when
                .iter()
                .map(|(f, v)| (f.to_string(), v.to_string()))
                .collect(),
            surface: surface.to_string(),
            kind: AffixKind::Suffix,
            slot: None,
            order: 0,
            morpheme: None,
            zero: false,
        }
    }

    #[test]
    fn default_features_exist_without_paradigms() {
        let morphology = Morphology::default();
        assert!(morphology.paradigms.is_empty());
        assert!(morphology.features.iter().any(|f| f.id == "tense"));
    }

    #[test]
    fn most_specific_row_wins() {
        let morphology = Morphology {
            features: Morphology::default().features,
            paradigms: vec![Paradigm {
                class: "verb".into(),
                rows: vec![
                    row(&[("tense", "past")], "-a"),
                    row(&[("tense", "past"), ("number", "singular")], "-ai"),
                ],
            }],
        };
        let full = BTreeMap::from([
            ("tense".to_string(), "past".to_string()),
            ("number".to_string(), "singular".to_string()),
        ]);
        assert_eq!(morphology.affix_for("verb", &full).unwrap().surface, "-ai");

        let just_tense = BTreeMap::from([("tense".to_string(), "past".to_string())]);
        assert_eq!(
            morphology.affix_for("verb", &just_tense).unwrap().surface,
            "-a"
        );
    }

    #[test]
    fn wrong_class_or_selection_matches_nothing() {
        let morphology = Morphology {
            features: Morphology::default().features,
            paradigms: vec![Paradigm {
                class: "verb".into(),
                rows: vec![row(&[("tense", "past")], "-a")],
            }],
        };
        assert!(morphology.affix_for("noun", &BTreeMap::new()).is_none());
        assert!(morphology
            .affix_for("verb", &BTreeMap::from([("tense".into(), "future".into())]))
            .is_none());
    }

    #[test]
    fn morpheme_ref_reads_legacy_and_object_forms() {
        let legacy: ParadigmRow =
            serde_json::from_str(r#"{"surface":"-u","morpheme":"plural"}"#).unwrap();
        assert_eq!(legacy.morpheme, Some(MorphemeRef::Key("plural".into())));
        assert!(!legacy.zero);

        let object: ParadigmRow = serde_json::from_str(
            r#"{"surface":"","zero":true,"morpheme":{"table":"fixes","id":"abc"}}"#,
        )
        .unwrap();
        assert_eq!(
            object.morpheme,
            Some(MorphemeRef::Ref {
                table: "fixes".into(),
                id: "abc".into()
            })
        );
        assert!(object.zero);
    }

    #[test]
    fn labels_describe_the_conditions() {
        let morphology = Morphology::default();
        let labels = morphology.labels_for(&row(&[("tense", "past")], "-a"));
        assert_eq!(labels, vec!["PAST"]);
    }
}
