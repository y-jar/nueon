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

/// A way a word breaks the conlang's phonology. Warnings only — the word is
/// never rejected, since conlangers break their own rules on purpose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Violation {
    /// A character that is not one of the inventory's phonemes.
    UnknownPhoneme { at: usize, symbol: String },
    /// The sequence of consonants/vowels does not fit any syllable shape.
    BadSyllable { at: usize },
}

/// Check one word against the inventory and syllable shapes. An empty
/// inventory means "not configured", so nothing is reported.
pub fn check_word(word: &str, config: &PhonologyConfig) -> Vec<Violation> {
    if config.phonemes.is_empty() {
        return Vec::new();
    }

    // Tokenize by longest matching phoneme (phonemes may be several
    // code points, e.g. an affricate).
    let chars: Vec<char> = word.chars().collect();
    let symbols: Vec<(Vec<char>, PhonemeKind)> = config
        .phonemes
        .iter()
        .filter(|phoneme| !phoneme.symbol.is_empty())
        .map(|phoneme| (phoneme.symbol.chars().collect(), phoneme.kind))
        .collect();

    let mut kinds: Vec<PhonemeKind> = Vec::new();
    let mut violations = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let mut best: Option<(usize, PhonemeKind)> = None;
        for (symbol, kind) in &symbols {
            if at + symbol.len() > chars.len() || chars[at..at + symbol.len()] != symbol[..] {
                continue;
            }
            if best.is_none_or(|(length, _)| symbol.len() > length) {
                best = Some((symbol.len(), *kind));
            }
        }
        match best {
            Some((length, kind)) => {
                kinds.push(kind);
                at += length;
            }
            None => {
                violations.push(Violation::UnknownPhoneme {
                    at,
                    symbol: chars[at].to_string(),
                });
                at += 1;
            }
        }
    }

    if violations.is_empty()
        && !config.syllables.is_empty()
        && !kinds.is_empty()
        && !matches_syllables(&kinds, &config.syllables)
    {
        violations.push(Violation::BadSyllable { at: 0 });
    }
    violations
}

/// Whether the consonant/vowel sequence can be split into allowed shapes.
fn matches_syllables(kinds: &[PhonemeKind], shapes: &[String]) -> bool {
    let count = kinds.len();
    let mut reachable = vec![false; count + 1];
    reachable[0] = true;
    for start in 0..count {
        if !reachable[start] {
            continue;
        }
        for shape in shapes {
            let pattern: Vec<u8> = shape.bytes().collect();
            if pattern.is_empty() || start + pattern.len() > count {
                continue;
            }
            let fits = pattern.iter().enumerate().all(|(offset, byte)| {
                let wants_vowel = byte.eq_ignore_ascii_case(&b'V');
                let wants_consonant = byte.eq_ignore_ascii_case(&b'C');
                match kinds[start + offset] {
                    // Unclassified sounds fit either slot.
                    PhonemeKind::Other => wants_vowel || wants_consonant,
                    PhonemeKind::Vowel => wants_vowel,
                    PhonemeKind::Consonant => wants_consonant,
                }
            });
            if fits {
                reachable[start + pattern.len()] = true;
            }
        }
    }
    reachable[count]
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

    fn consonant(symbol: &str) -> Phoneme {
        Phoneme {
            symbol: symbol.into(),
            kind: PhonemeKind::Consonant,
        }
    }

    fn vowel(symbol: &str) -> Phoneme {
        Phoneme {
            symbol: symbol.into(),
            kind: PhonemeKind::Vowel,
        }
    }

    fn config(phonemes: Vec<Phoneme>, syllables: &[&str]) -> PhonologyConfig {
        PhonologyConfig {
            phonemes,
            syllables: syllables.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn empty_inventory_checks_nothing() {
        assert!(check_word("anything", &PhonologyConfig::default()).is_empty());
    }

    #[test]
    fn unknown_phonemes_are_reported_by_position() {
        let cfg = config(vec![consonant("k"), vowel("a")], &[]);
        let violations = check_word("kat", &cfg);
        assert_eq!(
            violations,
            vec![Violation::UnknownPhoneme {
                at: 2,
                symbol: "t".into(),
            }]
        );
    }

    #[test]
    fn valid_syllable_shapes_pass() {
        let cfg = config(vec![consonant("k"), vowel("a")], &["CV"]);
        assert!(check_word("ka", &cfg).is_empty());
        assert!(check_word("kaka", &cfg).is_empty());
    }

    #[test]
    fn a_bad_syllable_shape_is_reported() {
        let cfg = config(vec![consonant("k"), vowel("a")], &["CV"]);
        assert_eq!(
            check_word("kak", &cfg),
            vec![Violation::BadSyllable { at: 0 }]
        );
    }

    #[test]
    fn multi_character_phonemes_match_longest_first() {
        let cfg = config(
            vec![
                Phoneme {
                    symbol: "t͡ʃ".into(),
                    kind: PhonemeKind::Consonant,
                },
                vowel("a"),
            ],
            &["CV"],
        );
        assert!(check_word("t͡ʃa", &cfg).is_empty());
    }

    #[test]
    fn other_kinds_match_either_slot() {
        let cfg = config(
            vec![
                Phoneme {
                    symbol: "ʔ".into(),
                    kind: PhonemeKind::Other,
                },
                vowel("a"),
            ],
            &["CV"],
        );
        assert!(check_word("ʔa", &cfg).is_empty());
    }
}
