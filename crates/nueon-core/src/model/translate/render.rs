//! Rendering matched words: affix resolution, composition and glossing.

use super::*;

/// Merge a token's inferred feature defaults with the caller's explicit
/// selections; an explicit selection wins over the inferred default.
pub(super) fn effective_selections(
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
pub(super) fn inherent_selections(
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
pub(super) struct ResolvedAffix {
    pub(super) surface: String,
    pub(super) kind: AffixKind,
    /// The gloss label this affix contributes (empty when it adds none).
    pub(super) gloss: String,
}

/// The paradigm affixes for `id`'s class given the selected features, ordered.
pub(super) fn resolve_affixes(
    dict: &Dictionary,
    id: Uuid,
    morphology: &Morphology,
    morphemes: &[Morpheme],
    selections: &BTreeMap<String, String>,
) -> Vec<ResolvedAffix> {
    let Some((table, entry)) = dict.find_entry(id) else {
        return Vec::new();
    };
    let Some(class) = word_class(entry, &class_column(dict, morphology)) else {
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
pub(super) fn insert_after_first_vowel(word: &str, infix: &str) -> String {
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
pub(super) fn compose_word(base: &str, affixes: &[ResolvedAffix]) -> String {
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
pub(super) fn render_word(
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
pub(super) fn render_gloss(
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

/// Build the interlinear gloss morpheme for a chosen word (with affix).
pub(super) fn gloss_for(dict: &Dictionary, picked: Option<&Picked>) -> Option<GlossMorpheme> {
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

pub(super) fn pick(
    candidates: &[Vec<Match>],
    chosen: &[Option<Picked>],
    assigned: &[bool],
    count: usize,
    tag: Option<&str>,
    class: Option<&str>,
    column: &str,
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
        if class.is_some_and(|class| word_class(matched.entry, column) != Some(class)) {
            continue;
        }
        return Some(index);
    }
    None
}

pub(super) fn word_for(dict: &Dictionary, picked: Option<&Picked>) -> String {
    picked
        .and_then(|picked| {
            dict.find_entry(picked.id)
                .map(|(_, entry)| format!("{}{}", entry.wordname, picked.affix))
        })
        .unwrap_or_else(|| "?".to_string())
}

pub(super) fn render(slots: &[SlotOutcome], separator: &str) -> String {
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
