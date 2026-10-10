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
    /// Ordered sound-change rules, applied left to right.
    pub rules: Vec<SoundChangeRule>,
}

/// One ordered sound-change rule: `from` becomes `to` in the given context.
///
/// `left` and `right` are matched against the neighbouring sounds, where `C`,
/// `V` and `L` stand for consonant, vowel and other (as classified by the
/// inventory), `#` is a word boundary, and anything else is a literal sound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SoundChangeRule {
    /// An optional human-readable label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The sound to replace (a phoneme symbol).
    pub from: String,
    /// The replacement; `Ø` (or empty) deletes.
    pub to: String,
    /// Sounds that must precede the target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<String>,
    /// Sounds that must follow the target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<String>,
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

/// One token of a word: a matched phoneme (`kind` is its class), or a single
/// character the inventory does not know (`kind` is `None`). `at` is the
/// character offset in the word.
struct Token {
    at: usize,
    symbol: String,
    kind: Option<PhonemeKind>,
}

/// Split a word into tokens by longest matching phoneme (phonemes may span
/// several code points, e.g. an affricate).
fn tokenize(word: &str, config: &PhonologyConfig) -> Vec<Token> {
    let chars: Vec<char> = word.chars().collect();
    let symbols: Vec<(Vec<char>, PhonemeKind)> = config
        .phonemes
        .iter()
        .filter(|phoneme| !phoneme.symbol.is_empty())
        .map(|phoneme| (phoneme.symbol.chars().collect(), phoneme.kind))
        .collect();

    let mut tokens = Vec::new();
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
                tokens.push(Token {
                    at,
                    symbol: chars[at..at + length].iter().collect(),
                    kind: Some(kind),
                });
                at += length;
            }
            None => {
                tokens.push(Token {
                    at,
                    symbol: chars[at].to_string(),
                    kind: None,
                });
                at += 1;
            }
        }
    }
    tokens
}

/// One segment of a word's sound breakdown (for the inspector).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub symbol: String,
    /// `None` when the symbol is not in the inventory.
    pub kind: Option<PhonemeKind>,
}

/// The word split into inventory phonemes, marking unknown characters — the
/// sound-by-sound breakdown shown for the selected word.
pub fn segments(word: &str, config: &PhonologyConfig) -> Vec<Segment> {
    tokenize(word, config)
        .into_iter()
        .map(|token| Segment {
            symbol: token.symbol,
            kind: token.kind,
        })
        .collect()
}

