//! English → conlang execution engine.
//!
//! Pure and UI-independent: tokenizes an English sentence, finds conlang
//! candidates by `definition` (with light lemmatization and rule-based
//! morphology), assigns them to a syntax grid's slots, and reports missing
//! words, homograph conflicts, and unfilled slots.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::dictionary::{contains_word, Dictionary, WordHit};
use super::entry::WordEntry;
use super::field::FieldValue;
use crate::config::{
    AffixKind, AffixRule, Feature, FeatureColumn, MorphemeRef, Morphology, ParadigmRow, TableRole,
    TableRoleConfig, POS_TAG,
};
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

/// Feature selections implied by an English surface form, used as defaults a
/// user's feature-bar choice can still override. A trailing plural `-s`/`-es`/
/// `-ies` (the same shapes [`lemma_forms`] strips) implies `number = plural`.
pub fn inferred_features(word: &str) -> BTreeMap<String, String> {
    let mut features = BTreeMap::new();
    let plural = (word.ends_with("ies") && word.len() > 3)
        || (word.ends_with("es") && word.len() > 2)
        || (word.ends_with('s') && !word.ends_with("ss") && word.len() > 1);
    if plural {
        features.insert("number".to_string(), "plural".to_string());
    }
    features
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
    /// Default feature selections the token's surface implies (e.g. a plural
    /// ending), which explicit selections may override.
    features: BTreeMap<String, String>,
}

fn collect_for_form<'a>(
    dict: &'a Dictionary,
    form: &str,
    skip_tables: &BTreeSet<String>,
    exact: &mut Vec<(&'a str, &'a WordEntry)>,
    partial: &mut Vec<(&'a str, &'a WordEntry)>,
) {
    for table in dict.tables() {
        // Fixes tables are morpheme sources, never roots.
        if skip_tables.contains(&table.name) {
            continue;
        }
        for entry in &table.entries {
            let Some(senses) = entry.definition() else {
                continue;
            };
            let normalized: Vec<String> = senses.iter().map(|sense| normalize(sense)).collect();
            if normalized.iter().any(|sense| sense == form) {
                exact.push((table.name.as_str(), entry));
            } else if form.chars().count() >= 3
                && normalized.iter().any(|sense| contains_word(sense, form))
            {
                partial.push((table.name.as_str(), entry));
            }
        }
    }
}

/// Find matching entries: exact sense matches win, otherwise whole-word matches
/// (tokens of at least three characters). Falls back to rule-based morphology
/// on the affix rules.
fn matching_entries<'a>(
    dict: &'a Dictionary,
    token: &Token,
    affixes: &[AffixRule],
    skip_tables: &BTreeSet<String>,
) -> Vec<Match<'a>> {
    let mut exact = Vec::new();
    let mut partial = Vec::new();
    let features = inferred_features(&token.normalized);
    for form in lemma_forms(&token.normalized) {
        collect_for_form(dict, &form, skip_tables, &mut exact, &mut partial);
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
                features: features.clone(),
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
            // English input has no infixes to strip; such rules never parse.
            AffixKind::Infix => continue,
        };
        let Some(base) = base.filter(|base| !base.is_empty()) else {
            continue;
        };
        let mut ex = Vec::new();
        let mut pa = Vec::new();
        for form in lemma_forms(base) {
            collect_for_form(dict, &form, skip_tables, &mut ex, &mut pa);
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
                features: features.clone(),
            });
        }
    }
    results
}

/// A conlang affix surface read from a fixes table. A leading hyphen marks a
/// suffix (`-i`), a trailing one a prefix (`ka-`), and both an infix (`-ta-`,
/// inserted after the first vowel).
pub fn parse_affix_surface(surface: &str) -> Option<(AffixKind, String)> {
    let trimmed = surface.trim();
    let leading = trimmed.starts_with('-');
    let trailing = trimmed.ends_with('-') && trimmed.len() > 1;
    let conlang = trimmed.trim_matches('-');
    if conlang.is_empty() {
        return None;
    }
    match (leading, trailing) {
        (true, false) => Some((AffixKind::Suffix, conlang.to_string())),
        (false, true) => Some((AffixKind::Prefix, conlang.to_string())),
        (true, true) => Some((AffixKind::Infix, conlang.to_string())),
        // Unmarked: not an affix.
        _ => None,
    }
}

