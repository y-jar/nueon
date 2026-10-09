//! Anki text-file export: file headers, field layout, and escaping.

use nueon_core::{
    export_anki, AnkiExportOptions, AnkiSeparator, FieldType, FieldValue, TagDef, Workspace,
};

fn sample() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    ws.create_table("lex").unwrap();
    ws.add_tag("lex", TagDef::new("noun", FieldType::Boolean))
        .unwrap();
    ws.add_tag("lex", TagDef::new("irregular", FieldType::Boolean))
        .unwrap();

    let proto = ws.create_entry("lex", "proto").unwrap().unwrap();
    ws.set_definition("lex", proto, vec!["first".into()])
        .unwrap();

    let kala = ws.create_entry("lex", "kala").unwrap().unwrap();
    ws.set_definition("lex", kala, vec!["dog".into(), "hound".into()])
        .unwrap();
    ws.set_value("lex", kala, "noun", Some(FieldValue::Boolean(true)))
        .unwrap();
    ws.set_value("lex", kala, "irregular", Some(FieldValue::Boolean(true)))
        .unwrap();
    ws.add_parent("lex", kala, proto).unwrap();

    (dir, ws)
}

#[test]
fn anki_default_export_has_headers_and_rows() {
    let (_dir, ws) = sample();
    let table = ws.dictionary.table("lex").unwrap();
    let opts = AnkiExportOptions {
        deck: "lex".into(),
        ..Default::default()
    };
    let text = export_anki(table, &opts);
    let lines: Vec<&str> = text.lines().collect();

    assert_eq!(lines[0], "#separator:tab");
    assert_eq!(lines[1], "#html:false");
    assert_eq!(lines[2], "#notetype:Basic");
    assert_eq!(lines[3], "#deck:lex");
    assert_eq!(lines[4], "#columns:Word\tDefinition\tTags\tGUID");
    assert_eq!(lines[5], "#tags column:3");
    assert_eq!(lines[6], "#guid column:4");

    let proto = table
        .entries
        .iter()
        .find(|e| e.wordname == "proto")
        .unwrap();
    assert_eq!(lines[7], format!("proto\tfirst\t\t{}", proto.id));

    let kala = table.entries.iter().find(|e| e.wordname == "kala").unwrap();
    assert_eq!(
        lines[8],
        format!(
            "kala\tdog; hound; from [[proto]]\tnoun irregular\t{}",
            kala.id
        )
    );
}

#[test]
fn anki_quotes_fields_containing_the_delimiter() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    ws.create_table("t").unwrap();
    let a = ws.create_entry("t", "a").unwrap().unwrap();
    ws.set_definition("t", a, vec!["has\ttab".into()]).unwrap();

    let text = export_anki(
        ws.dictionary.table("t").unwrap(),
        &AnkiExportOptions::default(),
    );
    assert!(text.contains("a\t\"has\ttab\""), "{text}");
}

#[test]
fn anki_html_joins_senses_and_escapes_markup() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    ws.create_table("t").unwrap();
    let a = ws.create_entry("t", "a").unwrap().unwrap();
    ws.set_definition("t", a, vec!["<x>".into(), "a & b".into()])
        .unwrap();

    let opts = AnkiExportOptions {
        html: true,
        ..Default::default()
    };
    let text = export_anki(ws.dictionary.table("t").unwrap(), &opts);
    assert!(text.contains("#html:true"), "{text}");
    assert!(text.contains("a\t&lt;x&gt;<br>a &amp; b\t"), "{text}");
}

#[test]
fn anki_options_can_drop_the_special_columns() {
    let (_dir, ws) = sample();
    let table = ws.dictionary.table("lex").unwrap();
    let opts = AnkiExportOptions {
        include_parent: false,
        include_tags: false,
        include_guid: false,
        notetype: String::new(),
        ..Default::default()
    };
    let text = export_anki(table, &opts);
    assert!(!text.contains("#notetype:"), "{text}");
    assert!(!text.contains("#deck:"), "{text}");
    assert!(!text.contains("#tags column:"), "{text}");
    assert!(!text.contains("#guid column:"), "{text}");
    assert!(text.contains("#columns:Word\tDefinition\n"), "{text}");
    assert!(text.contains("kala\tdog; hound\n"), "{text}");
}

#[test]
fn anki_separator_is_configurable() {
    let (_dir, ws) = sample();
    let opts = AnkiExportOptions {
        separator: AnkiSeparator::Semicolon,
        include_guid: false,
        ..Default::default()
    };
    let text = export_anki(ws.dictionary.table("lex").unwrap(), &opts);
    assert!(text.contains("#separator:semicolon\n"), "{text}");
    assert!(text.contains("#columns:Word;Definition;Tags\n"), "{text}");
    assert!(
        text.contains("kala;\"dog; hound; from [[proto]]\";noun irregular\n"),
        "{text}"
    );
}
