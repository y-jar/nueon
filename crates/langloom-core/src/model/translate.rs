//! English → conlang execution engine.
//!
//! Pure and UI-independent: tokenizes an English sentence, finds conlang
//! candidates by `definition`, assigns them to a syntax grid's slots, and
//! reports missing words, homograph conflicts, and unfilled slots.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::dictionary::Dictionary;
use super::entry::WordEntry;
use crate::translation::{ClauseSlot, SyntaxGrid};

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
    Separator,
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

/// Split an input sentence into normalized tokens.
pub fn tokenize(input: &str) -> Vec<Token> {
    input
        .split(|c: char| !c.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| Token {
            text: part.to_string(),
            normalized: normalize(part),
        })
        .filter(|token| !token.normalized.is_empty() && token.normalized != "to")
        .collect()
}

/// Find matching entries: exact sense matches win, otherwise substring matches.
fn matching_entries<'a>(dict: &'a Dictionary, token: &Token) -> Vec<(&'a str, &'a WordEntry)> {
    let mut exact = Vec::new();
    let mut partial = Vec::new();
    for table in dict.tables() {
        for entry in &table.entries {
            let Some(senses) = entry.definition() else {
                continue;
            };
            let normalized: Vec<String> = senses.iter().map(|sense| normalize(sense)).collect();
            if normalized.iter().any(|sense| sense == &token.normalized) {
                exact.push((table.name.as_str(), entry));
            } else if normalized
                .iter()
                .any(|sense| sense.contains(token.normalized.as_str()))
            {
                partial.push((table.name.as_str(), entry));
            }
        }
    }
    if exact.is_empty() {
        partial
    } else {
        exact
    }
}

/// Candidates for a token, for use by UI conflict pickers.
pub fn token_candidates(dict: &Dictionary, token: &Token) -> Vec<Candidate> {
    matching_entries(dict, token)
        .into_iter()
        .map(|(table, entry)| Candidate {
            table: table.to_string(),
            id: entry.id,
            wordname: entry.wordname.clone(),
            senses: entry.definition().map(|s| s.to_vec()).unwrap_or_default(),
        })
        .collect()
}

