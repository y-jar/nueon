//! English → conlang execution engine.
//!
//! Pure and UI-independent: tokenizes an English sentence, finds conlang
//! candidates by `definition` (with light lemmatization and rule-based
//! morphology), assigns them to a syntax grid's slots, and reports missing
//! words, homograph conflicts, and unfilled slots.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::dictionary::{Dictionary, WordHit};
use super::entry::WordEntry;
use super::field::FieldValue;
use crate::config::{
    AffixKind, AffixRule, Feature, FeatureColumn, MorphemeRef, Morphology, ParadigmRow, TableRole,
    TableRoleConfig,
};
use crate::translation::{ClauseSlot, SyntaxGrid};

mod grid;
mod inflect;
mod matching;
mod morphemes;
mod render;
mod tokens;

use tokens::normalize;
pub use tokens::{inferred_features, lemma_forms, tokenize, Token};

pub use grid::{paradigm_grid, GridCell, GridRow, ParadigmGrid, GRID_CAP};
pub use inflect::{compose, inflect, ComposePiece, Inflection, InflectionKind, InflectionMorpheme};
pub use matching::class_column;
use matching::{matching_entries, word_class, Match};
pub use morphemes::{
    dictionary_affixes, dictionary_morphemes, inherent_values, parse_affix_surface, Morpheme,
};
use morphemes::{entry_text, find_morpheme, find_morpheme_ref};
use render::{
    compose_word, insert_after_first_vowel, pick, render, render_gloss, render_word,
    resolve_affixes, ResolvedAffix,
};

/// A resolved piece of output produced by one slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Symbol {
    Word(String),
    Literal(String),
    /// A spacer; the payload overrides the global separator when present.
    Separator(Option<String>),
    Placeholder(String),
}

/// The outcome of one slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotOutcome {
    pub index: usize,
    pub slot: ClauseSlot,
    pub symbol: Symbol,
}

/// One morpheme of an interlinear gloss: its surface form and gloss.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GlossMorpheme {
    pub surface: String,
    pub gloss: String,
}

/// A Leipzig-style interlinear gloss of the translated sentence.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct InterlinearGloss {
    /// Morphemes in output order (surface + morpheme gloss).
    pub morphemes: Vec<GlossMorpheme>,
    /// The free English translation.
    pub translation: String,
}

/// The full result of a translation attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslationReport {
    /// The assembled conlang sentence (with placeholders for gaps).
    pub output: String,
    /// Whether every token was placed and every required slot filled.
    pub complete: bool,
    pub tokens: Vec<Token>,
    pub slots: Vec<SlotOutcome>,
    /// Indices of tokens with no conlang equivalent.
    pub missing: Vec<usize>,
    /// Indices of tokens with multiple candidates and no chosen meaning.
    pub conflicts: Vec<usize>,
    /// For each conflicting token, the entries it could resolve to, so the UI
    /// can offer a real picker.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub candidates: BTreeMap<usize, Vec<WordHit>>,
    /// Matched tokens that no slot consumed.
    pub leftovers: Vec<(usize, Uuid)>,
    /// Indices of `RequiredTag` slots that could not be filled.
    pub unfilled: Vec<usize>,
    /// Leipzig interlinear gloss (surface / morpheme gloss / translation).
    #[serde(default, skip_serializing_if = "InterlinearGloss::is_empty")]
    pub gloss: InterlinearGloss,
}

impl InterlinearGloss {
    /// Whether this gloss has no content.
    pub fn is_empty(&self) -> bool {
        self.morphemes.is_empty() && self.translation.is_empty()
    }
}