/// The first text value stored under `column`, if any.
fn entry_text(entry: &WordEntry, column: &str) -> Option<String> {
    match entry.values.get(column) {
        Some(FieldValue::Text(text)) => Some(text.clone()),
        Some(FieldValue::TagList(list)) => list.first().cloned(),
        _ => None,
    }
}

/// Every text value stored under `column` (a text is one, a tag list is many).
fn entry_texts(entry: &WordEntry, column: &str) -> Vec<String> {
    match entry.values.get(column) {
        Some(FieldValue::Text(text)) => vec![text.clone()],
        Some(FieldValue::TagList(list)) => list.clone(),
        _ => Vec::new(),
    }
}

/// Affix rules derived from tables designated `Fixes`: each entry's surface
/// (a configured column, or its wordname) with one rule per English trigger.
pub fn dictionary_affixes(
    dict: &Dictionary,
    roles: &BTreeMap<String, TableRoleConfig>,
) -> Vec<AffixRule> {
    let mut rules = Vec::new();
    for (table_name, config) in roles {
        if config.role != TableRole::Fixes {
            continue;
        }
        let Some(table) = dict.table(table_name) else {
            continue;
        };
        let Some(trigger_column) = config.trigger.as_deref() else {
            continue;
        };
        for entry in &table.entries {
            let surface = match config.surface.as_deref() {
                Some(column) => entry_text(entry, column),
                None => Some(entry.wordname.clone()),
            };
            let Some(surface) = surface else {
                continue;
            };
            let Some((kind, conlang)) = parse_affix_surface(&surface) else {
                continue;
            };
            // English input has no infixes, so they never become input rules.
            if kind == AffixKind::Infix {
                continue;
            }
            for trigger in entry_texts(entry, trigger_column) {
                let english = normalize(&trigger);
                if english.is_empty() {
                    continue;
                }
                rules.push(AffixRule {
                    kind,
                    english,
                    conlang: conlang.clone(),
                });
            }
        }
    }
    rules
}

/// A morpheme read from a `Fixes` table: a surface form, where it attaches, and
/// the gloss it contributes. A paradigm slot can reference one by [`Morpheme`]
/// key instead of repeating its surface, keeping the fixes table the single
/// source of truth for morpheme forms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Morpheme {
    /// The fixes table it came from.
    pub table: String,
    /// The row's stable id (the word entry's uuid).
    pub id: String,
    /// The row's wordname, one of its keys.
    pub wordname: String,
    /// Names the morpheme answers to: its wordname plus every english trigger.
    pub keys: Vec<String>,
    /// The bare conlang form (hyphens stripped).
    pub surface: String,
    pub kind: AffixKind,
    /// The morpheme's meaning, from the first definition sense.
    pub gloss: String,
}

/// Every morpheme supplied by tables designated `Fixes`.
///
/// English is optional: a row yields a morpheme as soon as its surface (a
/// configured column, else the wordname) is a hyphen-marked affix. A trigger
/// column, when configured, only adds English keys for reference and input
/// parsing — it is never required.
pub fn dictionary_morphemes(
    dict: &Dictionary,
    roles: &BTreeMap<String, TableRoleConfig>,
) -> Vec<Morpheme> {
    let mut morphemes = Vec::new();
    for (table_name, config) in roles {
        if config.role != TableRole::Fixes {
            continue;
        }
        let Some(table) = dict.table(table_name) else {
            continue;
        };
        for entry in &table.entries {
            let surface = match config.surface.as_deref() {
                Some(column) => entry_text(entry, column),
                None => Some(entry.wordname.clone()),
            };
            let Some(surface) = surface else {
                continue;
            };
            let Some((kind, form)) = parse_affix_surface(&surface) else {
                continue;
            };
            let mut keys = vec![entry.wordname.clone()];
            if let Some(trigger_column) = config.trigger.as_deref() {
                for trigger in entry_texts(entry, trigger_column) {
                    let trigger = normalize(&trigger);
                    if !trigger.is_empty() {
                        keys.push(trigger);
                    }
                }
            }
            let gloss = entry
                .definition()
                .and_then(<[String]>::first)
                .cloned()
                .unwrap_or_else(|| entry.wordname.clone());
            morphemes.push(Morpheme {
                table: table_name.clone(),
                id: entry.id.to_string(),
                wordname: entry.wordname.clone(),
                keys,
                surface: form,
                kind,
                gloss,
            });
        }
    }
    morphemes
}

