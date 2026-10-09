//! Rule-based morphology: ordered multi-slot affixes and fixes-table morphemes.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use nueon_core::config::POS_TAG;
use nueon_core::model::translate::{dictionary_morphemes, translate_direct_with_scoped};
use nueon_core::model::TranslationReport;
use nueon_core::{
    AffixKind, Dictionary, FieldType, FieldValue, Morphology, Paradigm, ParadigmRow, TableRole,
    TableRoleConfig, TagDef, WordEntry, DEFINITION_TAG,
};

fn classed(word: &str, sense: &str, class: &str) -> WordEntry {
    let mut entry = WordEntry::new(word);
    entry.set(DEFINITION_TAG, FieldValue::TagList(vec![sense.to_string()]));
    entry.set(POS_TAG, FieldValue::TagList(vec![class.to_string()]));
    entry
}

fn noun_dict(word: &str) -> Dictionary {
    let mut dict = Dictionary::new();
    dict.add_table("lex");
    dict.add_tag("lex", TagDef::new(POS_TAG, FieldType::TagList));
    dict.add_entry("lex", classed(word, "dog", "noun"));
    dict
}

fn selections(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(feature, value)| (feature.to_string(), value.to_string()))
        .collect()
}

fn row(
    when: &[(&str, &str)],
    surface: &str,
    kind: AffixKind,
    slot: Option<&str>,
    order: i32,
) -> ParadigmRow {
    ParadigmRow {
        when: when
            .iter()
            .map(|(feature, value)| (feature.to_string(), value.to_string()))
            .collect(),
        surface: surface.to_string(),
        kind,
        slot: slot.map(str::to_string),
        order,
        morpheme: None,
    }
}

fn morphology(rows: Vec<ParadigmRow>) -> Morphology {
    Morphology {
        features: Morphology::default().features,
        paradigms: vec![Paradigm {
            class: "noun".into(),
            rows,
        }],
    }
}

fn run(
    dict: &Dictionary,
    morphology: &Morphology,
    selections: &BTreeMap<String, String>,
) -> TranslationReport {
    translate_direct_with_scoped(
        dict,
        " ",
        "dog",
        &HashMap::new(),
        &[],
        morphology,
        selections,
        &BTreeSet::new(),
        &[],
    )
}

#[test]
fn two_slots_compose_in_order() {
    let dict = noun_dict("kala");
    let morphology = morphology(vec![
        row(
            &[("number", "plural")],
            "u",
            AffixKind::Suffix,
            Some("number"),
            1,
        ),
        row(
            &[("case", "accusative")],
            "m",
            AffixKind::Suffix,
            Some("case"),
            2,
        ),
    ]);
    let report = run(
        &dict,
        &morphology,
        &selections(&[("number", "plural"), ("case", "accusative")]),
    );
    assert_eq!(report.output, "kalaum");
}

#[test]
fn slot_order_controls_the_sequence() {
    let dict = noun_dict("kala");
    let morphology = morphology(vec![
        row(
            &[("number", "plural")],
            "u",
            AffixKind::Suffix,
            Some("number"),
            2,
        ),
        row(
            &[("case", "accusative")],
            "m",
            AffixKind::Suffix,
            Some("case"),
            1,
        ),
    ]);
    let report = run(
        &dict,
        &morphology,
        &selections(&[("number", "plural"), ("case", "accusative")]),
    );
    assert_eq!(report.output, "kalamu");
}

#[test]
fn prefix_infix_and_suffix_combine() {
    let dict = noun_dict("kala");
    let morphology = morphology(vec![
        row(
            &[("definite", "yes")],
            "ka",
            AffixKind::Prefix,
            Some("def"),
            1,
        ),
        row(
            &[("focus", "yes")],
            "ta",
            AffixKind::Infix,
            Some("focus"),
            2,
        ),
        row(
            &[("number", "plural")],
            "u",
            AffixKind::Suffix,
            Some("num"),
            3,
        ),
    ]);
    let report = run(
        &dict,
        &morphology,
        &selections(&[("definite", "yes"), ("focus", "yes"), ("number", "plural")]),
    );
    assert_eq!(report.output, "kakatalau");
}

#[test]
fn infix_lands_after_the_first_vowel() {
    let dict = noun_dict("kala");
    let morphology = morphology(vec![row(
        &[("focus", "yes")],
        "ta",
        AffixKind::Infix,
        Some("focus"),
        0,
    )]);
    let report = run(&dict, &morphology, &selections(&[("focus", "yes")]));
    assert_eq!(report.output, "katala");
}

#[test]
fn a_word_without_a_vowel_takes_the_infix_at_the_front() {
    let dict = noun_dict("krt");
    let morphology = morphology(vec![row(
        &[("focus", "yes")],
        "ta",
        AffixKind::Infix,
        Some("focus"),
        0,
    )]);
    let report = run(&dict, &morphology, &selections(&[("focus", "yes")]));
    assert_eq!(report.output, "takrt");
}

#[test]
fn legacy_single_row_still_applies_one_affix() {
    let dict = noun_dict("kala");
    let morphology = morphology(vec![row(
        &[("number", "plural")],
        "u",
        AffixKind::Suffix,
        None,
        0,
    )]);
    let report = run(&dict, &morphology, &selections(&[("number", "plural")]));
    assert_eq!(report.output, "kalau");
}

#[test]
fn a_slot_can_reference_a_fixes_table_morpheme() {
    let mut dict = noun_dict("kala");
    dict.add_table("fixes");
    dict.add_tag("fixes", TagDef::new("english", FieldType::Text));
    let mut plural = WordEntry::new("-u");
    plural.set(
        DEFINITION_TAG,
        FieldValue::TagList(vec!["plural marker".to_string()]),
    );
    plural.set("english", FieldValue::Text("plural".to_string()));
    dict.add_entry("fixes", plural);

    let roles = BTreeMap::from([(
        "fixes".to_string(),
        TableRoleConfig {
            role: TableRole::Fixes,
            trigger: Some("english".to_string()),
            surface: None,
        },
    )]);
    let morphemes = dictionary_morphemes(&dict, &roles);
    assert_eq!(morphemes.len(), 1);
    assert_eq!(morphemes[0].surface, "u");
    assert_eq!(morphemes[0].kind, AffixKind::Suffix);

    let mut plural_row = row(
        &[("number", "plural")],
        "",
        AffixKind::Suffix,
        Some("number"),
        0,
    );
    plural_row.morpheme = Some("plural".to_string());
    let morphology = morphology(vec![plural_row]);

    let report = translate_direct_with_scoped(
        &dict,
        " ",
        "dog",
        &HashMap::new(),
        &[],
        &morphology,
        &selections(&[("number", "plural")]),
        &BTreeSet::from(["fixes".to_string()]),
        &morphemes,
    );
    assert_eq!(report.output, "kalau");
    let gloss: Vec<&str> = report
        .gloss
        .morphemes
        .iter()
        .map(|morpheme| morpheme.gloss.as_str())
        .collect();
    assert!(
        gloss.iter().any(|gloss| gloss.contains("PLURAL MARKER")),
        "{gloss:?}"
    );
}