/// Translate `input` using `grid`. `choices` resolves conflicts by token index.
pub fn translate(
    dict: &Dictionary,
    grid: &SyntaxGrid,
    separator: &str,
    input: &str,
    choices: &HashMap<usize, Uuid>,
) -> TranslationReport {
    let tokens = tokenize(input);
    let candidates: Vec<Vec<(&str, &WordEntry)>> = tokens
        .iter()
        .map(|token| matching_entries(dict, token))
        .collect();

    let mut chosen: Vec<Option<Uuid>> = vec![None; tokens.len()];
    let mut missing = Vec::new();
    let mut conflicts = Vec::new();
    for (index, token_candidates) in candidates.iter().enumerate() {
        match token_candidates.len() {
            0 => missing.push(index),
            1 => chosen[index] = Some(token_candidates[0].1.id),
            _ => {
                let picked = choices
                    .get(&index)
                    .filter(|id| token_candidates.iter().any(|(_, entry)| entry.id == **id))
                    .copied();
                match picked {
                    Some(id) => chosen[index] = Some(id),
                    None => conflicts.push(index),
                }
            }
        }
    }

    let count = tokens.len();
    let mut assigned = vec![false; count];
    let mut unfilled = Vec::new();
    let mut slots = Vec::new();

    for (index, slot) in grid.slots.iter().enumerate() {
        let symbol = match slot {
            ClauseSlot::Literal { text } => Symbol::Literal(text.clone()),
            ClauseSlot::Spacer => Symbol::Separator,
            ClauseSlot::Wildcard => match pick(&candidates, &chosen, &assigned, count, None) {
                Some(token) => {
                    assigned[token] = true;
                    Symbol::Word(word_for(dict, chosen[token]))
                }
                None => Symbol::Placeholder("*?".to_string()),
            },
            ClauseSlot::RequiredTag { tag } => {
                match pick(&candidates, &chosen, &assigned, count, Some(tag)) {
                    Some(token) => {
                        assigned[token] = true;
                        Symbol::Word(word_for(dict, chosen[token]))
                    }
                    None => {
                        unfilled.push(index);
                        Symbol::Placeholder(format!("#{tag}?"))
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
    for (index, id) in chosen.iter().enumerate() {
        if !assigned[index] {
            if let Some(id) = id {
                leftovers.push((index, *id));
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
    }
}

fn pick(
    candidates: &[Vec<(&str, &WordEntry)>],
    chosen: &[Option<Uuid>],
    assigned: &[bool],
    count: usize,
    tag: Option<&str>,
) -> Option<usize> {
    for index in 0..count {
        if assigned[index] {
            continue;
        }
        let Some(id) = chosen[index] else {
            continue;
        };
        let Some((_, entry)) = candidates[index].iter().find(|(_, entry)| entry.id == id) else {
            continue;
        };
        if tag.is_some_and(|tag| !entry.has(tag)) {
            continue;
        }
        return Some(index);
    }
    None
}

fn word_for(dict: &Dictionary, id: Option<Uuid>) -> String {
    id.and_then(|id| dict.find_entry(id))
        .map(|(_, entry)| entry.wordname.clone())
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
            Symbol::Separator => {
                output.push_str(separator);
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

    #[test]
    fn tokenizes_and_normalizes() {
        let tokens = tokenize("To run, the dog!");
        let words: Vec<&str> = tokens.iter().map(|t| t.normalized.as_str()).collect();
        assert_eq!(words, ["run", "the", "dog"]);
    }

    #[test]
    fn translates_a_simple_sentence() {
        let dict = build(&[
            ("kala", &["dog"], &["Subject"]),
            ("velo", &["to run"], &["Verb"]),
        ]);
        let grid = grid(vec![tag("Subject"), tag("Verb")]);
        let report = translate(&dict, &grid, " ", "dog run", &HashMap::new());
        assert!(report.complete);
        assert_eq!(report.output, "kala velo");
    }

    #[test]
    fn reports_missing_and_is_incomplete() {
        let dict = build(&[("kala", &["dog"], &[])]);
        let grid = grid(vec![tag("Subject")]);
        let report = translate(&dict, &grid, " ", "dog fly", &HashMap::new());
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
        let unresolved = translate(&dict, &grid, " ", "run", &HashMap::new());
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
        let resolved = translate(&dict, &grid, " ", "run", &choices);
        assert!(resolved.complete);
        assert_eq!(resolved.output, "koro");
    }

    #[test]
    fn unfilled_required_slot_is_reported() {
        let dict = build(&[("kala", &["dog"], &["Subject"])]);
        let grid = grid(vec![tag("Subject"), tag("Verb")]);
        let report = translate(&dict, &grid, " ", "dog", &HashMap::new());
        assert_eq!(report.unfilled, vec![1]);
        assert!(!report.complete);
    }

    #[test]
    fn literals_attach_and_spacers_separate() {
        let dict = build(&[("velo", &["to run"], &["Verb"])]);
        // word + literal attach directly
        let attached = grid(vec![tag("Verb"), ClauseSlot::Literal { text: "ka".into() }]);
        assert_eq!(
            translate(&dict, &attached, " ", "run", &HashMap::new()).output,
            "veloka"
        );
        // a spacer between word and literal emits the separator
        let spaced = grid(vec![
            tag("Verb"),
            ClauseSlot::Spacer,
            ClauseSlot::Literal { text: "ka".into() },
        ]);
        assert_eq!(
            translate(&dict, &spaced, " ", "run", &HashMap::new()).output,
            "velo ka"
        );
    }

    #[test]
    fn substring_matching_when_no_exact() {
        let dict = build(&[("kala", &["speaker"], &[])]);
        let grid = grid(vec![ClauseSlot::Wildcard]);
        let report = translate(&dict, &grid, " ", "speak", &HashMap::new());
        assert_eq!(report.output, "kala");
    }
}
