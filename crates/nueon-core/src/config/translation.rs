//! Translation engine configuration.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::morphology::Morphology;
use crate::translation::SyntaxGrid;

/// Where an affix attaches relative to the root: before it (prefix), inside it
/// after the first vowel (infix), or after it (suffix).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AffixKind {
    Prefix,
    Infix,
    #[default]
    Suffix,
}

/// A minimal rule-based morphology rule.
///
/// The `english` surface is stripped from a token (or added, for prefixes) to
/// find a matching root; the `conlang` surface is then attached to the matched
/// conlang wordname.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AffixRule {
    pub kind: AffixKind,
    /// English affix to recognise, e.g. `s`, `ed`, `ing`.
    pub english: String,
    /// Conlang affix to emit, e.g. `i`.
    pub conlang: String,
}

/// What a table is for. `Vocab` tables supply roots; `Fixes` tables supply
/// morphemes (their `wordname` is the surface, a configured column the English
/// trigger).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TableRole {
    #[default]
    Vocab,
    Fixes,
}

/// A table's designation and, for `Fixes` tables, which columns hold the
/// surface and the English trigger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TableRoleConfig {
    pub role: TableRole,
    /// Column holding the English trigger (e.g. `s`, `ing`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    /// Column holding the conlang surface with hyphen markers (e.g. `-i`);
    /// defaults to the wordname when omitted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
}

impl Default for TableRoleConfig {
    fn default() -> Self {
        Self {
            role: TableRole::Vocab,
            trigger: None,
            surface: None,
        }
    }
}

/// How the translator assembles output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranslationMode {
    /// Use the drag-and-drop syntax grid.
    Grid,
    /// Word for word, in the order the input words appear (the default).
    #[default]
    Direct,
}

/// Runtime options the frontend edits (separator + morphology rules).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslationOptions {
    /// Between-word separator.
    pub separator: String,
    /// Rule-based morphology applied to inflected English tokens.
    #[serde(default)]
    pub affixes: Vec<AffixRule>,
    /// Grid or word-for-word.
    #[serde(default)]
    pub mode: TranslationMode,
}

impl Default for TranslationOptions {
    fn default() -> Self {
        Self {
            separator: " ".to_string(),
            affixes: Vec::new(),
            mode: TranslationMode::Grid,
        }
    }
}

/// Settings and saved syntax grids for the translation engine.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TranslationConfig {
    /// Name of the grammar rule to use by default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_rule: Option<String>,
    /// Free-form engine settings.
    pub settings: BTreeMap<String, String>,
    /// Saved drag-and-drop clause structures.
    pub grids: Vec<SyntaxGrid>,
    /// Minimal rule-based morphology.
    pub affixes: Vec<AffixRule>,
    /// Feature-based paradigms (tense/number/… realised on a word class).
    #[serde(default)]
    pub morphology: Morphology,
    /// Per-table designations (vocab vs fixes), keyed by table name.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub table_roles: BTreeMap<String, TableRoleConfig>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_empty() {
        let config: TranslationConfig = serde_json::from_str("{}").unwrap();
        assert!(config.default_rule.is_none());
        assert!(config.grids.is_empty());
        assert!(config.affixes.is_empty());
    }

    #[test]
    fn table_roles_default_empty_and_round_trip() {
        let config: TranslationConfig = serde_json::from_str("{}").unwrap();
        assert!(config.table_roles.is_empty());

        let mut config = TranslationConfig::default();
        config.table_roles.insert(
            "fixes".into(),
            TableRoleConfig {
                role: TableRole::Fixes,
                trigger: Some("english".into()),
                surface: None,
            },
        );
        let json = serde_json::to_string(&config).unwrap();
        let back: TranslationConfig = serde_json::from_str(&json).unwrap();
        let entry = back.table_roles.get("fixes").unwrap();
        assert_eq!(entry.role, TableRole::Fixes);
        assert_eq!(entry.trigger.as_deref(), Some("english"));
    }

    #[test]
    fn affixes_round_trip() {
        let rule = AffixRule {
            kind: AffixKind::Suffix,
            english: "s".into(),
            conlang: "i".into(),
        };
        let json = serde_json::to_string(&rule).unwrap();
        let back: AffixRule = serde_json::from_str(&json).unwrap();
        assert_eq!(back, rule);
    }
}
