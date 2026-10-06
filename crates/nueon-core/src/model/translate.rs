//! English → conlang execution engine.
//!
//! Pure and UI-independent: tokenizes an English sentence, finds conlang
//! candidates by `definition` (with light lemmatization and rule-based
//! morphology), assigns them to a syntax grid's slots, and reports missing
//! words, homograph conflicts, and unfilled slots.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::dictionary::Dictionary;
use super::entry::WordEntry;
use crate::config::{AffixKind, AffixRule};
use crate::translation::{ClauseSlot, SyntaxGrid};

/// English function words dropped during tokenization.
const STOPWORDS: &[&str] = &["a", "an", "the"];

/// One normalized word of the input sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Token {
    pub text: String,
    pub normalized: String,
}

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

/// A potential conlang equivalent for a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub table: String,
    pub id: Uuid,
    pub wordname: String,
    pub senses: Vec<String>,
    /// Morphology affix to attach to the wordname (empty when none).
    pub affix: String,
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
            leftovers: Vec::new(),
            unfilled: Vec::new(),
            gloss: InterlinearGloss::default(),
        }
    }
}

/// Normalize a word: lowercase, strip surrounding punctuation, drop a leading
/// `to ` (so "to run" matches the token "run").
fn normalize(text: &str) -> String {
    let trimmed: String = text
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase();
    let without_to = trimmed.strip_prefix("to ").unwrap_or(&trimmed);
    without_to.trim().to_string()
}

fn add_form(forms: &mut Vec<String>, form: String) {
    if !form.is_empty() && !forms.contains(&form) {
        forms.push(form);
    }
}

/// Light English lemmatization: the surface form plus plausible base forms
/// (plural and common verb inflections) so inflected tokens still match roots.
pub fn lemma_forms(word: &str) -> Vec<String> {
    let mut forms = vec![word.to_string()];

    if word.ends_with("ies") && word.len() > 3 {
        add_form(&mut forms, format!("{}y", &word[..word.len() - 3]));
    }
    if word.ends_with("es") && word.len() > 2 {
        add_form(&mut forms, word[..word.len() - 2].to_string());
    }
    if word.ends_with('s') && !word.ends_with("ss") && word.len() > 1 {
        add_form(&mut forms, word[..word.len() - 1].to_string());
    }
    if word.ends_with("ing") && word.len() > 4 {
        let stem = &word[..word.len() - 3];
        add_form(&mut forms, stem.to_string());
        add_form(&mut forms, format!("{stem}e"));
        add_degeminated(&mut forms, stem);
    }
    if word.ends_with("ed") && word.len() > 3 {
        let stem = &word[..word.len() - 2];
        add_form(&mut forms, stem.to_string());
        add_form(&mut forms, word[..word.len() - 1].to_string());
        add_degeminated(&mut forms, stem);
    }
    forms
}

/// Add the stem with a doubled final consonant reduced (`runn` → `run`).
fn add_degeminated(forms: &mut Vec<String>, stem: &str) {
    let bytes = stem.as_bytes();
    if bytes.len() >= 2 && bytes[bytes.len() - 1] == bytes[bytes.len() - 2] {
        let is_consonant = |b: u8| b.is_ascii_alphabetic() && !b"aeiou".contains(&b);
        if is_consonant(bytes[bytes.len() - 1]) {
            add_form(forms, stem[..stem.len() - 1].to_string());
        }
    }
}

/// Split an input sentence into normalized tokens (stopwords removed).
pub fn tokenize(input: &str) -> Vec<Token> {
    input
        .split(|c: char| !c.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| Token {
            text: part.to_string(),
            normalized: normalize(part),
        })
        .filter(|token| {
            !token.normalized.is_empty()
                && token.normalized != "to"
                && !STOPWORDS.contains(&token.normalized.as_str())
        })
        .collect()
}

/// A dictionary match plus the morphology affix to attach.
#[derive(Debug, Clone, PartialEq)]
struct Match<'a> {
    table: &'a str,
    entry: &'a WordEntry,
    affix: String,
    /// English affix to gloss with (upper-cased), empty for direct matches.
    affix_gloss: String,
    /// Whether the affix attaches before the root.
    prefix: bool,
}

