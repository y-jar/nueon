//! Inflection and composition of a single word.

use super::*;

/// Where one piece of an inflected word sits relative to its root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InflectionKind {
    Root,
    Prefix,
    Infix,
    Suffix,
}

/// One piece of an inflected word: its surface and gloss.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InflectionMorpheme {
    pub surface: String,
    pub gloss: String,
    pub kind: InflectionKind,
}

/// A single word inflected: the composed surface and an ordered breakdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inflection {
    pub surface: String,
    pub morphemes: Vec<InflectionMorpheme>,
}

impl From<AffixKind> for InflectionKind {
    fn from(kind: AffixKind) -> Self {
        match kind {
            AffixKind::Prefix => InflectionKind::Prefix,
            AffixKind::Infix => InflectionKind::Infix,
            AffixKind::Suffix => InflectionKind::Suffix,
        }
    }
}

fn piece(affix: &ResolvedAffix) -> InflectionMorpheme {
    InflectionMorpheme {
        surface: affix.surface.clone(),
        gloss: affix.gloss.clone(),
        kind: affix.kind.into(),
    }
}

/// One piece of a composed word: a lexicon root or a fixes-table morpheme.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum ComposePiece {
    /// A vocabulary word, by entry id.
    Word(Uuid),
    /// A fixes-table morpheme, by wordname or trigger.
    Morpheme(String),
}

/// Compose an ordered sequence of roots and morphemes into a word.
///
/// Read left to right: a root concatenates (compounding), a `-x` morpheme
/// appends a suffix, `x-` prepends a prefix, and `-x-` inserts after the first
/// vowel. The breakdown follows the input order.
pub fn compose(dict: &Dictionary, lexicon: &[Morpheme], pieces: &[ComposePiece]) -> Inflection {
    let mut surface = String::new();
    let mut morphemes: Vec<InflectionMorpheme> = Vec::new();

    for piece in pieces {
        match piece {
            ComposePiece::Word(id) => {
                let Some((_, entry)) = dict.find_entry(*id) else {
                    continue;
                };
                let root = entry.wordname.clone();
                let gloss = entry
                    .definition()
                    .and_then(<[String]>::first)
                    .cloned()
                    .unwrap_or_else(|| root.clone());
                surface.push_str(&root);
                morphemes.push(InflectionMorpheme {
                    surface: root,
                    gloss,
                    kind: InflectionKind::Root,
                });
            }
            ComposePiece::Morpheme(reference) => {
                let Some(morpheme) = find_morpheme(lexicon, reference) else {
                    continue;
                };
                match morpheme.kind {
                    AffixKind::Prefix => surface = format!("{}{}", morpheme.surface, surface),
                    AffixKind::Suffix => surface.push_str(&morpheme.surface),
                    AffixKind::Infix => {
                        surface = insert_after_first_vowel(&surface, &morpheme.surface)
                    }
                }
                morphemes.push(InflectionMorpheme {
                    surface: morpheme.surface.clone(),
                    gloss: morpheme.gloss.to_uppercase(),
                    kind: morpheme.kind.into(),
                });
            }
        }
    }

    Inflection { surface, morphemes }
}

/// Inflect one word: its root with the feature-driven paradigm affixes and any
/// `manual` morphemes the user picked, composed and broken down in order.
pub fn inflect(
    dict: &Dictionary,
    id: Uuid,
    morphology: &Morphology,
    lexicon: &[Morpheme],
    selections: &BTreeMap<String, String>,
    manual: &[Morpheme],
) -> Inflection {
    let Some((_, entry)) = dict.find_entry(id) else {
        return Inflection {
            surface: "?".to_string(),
            morphemes: Vec::new(),
        };
    };
    let root = entry.wordname.clone();
    let root_gloss = entry
        .definition()
        .and_then(<[String]>::first)
        .cloned()
        .unwrap_or_else(|| root.clone());

    let mut affixes = resolve_affixes(dict, id, morphology, lexicon, selections);
    affixes.extend(manual.iter().map(|morpheme| ResolvedAffix {
        surface: morpheme.surface.clone(),
        kind: morpheme.kind,
        gloss: morpheme.gloss.to_uppercase(),
    }));

    let surface = compose_word(&root, &affixes);
    let mut morphemes: Vec<InflectionMorpheme> = Vec::with_capacity(affixes.len() + 1);
    morphemes.extend(
        affixes
            .iter()
            .filter(|a| a.kind == AffixKind::Prefix)
            .map(piece),
    );
    morphemes.push(InflectionMorpheme {
        surface: root,
        gloss: root_gloss,
        kind: InflectionKind::Root,
    });
    morphemes.extend(
        affixes
            .iter()
            .filter(|a| a.kind == AffixKind::Infix)
            .map(piece),
    );
    morphemes.extend(
        affixes
            .iter()
            .filter(|a| a.kind == AffixKind::Suffix)
            .map(piece),
    );

    Inflection { surface, morphemes }
}
