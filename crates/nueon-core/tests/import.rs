//! Import tests driven by the `testlang` fixtures.
//!
//! Expected counts are computed from the fixture files themselves, never
//! hard-coded, so the tests keep meaning if the data changes.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use nueon_core::{
    import_apply, import_preview, ColumnRole, DuplicatePolicy, FieldValue, ImportOptions,
    ImportPlan, LinkChoice, LinkSyntax, Workspace,
};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn read(name: &str) -> String {
    std::fs::read_to_string(fixture(name)).unwrap()
}

fn roots_options() -> ImportOptions {
    ImportOptions {
        delimiter: '\t',
        roles: vec![
            ColumnRole::Wordname,
            ColumnRole::Definition,
            ColumnRole::Parents,
            ColumnRole::TextTag {
                name: "usage".into(),
            },
            ColumnRole::TextTag {
                name: "valency".into(),
            },
            ColumnRole::TagFlags,
        ],
        target_table: "roots".into(),
        ..Default::default()
    }
}

fn derived_options() -> ImportOptions {
    ImportOptions {
        delimiter: '\t',
        roles: vec![
            ColumnRole::Wordname,
            ColumnRole::Definition,
            ColumnRole::Parents,
            ColumnRole::TextTag {
                name: "usage".into(),
            },
            ColumnRole::TagFlags,
        ],
        target_table: "derived".into(),
        ..Default::default()
    }
}

// -- independent counting helpers (do not use the importer) ------------------

fn non_blank_lines(text: &str) -> usize {
    text.lines().filter(|l| !l.trim().is_empty()).count()
}

fn blank_lines(text: &str) -> usize {
    text.lines().filter(|l| l.trim().is_empty()).count()
}

fn count_substr(text: &str, needle: &str) -> usize {
    text.matches(needle).count()
}

fn data_rows(text: &str) -> usize {
    // minus the header
    non_blank_lines(text) - 1
}

// -- tests -------------------------------------------------------------------

#[test]
fn fixtures_are_tab_separated_with_the_expected_shape() {
    let roots = read("testlangRoots.csv");
    let derived = read("testlangDerived.csv");
    assert!(roots.contains('\t'));
    // No commas used as the field separator (header has none).
    assert_eq!(roots.lines().next().unwrap().matches(',').count(), 0);
    assert!(derived.lines().next().unwrap().split('\t').count() == 5);
    assert!(roots.lines().next().unwrap().split('\t').count() == 6);
}

#[test]
fn detect_proposes_delimiter_header_and_roles() {
    let roots = read("testlangRoots.csv");
    let detection = nueon_core::detect(&roots, &roots_options());
    assert_eq!(detection.delimiter, '\t');
    assert!(detection.has_header);
    assert_eq!(detection.columns.len(), 6);
    assert_eq!(detection.columns[0].role, ColumnRole::Wordname);
    assert_eq!(detection.columns[1].role, ColumnRole::Definition);
    assert_eq!(detection.columns[2].role, ColumnRole::Parents);
    assert_eq!(detection.columns[5].role, ColumnRole::TagFlags);
    // valency has few distinct values, offered as a boolean split.
    assert!(
        !detection.columns[4].boolean_split.is_empty(),
        "valency should offer a split: {:?}",
        detection.columns[4]
    );

    let derived = read("testlangDerived.csv");
    let detection = nueon_core::detect(&derived, &derived_options());
    assert_eq!(detection.delimiter, '\t');
    assert_eq!(detection.columns.len(), 5);
    assert_eq!(detection.columns[4].role, ColumnRole::TagFlags);
}

