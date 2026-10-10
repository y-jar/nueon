//! Tokenisation and light English lemmatization.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// English function words dropped during tokenization.
const STOPWORDS: &[&str] = &["a", "an", "the"];

/// One normalized word of the input sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Token {
    pub text: String,
    pub normalized: String,
}

/// Normalize a word: lowercase, strip surrounding punctuation, drop a leading
/// `to ` (so "to run" matches the token "run").
pub(super) fn normalize(text: &str) -> String {
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
