//! Phonology: the selected phoneme inventory and the allowed syllable shapes.

use serde::{Deserialize, Serialize};

/// What kinds of sound a phoneme is treated as, for syllable patterns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhonemeKind {
    Consonant,
    Vowel,
    Other,
}

/// One selected sound. `symbol` is its IPA (or custom) spelling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Phoneme {
    pub symbol: String,
    pub kind: PhonemeKind,
}

/// The conlang's phoneme inventory and phonotactics.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PhonologyConfig {
    /// Every sound the language uses.
    pub phonemes: Vec<Phoneme>,
    /// Allowed syllable shapes as strings over `C` (consonant) and `V`
    /// (vowel), e.g. `CV`, `CVC`. Empty means "no syllable check".
    pub syllables: Vec<String>,
}

impl PhonologyConfig {
    /// Whether an inventory has been defined.
    pub fn is_empty(&self) -> bool {
        self.phonemes.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_empty() {
        let config: PhonologyConfig = serde_json::from_str("{}").unwrap();
        assert!(config.is_empty());
        assert!(config.syllables.is_empty());
    }

    #[test]
    fn round_trips() {
        let config = PhonologyConfig {
            phonemes: vec![
                Phoneme {
                    symbol: "k".into(),
                    kind: PhonemeKind::Consonant,
                },
                Phoneme {
                    symbol: "a".into(),
                    kind: PhonemeKind::Vowel,
                },
            ],
            syllables: vec!["CV".into(), "CVC".into()],
        };
        let json = serde_json::to_string(&config).unwrap();
        let back: PhonologyConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, config);
        assert!(json.contains("\"consonant\""));
    }
}