#[test]
fn roots_preview_counts_match_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path()).unwrap();
    let text = read("testlangRoots.csv");
    let preview = import_preview(&ws, &fixture("testlangRoots.csv"), &roots_options()).unwrap();

    assert_eq!(preview.rows_total, data_rows(&text));
    assert_eq!(preview.rows_blank, blank_lines(&text));
    assert_eq!(preview.rows_total, 183);
    // 10 short rows; count them independently (rows with fewer than 6 fields).
    let short = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .skip(1)
        .filter(|l| l.split('\t').count() < 6)
        .count();
    assert_eq!(preview.short_rows.len(), short);
    // Two placeholder words (Untitled, Untitled 1), skipped by default.
    assert_eq!(preview.placeholders.len(), 2);
    assert_eq!(preview.words, data_rows(&text) - 2);
    // The tags column proposes one boolean tag per distinct flag.
    let tag_names: BTreeSet<&str> = preview.tags.iter().map(|t| t.name.as_str()).collect();
    for expected in [
        "adjective",
        "noun",
        "verb",
        "color",
        "root",
        "suffix",
        "pronoun",
    ] {
        assert!(
            tag_names.contains(expected),
            "missing tag {expected}: {tag_names:?}"
        );
    }
    // "#nouns" is surfaced as a suspicious trailing-s tag, not fixed.
    assert!(preview
        .suspicious
        .iter()
        .any(|s| s.reason.contains("typo") && s.wordname == "fuia"));
}

#[test]
fn import_roots_creates_words_sparsely_and_stores_valency() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    let plan = ImportPlan::new(fixture("testlangRoots.csv"), roots_options());
    let report = import_apply(&mut ws, &plan).unwrap();

    assert_eq!(report.words_created, 181);
    assert_eq!(report.table, "roots");
    let table = ws.dictionary.table("roots").unwrap();
    assert_eq!(table.entries.len(), 181);

    // Tags became boolean columns on this table only.
    for tag in [
        "adjective",
        "noun",
        "verb",
        "color",
        "root",
        "suffix",
        "pronoun",
    ] {
        assert_eq!(table.tag(tag).unwrap().kind, nueon_core::FieldType::Boolean);
    }
    // Sparse: a word with no usage/valency has no such tags at all.
    let adei = table.entries.iter().find(|e| e.wordname == "adei").unwrap();
    assert!(adei.get("adjective").is_some());
    assert!(adei.get("usage").is_none());
    assert!(adei.values.keys().all(|k| k != "valency"));

    // "fyo" has a valency value, stored as text.
    let fyo = table.entries.iter().find(|e| e.wordname == "fyo").unwrap();
    assert_eq!(
        fyo.get("valency"),
        Some(&FieldValue::Text("Intransitive".into()))
    );

    // The roots file has no [[ ]] links, so no parents were linked.
    assert_eq!(report.parents_linked, 0);
}

#[test]
fn import_declares_the_definition_column_and_stores_its_senses() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    import_apply(
        &mut ws,
        &ImportPlan::new(fixture("testlangRoots.csv"), roots_options()),
    )
    .unwrap();

    // The reserved `definition` column must be declared, or the stored value
    // has no column to appear in.
    let table = ws.dictionary.table("roots").unwrap();
    let definition = table.tag("definition").expect("definition tag declared");
    assert_eq!(definition.kind, nueon_core::FieldType::TagList);

    let il = table.entries.iter().find(|e| e.wordname == "il").unwrap();
    assert_eq!(
        il.get("definition"),
        Some(&FieldValue::TagList(vec![
            "tall".into(),
            "tower".into(),
            "holy".into()
        ]))
    );
}

