//! Exporting a table to delimited text (CSV/TSV).
//!
//! The layout mirrors what [`crate::import`] can read back: `wordname`, then
//! `definition`, then `parent` as `[[wordname]]` wiki links, boolean tags
//! consolidated into one `tags` column of `#flag`s, and every other
//! (non-reserved) tag as its own column. Reference columns are written the
//! same `[[wordname]]` way, so a round trip through the importer restores the
//! relations rather than flattening them to text.
//!
//! [`export_columns`] returns the exact column order used, so callers (and
//! tests) can build matching import roles without duplicating the rules.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::{FieldType, FieldValue, WordTable, DEFINITION_TAG, PARENT_TAG, WORDNAME_TAG};

/// A table export format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TableFormat {
    Csv,
    Tsv,
    /// A lossless `WordTable` snapshot (exact ids, schema and values).
    Json,
}

/// One column in an exported table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportColumn {
    Wordname,
    Definition,
    Parent,
    /// Every boolean tag, consolidated as `#flag` values.
    Flags,
    /// A single non-boolean, non-reserved tag.
    Tag(String),
}

impl ExportColumn {
    /// The header written for this column.
    pub fn header(&self) -> String {
        match self {
            ExportColumn::Wordname => WORDNAME_TAG.to_string(),
            ExportColumn::Definition => DEFINITION_TAG.to_string(),
            ExportColumn::Parent => PARENT_TAG.to_string(),
            ExportColumn::Flags => "tags".to_string(),
            ExportColumn::Tag(name) => name.clone(),
        }
    }
}

fn reserved(name: &str) -> bool {
    name == WORDNAME_TAG || name == DEFINITION_TAG || name == PARENT_TAG
}

/// The column layout for `table`, in write order.
///
/// `wordname` is always present. `definition`/`parent`/`tags` appear only when
/// the table actually uses them; other tags appear when they are declared.
pub fn export_columns(table: &WordTable) -> Vec<ExportColumn> {
    let has_definition = table.entries.iter().any(|e| e.has(DEFINITION_TAG));
    let has_parent = table.entries.iter().any(|e| !e.parents().is_empty())
        || table.tags.iter().any(|t| t.name == PARENT_TAG);
    let has_flags = table
        .tags
        .iter()
        .any(|t| t.kind == FieldType::Boolean && !reserved(&t.name));

    let mut columns = vec![ExportColumn::Wordname];
    if has_definition {
        columns.push(ExportColumn::Definition);
    }
    if has_parent {
        columns.push(ExportColumn::Parent);
    }
    if has_flags {
        columns.push(ExportColumn::Flags);
    }
    let others: Vec<&str> = table
        .tags
        .iter()
        .filter(|t| !reserved(&t.name) && t.kind != FieldType::Boolean)
        .map(|t| t.name.as_str())
        .collect();
    for name in others {
        columns.push(ExportColumn::Tag(name.to_string()));
    }
    columns
}

fn id_names(table: &WordTable) -> HashMap<Uuid, String> {
    table
        .entries
        .iter()
        .map(|e| (e.id, e.wordname.clone()))
        .collect()
}

fn reference_links(ids: &[Uuid], names: &HashMap<Uuid, String>) -> String {
    ids.iter()
        .map(|id| match names.get(id) {
            Some(name) => format!("[[{name}]]"),
            None => format!("[[{id}]]"),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Format one field value for a non-boolean tag column.
fn value_cell(value: Option<&FieldValue>, names: &HashMap<Uuid, String>) -> String {
    match value {
        None => String::new(),
        Some(FieldValue::Text(text)) => text.clone(),
        Some(FieldValue::TagList(items)) => items.join(", "),
        Some(FieldValue::Boolean(flag)) => flag.to_string(),
        Some(FieldValue::Reference(id)) => reference_links(&[*id], names),
        Some(FieldValue::References(ids)) => reference_links(ids, names),
    }
}

fn flags_cell(table: &WordTable, id: Uuid) -> String {
    let Some(entry) = table.get(id) else {
        return String::new();
    };
    let mut flags: Vec<String> = Vec::new();
    for tag in &table.tags {
        if tag.kind != FieldType::Boolean || reserved(&tag.name) {
            continue;
        }
        if matches!(entry.get(&tag.name), Some(FieldValue::Boolean(true))) {
            flags.push(format!("#{}", tag.name));
        }
    }
    flags.join(", ")
}

/// Quote a single field if it contains the delimiter, the quote, or a newline.
fn escape(value: &str, delimiter: char, quote: char) -> String {
    if value.contains(delimiter)
        || value.contains(quote)
        || value.contains('\n')
        || value.contains('\r')
    {
        let escaped = value.replace(quote, &format!("{quote}{quote}"));
        format!("{quote}{escaped}{quote}")
    } else {
        value.to_string()
    }
}

/// Render a table as delimited text (a header row, then one row per word).
///
/// Values are quoted only when needed, so the output is byte-for-byte stable
/// and re-readable by [`crate::import::parse_records`].
pub fn export_delimited(table: &WordTable, delimiter: char, quote: char) -> String {
    let columns = export_columns(table);
    let names = id_names(table);
    let mut out = String::new();

    let header: Vec<String> = columns.iter().map(|c| c.header()).collect();
    out.push_str(
        &header
            .iter()
            .map(|h| escape(h, delimiter, quote))
            .collect::<Vec<_>>()
            .join(&delimiter.to_string()),
    );
    out.push('\n');

    for entry in &table.entries {
        let mut row: Vec<String> = Vec::with_capacity(columns.len());
        for column in &columns {
            let cell = match column {
                ExportColumn::Wordname => entry.wordname.clone(),
                ExportColumn::Definition => entry
                    .definition()
                    .map(|senses| senses.join(", "))
                    .unwrap_or_default(),
                ExportColumn::Parent => reference_links(&entry.parents(), &names),
                ExportColumn::Flags => flags_cell(table, entry.id),
                ExportColumn::Tag(name) => value_cell(entry.get(name), &names),
            };
            row.push(escape(&cell, delimiter, quote));
        }
        out.push_str(&row.join(&delimiter.to_string()));
        out.push('\n');
    }
    out
}

/// Export a table in the requested format as text.
pub fn export_table(table: &WordTable, format: TableFormat) -> Result<String, serde_json::Error> {
    Ok(match format {
        TableFormat::Csv => export_delimited(table, ',', '"'),
        TableFormat::Tsv => export_delimited(table, '\t', '"'),
        TableFormat::Json => serde_json::to_string_pretty(table)?,
    })
}
