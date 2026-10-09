//! Rule-based morphology: ordered multi-slot affixes and fixes-table morphemes.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use nueon_core::config::POS_TAG;
use nueon_core::model::translate::{
    compose, dictionary_affixes, dictionary_morphemes, inflect, translate_direct_with_scoped,
};
use nueon_core::model::TranslationReport;
use nueon_core::{
    AffixKind, ComposePiece, Dictionary, FieldType, FieldValue, InflectionKind, MorphemeRef,
    Morphology, Paradigm, ParadigmRow, TableRole, TableRoleConfig, TagDef, WordEntry,
    DEFINITION_TAG,
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
        zero: false,
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
    plural_row.morpheme = Some(MorphemeRef::Ref {
        table: morphemes[0].table.clone(),
        id: morphemes[0].id.clone(),
    });
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

#[test]
fn compose_combines_roots_and_morphemes_left_to_right() {
    let mut dict = noun_dict("kala");
    let paka = dict
        .add_entry("lex", classed("paka", "stone", "noun"))
        .unwrap();
    let kala = dict
        .table("lex")
        .unwrap()
        .entries
        .iter()
        .find(|entry| entry.wordname == "kala")
        .unwrap()
        .id;

    dict.add_table("morphs");
    for (surface, gloss) in [("ka-", "definite"), ("-u", "plural"), ("-ta-", "focus")] {
        let mut morpheme = WordEntry::new(surface);
        morpheme.set(DEFINITION_TAG, FieldValue::TagList(vec![gloss.to_string()]));
        dict.add_entry("morphs", morpheme);
    }
    let roles = BTreeMap::from([(
        "morphs".to_string(),
        TableRoleConfig {
            role: TableRole::Fixes,
            trigger: None,
            surface: None,
        },
    )]);
    let lexicon = dictionary_morphemes(&dict, &roles);

    let compound = compose(
        &dict,
        &lexicon,
        &[ComposePiece::Word(kala), ComposePiece::Word(paka)],
    );
    assert_eq!(compound.surface, "kalapaka");

    let affixed = compose(
        &dict,
        &lexicon,
        &[
            ComposePiece::Morpheme("ka-".to_string()),
            ComposePiece::Word(kala),
            ComposePiece::Morpheme("-u".to_string()),
        ],
    );
    assert_eq!(affixed.surface, "kakalau");

    let infixed = compose(
        &dict,
        &lexicon,
        &[
            ComposePiece::Word(kala),
            ComposePiece::Morpheme("-ta-".to_string()),
        ],
    );
    assert_eq!(infixed.surface, "katala");
}

#[test]
fn morphemes_do_not_require_english_triggers() {
    let mut dict = Dictionary::new();
    dict.add_table("morphs");
    let mut suffix = WordEntry::new("-u");
    suffix.set(
        DEFINITION_TAG,
        FieldValue::TagList(vec!["plural".to_string()]),
    );
    dict.add_entry("morphs", suffix);

    // A fixes table with no trigger column still supplies its morphemes.
    let roles = BTreeMap::from([(
        "morphs".to_string(),
        TableRoleConfig {
            role: TableRole::Fixes,
            trigger: None,
            surface: None,
        },
    )]);
    let morphemes = dictionary_morphemes(&dict, &roles);
    assert_eq!(morphemes.len(), 1);
    assert_eq!(morphemes[0].surface, "u");
    assert_eq!(morphemes[0].kind, AffixKind::Suffix);
    assert_eq!(morphemes[0].gloss, "plural");
    assert!(morphemes[0].matches("-u"));
    // With no English column there are no input rules, only morphemes.
    assert!(dictionary_affixes(&dict, &roles).is_empty());
}

#[test]
fn inflect_stacks_paradigm_and_manual_morphemes() {
    let mut dict = noun_dict("kala");
    dict.add_table("fixes");
    dict.add_tag("fixes", TagDef::new("english", FieldType::Text));
    let mut plural = WordEntry::new("-u");
    plural.set(
        DEFINITION_TAG,
        FieldValue::TagList(vec!["plural".to_string()]),
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
    let lexicon = dictionary_morphemes(&dict, &roles);

    // Feature-driven case suffix (accusative -> "m") plus a manually picked -u.
    let morphology = morphology(vec![row(
        &[("case", "accusative")],
        "m",
        AffixKind::Suffix,
        Some("case"),
        1,
    )]);
    let id = dict.table("lex").unwrap().entries[0].id;
    let inflection = inflect(
        &dict,
        id,
        &morphology,
        &lexicon,
        &selections(&[("case", "accusative")]),
        &lexicon,
    );

    assert_eq!(inflection.surface, "kalamu");
    let pieces: Vec<(&str, InflectionKind)> = inflection
        .morphemes
        .iter()
        .map(|piece| (piece.surface.as_str(), piece.kind))
        .collect();
    assert_eq!(
        pieces,
        vec![
            ("kala", InflectionKind::Root),
            ("m", InflectionKind::Suffix),
            ("u", InflectionKind::Suffix),
        ]
    );
}

/// A fixes table with one morpheme, for the reference tests.
fn fixes_dict(
    dict: &mut Dictionary,
    surface: &str,
    gloss: &str,
) -> BTreeMap<String, TableRoleConfig> {
    dict.add_table("fixes");
    let mut entry = WordEntry::new(surface);
    entry.set(DEFINITION_TAG, FieldValue::TagList(vec![gloss.to_string()]));
    dict.add_entry("fixes", entry);
    BTreeMap::from([(
        "fixes".to_string(),
        TableRoleConfig {
            role: TableRole::Fixes,
            trigger: None,
            surface: None,
        },
    )])
}

#[test]
fn a_referenced_morpheme_inflects_uene_to_ueneyu() {
    let mut dict = noun_dict("uene");
    let roles = fixes_dict(&mut dict, "-yu", "plural");
    let morphemes = dictionary_morphemes(&dict, &roles);

    let mut plural = row(
        &[("number", "plural")],
        "",
        AffixKind::Suffix,
        Some("number"),
        0,
    );
    plural.morpheme = Some(MorphemeRef::Ref {
        table: morphemes[0].table.clone(),
        id: morphemes[0].id.clone(),
    });
    let morphology = morphology(vec![plural]);

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
    assert_eq!(report.output, "ueneyu");
}

#[test]
fn legacy_key_and_id_ref_resolve_alike() {
    let mut dict = noun_dict("kala");
    dict.add_table("fixes");
    dict.add_tag("fixes", TagDef::new("english", FieldType::Text));
    let mut entry = WordEntry::new("-u");
    entry.set(
        DEFINITION_TAG,
        FieldValue::TagList(vec!["plural".to_string()]),
    );
    entry.set("english", FieldValue::Text("plural".to_string()));
    dict.add_entry("fixes", entry);
    let roles = BTreeMap::from([(
        "fixes".to_string(),
        TableRoleConfig {
            role: TableRole::Fixes,
            trigger: Some("english".to_string()),
            surface: None,
        },
    )]);
    let morphemes = dictionary_morphemes(&dict, &roles);

    let build = |reference: MorphemeRef| {
        let mut plural = row(
            &[("number", "plural")],
            "",
            AffixKind::Suffix,
            Some("number"),
            0,
        );
        plural.morpheme = Some(reference);
        morphology(vec![plural])
    };
    let key = build(MorphemeRef::Key("plural".to_string()));
    let id = build(MorphemeRef::Ref {
        table: morphemes[0].table.clone(),
        id: morphemes[0].id.clone(),
    });

    let skip = BTreeSet::from(["fixes".to_string()]);
    let run = |m: &Morphology| {
        translate_direct_with_scoped(
            &dict,
            " ",
            "dog",
            &HashMap::new(),
            &[],
            m,
            &selections(&[("number", "plural")]),
            &skip,
            &morphemes,
        )
        .output
    };
    assert_eq!(run(&key), "kalau");
    assert_eq!(run(&id), "kalau");
}

#[test]
fn a_zero_ending_leaves_the_stem_unchanged() {
    let dict = noun_dict("kala");
    let mut plural = row(
        &[("number", "plural")],
        "",
        AffixKind::Suffix,
        Some("number"),
        0,
    );
    plural.zero = true;
    let morphology = morphology(vec![plural]);

    let report = run(&dict, &morphology, &selections(&[("number", "plural")]));
    assert_eq!(report.output, "kala");
    let surface = &report.gloss.morphemes[0].surface;
    assert!(!surface.ends_with('-'), "dangling hyphen in {surface:?}");
}

#[test]
fn a_broken_reference_falls_back_to_the_surface() {
    let dict = noun_dict("kala");
    let mut plural = row(
        &[("number", "plural")],
        "u",
        AffixKind::Suffix,
        Some("number"),
        0,
    );
    plural.morpheme = Some(MorphemeRef::Ref {
        table: "missing".to_string(),
        id: "nope".to_string(),
    });
    let morphology = morphology(vec![plural]);

    let report = run(&dict, &morphology, &selections(&[("number", "plural")]));
    assert_eq!(report.output, "kalau");
}

#[test]
fn surface_only_paradigms_still_inflect() {
    let dict = noun_dict("kala");
    let morphology = morphology(vec![row(
        &[("number", "plural")],
        "u",
        AffixKind::Suffix,
        Some("number"),
        0,
    )]);
    let report = run(&dict, &morphology, &selections(&[("number", "plural")]));
    assert_eq!(report.output, "kalau");
}