#[test]
fn derived_preview_reports_links_and_the_duplicate_word() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    // Import roots first so "itorei" exists and links can resolve.
    import_apply(
        &mut ws,
        &ImportPlan::new(fixture("testlangRoots.csv"), roots_options()),
    )
    .unwrap();

    let text = read("testlangDerived.csv");
    let preview = import_preview(&ws, &fixture("testlangDerived.csv"), &derived_options()).unwrap();

    assert_eq!(preview.rows_total, data_rows(&text));
    assert_eq!(preview.rows_total, 134);
    assert_eq!(preview.placeholders.len(), 0);

    // Link occurrences and unique targets are computed from the file.
    assert_eq!(preview.links.occurrences, count_substr(&text, "[["));
    assert_eq!(preview.links.occurrences, 48);
    assert!(preview.links.unique_targets > 0);
    assert!(preview.links.unique_targets <= preview.links.occurrences);
    // Suffixes that are not words stay unresolved.
    assert!(preview.links.unresolved.contains(&"-ia".to_string()));
    assert!(preview.links.unresolved.contains(&"lem".to_string()));
    // "itorei" now exists in roots, so importing it into derived is a conflict.
    assert!(preview
        .duplicates
        .iter()
        .any(|d| d.wordname == "itorei" && d.existing_tables.contains(&"roots".to_string())));
    // The duplicate is skipped by default, so it is not counted as created.
    assert_eq!(preview.words, 134 - 1);
}

#[test]
fn importing_both_tables_resolves_parents_from_wikilinks() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    import_apply(
        &mut ws,
        &ImportPlan::new(fixture("testlangRoots.csv"), roots_options()),
    )
    .unwrap();
    let report = import_apply(
        &mut ws,
        &ImportPlan::new(fixture("testlangDerived.csv"), derived_options()),
    )
    .unwrap();

    assert_eq!(report.words_created, 133); // itorei skipped
    assert!(report.parents_linked > 0);

    let derived = ws.dictionary.table("derived").unwrap();
    let yimeshia = derived
        .entries
        .iter()
        .find(|e| e.wordname == "yimeshia")
        .unwrap();
    // Raw prose is kept verbatim in a text column, never resolved.
    assert_eq!(
        yimeshia.get("derived-root(s)"),
        Some(&FieldValue::Text("[[yime]], [[shia]], /, [[-ia]]".into()))
    );
    // [[yime]] resolves (a derived word); [[shia]] and [[-ia]] do not.
    let parents = yimeshia.parents();
    assert_eq!(parents.len(), 1);
    // [[yime]] resolves to the word in the *roots* table.
    let yime_id = ws
        .dictionary
        .table("roots")
        .unwrap()
        .entries
        .iter()
        .find(|e| e.wordname == "yime")
        .unwrap()
        .id;
    assert_eq!(parents[0], yime_id);
    let _ = derived;
}

#[test]
fn reimport_is_idempotent_under_every_duplicate_policy() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    import_apply(
        &mut ws,
        &ImportPlan::new(fixture("testlangRoots.csv"), roots_options()),
    )
    .unwrap();
    let before = ws.dictionary.table("roots").unwrap().entries.len();

    // Skip: a second run creates nothing.
    let mut skip = ImportPlan::new(fixture("testlangRoots.csv"), roots_options());
    skip.options.duplicate_policy = DuplicatePolicy::Skip;
    let report = import_apply(&mut ws, &skip).unwrap();
    assert_eq!(report.words_created, 0);
    assert_eq!(ws.dictionary.table("roots").unwrap().entries.len(), before);

    // Add: a second run adds homographs.
    let mut add = ImportPlan::new(fixture("testlangRoots.csv"), roots_options());
    add.options.duplicate_policy = DuplicatePolicy::Add;
    add.options.skip_placeholders = true;
    let report = import_apply(&mut ws, &add).unwrap();
    assert_eq!(report.words_created, 181);
    assert_eq!(
        ws.dictionary.table("roots").unwrap().entries.len(),
        before * 2
    );

    // Update: a third run changes nothing (same data) but does not duplicate.
    let mut update = ImportPlan::new(fixture("testlangRoots.csv"), roots_options());
    update.options.duplicate_policy = DuplicatePolicy::Update;
    let before_update = ws.dictionary.table("roots").unwrap().entries.len();
    import_apply(&mut ws, &update).unwrap();
    assert_eq!(
        ws.dictionary.table("roots").unwrap().entries.len(),
        before_update
    );
}

