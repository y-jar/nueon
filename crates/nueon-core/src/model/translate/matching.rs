//! Matching English tokens to conlang entries and reading word classes.

use crate::config::POS_TAG;
use crate::model::dictionary::contains_word;

use super::*;

/// A dictionary match plus the morphology affix to attach.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Match<'a> {
    pub(super) table: &'a str,
    pub(super) entry: &'a WordEntry,
    pub(super) affix: String,
    /// English affix to gloss with (upper-cased), empty for direct matches.
    pub(super) affix_gloss: String,
    /// Whether the affix attaches before the root.
    pub(super) prefix: bool,
    /// Default feature selections the token's surface implies (e.g. a plural
    /// ending), which explicit selections may override.
    pub(super) features: BTreeMap<String, String>,
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
pub(super) fn matching_entries<'a>(
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

/// The column holding each word's class: the configured name, else the first of
/// `pos`/`class`/`type` a table declares, else `pos`.
pub fn class_column(dict: &Dictionary, morphology: &Morphology) -> String {
    if let Some(column) = morphology
        .class_column
        .as_deref()
        .filter(|name| !name.is_empty())
    {
        return column.to_string();
    }
    for candidate in [POS_TAG, "class", "type"] {
        if dict.tables().any(|table| table.has_tag(candidate)) {
            return candidate.to_string();
        }
    }
    POS_TAG.to_string()
}

/// Drop a leading `#`, so a `#noun` flag reads as the class `noun`.
pub(super) fn strip_hash(value: &str) -> &str {
    value.strip_prefix('#').unwrap_or(value)
}

/// The word class of an entry, read from `column` (first sense), `#`-stripped.
pub(super) fn word_class<'a>(entry: &'a WordEntry, column: &str) -> Option<&'a str> {
    match entry.values.get(column) {
        Some(FieldValue::TagList(list)) => list.first().map(String::as_str),
        Some(FieldValue::Text(text)) => Some(text.as_str()),
        _ => None,
    }
    .map(strip_hash)
}
