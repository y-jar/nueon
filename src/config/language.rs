//! Language metadata.

use serde::{Deserialize, Serialize};

/// The writing direction of the conlang.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextDirection {
    #[default]
    Ltr,
    Rtl,
}

/// Metadata describing the conlang as a whole.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LanguageConfig {
    /// Display name of the language.
    pub name: String,
    /// Author/creator.
    pub author: String,
    /// Short description.
    pub description: String,
    /// Name of the writing system.
    pub script: String,
    /// Writing direction.
    pub direction: TextDirection,
}

impl Default for LanguageConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            author: String::new(),
            description: String::new(),
            script: String::new(),
            direction: TextDirection::Ltr,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_fill_missing_fields() {
        let config: LanguageConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config.direction, TextDirection::Ltr);
        assert!(config.name.is_empty());
    }
}