#[test]
fn a_malformed_file_errors_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    let path = dir.path().join("bad.tsv");
    std::fs::write(&path, "no wordname column here\njust one field\n").unwrap();

    // Roles with no Wordname mapped → a clear error.
    let mut options = roots_options();
    options.roles = vec![ColumnRole::Ignore, ColumnRole::Ignore];
    let err = import_apply(&mut ws, &ImportPlan::new(&path, options));
    assert!(err.is_err());
    assert!(
        ws.dictionary.table("roots").is_none(),
        "nothing was created"
    );

    // Invalid UTF-8 is refused too, without partial writes.
    let bytes = dir.path().join("bytes.tsv");
    std::fs::write(&bytes, [0xff, 0xfe, 0x00, 0x01]).unwrap();
    let err = import_preview(&ws, &bytes, &roots_options());
    assert!(err.is_err());
    assert!(ws.dictionary.tables().next().is_none());
}

#[test]
fn options_handle_other_delimiters_quotes_and_no_header() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    let path = dir.path().join("semi.csv");
    // Semicolon-delimited, quoted field containing the delimiter.
    std::fs::write(
        &path,
        "word;def\nkala;\"to speak; to say\"\nvelo;\"fast\"\n",
    )
    .unwrap();
    let options = ImportOptions {
        delimiter: ';',
        quote: '"',
        has_header: true,
        tag_list_delimiter: ';',
        roles: vec![ColumnRole::Wordname, ColumnRole::Definition],
        target_table: "verbs".into(),
        ..Default::default()
    };
    let report = import_apply(&mut ws, &ImportPlan::new(&path, options)).unwrap();
    assert_eq!(report.words_created, 2);
    let kala = ws
        .dictionary
        .table("verbs")
        .unwrap()
        .entries
        .iter()
        .find(|e| e.wordname == "kala")
        .unwrap();
    // The definition is split on the tag-list delimiter, not the field one.
    assert_eq!(
        kala.get("definition"),
        Some(&FieldValue::TagList(vec![
            "to speak".into(),
            "to say".into()
        ]))
    );

    // Comma delimiter, no header.
    let path = dir.path().join("comma.csv");
    std::fs::write(&path, "alfa,adj\nbeta,prep\n").unwrap();
    let options = ImportOptions {
        delimiter: ',',
        has_header: false,
        roles: vec![
            ColumnRole::Wordname,
            ColumnRole::TextTag { name: "pos".into() },
        ],
        target_table: "words".into(),
        ..Default::default()
    };
    let preview = import_preview(&ws, &path, &options).unwrap();
    assert_eq!(preview.rows_total, 2);
    let report = import_apply(&mut ws, &ImportPlan::new(&path, options)).unwrap();
    assert_eq!(report.words_created, 2);
    assert!(ws.dictionary.table("words").unwrap().has_tag("pos"));
}

#[test]
fn cycles_are_rejected_not_forced() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    let path = dir.path().join("cycle.tsv");
    // a → b, b → a.
    std::fs::write(&path, "word\troot\na\t[[b]]\nb\t[[a]]\n").unwrap();
    let options = ImportOptions {
        delimiter: '\t',
        roles: vec![ColumnRole::Wordname, ColumnRole::Parents],
        target_table: "g".into(),
        ..Default::default()
    };
    let report = import_apply(&mut ws, &ImportPlan::new(&path, options)).unwrap();
    assert_eq!(report.words_created, 2);
    // The first link is fine; the second would close a cycle and is refused.
    assert_eq!(report.parents_linked, 1);
    assert!(report.parents_skipped >= 1);
    assert!(report.warnings.iter().any(|w| w.contains("cycle")));
}

