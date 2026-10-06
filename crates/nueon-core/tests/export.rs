//! Delimited export round-trip: export a table, import it back, and confirm
//! nothing is lost.

use nueon_core::{
    export_columns, export_delimited, export_table, import_apply, ColumnRole, ExportColumn,
    FieldType, FieldValue, ImportOptions, ImportPlan, TableFormat, TagDef, WordTable, Workspace,
};

/// Import roles that exactly mirror an exported table's column layout.
fn roles_for(table: &WordTable) -> Vec<ColumnRole> {
    export_columns(table)
        .into_iter()
        .map(|column| match column {
            ExportColumn::Wordname => ColumnRole::Wordname,
            ExportColumn::Definition => ColumnRole::Definition,
            ExportColumn::Parent => ColumnRole::Parents,
            ExportColumn::Flags => ColumnRole::TagFlags,
            ExportColumn::Tag(name) => match table.tag(&name).unwrap().kind {
                FieldType::Text => ColumnRole::TextTag { name },
                FieldType::TagList => ColumnRole::ListTag { name },
                FieldType::References | FieldType::Reference => ColumnRole::References { name },
                FieldType::Boolean => ColumnRole::BooleanTag { name },
            },
        })
        .collect()
}

fn sample_table(ws: &mut Workspace) {
    ws.create_table("src").unwrap();
    ws.add_tag("src", TagDef::new("verb", FieldType::Boolean))
        .unwrap();
    ws.add_tag("src", TagDef::new("note", FieldType::Text))
        .unwrap();
    ws.add_tag("src", TagDef::new("senses", FieldType::TagList))
        .unwrap();
    ws.add_tag("src", TagDef::new("synonym", FieldType::References))
        .unwrap();

    let ala = ws.create_entry("src", "ala").unwrap().unwrap();
    ws.set_definition("src", ala, vec!["to go".into(), "walk".into()])
        .unwrap();
    ws.set_value("src", ala, "verb", Some(FieldValue::Boolean(true)))
        .unwrap();
    // A value that needs quoting: comma, a quote, and a newline.
    ws.set_value(
        "src",
        ala,
        "note",
        Some(FieldValue::Text("a,b \"q\"\nline".into())),
    )
    .unwrap();
    ws.set_value(
        "src",
        ala,
        "senses",
        Some(FieldValue::TagList(vec!["move".into(), "travel".into()])),
    )
    .unwrap();

    let bela = ws.create_entry("src", "bela").unwrap().unwrap();
    ws.set_value(
        "src",
        ala,
        "synonym",
        Some(FieldValue::References(vec![bela])),
    )
    .unwrap();
    ws.add_parent("src", ala, bela).unwrap();
}

fn round_trip(delimiter: char) -> WordTable {
    let source = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(source.path()).unwrap();
    sample_table(&mut ws);
    let table = ws.dictionary.table("src").unwrap().clone();

    let text = export_delimited(&table, delimiter, '"');
    let path = source.path().join("dump");
    std::fs::write(&path, &text).unwrap();

    let options = ImportOptions {
        delimiter,
        quote: '"',
        has_header: true,
        roles: roles_for(&table),
        target_table: "dst".into(),
        ..Default::default()
    };
    let dest = tempfile::tempdir().unwrap();
    let mut dst = Workspace::new(dest.path()).unwrap();
    import_apply(&mut dst, &ImportPlan::new(&path, options)).unwrap();
    dst.dictionary.table("dst").unwrap().clone()
}

fn assert_round_tripped(d: &WordTable) {
    assert_eq!(d.entries.len(), 2);
    let ala = d.entries.iter().find(|e| e.wordname == "ala").unwrap();
    let bela = d.entries.iter().find(|e| e.wordname == "bela").unwrap();

    assert_eq!(
        ala.get("definition"),
        Some(&FieldValue::TagList(vec!["to go".into(), "walk".into()]))
    );
    assert_eq!(ala.get("verb"), Some(&FieldValue::Boolean(true)));
    // The quoted value survives byte-for-byte.
    assert_eq!(
        ala.get("note"),
        Some(&FieldValue::Text("a,b \"q\"\nline".into()))
    );
    assert_eq!(
        ala.get("senses"),
        Some(&FieldValue::TagList(vec!["move".into(), "travel".into()]))
    );
    assert_eq!(ala.parents(), vec![bela.id]);
    assert_eq!(
        ala.get("synonym"),
        Some(&FieldValue::References(vec![bela.id]))
    );
}

#[test]
fn tsv_export_round_trips_through_the_importer() {
    assert_round_tripped(&round_trip('\t'));
}

#[test]
fn csv_export_round_trips_through_the_importer() {
    assert_round_tripped(&round_trip(','));
}

#[test]
fn export_quotes_only_when_needed() {
    let mut ws = Workspace::new(tempfile::tempdir().unwrap().path()).unwrap();
    ws.create_table("t").unwrap();
    ws.add_tag("t", TagDef::new("note", FieldType::Text))
        .unwrap();
    let a = ws.create_entry("t", "plain").unwrap().unwrap();
    ws.set_value("t", a, "note", Some(FieldValue::Text("simple".into())))
        .unwrap();
    let b = ws.create_entry("t", "quoted").unwrap().unwrap();
    ws.set_value("t", b, "note", Some(FieldValue::Text("a,b".into())))
        .unwrap();
    let table = ws.dictionary.table("t").unwrap();

    let csv = export_delimited(table, ',', '"');
    // "simple" is unquoted; "a,b" is quoted because it holds the delimiter.
    assert!(csv.contains("plain,simple\n"), "{csv}");
    assert!(csv.contains("quoted,\"a,b\"\n"), "{csv}");
}

#[test]
fn export_columns_follow_the_documented_order() {
    let mut ws = Workspace::new(tempfile::tempdir().unwrap().path()).unwrap();
    sample_table(&mut ws);
    let table = ws.dictionary.table("src").unwrap();
    let headers: Vec<String> = export_columns(table).iter().map(|c| c.header()).collect();
    assert_eq!(
        headers,
        vec![
            "wordname",
            "definition",
            "parent",
            "tags",
            "note",
            "senses",
            "synonym"
        ]
    );
}

#[test]
fn json_export_is_an_exact_lossless_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new(dir.path()).unwrap();
    sample_table(&mut ws);
    let table = ws.dictionary.table("src").unwrap().clone();

    let json = export_table(&table, TableFormat::Json).unwrap();
    let restored: WordTable = serde_json::from_str(&json).unwrap();
    // Exact equality: ids, schema, values and relations all survive.
    assert_eq!(restored, table);
}
