//! Morphemes read from `Fixes` tables and the affix rules they yield.

use super::*;

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
pub(super) fn entry_text(entry: &WordEntry, column: &str) -> Option<String> {
    match entry.values.get(column) {
        Some(FieldValue::Text(text)) => Some(text.clone()),
        Some(FieldValue::TagList(list)) => list.first().cloned(),
        _ => None,
    }
}

/// Every text value stored under `column` (a text is one, a tag list is many).
pub(super) fn entry_texts(entry: &WordEntry, column: &str) -> Vec<String> {
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
pub(super) fn find_morpheme<'a>(
    morphemes: &'a [Morpheme],
    reference: &str,
) -> Option<&'a Morpheme> {
    morphemes
        .iter()
        .find(|morpheme| morpheme.matches(reference))
}

/// Resolve a paradigm row's morpheme reference: `{ table, id }` first, then a
/// legacy key by wordname/trigger.
pub(super) fn find_morpheme_ref<'a>(
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