/// Check one word against the inventory and syllable shapes. An empty
/// inventory means "not configured", so nothing is reported.
pub fn check_word(word: &str, config: &PhonologyConfig) -> Vec<Violation> {
    if config.phonemes.is_empty() {
        return Vec::new();
    }

    let mut kinds: Vec<PhonemeKind> = Vec::new();
    let mut violations = Vec::new();
    for token in tokenize(word, config) {
        match token.kind {
            Some(kind) => kinds.push(kind),
            None => violations.push(Violation::UnknownPhoneme {
                at: token.at,
                symbol: token.symbol,
            }),
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

// -- sound change engine ---------------------------------------------------

/// Apply every rule in order, returning the word after each step (for a
/// step-by-step preview). No rules means the word is returned unchanged.
pub fn apply_rules(word: &str, config: &PhonologyConfig) -> Vec<String> {
    if config.rules.is_empty() {
        return vec![word.to_string()];
    }
    let mut steps = Vec::with_capacity(config.rules.len() + 1);
    steps.push(word.to_string());
    let mut current = word.to_string();
    for rule in &config.rules {
        current = apply_rule(&current, config, rule);
        steps.push(current.clone());
    }
    steps
}

/// The word after every sound change has run.
pub fn apply_to_word(word: &str, config: &PhonologyConfig) -> String {
    apply_rules(word, config)
        .into_iter()
        .last()
        .unwrap_or_else(|| word.to_string())
}

/// Whether a context unit matches the sound `ch` (classified as `kind`).
fn unit_matches(unit: char, ch: char, kind: Option<PhonemeKind>) -> bool {
    match unit {
        'C' => kind == Some(PhonemeKind::Consonant),
        'V' => kind == Some(PhonemeKind::Vowel),
        'L' => kind == Some(PhonemeKind::Other),
        _ => unit == ch,
    }
}

/// Whether `spec` matches the sounds adjacent to the range `pos` (left side) or
/// after `pos` (right side). `#` is a word boundary.
fn context_matches(
    spec: Option<&str>,
    chars: &[char],
    kind: &[Option<PhonemeKind>],
    pos: usize,
    left: bool,
) -> bool {
    let Some(spec) = spec else { return true };
    let units: Vec<char> = spec.chars().collect();
    if left {
        let mut idx = pos;
        let mut u = units.len();
        while u > 0 {
            u -= 1;
            let unit = units[u];
            if unit == '#' {
                if idx != 0 {
                    return false;
                }
            } else if idx == 0 {
                return false;
            } else {
                idx -= 1;
                if !unit_matches(unit, chars[idx], kind.get(idx).copied().flatten()) {
                    return false;
                }
            }
        }
        true
    } else {
        let mut idx = pos;
        for unit in units {
            if unit == '#' {
                if idx != chars.len() {
                    return false;
                }
                continue;
            }
            if idx >= chars.len()
                || !unit_matches(unit, chars[idx], kind.get(idx).copied().flatten())
            {
                return false;
            }
            idx += 1;
        }
        true
    }
}

/// Apply one rule to `word`.
fn apply_rule(word: &str, config: &PhonologyConfig, rule: &SoundChangeRule) -> String {
    let from: Vec<char> = rule.from.chars().collect();
    if from.is_empty() || rule.from == "Ø" {
        // Insertion (from == "Ø") is not supported yet.
        return word.to_string();
    }
    let to: Vec<char> = if rule.to.is_empty() || rule.to == "Ø" {
        Vec::new()
    } else {
        rule.to.chars().collect()
    };

    // A per-char classification (each char inherits its phoneme's kind).
    let segs = segments(word, config);
    let mut kind: Vec<Option<PhonemeKind>> = Vec::with_capacity(word.chars().count());
    for seg in &segs {
        for _ in seg.symbol.chars() {
            kind.push(seg.kind);
        }
    }

    let chars: Vec<char> = word.chars().collect();
    let mut out = String::with_capacity(word.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i..].starts_with(&from) {
            let end = i + from.len();
            if context_matches(rule.left.as_deref(), &chars, &kind, i, true)
                && context_matches(rule.right.as_deref(), &chars, &kind, end, false)
            {
                out.extend(&to);
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
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
            rules: vec![],
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
            rules: vec![],
        }
    }

    #[test]
    fn empty_inventory_checks_nothing() {
        assert!(check_word("anything", &PhonologyConfig::default()).is_empty());
    }

    #[test]
    fn segments_classify_and_flag_unknowns() {
        let cfg = config(vec![consonant("k"), vowel("a")], &[]);
        let parts = segments("kata", &cfg);
        assert_eq!(
            parts,
            vec![
                Segment {
                    symbol: "k".into(),
                    kind: Some(PhonemeKind::Consonant)
                },
                Segment {
                    symbol: "a".into(),
                    kind: Some(PhonemeKind::Vowel)
                },
                Segment {
                    symbol: "t".into(),
                    kind: None
                },
                Segment {
                    symbol: "a".into(),
                    kind: Some(PhonemeKind::Vowel)
                },
            ]
        );
    }

    #[test]
    fn segments_match_the_longest_phoneme() {
        let cfg = config(vec![consonant("t"), consonant("tʃ")], &[]);
        let parts = segments("tʃa", &cfg);
        assert_eq!(parts[0].symbol, "tʃ");
        assert_eq!(parts[0].kind, Some(PhonemeKind::Consonant));
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

    fn sca(phonemes: Vec<Phoneme>, rules: Vec<SoundChangeRule>) -> PhonologyConfig {
        PhonologyConfig {
            phonemes,
            syllables: vec![],
            rules,
        }
    }

    fn rule(from: &str, to: &str) -> SoundChangeRule {
        SoundChangeRule {
            name: None,
            from: from.into(),
            to: to.into(),
            left: None,
            right: None,
        }
    }

    #[test]
    fn sound_changes_apply_in_order() {
        let cfg = sca(
            vec![consonant("k"), consonant("s"), vowel("a")],
            vec![rule("k", "s"), rule("s", "a")],
        );
        // k -> s -> a
        assert_eq!(apply_to_word("ka", &cfg), "aa");
    }

    #[test]
    fn a_conditioned_change_only_fires_in_context() {
        let cfg = sca(
            vec![consonant("k"), consonant("t"), vowel("a"), vowel("i")],
            vec![SoundChangeRule {
                name: None,
                from: "k".into(),
                to: "t".into(),
                left: None,
                right: Some("i".into()),
            }],
        );
        // k -> t only before i
        assert_eq!(apply_to_word("ki", &cfg), "ti");
        assert_eq!(apply_to_word("ka", &cfg), "ka");
    }

    #[test]
    fn category_context_matches_vowels_and_boundaries() {
        let cfg = sca(
            vec![consonant("k"), vowel("a"), vowel("u")],
            vec![SoundChangeRule {
                name: None,
                from: "a".into(),
                to: "u".into(),
                left: Some("V".into()),
                right: Some("#".into()),
            }],
        );
        // a -> u after a vowel and at the end of the word.
        assert_eq!(apply_to_word("kaa", &cfg), "kau");
        assert_eq!(apply_to_word("ka", &cfg), "ka");
    }

    #[test]
    fn a_deletion_rule_removes_the_sound() {
        let cfg = sca(vec![consonant("k"), vowel("a")], vec![rule("k", "Ø")]);
        assert_eq!(apply_to_word("kaka", &cfg), "aa");
    }

    #[test]
    fn apply_rules_returns_each_step() {
        let cfg = sca(
            vec![consonant("k"), vowel("a"), consonant("s")],
            vec![rule("k", "s"), rule("s", "a")],
        );
        assert_eq!(apply_rules("ka", &cfg), vec!["ka", "sa", "aa"]);
    }
}