/// The distinct values present under `column` in `table`, sorted — the options
/// for an inherent feature bound to that column.
pub fn inherent_values(dict: &Dictionary, table: &str, column: &str) -> Vec<String> {
    let mut values: BTreeSet<String> = BTreeSet::new();
    if let Some(word_table) = dict.table(table) {
        for entry in &word_table.entries {
            match entry.values.get(column) {
                Some(FieldValue::Text(text)) if !text.is_empty() => {
                    values.insert(text.clone());
                }
                Some(FieldValue::TagList(items)) => {
                    for item in items {
                        if !item.is_empty() {
                            values.insert(item.clone());
                        }
                    }
                }
                _ => {}
            }
        }
    }
    values.into_iter().collect()
}

impl Morpheme {
    /// Whether this morpheme answers to `reference`: its wordname or any
    /// trigger, compared case-insensitively.
    pub fn matches(&self, reference: &str) -> bool {
        if self.wordname == reference || self.keys.iter().any(|key| key == reference) {
            return true;
        }
        let wanted = normalize(reference);
        !wanted.is_empty() && self.keys.contains(&wanted)
    }
}

/// The morpheme a paradigm row references, matched by wordname or trigger.
fn find_morpheme<'a>(morphemes: &'a [Morpheme], reference: &str) -> Option<&'a Morpheme> {
    morphemes
        .iter()
        .find(|morpheme| morpheme.matches(reference))
}

/// Resolve a paradigm row's morpheme reference: `{ table, id }` first, then a
/// legacy key by wordname/trigger.
fn find_morpheme_ref<'a>(
    morphemes: &'a [Morpheme],
    reference: &MorphemeRef,
) -> Option<&'a Morpheme> {
    match reference {
        MorphemeRef::Ref { table, id } => morphemes
            .iter()
            .find(|morpheme| morpheme.table == *table && morpheme.id == *id),
        MorphemeRef::Key(key) => find_morpheme(morphemes, key),
    }
}