fn collect_for_form<'a>(
    dict: &'a Dictionary,
    form: &str,
    exact: &mut Vec<(&'a str, &'a WordEntry)>,
    partial: &mut Vec<(&'a str, &'a WordEntry)>,
) {
    for table in dict.tables() {
        for entry in &table.entries {
            let Some(senses) = entry.definition() else {
                continue;
            };
            let normalized: Vec<String> = senses.iter().map(|sense| normalize(sense)).collect();
            if normalized.iter().any(|sense| sense == form) {
                exact.push((table.name.as_str(), entry));
            } else if normalized.iter().any(|sense| sense.contains(form)) {
                partial.push((table.name.as_str(), entry));
            }
        }
    }
}

/// Find matching entries: exact sense matches win, otherwise substring matches.
/// Falls back to rule-based morphology on the affix rules.
fn matching_entries<'a>(
    dict: &'a Dictionary,
    token: &Token,
    affixes: &[AffixRule],
) -> Vec<Match<'a>> {
    let mut exact = Vec::new();
    let mut partial = Vec::new();
    for form in lemma_forms(&token.normalized) {
        collect_for_form(dict, &form, &mut exact, &mut partial);
    }
    let direct = if exact.is_empty() { partial } else { exact };
    if !direct.is_empty() {
        return direct
            .into_iter()
            .map(|(table, entry)| Match {
                table,
                entry,
                affix: String::new(),
                affix_gloss: String::new(),
                prefix: false,
            })
            .collect();
    }

    let mut results: Vec<Match> = Vec::new();
    for rule in affixes {
        if rule.english.is_empty() {
            continue;
        }
        let base = match rule.kind {
            AffixKind::Suffix => token.normalized.strip_suffix(&rule.english),
            AffixKind::Prefix => token.normalized.strip_prefix(&rule.english),
        };
        let Some(base) = base.filter(|base| !base.is_empty()) else {
            continue;
        };
        let mut ex = Vec::new();
        let mut pa = Vec::new();
        for form in lemma_forms(base) {
            collect_for_form(dict, &form, &mut ex, &mut pa);
        }
        let picked = if ex.is_empty() { pa } else { ex };
        for (table, entry) in picked {
            if results
                .iter()
                .any(|existing| existing.entry.id == entry.id && existing.affix == rule.conlang)
            {
                continue;
            }
            results.push(Match {
                table,
                entry,
                affix: rule.conlang.clone(),
                affix_gloss: rule.english.to_uppercase(),
                prefix: rule.kind == AffixKind::Prefix,
            });
        }
    }
    results
}

/// Candidates for a token, for use by UI conflict pickers.
pub fn token_candidates(dict: &Dictionary, token: &Token, affixes: &[AffixRule]) -> Vec<Candidate> {
    matching_entries(dict, token, affixes)
        .into_iter()
        .map(|matched| Candidate {
            table: matched.table.to_string(),
            id: matched.entry.id,
            wordname: matched.entry.wordname.clone(),
            senses: matched
                .entry
                .definition()
                .map(<[String]>::to_vec)
                .unwrap_or_default(),
            affix: matched.affix,
        })
        .collect()
}

/// A chosen dictionary entry plus its morphology affix.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Picked {
    id: Uuid,
    affix: String,
    affix_gloss: String,
    prefix: bool,
}