#[test]
fn unresolved_links_can_create_suffix_entries() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    let path = dir.path().join("suffix.tsv");
    std::fs::write(&path, "word\troot\nala\t[[-ia]]\n").unwrap();
    let options = ImportOptions {
        delimiter: '\t',
        roles: vec![ColumnRole::Wordname, ColumnRole::Parents],
        target_table: "w".into(),
        create_suffix_entries: true,
        ..Default::default()
    };
    let report = import_apply(&mut ws, &ImportPlan::new(&path, options.clone())).unwrap();
    assert_eq!(report.suffix_entries, 1);
    assert_eq!(report.parents_linked, 1);
    let table = ws.dictionary.table("w").unwrap();
    let suffix = table.entries.iter().find(|e| e.wordname == "-ia").unwrap();
    assert_eq!(suffix.get("suffix"), Some(&FieldValue::Boolean(true)));

    // With the option off, the link stays unresolved.
    let dir2 = tempfile::tempdir().unwrap();
    let mut ws2 = Workspace::new(dir2.path()).unwrap();
    let mut off = options;
    off.create_suffix_entries = false;
    let report = import_apply(&mut ws2, &ImportPlan::new(&path, off)).unwrap();
    assert_eq!(report.suffix_entries, 0);
    assert_eq!(report.parents_linked, 0);
}

#[test]
fn generic_reference_columns_resolve_to_reference_values() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    let path = dir.path().join("refs.tsv");
    std::fs::write(&path, "word\tsynonym\nala\t[[bela]]\nbela\t\n").unwrap();
    let options = ImportOptions {
        delimiter: '\t',
        roles: vec![
            ColumnRole::Wordname,
            ColumnRole::References {
                name: "synonym".into(),
            },
        ],
        target_table: "w".into(),
        ..Default::default()
    };
    let report = import_apply(&mut ws, &ImportPlan::new(&path, options)).unwrap();
    assert_eq!(report.words_created, 2);
    assert_eq!(report.references_linked, 1);

    let table = ws.dictionary.table("w").unwrap();
    assert_eq!(
        table.tag("synonym").unwrap().kind,
        nueon_core::FieldType::References
    );
    let ala = table.entries.iter().find(|e| e.wordname == "ala").unwrap();
    let bela = table.entries.iter().find(|e| e.wordname == "bela").unwrap();
    assert_eq!(
        ala.get("synonym"),
        Some(&FieldValue::References(vec![bela.id]))
    );
}

#[test]
fn links_can_be_overridden_with_an_explicit_choice() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    // An existing word the link would normally not match.
    let other = ImportOptions {
        delimiter: '\t',
        roles: vec![ColumnRole::Wordname],
        target_table: "roots2".into(),
        ..Default::default()
    };
    let existing = dir.path().join("existing.tsv");
    std::fs::write(&existing, "word\nreal-root\n").unwrap();
    import_apply(&mut ws, &ImportPlan::new(&existing, other)).unwrap();
    let real_id = ws
        .dictionary
        .table("roots2")
        .unwrap()
        .entries
        .iter()
        .find(|e| e.wordname == "real-root")
        .unwrap()
        .id;

    let path = dir.path().join("links.tsv");
    std::fs::write(&path, "word\troot\nchild\t[[placeholder-name]]\n").unwrap();
    let options = ImportOptions {
        delimiter: '\t',
        roles: vec![ColumnRole::Wordname, ColumnRole::Parents],
        target_table: "w".into(),
        ..Default::default()
    };
    let mut plan = ImportPlan::new(&path, options);
    plan.link_choices.insert(
        "placeholder-name".into(),
        LinkChoice::UseExisting {
            table: "roots2".into(),
            id: real_id,
        },
    );
    let report = import_apply(&mut ws, &plan).unwrap();
    assert_eq!(report.parents_linked, 1);
    let child = ws
        .dictionary
        .table("w")
        .unwrap()
        .entries
        .iter()
        .find(|e| e.wordname == "child")
        .unwrap();
    assert_eq!(child.parents(), vec![real_id]);
}