/// A chosen dictionary entry plus its morphology affix.
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
                match pick(&candidates, &chosen, &assigned, count, None, None) {
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
                match pick(&candidates, &chosen, &assigned, count, Some(tag), None) {
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
                match pick(&candidates, &chosen, &assigned, count, None, Some(class)) {
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

/// Build the interlinear gloss morpheme for a chosen word (with affix).
/// The word class of an entry (`pos` tag, first sense).
fn word_class(entry: &WordEntry) -> Option<&str> {
    match entry.values.get(POS_TAG) {
        Some(FieldValue::TagList(list)) => list.first().map(String::as_str),
        Some(FieldValue::Text(text)) => Some(text.as_str()),
        _ => None,
    }
}

/// Merge a token's inferred feature defaults with the caller's explicit
/// selections; an explicit selection wins over the inferred default.
fn effective_selections(
    explicit: &BTreeMap<String, String>,
    inferred: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut selections = inferred.clone();
    for (feature, value) in explicit {
        selections.insert(feature.clone(), value.clone());
    }
    selections
}

/// The word's inherent feature values, read from each feature's bound column
/// (only when the binding's table matches the word's table).
fn inherent_selections(
    table: &str,
    entry: &WordEntry,
    morphology: &Morphology,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for feature in &morphology.features {
        let Some(binding) = feature.column.as_ref() else {
            continue;
        };
        if binding.table != table {
            continue;
        }
        // An unset value is recorded as "" so rules can target the "unset" row.
        out.insert(
            feature.id.clone(),
            entry_text(entry, &binding.column).unwrap_or_default(),
        );
    }
    out
}

/// One affix to attach, resolved from a paradigm row (and, for a `morpheme`
/// reference, from the fixes table that defines it).
struct ResolvedAffix {
    surface: String,
    kind: AffixKind,
    /// The gloss label this affix contributes (empty when it adds none).
    gloss: String,
}

/// The paradigm affixes for `id`'s class given the selected features, ordered.
fn resolve_affixes(
    dict: &Dictionary,
    id: Uuid,
    morphology: &Morphology,
    morphemes: &[Morpheme],
    selections: &BTreeMap<String, String>,
) -> Vec<ResolvedAffix> {
    let Some((table, entry)) = dict.find_entry(id) else {
        return Vec::new();
    };
    let Some(class) = word_class(entry) else {
        return Vec::new();
    };
    // A word's inherent values (from bound columns) join the selection; an
    // explicit inflectional choice still wins.
    let mut effective = inherent_selections(table, entry, morphology);
    for (feature, value) in selections {
        effective.insert(feature.clone(), value.clone());
    }
    morphology
        .rows_for(class, &effective)
        .into_iter()
        // A zero ending matches and counts as defined, but attaches nothing.
        .filter(|row| !row.zero)
        .map(|row| {
            if let Some(reference) = row.morpheme.as_ref() {
                if let Some(morpheme) = find_morpheme_ref(morphemes, reference) {
                    return ResolvedAffix {
                        surface: morpheme.surface.clone(),
                        kind: morpheme.kind,
                        gloss: morpheme.gloss.to_uppercase(),
                    };
                }
            }
            ResolvedAffix {
                surface: row.surface.clone(),
                kind: row.kind,
                gloss: morphology.labels_for(row).join("."),
            }
        })
        .collect()
}

/// Insert `infix` after the first vowel of `word` (or at the start if none).
fn insert_after_first_vowel(word: &str, infix: &str) -> String {
    const VOWELS: &str = "aeiou";
    let at = word
        .char_indices()
        .find(|(_, ch)| VOWELS.contains(ch.to_ascii_lowercase()))
        .map(|(index, ch)| index + ch.len_utf8())
        .unwrap_or(0);
    format!("{}{}{}", &word[..at], infix, &word[at..])
}

/// Attach resolved affixes around a stem: infixes inside it, then a prefix and
/// a suffix on the ends. Affixes arrive already ordered.
fn compose_word(base: &str, affixes: &[ResolvedAffix]) -> String {
    let mut stem = base.to_string();
    for affix in affixes.iter().filter(|a| a.kind == AffixKind::Infix) {
        stem = insert_after_first_vowel(&stem, &affix.surface);
    }
    let mut word = stem;
    for affix in affixes.iter().filter(|a| a.kind == AffixKind::Prefix) {
        word = format!("{}{}", affix.surface, word);
    }
    for affix in affixes.iter().filter(|a| a.kind == AffixKind::Suffix) {
        word.push_str(&affix.surface);
    }
    word
}

/// The conlang surface for a chosen word, with every paradigm affix attached.
fn render_word(
    dict: &Dictionary,
    picked: Option<&Picked>,
    morphology: &Morphology,
    morphemes: &[Morpheme],
    selections: &BTreeMap<String, String>,
) -> String {
    let base = word_for(dict, picked);
    let Some(picked) = picked else {
        return base;
    };
    let selections = effective_selections(selections, &picked.features);
    let affixes = resolve_affixes(dict, picked.id, morphology, morphemes, &selections);
    compose_word(&base, &affixes)
}

/// The interlinear-gloss morpheme for a chosen word, with every paradigm affix
/// and its gloss labels.
fn render_gloss(
    dict: &Dictionary,
    picked: Option<&Picked>,
    morphology: &Morphology,
    morphemes: &[Morpheme],
    selections: &BTreeMap<String, String>,
) -> Option<GlossMorpheme> {
    let mut morpheme = gloss_for(dict, picked)?;
    let picked = picked?;
    let selections = effective_selections(selections, &picked.features);
    for affix in resolve_affixes(dict, picked.id, morphology, morphemes, &selections) {
        morpheme.surface = match affix.kind {
            AffixKind::Prefix => format!("{}-{}", affix.surface, morpheme.surface),
            AffixKind::Suffix => format!("{}-{}", morpheme.surface, affix.surface),
            AffixKind::Infix => {
                insert_after_first_vowel(&morpheme.surface, &format!("-{}-", affix.surface))
            }
        };
        if !affix.gloss.is_empty() {
            morpheme.gloss = format!("{}.{}", morpheme.gloss, affix.gloss);
        }
    }
    Some(morpheme)
}

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

/// A cell in the endings grid: the ending resolved for one (combination, slot).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GridCell {
    pub slot: Option<String>,
    /// Whether a rule matched (an empty cell is a coverage gap).
    pub defined: bool,
    /// Equal-specificity ties that also matched (an ambiguous cell).
    pub ambiguous: bool,
    pub zero: bool,
    pub kind: AffixKind,
    /// The inline surface (used when neither a morpheme nor zero is set).
    pub surface: String,
    /// The referenced morpheme, if any (for the picker to preselect).
    pub morpheme: Option<MorphemeRef>,
    /// A display form: the morpheme's bare surface, the inline surface, or "∅".
    pub preview: String,
}

/// One feature combination (a grid row), with a cell per slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GridRow {
    pub when: BTreeMap<String, String>,
    pub cells: Vec<GridCell>,
}

/// The endings grid for a class: its slot columns and covered combinations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParadigmGrid {
    pub slots: Vec<Option<String>>,
    pub rows: Vec<GridRow>,
    /// Total combinations before the display cap.
    pub total: usize,
}

