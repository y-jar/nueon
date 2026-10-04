//! Grammar rules expressed as patterns over tag names.

use serde::{Deserialize, Serialize};

use crate::translation::ClauseSlot;

/// A named sentence pattern built from the user's tags.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GrammarRule {
    /// Display name, e.g. "Standard SVO".
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub slots: Vec<ClauseSlot>,
}

/// The collection of grammar rules for the conlang.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GrammarConfig {
    pub rules: Vec<GrammarRule>,
}

impl GrammarConfig {
    /// Look up a rule by name.
    pub fn rule(&self, name: &str) -> Option<&GrammarRule> {
        self.rules.iter().find(|r| r.name == name)
    }
}
