//! Translation engine configuration.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::translation::SyntaxGrid;

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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_empty() {
        let config: TranslationConfig = serde_json::from_str("{}").unwrap();
        assert!(config.default_rule.is_none());
        assert!(config.grids.is_empty());
    }
}