/// Translate `input` using `grid`. `choices` resolves conflicts by token index.
pub fn translate(
    dict: &Dictionary,
    grid: &SyntaxGrid,
    separator: &str,
    input: &str,
    choices: &HashMap<usize, Uuid>,
    affixes: &[AffixRule],
) -> TranslationReport {
    let tokens = tokenize(input);
    let candidates: Vec<Vec<Match>> = tokens
        .iter()
        .map(|token| matching_entries(dict, token, affixes))
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
    let mut morphemes = Vec::new();

    for (index, slot) in grid.slots.iter().enumerate() {
        let symbol = match slot {
            ClauseSlot::Literal { text } => {
                morphemes.push(GlossMorpheme {
                    surface: text.clone(),
                    gloss: text.clone(),
                });
                Symbol::Literal(text.clone())
            }
            ClauseSlot::Spacer { text } => Symbol::Separator(text.clone()),
            ClauseSlot::Wildcard => match pick(&candidates, &chosen, &assigned, count, None) {
                Some(token) => {
                    assigned[token] = true;
                    if let Some(morpheme) = gloss_for(dict, chosen[token].as_ref()) {
                        morphemes.push(morpheme);
                    }
                    Symbol::Word(word_for(dict, chosen[token].as_ref()))
                }
                None => {
                    morphemes.push(GlossMorpheme {
                        surface: "*?".to_string(),
                        gloss: "?".to_string(),
                    });
                    Symbol::Placeholder("*?".to_string())
                }
            },
            ClauseSlot::RequiredTag { tag } => {
                match pick(&candidates, &chosen, &assigned, count, Some(tag)) {
                    Some(token) => {
                        assigned[token] = true;
                        if let Some(morpheme) = gloss_for(dict, chosen[token].as_ref()) {
                            morphemes.push(morpheme);
                        }
                        Symbol::Word(word_for(dict, chosen[token].as_ref()))
                    }
                    None => {
                        unfilled.push(index);
                        let placeholder = format!("#{tag}?");
                        morphemes.push(GlossMorpheme {
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
        leftovers,
        unfilled,
        gloss: InterlinearGloss {
            morphemes,
            translation: input.to_string(),
        },
    }
}

/// Build the interlinear gloss morpheme for a chosen word (with affix).
fn gloss_for(dict: &Dictionary, picked: Option<&Picked>) -> Option<GlossMorpheme> {
    let picked = picked?;
    let (_, entry) = dict.find_entry(picked.id)?;
    let sense = entry
        .definition()
        .and_then(<[String]>::first)
        .map(|sense| normalize(sense))
        .filter(|sense| !sense.is_empty())
        .unwrap_or_else(|| entry.wordname.clone());
    let root = entry.wordname.clone();

    let surface = if picked.affix.is_empty() {
        root
    } else if picked.prefix {
        format!("{}-{root}", picked.affix)
    } else {
        format!("{root}-{}", picked.affix)
    };
    let gloss = if picked.affix_gloss.is_empty() {
        sense
    } else if picked.prefix {
        format!("{}-{sense}", picked.affix_gloss)
    } else {
        format!("{sense}-{}", picked.affix_gloss)
    };
    Some(GlossMorpheme { surface, gloss })
}

fn pick(
    candidates: &[Vec<Match>],
    chosen: &[Option<Picked>],
    assigned: &[bool],
    count: usize,
    tag: Option<&str>,
) -> Option<usize> {
    for index in 0..count {
        if assigned[index] {
            continue;
        }
        let Some(picked) = &chosen[index] else {
            continue;
        };
        let Some(matched) = candidates[index]
            .iter()
            .find(|matched| matched.entry.id == picked.id)
        else {
            continue;
        };
        if tag.is_some_and(|tag| !matched.entry.has(tag)) {
            continue;
        }
        return Some(index);
    }
    None
}

fn word_for(dict: &Dictionary, picked: Option<&Picked>) -> String {
    picked
        .and_then(|picked| {
            dict.find_entry(picked.id)
                .map(|(_, entry)| format!("{}{}", entry.wordname, picked.affix))
        })
        .unwrap_or_else(|| "?".to_string())
}

fn render(slots: &[SlotOutcome], separator: &str) -> String {
    let mut output = String::new();
    let mut previous_word = false;
    for outcome in slots {
        match &outcome.symbol {
            Symbol::Word(word) => {
                if previous_word {
                    output.push_str(separator);
                }
                output.push_str(word);
                previous_word = true;
            }
            Symbol::Placeholder(text) => {
                if previous_word {
                    output.push_str(separator);
                }
                output.push_str(text);
                previous_word = true;
            }
            Symbol::Literal(text) => {
                output.push_str(text);
                previous_word = false;
            }
            Symbol::Separator(custom) => {
                output.push_str(
                    custom
                        .as_deref()
                        .filter(|surface| !surface.is_empty())
                        .unwrap_or(separator),
                );
                previous_word = false;
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn substring_matching_when_no_exact() {
        let dict = build(&[("kala", &["speaker"], &[])]);
        let grid = grid(vec![ClauseSlot::Wildcard]);
        let report = translate(&dict, &grid, " ", "speak", &HashMap::new(), &no_affixes());
        assert_eq!(report.output, "kala");
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
}