impl TranslationReport {
    /// An empty report.
    pub fn empty() -> Self {
        Self {
            output: String::new(),
            complete: true,
            tokens: Vec::new(),
            slots: Vec::new(),
            missing: Vec::new(),
            conflicts: Vec::new(),
            candidates: BTreeMap::new(),
            leftovers: Vec::new(),
            unfilled: Vec::new(),
            gloss: InterlinearGloss::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Picked {
    id: Uuid,
    affix: String,
    affix_gloss: String,
    prefix: bool,
    /// Default feature selections implied by the token's surface.
    features: BTreeMap<String, String>,
}

/// Translate `input` using `grid`, without any feature morphology.
pub fn translate(
    dict: &Dictionary,
    grid: &SyntaxGrid,
    separator: &str,
    input: &str,
    choices: &HashMap<usize, Uuid>,
    affixes: &[AffixRule],
) -> TranslationReport {
    translate_with(
        dict,
        grid,
        separator,
        input,
        choices,
        affixes,
        &Morphology::default(),
        &BTreeMap::new(),
    )
}

/// Translate `input` using `grid`, applying `morphology` for any selected
/// features. `choices` resolves conflicts by token index.
#[allow(clippy::too_many_arguments)]
pub fn translate_with(
    dict: &Dictionary,
    grid: &SyntaxGrid,
    separator: &str,
    input: &str,
    choices: &HashMap<usize, Uuid>,
    affixes: &[AffixRule],
    morphology: &Morphology,
    selections: &BTreeMap<String, String>,
) -> TranslationReport {
    translate_with_scoped(
        dict,
        grid,
        separator,
        input,
        choices,
        affixes,
        morphology,
        selections,
        &BTreeSet::new(),
        &[],
    )
}

/// Like [`translate_with`], but skipping `skip_tables` during root lookup and
/// resolving paradigm `morpheme` references against `morphemes`. A `Fixes`
/// table's rows are morphemes, never candidate roots.
#[allow(clippy::too_many_arguments)]
pub fn translate_with_scoped(
    dict: &Dictionary,
    grid: &SyntaxGrid,
    separator: &str,
    input: &str,
    choices: &HashMap<usize, Uuid>,
    affixes: &[AffixRule],
    morphology: &Morphology,
    selections: &BTreeMap<String, String>,
    skip_tables: &BTreeSet<String>,
    morphemes: &[Morpheme],
) -> TranslationReport {
    let tokens = tokenize(input);
    let candidates: Vec<Vec<Match>> = tokens
        .iter()
        .map(|token| matching_entries(dict, token, affixes, skip_tables))
        .collect();

    let mut chosen: Vec<Option<Picked>> = vec![None; tokens.len()];
    let mut missing = Vec::new();
    let mut conflicts = Vec::new();
    for (index, token_candidates) in candidates.iter().enumerate() {
        match token_candidates.len() {
            0 => missing.push(index),
            1 => {
                let matched = &token_candidates[0];
                chosen[index] = Some(Picked {
                    id: matched.entry.id,
                    affix: matched.affix.clone(),
                    affix_gloss: matched.affix_gloss.clone(),
                    prefix: matched.prefix,
                    features: matched.features.clone(),
                });
            }
            _ => {
                let picked = choices.get(&index).and_then(|id| {
                    token_candidates
                        .iter()
                        .find(|matched| matched.entry.id == *id)
                });
                match picked {
                    Some(matched) => {
                        chosen[index] = Some(Picked {
                            id: matched.entry.id,
                            affix: matched.affix.clone(),
                            affix_gloss: matched.affix_gloss.clone(),
                            prefix: matched.prefix,
                            features: matched.features.clone(),
                        })
                    }
                    None => conflicts.push(index),
                }
            }
        }
    }

    let count = tokens.len();
    let mut assigned = vec![false; count];
    let mut unfilled = Vec::new();
    let mut slots = Vec::new();
    let mut gloss_morphemes = Vec::new();
    let column = class_column(dict, morphology);

    for (index, slot) in grid.slots.iter().enumerate() {
        let symbol = match slot {
            ClauseSlot::Literal { text } => {
                gloss_morphemes.push(GlossMorpheme {
                    surface: text.clone(),
                    gloss: text.clone(),
                });
                Symbol::Literal(text.clone())
            }
            ClauseSlot::Spacer { text } => Symbol::Separator(text.clone()),
            ClauseSlot::Wildcard => {
                match pick(&candidates, &chosen, &assigned, count, None, None, &column) {
                    Some(token) => {
                        assigned[token] = true;
                        if let Some(morpheme) = render_gloss(
                            dict,
                            chosen[token].as_ref(),
                            morphology,
                            morphemes,
                            selections,
                        ) {
                            gloss_morphemes.push(morpheme);
                        }
                        Symbol::Word(render_word(
                            dict,
                            chosen[token].as_ref(),
                            morphology,
                            morphemes,
                            selections,
                        ))
                    }
                    None => {
                        gloss_morphemes.push(GlossMorpheme {
                            surface: "*?".to_string(),
                            gloss: "?".to_string(),
                        });
                        Symbol::Placeholder("*?".to_string())
                    }
                }
            }
            ClauseSlot::RequiredTag { tag } => {
                match pick(
                    &candidates,
                    &chosen,
                    &assigned,
                    count,
                    Some(tag),
                    None,
                    &column,
                ) {
                    Some(token) => {
                        assigned[token] = true;
                        if let Some(morpheme) = render_gloss(
                            dict,
                            chosen[token].as_ref(),
                            morphology,
                            morphemes,
                            selections,
                        ) {
                            gloss_morphemes.push(morpheme);
                        }
                        Symbol::Word(render_word(
                            dict,
                            chosen[token].as_ref(),
                            morphology,
                            morphemes,
                            selections,
                        ))
                    }
                    None => {
                        unfilled.push(index);
                        let placeholder = format!("#{tag}?");
                        gloss_morphemes.push(GlossMorpheme {
                            surface: placeholder.clone(),
                            gloss: "?".to_string(),
                        });
                        Symbol::Placeholder(placeholder)
                    }
                }
            }
            ClauseSlot::Pos { class } => {
                match pick(
                    &candidates,
                    &chosen,
                    &assigned,
                    count,
                    None,
                    Some(class),
                    &column,
                ) {
                    Some(token) => {
                        assigned[token] = true;
                        if let Some(morpheme) = render_gloss(
                            dict,
                            chosen[token].as_ref(),
                            morphology,
                            morphemes,
                            selections,
                        ) {
                            gloss_morphemes.push(morpheme);
                        }
                        Symbol::Word(render_word(
                            dict,
                            chosen[token].as_ref(),
                            morphology,
                            morphemes,
                            selections,
                        ))
                    }
                    None => {
                        unfilled.push(index);
                        let placeholder = format!("[{class}?]");
                        gloss_morphemes.push(GlossMorpheme {
                            surface: placeholder.clone(),
                            gloss: "?".to_string(),
                        });
                        Symbol::Placeholder(placeholder)
                    }
                }
            }
        };
        slots.push(SlotOutcome {
            index,
            slot: slot.clone(),
            symbol,
        });
    }

    let mut leftovers = Vec::new();
    for (index, picked) in chosen.iter().enumerate() {
        if !assigned[index] {
            if let Some(picked) = picked {
                leftovers.push((index, picked.id));
            }
        }
    }

    let mut candidate_map: BTreeMap<usize, Vec<WordHit>> = BTreeMap::new();
    for &index in &conflicts {
        if let Some(list) = candidates.get(index) {
            candidate_map.insert(
                index,
                list.iter()
                    .map(|matched| WordHit::from_entry(matched.table, matched.entry))
                    .collect(),
            );
        }
    }

    let output = render(&slots, if separator.is_empty() { " " } else { separator });
    let complete =
        missing.is_empty() && conflicts.is_empty() && unfilled.is_empty() && leftovers.is_empty();

    TranslationReport {
        output,
        complete,
        tokens,
        slots,
        missing,
        conflicts,
        candidates: candidate_map,
        leftovers,
        unfilled,
        gloss: InterlinearGloss {
            morphemes: gloss_morphemes,
            translation: input.to_string(),
        },
    }
}

/// Translate `input` word for word, in the order the words appear, without a
/// syntax grid. Each token maps to its conlang word (with the same
/// lemmatization and affix morphology), a token that already matches a
/// `wordname` is passed through unchanged, and unmatched tokens are reported
/// as missing so they can be added lazily.
pub fn translate_direct(
    dict: &Dictionary,
    separator: &str,
    input: &str,
    choices: &HashMap<usize, Uuid>,
    affixes: &[AffixRule],
) -> TranslationReport {
    translate_direct_with(
        dict,
        separator,
        input,
        choices,
        affixes,
        &Morphology::default(),
        &BTreeMap::new(),
    )
}

/// Word-for-word with feature morphology applied.
#[allow(clippy::too_many_arguments)]
pub fn translate_direct_with(
    dict: &Dictionary,
    separator: &str,
    input: &str,
    choices: &HashMap<usize, Uuid>,
    affixes: &[AffixRule],
    morphology: &Morphology,
    selections: &BTreeMap<String, String>,
) -> TranslationReport {
    translate_direct_with_scoped(
        dict,
        separator,
        input,
        choices,
        affixes,
        morphology,
        selections,
        &BTreeSet::new(),
        &[],
    )
}

/// Like [`translate_direct_with`], but skipping `skip_tables` during root
/// lookup and pass-through, and resolving paradigm `morpheme` references
/// against `morphemes`.
#[allow(clippy::too_many_arguments)]
pub fn translate_direct_with_scoped(
    dict: &Dictionary,
    separator: &str,
    input: &str,
    choices: &HashMap<usize, Uuid>,
    affixes: &[AffixRule],
    morphology: &Morphology,
    selections: &BTreeMap<String, String>,
    skip_tables: &BTreeSet<String>,
    morphemes: &[Morpheme],
) -> TranslationReport {
    let tokens = tokenize(input);
    let mut slots = Vec::new();
    let mut gloss_morphemes = Vec::new();
    let mut missing = Vec::new();
    let mut conflicts = Vec::new();
    let mut candidate_map: BTreeMap<usize, Vec<WordHit>> = BTreeMap::new();

    for (index, token) in tokens.iter().enumerate() {
        // A conlang word the user typed is emitted unchanged.
        if let Some(entry) = dict
            .all_entries()
            .find(|entry| entry.wordname.to_lowercase() == token.normalized)
            .filter(|entry| {
                dict.find_entry(entry.id)
                    .is_none_or(|(table, _)| !skip_tables.contains(table))
            })
        {
            let word = entry.wordname.clone();
            gloss_morphemes.push(GlossMorpheme {
                surface: word.clone(),
                gloss: word.clone(),
            });
            slots.push(SlotOutcome {
                index,
                slot: ClauseSlot::Wildcard,
                symbol: Symbol::Word(word),
            });
            continue;
        }

        let candidates = matching_entries(dict, token, affixes, skip_tables);
        let picked = match candidates.len() {
            0 => {
                missing.push(index);
                None
            }
            1 => Some(Picked {
                id: candidates[0].entry.id,
                affix: candidates[0].affix.clone(),
                affix_gloss: candidates[0].affix_gloss.clone(),
                prefix: candidates[0].prefix,
                features: candidates[0].features.clone(),
            }),
            _ => {
                let picked = choices
                    .get(&index)
                    .and_then(|id| candidates.iter().find(|matched| matched.entry.id == *id))
                    .map(|matched| Picked {
                        id: matched.entry.id,
                        affix: matched.affix.clone(),
                        affix_gloss: matched.affix_gloss.clone(),
                        prefix: matched.prefix,
                        features: matched.features.clone(),
                    });
                if picked.is_none() {
                    conflicts.push(index);
                    candidate_map.insert(
                        index,
                        candidates
                            .iter()
                            .map(|matched| WordHit::from_entry(matched.table, matched.entry))
                            .collect(),
                    );
                }
                picked
            }
        };

        match &picked {
            Some(_) => {
                if let Some(morpheme) =
                    render_gloss(dict, picked.as_ref(), morphology, morphemes, selections)
                {
                    gloss_morphemes.push(morpheme);
                }
                slots.push(SlotOutcome {
                    index,
                    slot: ClauseSlot::Wildcard,
                    symbol: Symbol::Word(render_word(
                        dict,
                        picked.as_ref(),
                        morphology,
                        morphemes,
                        selections,
                    )),
                });
            }
            None => {
                gloss_morphemes.push(GlossMorpheme {
                    surface: "*?".to_string(),
                    gloss: "?".to_string(),
                });
                slots.push(SlotOutcome {
                    index,
                    slot: ClauseSlot::Wildcard,
                    symbol: Symbol::Placeholder("*?".to_string()),
                });
            }
        }
    }

    let output = render(&slots, if separator.is_empty() { " " } else { separator });
    let complete = missing.is_empty() && conflicts.is_empty();

    TranslationReport {
        output,
        complete,
        tokens,
        slots,
        missing,
        conflicts,
        candidates: candidate_map,
        leftovers: Vec::new(),
        unfilled: Vec::new(),
        gloss: InterlinearGloss {
            morphemes: gloss_morphemes,
            translation: input.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Paradigm, ParadigmRow, TableRole, TableRoleConfig, POS_TAG};
    use crate::model::{FieldType, FieldValue, TagDef};
    use crate::translation::ClauseSlot;

    fn build(entries: &[(&str, &[&str], &[&str])]) -> Dictionary {
        let mut dict = Dictionary::new();
        dict.add_table("t");
        for (_, _, tags) in entries {
            for tag in *tags {
                dict.add_tag("t", TagDef::new(*tag, FieldType::Boolean));
            }
        }
        for (word, senses, tags) in entries {
            let mut entry = WordEntry::new(*word);
            entry.set(
                crate::model::DEFINITION_TAG,
                FieldValue::TagList(senses.iter().map(|s| s.to_string()).collect()),
            );
            for tag in *tags {
                entry.set(tag, FieldValue::Boolean(true));
            }
            dict.add_entry("t", entry);
        }
        dict
    }

    fn grid(slots: Vec<ClauseSlot>) -> SyntaxGrid {
        SyntaxGrid {
            preset_name: "t".into(),
            slots,
        }
    }

    fn tag(name: &str) -> ClauseSlot {
        ClauseSlot::RequiredTag { tag: name.into() }
    }

    fn no_affixes() -> Vec<AffixRule> {
        Vec::new()
    }

    #[test]
    fn tokenizes_and_normalizes_and_drops_stopwords() {
        let tokens = tokenize("To run, the dog!");
        let words: Vec<&str> = tokens.iter().map(|t| t.normalized.as_str()).collect();
        assert_eq!(words, ["run", "dog"]);
    }

    #[test]
    fn translates_a_simple_sentence() {
        let dict = build(&[
            ("kala", &["dog"], &["Subject"]),
            ("velo", &["to run"], &["Verb"]),
        ]);
        let grid = grid(vec![tag("Subject"), tag("Verb")]);
        let report = translate(&dict, &grid, " ", "dog run", &HashMap::new(), &no_affixes());
        assert!(report.complete);
        assert_eq!(report.output, "kala velo");
    }

    #[test]
    fn lemmatizes_plurals_and_verb_inflections() {
        let dict = build(&[("kala", &["dog"], &["Subject"])]);
        let dog_grid = grid(vec![tag("Subject")]);
        for input in ["dogs", "dog"] {
            let report = translate(&dict, &dog_grid, " ", input, &HashMap::new(), &no_affixes());
            assert!(report.complete, "input {input} should match");
            assert_eq!(report.output, "kala");
        }

        let verbs = build(&[("velo", &["to run"], &["Verb"])]);
        let verb_grid = grid(vec![tag("Verb")]);
        for input in ["runs", "running", "run"] {
            let report = translate(
                &verbs,
                &verb_grid,
                " ",
                input,
                &HashMap::new(),
                &no_affixes(),
            );
            assert!(report.complete, "input {input} should match");
            assert_eq!(report.output, "velo");
        }
    }

    #[test]
    fn morphology_applies_affix_to_matched_root() {
        let dict = build(&[("kala", &["dog"], &["Subject"])]);
        let rules = vec![AffixRule {
            kind: AffixKind::Suffix,
            english: "z".into(),
            conlang: "i".into(),
        }];
        let grid = grid(vec![tag("Subject")]);
        let report = translate(&dict, &grid, " ", "dogz", &HashMap::new(), &rules);
        assert!(report.complete);
        assert_eq!(report.output, "kalai");
    }

    #[test]
    fn inferred_features_detect_plural() {
        let plural = |word: &str| inferred_features(word).get("number").cloned();
        assert_eq!(plural("dogs"), Some("plural".to_string()));
        assert_eq!(plural("boxes"), Some("plural".to_string()));
        assert_eq!(plural("cities"), Some("plural".to_string()));
        assert!(inferred_features("dog").is_empty());
        // A word ending in a doubled `s` is not a plural.
        assert!(inferred_features("glass").is_empty());
    }

    fn noun_plural() -> Morphology {
        Morphology {
            features: Morphology::default().features,
            paradigms: vec![Paradigm {
                class: "noun".into(),
                rows: vec![ParadigmRow {
                    when: BTreeMap::from([("number".to_string(), "plural".to_string())]),
                    surface: "i".into(),
                    kind: AffixKind::Suffix,
                    slot: None,
                    order: 0,
                    morpheme: None,
                    zero: false,
                }],
            }],
            class_column: None,
        }
    }

    fn noun_dict() -> Dictionary {
        let mut dict = Dictionary::new();
        dict.add_table("t");
        dict.add_tag("t", TagDef::new(POS_TAG, FieldType::TagList));
        dict.add_entry("t", classed("kala", "dog", "noun"));
        dict
    }

    #[test]
    fn a_plural_input_selects_the_plural_feature() {
        let dict = noun_dict();
        let grid = grid(vec![ClauseSlot::Wildcard]);
        let report = translate_with(
            &dict,
            &grid,
            " ",
            "dogs",
            &HashMap::new(),
            &no_affixes(),
            &noun_plural(),
            &BTreeMap::new(),
        );
        assert_eq!(report.output, "kalai");
    }

    #[test]
    fn an_explicit_selection_overrides_the_inferred_plural() {
        let dict = noun_dict();
        let grid = grid(vec![ClauseSlot::Wildcard]);
        let explicit = BTreeMap::from([("number".to_string(), "singular".to_string())]);
        let report = translate_with(
            &dict,
            &grid,
            " ",
            "dogs",
            &HashMap::new(),
            &no_affixes(),
            &noun_plural(),
            &explicit,
        );
        assert_eq!(report.output, "kala");
    }

    #[test]
    fn parses_affix_surfaces_from_hyphens() {
        assert_eq!(
            parse_affix_surface("-i"),
            Some((AffixKind::Suffix, "i".to_string()))
        );
        assert_eq!(
            parse_affix_surface("ka-"),
            Some((AffixKind::Prefix, "ka".to_string()))
        );
        assert_eq!(
            parse_affix_surface("-ta-"),
            Some((AffixKind::Infix, "ta".to_string()))
        );
        // An unmarked surface is not an affix.
        assert_eq!(parse_affix_surface("i"), None);
        assert_eq!(parse_affix_surface("-"), None);
    }

    fn fixes_setup() -> (
        Dictionary,
        BTreeMap<String, TableRoleConfig>,
        BTreeSet<String>,
    ) {
        let mut dict = Dictionary::new();
        dict.add_table("lex");
        dict.add_entry("lex", classed("kala", "dog", "noun"));

        dict.add_table("fixes");
        let mut fix = WordEntry::new("-i");
        fix.set(
            crate::model::DEFINITION_TAG,
            FieldValue::TagList(vec!["cat".to_string()]),
        );
        fix.set("english", FieldValue::Text("z".to_string()));
        dict.add_entry("fixes", fix);

        let roles = BTreeMap::from([(
            "fixes".to_string(),
            TableRoleConfig {
                role: TableRole::Fixes,
                trigger: Some("english".to_string()),
                surface: None,
            },
        )]);
        let skip = ["fixes".to_string()].into_iter().collect();
        (dict, roles, skip)
    }

    #[test]
    fn fixes_tables_supply_affix_rules() {
        let (dict, roles, _) = fixes_setup();
        let affixes = dictionary_affixes(&dict, &roles);
        assert_eq!(affixes.len(), 1);
        assert_eq!(affixes[0].kind, AffixKind::Suffix);
        assert_eq!(affixes[0].english, "z");
        assert_eq!(affixes[0].conlang, "i");
    }

    #[test]
    fn a_fixes_affix_is_applied_and_its_table_is_not_a_root() {
        let (dict, roles, skip) = fixes_setup();
        let affixes = dictionary_affixes(&dict, &roles);

        // "dogz" has no plural/verb lemma, so it reaches the fixes affix.
        let report = translate_direct_with_scoped(
            &dict,
            " ",
            "dogz",
            &HashMap::new(),
            &affixes,
            &Morphology::default(),
            &BTreeMap::new(),
            &skip,
            &[],
        );
        assert_eq!(report.output, "kalai");

        // The fixes entry's own sense ("cat") is never matched as a root.
        let report = translate_direct_with_scoped(
            &dict,
            " ",
            "cat",
            &HashMap::new(),
            &affixes,
            &Morphology::default(),
            &BTreeMap::new(),
            &skip,
            &[],
        );
        assert_eq!(report.missing, vec![0]);
    }

    #[test]
    fn a_plural_input_inflects_in_direct_mode() {
        let dict = noun_dict();
        let report = translate_direct_with(
            &dict,
            " ",
            "dogs",
            &HashMap::new(),
            &no_affixes(),
            &noun_plural(),
            &BTreeMap::new(),
        );
        assert_eq!(report.output, "kalai");
    }

    #[test]
    fn reports_missing_and_is_incomplete() {
        let dict = build(&[("kala", &["dog"], &[])]);
        let grid = grid(vec![tag("Subject")]);
        let report = translate(&dict, &grid, " ", "dog fly", &HashMap::new(), &no_affixes());
        assert!(!report.complete);
        assert_eq!(report.missing.len(), 1);
    }

    #[test]
    fn conflicts_require_a_choice() {
        let dict = build(&[
            ("velo", &["to run"], &["Verb"]),
            ("koro", &["to run"], &["Verb"]),
        ]);
        let grid = grid(vec![tag("Verb")]);
        let unresolved = translate(&dict, &grid, " ", "run", &HashMap::new(), &no_affixes());
        assert!(!unresolved.complete);
        assert_eq!(unresolved.conflicts, vec![0]);

        let chosen_id = dict
            .table("t")
            .unwrap()
            .entries
            .iter()
            .find(|e| e.wordname == "koro")
            .unwrap()
            .id;
        let choices = HashMap::from([(0usize, chosen_id)]);
        let resolved = translate(&dict, &grid, " ", "run", &choices, &no_affixes());
        assert!(resolved.complete);
        assert_eq!(resolved.output, "koro");
    }

    #[test]
    fn unfilled_required_slot_is_reported() {
        let dict = build(&[("kala", &["dog"], &["Subject"])]);
        let grid = grid(vec![tag("Subject"), tag("Verb")]);
        let report = translate(&dict, &grid, " ", "dog", &HashMap::new(), &no_affixes());
        assert_eq!(report.unfilled, vec![1]);
        assert!(!report.complete);
    }

    fn classed(word: &str, sense: &str, class: &str) -> WordEntry {
        let mut entry = WordEntry::new(word);
        entry.set(
            crate::model::DEFINITION_TAG,
            FieldValue::TagList(vec![sense.to_string()]),
        );
        entry.set(POS_TAG, FieldValue::TagList(vec![class.to_string()]));
        entry
    }

    #[test]
    fn pos_slot_matches_by_class() {
        let mut dict = Dictionary::new();
        dict.add_table("t");
        dict.add_tag("t", TagDef::new(POS_TAG, FieldType::TagList));
        dict.add_entry("t", classed("velo", "to run", "verb"));
        dict.add_entry("t", classed("kala", "dog", "noun"));

        let grid = grid(vec![ClauseSlot::Pos {
            class: "verb".into(),
        }]);
        let report = translate(&dict, &grid, " ", "run", &HashMap::new(), &no_affixes());
        assert!(report.complete);
        assert_eq!(report.output, "velo");
    }

    #[test]
    fn pos_slot_ignores_other_classes() {
        let mut dict = Dictionary::new();
        dict.add_table("t");
        dict.add_tag("t", TagDef::new(POS_TAG, FieldType::TagList));
        dict.add_entry("t", classed("kala", "dog", "noun"));

        let grid = grid(vec![ClauseSlot::Pos {
            class: "verb".into(),
        }]);
        let report = translate(&dict, &grid, " ", "dog", &HashMap::new(), &no_affixes());
        assert_eq!(report.unfilled, vec![0]);
        assert!(!report.complete);
    }

    #[test]
    fn literals_attach_and_spacers_separate() {
        let dict = build(&[("velo", &["to run"], &["Verb"])]);
        // word + literal attach directly
        let attached = grid(vec![tag("Verb"), ClauseSlot::Literal { text: "ka".into() }]);
        assert_eq!(
            translate(&dict, &attached, " ", "run", &HashMap::new(), &no_affixes()).output,
            "veloka"
        );
        // a spacer between word and literal emits the separator
        let spaced = grid(vec![
            tag("Verb"),
            ClauseSlot::Spacer { text: None },
            ClauseSlot::Literal { text: "ka".into() },
        ]);
        assert_eq!(
            translate(&dict, &spaced, " ", "run", &HashMap::new(), &no_affixes()).output,
            "velo ka"
        );
    }

    #[test]
    fn custom_spacer_text_overrides_separator() {
        let dict = build(&[("velo", &["to run"], &["Verb"])]);
        let grid = grid(vec![
            tag("Verb"),
            ClauseSlot::Spacer {
                text: Some("·".into()),
            },
            ClauseSlot::Literal { text: "ka".into() },
        ]);
        assert_eq!(
            translate(&dict, &grid, " ", "run", &HashMap::new(), &no_affixes()).output,
            "velo·ka"
        );
    }

    #[test]
    fn whole_word_matching_when_no_exact() {
        let grid = grid(vec![ClauseSlot::Wildcard]);
        // A whole word inside a sense still matches...
        let dict = build(&[("kala", &["to speak loudly"], &[])]);
        let report = translate(&dict, &grid, " ", "speak", &HashMap::new(), &no_affixes());
        assert_eq!(report.output, "kala");

        // ...but a bare substring ("speaker") no longer does.
        let sub = build(&[("kala", &["speaker"], &[])]);
        let report = translate(&sub, &grid, " ", "speak", &HashMap::new(), &no_affixes());
        assert_eq!(report.missing, vec![0]);
    }

    #[test]
    fn gloss_pairs_surfaces_with_senses() {
        let dict = build(&[
            ("kala", &["dog"], &["Subject"]),
            ("velo", &["to run"], &["Verb"]),
        ]);
        let grid = grid(vec![tag("Subject"), tag("Verb")]);
        let report = translate(&dict, &grid, " ", "dog run", &HashMap::new(), &no_affixes());

        let surfaces: Vec<&str> = report
            .gloss
            .morphemes
            .iter()
            .map(|m| m.surface.as_str())
            .collect();
        let glosses: Vec<&str> = report
            .gloss
            .morphemes
            .iter()
            .map(|m| m.gloss.as_str())
            .collect();
        assert_eq!(surfaces, ["kala", "velo"]);
        assert_eq!(glosses, ["dog", "run"]);
        assert_eq!(report.gloss.translation, "dog run");
    }

    #[test]
    fn gloss_splits_morphology_and_uppercases_affix() {
        let dict = build(&[("kala", &["dog"], &["Subject"])]);
        let rules = vec![AffixRule {
            kind: AffixKind::Suffix,
            english: "x".into(),
            conlang: "i".into(),
        }];
        let grid = grid(vec![tag("Subject")]);
        let report = translate(&dict, &grid, " ", "dogx", &HashMap::new(), &rules);

        assert_eq!(report.output, "kalai");
        assert_eq!(report.gloss.morphemes[0].surface, "kala-i");
        assert_eq!(report.gloss.morphemes[0].gloss, "dog-X");
    }

    #[test]
    fn gloss_keeps_literals_and_drops_spacers() {
        let dict = build(&[("velo", &["to run"], &["Verb"])]);
        let grid = grid(vec![
            tag("Verb"),
            ClauseSlot::Spacer { text: None },
            ClauseSlot::Literal { text: "ka".into() },
        ]);
        let report = translate(&dict, &grid, " ", "run", &HashMap::new(), &no_affixes());

        let surfaces: Vec<&str> = report
            .gloss
            .morphemes
            .iter()
            .map(|m| m.surface.as_str())
            .collect();
        assert_eq!(surfaces, ["velo", "ka"]);
    }

    #[test]
    fn gloss_marks_unfilled_slots() {
        let dict = build(&[("kala", &["dog"], &["Subject"])]);
        let grid = grid(vec![tag("Subject"), tag("Verb")]);
        let report = translate(&dict, &grid, " ", "dog", &HashMap::new(), &no_affixes());

        let last = report.gloss.morphemes.last().unwrap();
        assert_eq!(last.surface, "#Verb?");
        assert_eq!(last.gloss, "?");
    }

    // -- word-for-word (direct) mode -----------------------------------------

    #[test]
    fn direct_translates_in_input_order() {
        let dict = build(&[
            ("kala", &["dog"], &["Subject"]),
            ("velo", &["to run"], &["Verb"]),
        ]);
        let report = translate_direct(&dict, " ", "dog run", &HashMap::new(), &no_affixes());
        assert!(report.complete);
        assert_eq!(report.output, "kala velo");
        assert_eq!(report.slots.len(), 2);
        assert!(report.unfilled.is_empty());
    }

    #[test]
    fn direct_passes_through_conlang_wordnames() {
        // "kala" is already conlang: it should be emitted unchanged.
        let dict = build(&[
            ("kala", &["dog"], &["Subject"]),
            ("velo", &["to run"], &["Verb"]),
        ]);
        let report = translate_direct(&dict, " ", "kala run", &HashMap::new(), &no_affixes());
        assert!(report.complete);
        assert_eq!(report.output, "kala velo");
    }

    #[test]
    fn direct_drops_stopwords() {
        let dict = build(&[("kala", &["dog"], &["Subject"])]);
        let report = translate_direct(&dict, " ", "the dog", &HashMap::new(), &no_affixes());
        assert_eq!(report.output, "kala");
    }

    #[test]
    fn direct_reports_missing_words() {
        let dict = build(&[("kala", &["dog"], &["Subject"])]);
        let report = translate_direct(&dict, " ", "dog fly", &HashMap::new(), &no_affixes());
        assert!(!report.complete);
        assert_eq!(report.missing, vec![1]);
    }

    #[test]
    fn direct_applies_morphology_affixes() {
        let dict = build(&[("kala", &["dog"], &["Subject"])]);
        let rules = vec![AffixRule {
            kind: AffixKind::Suffix,
            english: "z".into(),
            conlang: "i".into(),
        }];
        let report = translate_direct(&dict, " ", "dogz", &HashMap::new(), &rules);
        assert!(report.complete);
        assert_eq!(report.output, "kalai");
    }

    #[test]
    fn short_tokens_do_not_match_substrings() {
        // "i" must not match every sense containing an "i".
        let dict = build(&[("big", &["big"], &[]), ("with", &["with"], &[])]);
        let grid = grid(vec![ClauseSlot::Wildcard]);
        let report = translate(&dict, &grid, " ", "i", &HashMap::new(), &no_affixes());
        assert_eq!(report.missing, vec![0]);
        assert!(report.conflicts.is_empty());
        assert!(report.candidates.is_empty());
    }

    #[test]
    fn whole_words_match_but_substrings_do_not() {
        let grid = grid(vec![ClauseSlot::Wildcard]);
        let hit = build(&[("name", &["to eat food"], &[])]);
        let report = translate(&hit, &grid, " ", "eat", &HashMap::new(), &no_affixes());
        assert!(report.missing.is_empty());
        assert_eq!(report.output, "name");

        let miss = build(&[("feat", &["feature"], &[])]);
        let report = translate(&miss, &grid, " ", "eat", &HashMap::new(), &no_affixes());
        assert_eq!(report.missing, vec![0]);
    }

    #[test]
    fn ambiguous_matches_expose_candidates() {
        let dict = build(&[("velo", &["to run"], &[]), ("koro", &["to run"], &[])]);
        let grid = grid(vec![ClauseSlot::Wildcard]);
        let report = translate(&dict, &grid, " ", "run", &HashMap::new(), &no_affixes());
        assert_eq!(report.conflicts, vec![0]);
        let list = report.candidates.get(&0).expect("candidates");
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|hit| hit.wordname == "velo"));
        assert!(list.iter().any(|hit| hit.wordname == "koro"));
    }

    #[test]
    fn direct_conflicts_expose_candidates() {
        let dict = build(&[("velo", &["to run"], &[]), ("koro", &["to run"], &[])]);
        let report = translate_direct(&dict, " ", "run", &HashMap::new(), &no_affixes());
        assert_eq!(report.conflicts, vec![0]);
        assert_eq!(report.candidates.get(&0).map(Vec::len), Some(2));
    }

    #[test]
    fn direct_resolves_conflicts_by_choice() {
        let dict = build(&[
            ("velo", &["to run"], &["Verb"]),
            ("koro", &["to run"], &["Verb"]),
        ]);
        let unresolved = translate_direct(&dict, " ", "run", &HashMap::new(), &no_affixes());
        assert!(!unresolved.complete);
        assert_eq!(unresolved.conflicts, vec![0]);

        let chosen_id = dict
            .table("t")
            .unwrap()
            .entries
            .iter()
            .find(|e| e.wordname == "koro")
            .unwrap()
            .id;
        let choices = HashMap::from([(0usize, chosen_id)]);
        let resolved = translate_direct(&dict, " ", "run", &choices, &no_affixes());
        assert!(resolved.complete);
        assert_eq!(resolved.output, "koro");
    }
}
