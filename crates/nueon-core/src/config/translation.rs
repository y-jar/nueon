//! Translation engine configuration.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::translation::SyntaxGrid;

/// Whether an affix attaches before or after a root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AffixKind {
    Prefix,
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

/// How the translator assembles output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranslationMode {
    /// Use the drag-and-drop syntax grid.
    #[default]
    Grid,
    /// Word for word, in the order the input words appear.
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
