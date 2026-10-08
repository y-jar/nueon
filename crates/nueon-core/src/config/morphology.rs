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

/// A grammatical feature, e.g. `tense` with present/past/future.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Feature {
    pub id: String,
    pub label: String,
    pub values: Vec<FeatureValue>,
}

/// One ending in a paradigm, realised when `when` matches the selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParadigmRow {
    /// feature id -> value id, all of which must match the selection.
    #[serde(default)]
    pub when: BTreeMap<String, String>,
    pub surface: String,
    #[serde(default)]
    pub kind: AffixKind,
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
    fn labels_describe_the_conditions() {
        let morphology = Morphology::default();
        let labels = morphology.labels_for(&row(&[("tense", "past")], "-a"));
        assert_eq!(labels, vec!["PAST"]);
    }
}
