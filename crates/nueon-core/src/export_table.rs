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

/// A field separator Anki should use for the imported file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnkiSeparator {
    Tab,
    Comma,
    Semicolon,
    Space,
    Pipe,
    Colon,
}

impl AnkiSeparator {
    /// The literal delimiter character written between columns.
    pub fn delimiter(self) -> char {
        match self {
            AnkiSeparator::Tab => '\t',
            AnkiSeparator::Comma => ',',
            AnkiSeparator::Semicolon => ';',
            AnkiSeparator::Space => ' ',
            AnkiSeparator::Pipe => '|',
            AnkiSeparator::Colon => ':',
        }
    }

    /// The value written in the `#separator:` file header.
    pub fn name(self) -> &'static str {
        match self {
            AnkiSeparator::Tab => "tab",
            AnkiSeparator::Comma => "comma",
            AnkiSeparator::Semicolon => "semicolon",
            AnkiSeparator::Space => "space",
            AnkiSeparator::Pipe => "pipe",
            AnkiSeparator::Colon => "colon",
        }
    }
}

/// Options controlling an Anki text-file export.
///
/// Defaults produce a two-field `Basic` card (front = wordname, back =
/// definition with parents appended), tab separated, with per-word boolean
/// tags and a stable GUID for update-in-place re-imports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct AnkiExportOptions {
    pub separator: AnkiSeparator,
    /// Treat fields as HTML (senses joined by `<br>`, `< > &` escaped).
    pub html: bool,
    /// Preset deck name; omitted from the headers when empty.
    pub deck: String,
    /// Preset note type name; omitted from the headers when empty.
    pub notetype: String,
    /// Append parents to the definition as `from [[parent]]` links.
    pub include_parent: bool,
    /// Emit a `#tags column` sourced from the word's boolean flags.
    pub include_tags: bool,
    /// Emit a `#guid column` with each word's stable id.
    pub include_guid: bool,
}

impl Default for AnkiExportOptions {
    fn default() -> Self {
        Self {
            separator: AnkiSeparator::Tab,
            html: false,
            deck: String::new(),
            notetype: "Basic".into(),
            include_parent: true,
            include_tags: true,
            include_guid: true,
        }
    }
}

/// Escape HTML-significant characters so a plain value can live in an
/// `#html:true` field.
fn anki_html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Space-separated Anki tags from every boolean flag set to `true`.
fn anki_tags(table: &WordTable, id: Uuid) -> String {
    let Some(entry) = table.get(id) else {
        return String::new();
    };
    let mut tags: Vec<&str> = Vec::new();
    for tag in &table.tags {
        if tag.kind != FieldType::Boolean || reserved(&tag.name) {
            continue;
        }
        if matches!(entry.get(&tag.name), Some(FieldValue::Boolean(true))) {
            tags.push(tag.name.as_str());
        }
    }
    tags.join(" ")
}

/// The back-of-card text: senses, then the parents as `from [[name]]` links.
///
/// When `html` is set each sense is escaped individually and joined with
/// `<br>`, so the line break survives escaping.
fn anki_back(
    entry: &crate::model::WordEntry,
    names: &HashMap<Uuid, String>,
    opts: &AnkiExportOptions,
) -> String {
    let join = if opts.html { "<br>" } else { "; " };
    let mut parts: Vec<String> = entry
        .definition()
        .unwrap_or(&[])
        .iter()
        .map(|sense| {
            if opts.html {
                anki_html_escape(sense)
            } else {
                sense.clone()
            }
        })
        .collect();
    if opts.include_parent {
        let parents = entry.parents();
        if !parents.is_empty() {
            let mut links = format!("from {}", reference_links(&parents, names));
            if opts.html {
                links = anki_html_escape(&links);
            }
            parts.push(links);
        }
    }
    parts.join(join)
}

/// Render a table as an Anki-importable text file.
///
/// The file opens with `#key:value` file headers (separator, html, note type,
/// deck, columns, and the column indices for tags and GUID), followed by one
/// row per word: wordname, back-of-card, tags, then GUID when enabled.
pub fn export_anki(table: &WordTable, opts: &AnkiExportOptions) -> String {
    let delimiter = opts.separator.delimiter();
    let names = id_names(table);

    let has_tags = opts.include_tags
        && table
            .tags
            .iter()
            .any(|t| t.kind == FieldType::Boolean && !reserved(&t.name));
    let has_guid = opts.include_guid;

    // Column labels, in write order, and the 1-based index of the special
    // tags/GUID columns for the matching headers.
    let mut columns: Vec<&str> = vec!["Word", "Definition"];
    let tags_index = {
        if has_tags {
            columns.push("Tags");
            Some(columns.len())
        } else {
            None
        }
    };
    let guid_index = {
        if has_guid {
            columns.push("GUID");
            Some(columns.len())
        } else {
            None
        }
    };

    let mut out = String::new();
    out.push_str(&format!("#separator:{}\n", opts.separator.name()));
    out.push_str(&format!("#html:{}\n", opts.html));
    if !opts.notetype.is_empty() {
        out.push_str(&format!("#notetype:{}\n", opts.notetype));
    }
    if !opts.deck.is_empty() {
        out.push_str(&format!("#deck:{}\n", opts.deck));
    }
    out.push_str(&format!(
        "#columns:{}\n",
        columns.join(&delimiter.to_string())
    ));
    if let Some(index) = tags_index {
        out.push_str(&format!("#tags column:{index}\n"));
    }
    if let Some(index) = guid_index {
        out.push_str(&format!("#guid column:{index}\n"));
    }

    for entry in &table.entries {
        let mut cells: Vec<String> = Vec::with_capacity(columns.len());
        let word = if opts.html {
            anki_html_escape(&entry.wordname)
        } else {
            entry.wordname.clone()
        };
        let back = anki_back(entry, &names, opts);
        cells.push(escape(&word, delimiter, '"'));
        cells.push(escape(&back, delimiter, '"'));
        if has_tags {
            cells.push(escape(&anki_tags(table, entry.id), delimiter, '"'));
        }
        if has_guid {
            cells.push(escape(&entry.id.to_string(), delimiter, '"'));
        }
        out.push_str(&cells.join(&delimiter.to_string()));
        out.push('\n');
    }
    out
}