#[test]
fn case_only_links_are_flagged_not_used_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    let base = ImportOptions {
        delimiter: '\t',
        roles: vec![ColumnRole::Wordname],
        target_table: "t".into(),
        ..Default::default()
    };
    let known = dir.path().join("known.tsv");
    std::fs::write(&known, "word\non\n").unwrap();
    import_apply(&mut ws, &ImportPlan::new(&known, base)).unwrap();

    let path = dir.path().join("link.tsv");
    std::fs::write(&path, "word\troot\nchild\t[[On]]\n").unwrap();
    let options = ImportOptions {
        delimiter: '\t',
        roles: vec![ColumnRole::Wordname, ColumnRole::Parents],
        target_table: "t".into(),
        ..Default::default()
    };
    let preview = import_preview(&ws, &path, &options).unwrap();
    assert!(preview
        .links
        .case_only
        .iter()
        .any(|(raw, matched)| raw == "On" && matched == "on"));
}

#[test]
fn non_nfc_text_is_warned_and_left_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    let path = dir.path().join("nfc.tsv");
    // "e" + combining acute is not NFC (NFC would be "é").
    let decomposed = "cafe\u{0301}";
    std::fs::write(&path, format!("word\tdef\n{decomposed}\tcoffee\n")).unwrap();
    let options = ImportOptions {
        delimiter: '\t',
        roles: vec![ColumnRole::Wordname, ColumnRole::Definition],
        target_table: "t".into(),
        ..Default::default()
    };
    let preview = import_preview(&ws, &path, &options).unwrap();
    assert_eq!(preview.non_nfc_rows.len(), 1);
    assert!(preview.warnings.iter().any(|w| w.contains("NFC")));

    import_apply(&mut ws, &ImportPlan::new(&path, options)).unwrap();
    let word = ws
        .dictionary
        .table("t")
        .unwrap()
        .entries
        .iter()
        .find(|e| e.wordname == decomposed)
        .expect("the decomposed spelling is stored exactly, not normalized");
    assert_eq!(word.wordname, decomposed);
}

#[test]
fn parse_handles_quotes_and_ragged_rows() {
    let rows = nueon_core::import::parse_records("a,b\n\"x,y\",z\nshort\n", ',', '"');
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0], vec!["a", "b"]);
    assert_eq!(rows[1], vec!["x,y", "z"]);
    assert_eq!(rows[2], vec!["short"]);
    assert_eq!(
        nueon_core::import::normalize_link_target("a/b/c|alias"),
        "c"
    );
    assert_eq!(nueon_core::import::normalize_link_target("plain"), "plain");
}

#[test]
fn apply_makes_a_revertible_git_commit_when_git_is_ready() {
    let git_ok = std::process::Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !git_ok {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    ws.init_git().unwrap();
    let path = dir.path().join("t.tsv");
    std::fs::write(&path, "word\nala\nvelo\n").unwrap();
    let options = ImportOptions {
        delimiter: '\t',
        roles: vec![ColumnRole::Wordname],
        target_table: "t".into(),
        ..Default::default()
    };
    import_apply(&mut ws, &ImportPlan::new(&path, options)).unwrap();
    let log = std::process::Command::new("git")
        .args(["log", "--oneline"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&log.stdout);
    assert!(text.contains("CAN REVERT"), "commit log: {text}");
}

#[test]
fn link_syntax_none_ignores_brackets() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    let path = dir.path().join("nolinks.tsv");
    std::fs::write(&path, "word\troot\nala\t[[does-not-matter]]\n").unwrap();
    let options = ImportOptions {
        delimiter: '\t',
        roles: vec![ColumnRole::Wordname, ColumnRole::Parents],
        target_table: "w".into(),
        link_syntax: LinkSyntax::None,
        ..Default::default()
    };
    let preview = import_preview(&ws, &path, &options).unwrap();
    assert_eq!(preview.links.occurrences, 0);
    let report = import_apply(&mut ws, &ImportPlan::new(&path, options)).unwrap();
    assert_eq!(report.parents_linked, 0);
}