/// The maximum number of combination rows the grid renders.
pub const GRID_CAP: usize = 64;

fn grid_cell(
    slot: Option<String>,
    row: &ParadigmRow,
    ambiguous: bool,
    morphemes: &[Morpheme],
) -> GridCell {
    let preview = if row.zero {
        "∅".to_string()
    } else if let Some(reference) = row.morpheme.as_ref() {
        find_morpheme_ref(morphemes, reference)
            .map(|morpheme| morpheme.surface.clone())
            .unwrap_or_else(|| row.surface.clone())
    } else {
        row.surface.clone()
    };
    GridCell {
        slot,
        defined: true,
        ambiguous,
        zero: row.zero,
        kind: row.kind,
        surface: row.surface.clone(),
        morpheme: row.morpheme.clone(),
        preview,
    }
}

/// Build the endings coverage grid for `class`: columns are the class's slots,
/// rows are the combinations of the features it uses (referenced + inherent),
/// each cell the winning ending (empty = a coverage gap, flagged if ambiguous).
pub fn paradigm_grid(
    dict: &Dictionary,
    morphology: &Morphology,
    morphemes: &[Morpheme],
    class: &str,
) -> ParadigmGrid {
    let rows: &[ParadigmRow] = morphology
        .paradigms
        .iter()
        .find(|paradigm| paradigm.class == class)
        .map(|paradigm| paradigm.rows.as_slice())
        .unwrap_or(&[]);

    // Slot columns, ordered by the smallest `order` seen in that slot.
    let mut slots: Vec<(i32, Option<String>)> = Vec::new();
    for row in rows {
        match slots.iter_mut().find(|(_, slot)| *slot == row.slot) {
            Some((order, _)) => *order = (*order).min(row.order),
            None => slots.push((row.order, row.slot.clone())),
        }
    }
    slots.sort_by_key(|(order, _)| *order);
    let slot_list: Vec<Option<String>> = if slots.is_empty() {
        vec![None]
    } else {
        slots.into_iter().map(|(_, slot)| slot).collect()
    };

    // Features the class uses: referenced by its rows, plus inherent (bound).
    let mut used: Vec<String> = Vec::new();
    for row in rows {
        for feature in row.when.keys() {
            if !used.contains(feature) {
                used.push(feature.clone());
            }
        }
    }
    // An inherent feature counts as used when the class's own words carry a
    // value in its bound column (so unrelated classes don't show it).
    let class_uses_column = |binding: &FeatureColumn| {
        dict.table(&binding.table).is_some_and(|table| {
            table.entries.iter().any(|entry| {
                word_class(entry) == Some(class)
                    && entry_text(entry, &binding.column).is_some_and(|value| !value.is_empty())
            })
        })
    };
    for feature in &morphology.features {
        if let Some(binding) = &feature.column {
            if !used.contains(&feature.id) && class_uses_column(binding) {
                used.push(feature.id.clone());
            }
        }
    }
    let grid_features: Vec<&Feature> = morphology
        .features
        .iter()
        .filter(|feature| used.contains(&feature.id))
        .collect();

    // Values per feature: inherent reads the bound column (with an "unset" "");
    // inflectional uses the declared values.
    let values_per: Vec<Vec<String>> = grid_features
        .iter()
        .map(|feature| match &feature.column {
            Some(binding) => {
                let mut values = vec![String::new()];
                values.extend(inherent_values(dict, &binding.table, &binding.column));
                values
            }
            None => feature
                .values
                .iter()
                .map(|value| value.id.clone())
                .collect(),
        })
        .collect();

    // Cartesian product, capped at GRID_CAP rows.
    let mut combos: Vec<BTreeMap<String, String>> = vec![BTreeMap::new()];
    for (feature, values) in grid_features.iter().zip(&values_per) {
        let mut next = Vec::new();
        'outer: for combo in &combos {
            for value in values {
                let mut built = combo.clone();
                built.insert(feature.id.clone(), value.clone());
                next.push(built);
                if next.len() >= GRID_CAP {
                    break 'outer;
                }
            }
        }
        combos = next;
    }
    let total = values_per
        .iter()
        .fold(1usize, |acc, values| acc * values.len().max(1));

    let resolved: Vec<GridRow> = combos
        .into_iter()
        .map(|combo| {
            let cells = slot_list
                .iter()
                .map(|slot| {
                    let matching: Vec<&ParadigmRow> = rows
                        .iter()
                        .filter(|row| {
                            !row.when.is_empty()
                                && &row.slot == slot
                                && row
                                    .when
                                    .iter()
                                    .all(|(feature, value)| combo.get(feature) == Some(value))
                        })
                        .collect();
                    if matching.is_empty() {
                        return GridCell {
                            slot: slot.clone(),
                            defined: false,
                            ambiguous: false,
                            zero: false,
                            kind: AffixKind::Suffix,
                            surface: String::new(),
                            morpheme: None,
                            preview: String::new(),
                        };
                    }
                    let max = matching.iter().map(|row| row.when.len()).max().unwrap_or(0);
                    let mut top: Vec<&ParadigmRow> = matching
                        .into_iter()
                        .filter(|row| row.when.len() == max)
                        .collect();
                    let winner = top.remove(0);
                    grid_cell(slot.clone(), winner, !top.is_empty(), morphemes)
                })
                .collect();
            GridRow { when: combo, cells }
        })
        .collect();

    ParadigmGrid {
        slots: slot_list,
        rows: resolved,
        total,
    }
}

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
    class: Option<&str>,
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
        if class.is_some_and(|class| word_class(matched.entry) != Some(class)) {
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
    use crate::config::{Paradigm, ParadigmRow, TableRole, TableRoleConfig};
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
