//! Rule-based morphology: ordered multi-slot affixes and fixes-table morphemes.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use nueon_core::config::POS_TAG;
use nueon_core::model::translate::{
    class_column, compose, dictionary_affixes, dictionary_morphemes, inflect, inherent_values,
    paradigm_grid, translate_direct_with_scoped, ScopedInput, TranslateInput,
};
use nueon_core::model::TranslationReport;
use nueon_core::{
    AffixKind, ComposePiece, Dictionary, Feature, FeatureColumn, FieldType, FieldValue,
    InflectionKind, MorphemeRef, Morphology, Paradigm, ParadigmRow, TableRole, TableRoleConfig,
    TagDef, WordEntry, DEFINITION_TAG,
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
        class_column: None,
    }
}

fn run(
    dict: &Dictionary,
    morphology: &Morphology,
    selections: &BTreeMap<String, String>,
) -> TranslationReport {
    translate_direct_with_scoped(&ScopedInput {
        input: TranslateInput {
            dict,
            separator: " ",
            input: "dog",
            choices: &HashMap::new(),
            affixes: &[],
            morphology,
            selections,
        },
        skip_tables: &BTreeSet::new(),
        morphemes: &[],
    })
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

    let report = translate_direct_with_scoped(&ScopedInput {
        input: TranslateInput {
            dict: &dict,
            separator: " ",
            input: "dog",
            choices: &HashMap::new(),
            affixes: &[],
            morphology: &morphology,
            selections: &selections(&[("number", "plural")]),
        },
        skip_tables: &BTreeSet::from(["fixes".to_string()]),
        morphemes: &morphemes,
    });
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

    let report = translate_direct_with_scoped(&ScopedInput {
        input: TranslateInput {
            dict: &dict,
            separator: " ",
            input: "dog",
            choices: &HashMap::new(),
            affixes: &[],
            morphology: &morphology,
            selections: &selections(&[("number", "plural")]),
        },
        skip_tables: &BTreeSet::from(["fixes".to_string()]),
        morphemes: &morphemes,
    });
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
        translate_direct_with_scoped(&ScopedInput {
            input: TranslateInput {
                dict: &dict,
                separator: " ",
                input: "dog",
                choices: &HashMap::new(),
                affixes: &[],
                morphology: m,
                selections: &selections(&[("number", "plural")]),
            },
            skip_tables: &skip,
            morphemes: &morphemes,
        })
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

/// A noun class with an inherent `decl` feature read from the `decl` column,
/// where plural takes `-u` for decl 1 and `-yu` for decl 2.
fn declension_setup() -> (Dictionary, Morphology) {
    let mut dict = Dictionary::new();
    dict.add_table("lex");
    dict.add_tag("lex", TagDef::new(POS_TAG, FieldType::TagList));
    dict.add_tag("lex", TagDef::new("decl", FieldType::Text));
    let mut first = classed("uene", "person", "noun");
    first.set("decl", FieldValue::Text("1".to_string()));
    dict.add_entry("lex", first);
    let mut second = classed("kala", "dog", "noun");
    second.set("decl", FieldValue::Text("2".to_string()));
    dict.add_entry("lex", second);

    let mut morphology = Morphology::default();
    morphology.features.push(Feature {
        id: "decl".to_string(),
        label: "Declension".to_string(),
        values: Vec::new(),
        column: Some(FeatureColumn {
            table: "lex".to_string(),
            column: "decl".to_string(),
        }),
    });
    morphology.paradigms.push(Paradigm {
        class: "noun".to_string(),
        rows: vec![
            row(
                &[("number", "plural"), ("decl", "1")],
                "u",
                AffixKind::Suffix,
                Some("num"),
                0,
            ),
            row(
                &[("number", "plural"), ("decl", "2")],
                "yu",
                AffixKind::Suffix,
                Some("num"),
                0,
            ),
        ],
    });
    (dict, morphology)
}

#[test]
fn an_inherent_feature_selects_the_ending() {
    let (dict, morphology) = declension_setup();
    let ids: Vec<uuid::Uuid> = dict
        .table("lex")
        .unwrap()
        .entries
        .iter()
        .map(|entry| entry.id)
        .collect();

    let inflection = |id| {
        inflect(
            &dict,
            id,
            &morphology,
            &[],
            &selections(&[("number", "plural")]),
            &[],
        )
    };
    assert_eq!(inflection(ids[0]).surface, "ueneu");
    assert_eq!(inflection(ids[1]).surface, "kalayu");

    assert_eq!(
        inherent_values(&dict, "lex", "decl"),
        vec!["1".to_string(), "2".to_string()]
    );
}

#[test]
fn auto_detected_type_column_strips_hash() {
    let mut dict = Dictionary::new();
    dict.add_table("lex");
    dict.add_tag("lex", TagDef::new("type", FieldType::TagList));
    let mut entry = WordEntry::new("nau");
    entry.set(
        DEFINITION_TAG,
        FieldValue::TagList(vec!["food".to_string()]),
    );
    entry.set("type", FieldValue::TagList(vec!["#noun".to_string()]));
    let id = dict.add_entry("lex", entry).unwrap();

    let mut morphology = Morphology::default();
    morphology.paradigms.push(Paradigm {
        class: "noun".to_string(),
        rows: vec![row(
            &[("number", "plural")],
            "u",
            AffixKind::Suffix,
            Some("num"),
            0,
        )],
    });

    // No `pos`/`class`, so `type` is detected; `#noun` reads as `noun`.
    assert_eq!(class_column(&dict, &morphology), "type");
    let inflection = inflect(
        &dict,
        id,
        &morphology,
        &[],
        &selections(&[("number", "plural")]),
        &[],
    );
    assert_eq!(inflection.surface, "nauu");
}

#[test]
fn a_configured_class_column_wins() {
    let mut dict = Dictionary::new();
    dict.add_table("lex");
    dict.add_tag("lex", TagDef::new("pos", FieldType::TagList));
    dict.add_tag("lex", TagDef::new("class", FieldType::TagList));

    let auto = Morphology::default();
    assert_eq!(class_column(&dict, &auto), "pos");
    let configured = Morphology {
        class_column: Some("class".to_string()),
        ..Morphology::default()
    };
    assert_eq!(class_column(&dict, &configured), "class");
}

#[test]
fn equal_specificity_rows_are_flagged_ambiguous() {
    let morphology = morphology(vec![
        row(
            &[("number", "plural")],
            "u",
            AffixKind::Suffix,
            Some("num"),
            0,
        ),
        row(
            &[("number", "plural")],
            "yu",
            AffixKind::Suffix,
            Some("num"),
            0,
        ),
    ]);
    let sel = selections(&[("number", "plural")]);
    let slots = morphology.resolve_slots("noun", &sel);
    assert_eq!(slots.len(), 1);
    assert_eq!(slots[0].winner.surface, "u");
    assert_eq!(slots[0].ambiguous.len(), 1);
    assert_eq!(slots[0].ambiguous[0].surface, "yu");
    // Resolution still picks the first-declared winner.
    assert_eq!(morphology.rows_for("noun", &sel)[0].surface, "u");
}

#[test]
fn the_grid_reports_coverage_and_gaps() {
    let (dict, morphology) = declension_setup();
    let grid = paradigm_grid(&dict, &morphology, &[], "noun");
    assert_eq!(grid.slots, vec![Some("num".to_string())]);
    // number (2 values) x decl ("" + 2 values) = 6 combinations.
    assert_eq!(grid.total, 6);

    let cell = |number: &str, decl: &str| {
        grid.rows
            .iter()
            .find(|row| {
                row.when.get("number").map(String::as_str) == Some(number)
                    && row.when.get("decl").map(String::as_str) == Some(decl)
            })
            .and_then(|row| row.cells.first())
            .cloned()
            .expect("no grid row")
    };
    assert!(cell("plural", "1").defined);
    assert_eq!(cell("plural", "1").preview, "u");
    assert_eq!(cell("plural", "2").preview, "yu");
    // A combination with no rule is a coverage gap.
    assert!(!cell("singular", "1").defined);
}
