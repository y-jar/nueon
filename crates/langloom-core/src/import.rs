//! Importing words from delimited text (CSV/TSV) into a table.
//!
//! The flow is deliberately split so nothing is written without the caller
//! seeing it first:
//!
//! 1. [`detect`] inspects a file and *proposes* a delimiter, whether it has a
//!    header, and a role for every column. Proposals are data, never applied.
//! 2. [`import_preview`] parses the file and reports what an import would do —
//!    rows, placeholders, links, duplicate conflicts — against a workspace,
//!    without changing anything.
//! 3. [`import_apply`] performs the import from an [`ImportPlan`] the caller
//!    has reviewed.
//!
//! Reference links (`[[target|alias]]`) resolve into `parent` relations; any
//! other prose in the same cell is kept verbatim in a text column and never
//! guessed at. Empty cells never write a tag, so the stored data stays sparse.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::{FieldType, FieldValue, TagDef, WordEntry, DEFINITION_TAG};
use crate::workspace::{StorageError, Workspace};

/// What a column in the input file means.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum ColumnRole {
    /// Skip the column entirely.
    Ignore,
    /// The word's spelling.
    Wordname,
    /// English definition senses (split on the tag-list delimiter).
    Definition,
    /// Root/derivation links: the whole cell is kept verbatim as a text
    /// column, and every `[[…]]` reference inside it becomes a `parent` link.
    Parents,
    /// A cell listing tags (`#noun, #verb`): split, strip the tag prefix, and
    /// set each named tag to `true` on the word.
    TagFlags,
    /// The whole cell is stored as text under `name`.
    TextTag { name: String },
    /// The cell is split on the tag-list delimiter and stored as a tag list.
    ListTag { name: String },
    /// A truthy cell sets the boolean tag `name`; empty/falsey cells write
    /// nothing.
    BooleanTag { name: String },
}

/// What to do when a word already exists somewhere in the workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DuplicatePolicy {
    /// Leave the existing word untouched (the safe default).
    #[default]
    Skip,
    /// Merge the imported fields into the existing word in the target table.
    Update,
    /// Create a second entry with the same spelling (a homograph).
    Add,
}

/// How reference links are written in the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkSyntax {
    /// `[[target]]` or `[[target|alias]]`.
    #[default]
    Wiki,
    /// No link syntax recognized.
    None,
}

/// Everything the importer needs to know about the file it is reading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportOptions {
    pub delimiter: char,
    pub quote: char,
    pub has_header: bool,
    /// Delimiter inside a cell that holds a list (tags, definition senses).
    pub tag_list_delimiter: char,
    /// Prefix stripped from tag names (`#noun` → `noun`).
    pub tag_prefix: String,
    /// Delimiter between several `[[…]]` links; informational, links are found
    /// by their brackets regardless.
    pub parent_delimiter: String,
    pub link_syntax: LinkSyntax,
    /// One role per column, in file order.
    pub roles: Vec<ColumnRole>,
    /// Table the words are imported into.
    pub target_table: String,
    pub duplicate_policy: DuplicatePolicy,
    /// Skip rows whose wordname looks like a placeholder (`Untitled`, …).
    pub skip_placeholders: bool,
    /// Create a `suffix`-tagged entry for an unresolved link instead of
    /// leaving it unresolved.
    pub create_suffix_entries: bool,
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            delimiter: ',',
            quote: '"',
            has_header: true,
            tag_list_delimiter: ',',
            tag_prefix: "#".to_string(),
            parent_delimiter: ",".to_string(),
            link_syntax: LinkSyntax::Wiki,
            roles: Vec::new(),
            target_table: "imported".to_string(),
            duplicate_policy: DuplicatePolicy::default(),
            skip_placeholders: true,
            create_suffix_entries: false,
        }
    }
}

/// Errors raised while reading or applying an import.
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("failed to read {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("the file has no data rows")]
    Empty,
    #[error("no column is mapped as the wordname")]
    NoWordname,
    #[error("the file is not valid UTF-8: {0}")]
    NotUtf8(String),
}

fn read_file(path: &Path) -> Result<String, ImportError> {
    let bytes = std::fs::read(path).map_err(|source| ImportError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    String::from_utf8(bytes).map_err(|err| ImportError::NotUtf8(err.to_string()))
}

// -- parsing -----------------------------------------------------------------

/// Parse delimited text into rows of fields.
///
/// Handles a configurable delimiter and quote character (including `""` for a
/// literal quote and delimiters/newlines inside quotes). `\r\n` and `\n` both
/// end a row. Rows are returned as-is, ragged fields included.
pub fn parse_records(text: &str, delimiter: char, quote: char) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == quote {
                if chars.peek() == Some(&quote) {
                    field.push(quote);
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else if c == quote && field.is_empty() {
            in_quotes = true;
        } else if c == delimiter {
            row.push(std::mem::take(&mut field));
        } else if c == '\n' {
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else if c == '\r' {
            // Part of a CRLF pair; ignored.
        } else {
            field.push(c);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn is_blank_row(row: &[String]) -> bool {
    row.iter().all(|cell| cell.trim().is_empty())
}

fn is_placeholder(wordname: &str) -> bool {
    let name = wordname.trim();
    if !name.starts_with("Untitled") {
        return false;
    }
    let rest = &name["Untitled".len()..];
    rest.trim().is_empty() || rest.trim().chars().all(|c| c.is_ascii_digit())
}

/// Whether a value reads as boolean-true.
fn truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "y" | "x" | "✓" | "on"
    )
}

fn looks_boolean(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "false" | "1" | "0" | "yes" | "no" | "y" | "n"
    )
}

/// Extract the raw inner text of every `[[…]]` in `cell`.
fn raw_links(cell: &str, syntax: LinkSyntax) -> Vec<String> {
    if syntax != LinkSyntax::Wiki {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut rest = cell;
    while let Some(open) = rest.find("[[") {
        let after = &rest[open + 2..];
        match after.find("]]") {
            Some(close) => {
                out.push(after[..close].to_string());
                rest = &after[close + 2..];
            }
            None => break,
        }
    }
    out
}

/// `[[target|alias]]` / `folder/target` → the bare target name.
pub fn normalize_link_target(raw: &str) -> String {
    raw.split('|')
        .next()
        .unwrap_or(raw)
        .rsplit('/')
        .next()
        .unwrap_or(raw)
        .trim()
        .to_string()
}

/// Heuristic: text that still carries combining marks is likely not NFC.
fn has_combining_marks(text: &str) -> bool {
    text.chars().any(|c| {
        let n = c as u32;
        (0x0300..=0x036F).contains(&n) || (0x1AB0..=0x1AFF).contains(&n)
    })
}

fn strip_prefix<'a>(value: &'a str, prefix: &str) -> &'a str {
    let value = value.trim();
    value.strip_prefix(prefix).unwrap_or(value).trim()
}

// -- detection ---------------------------------------------------------------

/// A proposed meaning for one column, with the evidence behind it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnProposal {
    pub index: usize,
    pub header: String,
    pub role: ColumnRole,
    /// Number of distinct non-empty values seen.
    pub distinct_values: usize,
    /// When the column looks like a small set of flags, the values it could be
    /// split into (one boolean tag each). Empty when not applicable.
    pub boolean_split: Vec<String>,
    pub reasons: Vec<String>,
}

/// What [`detect`] guessed about a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detection {
    pub delimiter: char,
    pub has_header: bool,
    pub columns: Vec<ColumnProposal>,
}

/// Inspect a file and propose import settings. Writes nothing.
pub fn detect(text: &str, base: &ImportOptions) -> Detection {
    let non_blank: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let delimiter = pick_delimiter(&non_blank, base.delimiter);
    let rows = parse_records(text, delimiter, base.quote);
    let data_rows: Vec<&Vec<String>> = rows.iter().filter(|r| !is_blank_row(r)).collect();
    let has_header = guess_has_header(&data_rows);

    let header: Vec<String> = if has_header {
        data_rows.first().map(|r| r.to_vec()).unwrap_or_default()
    } else {
        Vec::new()
    };
    let body = if has_header {
        &data_rows[1.min(data_rows.len())..]
    } else {
        &data_rows[..]
    };
    let column_count = data_rows.iter().map(|r| r.len()).max().unwrap_or(0);

    let mut columns = Vec::new();
    for index in 0..column_count {
        let name = header.get(index).cloned().unwrap_or_default();
        columns.push(propose_column(index, &name, body, base));
    }
    Detection {
        delimiter,
        has_header,
        columns,
    }
}

fn pick_delimiter(lines: &[&str], fallback: char) -> char {
    let candidates = ['\t', ';', ',', '|'];
    let mut best = fallback;
    let mut best_score = 0usize;
    for &candidate in &candidates {
        // Score = number of lines sharing the most common field count > 1.
        let mut counts: BTreeMap<usize, usize> = BTreeMap::new();
        for line in lines.iter().take(50) {
            let n = parse_line_count(line, candidate);
            if n > 1 {
                *counts.entry(n).or_default() += 1;
            }
        }
        let score = counts.values().copied().max().unwrap_or(0);
        if score > best_score {
            best_score = score;
            best = candidate;
        }
    }
    best
}

fn parse_line_count(line: &str, delimiter: char) -> usize {
    parse_records(line, delimiter, '"')
        .first()
        .map_or(0, Vec::len)
}

fn guess_has_header(data_rows: &[&Vec<String>]) -> bool {
    let Some(first) = data_rows.first() else {
        return false;
    };
    let second = data_rows.get(1);
    let first_has_digits = first
        .iter()
        .any(|c| c.chars().any(|ch| ch.is_ascii_digit()));
    let all_named = first.iter().all(|c| !c.trim().is_empty());
    let differs = second.is_some_and(|s| {
        // A header row tends not to look exactly like the next data row.
        s.iter().zip(first.iter()).any(|(a, b)| a != b)
    });
    all_named && !first_has_digits && differs
}

fn propose_column(
    index: usize,
    header: &str,
    body: &[&Vec<String>],
    base: &ImportOptions,
) -> ColumnProposal {
    let values: Vec<String> = body
        .iter()
        .filter_map(|row| row.get(index))
        .map(|cell| cell.trim().to_string())
        .filter(|cell| !cell.is_empty())
        .collect();
    let distinct: BTreeSet<&String> = values.iter().collect();
    let distinct_values = distinct.len();
    let lower = header.to_lowercase();
    let mut reasons = Vec::new();
    let mut boolean_split = Vec::new();

    let role = if lower.contains("wordname")
        || lower.contains("word")
        || lower == "file name"
        || lower == "name"
        || lower == "lemma"
        || lower == "form"
    {
        reasons.push("header looks like the word name".to_string());
        ColumnRole::Wordname
    } else if lower.contains("definition") || lower.contains("gloss") || lower.contains("meaning") {
        reasons.push("header looks like a definition".to_string());
        ColumnRole::Definition
    } else if lower.contains("parent") || lower.contains("root") || lower.contains("derive") {
        reasons.push("header looks like parent/derivation links".to_string());
        ColumnRole::Parents
    } else if lower.contains("tag") {
        let prefixed = values
            .iter()
            .filter(|v| v.contains(&base.tag_prefix))
            .count();
        if prefixed > 0 && values.iter().any(|v| v.contains(base.tag_list_delimiter)) {
            reasons.push("values are prefixed and delimited tags".to_string());
            boolean_split = split_flags(&values, base);
            ColumnRole::TagFlags
        } else {
            reasons.push("header looks like tags".to_string());
            ColumnRole::ListTag {
                name: fallback_name(header, index),
            }
        }
    } else if !values.is_empty() && values.iter().all(|v| looks_boolean(v)) {
        reasons.push("all values look boolean".to_string());
        ColumnRole::BooleanTag {
            name: fallback_name(header, index),
        }
    } else if !values.is_empty() && values.iter().all(|v| v.contains(&base.tag_prefix)) {
        reasons.push("every value carries the tag prefix".to_string());
        boolean_split = split_flags(&values, base);
        ColumnRole::TagFlags
    } else if distinct_values > 0 && distinct_values * 2 <= values.len() && distinct_values <= 12 {
        boolean_split = values
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        reasons.push(format!(
            "only {distinct_values} distinct values across {} rows; could be split into flags",
            values.len()
        ));
        ColumnRole::TextTag {
            name: fallback_name(header, index),
        }
    } else if distinct_values * 2 > values.len() {
        reasons.push("values are mostly unique; treat as text".to_string());
        ColumnRole::TextTag {
            name: fallback_name(header, index),
        }
    } else if values.is_empty() {
        reasons.push("no values; defaulting to text".to_string());
        ColumnRole::TextTag {
            name: fallback_name(header, index),
        }
    } else {
        reasons.push("defaulting to text".to_string());
        ColumnRole::TextTag {
            name: fallback_name(header, index),
        }
    };

    ColumnProposal {
        index,
        header: header.to_string(),
        role,
        distinct_values,
        boolean_split,
        reasons,
    }
}

fn split_flags(values: &[String], base: &ImportOptions) -> Vec<String> {
    let mut set = BTreeSet::new();
    for value in values {
        for part in value.split(base.tag_list_delimiter) {
            let name = strip_prefix(part, &base.tag_prefix);
            if !name.is_empty() {
                set.insert(name.to_string());
            }
        }
    }
    set.into_iter().collect()
}

fn fallback_name(header: &str, index: usize) -> String {
    if header.trim().is_empty() {
        format!("column {}", index + 1)
    } else {
        header.trim().to_string()
    }
}

// -- preview -----------------------------------------------------------------

/// A reference link found in the source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkOccurrence {
    pub row: usize,
    pub raw: String,
    pub target: String,
}

/// How the file's links resolve against the workspace.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkReport {
    pub occurrences: usize,
    pub unique_targets: usize,
    /// Targets that matched exactly one word.
    pub exact: Vec<String>,
    /// Targets that only matched case-insensitively: `(target, matched)`.
    pub case_only: Vec<(String, String)>,
    /// Targets with no match at all.
    pub unresolved: Vec<String>,
    /// Targets matching more than one word (e.g. a name in two tables).
    pub ambiguous: Vec<String>,
}

/// A word that already exists where the import would create it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DuplicateConflict {
    pub wordname: String,
    pub incoming_table: String,
    pub existing_tables: Vec<String>,
}

/// A row that looks wrong but is left for the user to decide.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuspiciousRow {
    pub row: usize,
    pub wordname: String,
    pub reason: String,
}

/// A tag the import would add to the table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagProposal {
    pub name: String,
    pub kind: FieldType,
}

/// What an import would do. Nothing has been written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preview {
    pub table: String,
    /// Non-blank data rows (excluding the header).
    pub rows_total: usize,
    pub rows_blank: usize,
    /// Data rows with fewer fields than the widest row.
    pub short_rows: Vec<usize>,
    pub placeholders: Vec<usize>,
    pub rows_skipped: usize,
    /// Words that would be created.
    pub words: usize,
    pub tags: Vec<TagProposal>,
    pub links: LinkReport,
    pub duplicates: Vec<DuplicateConflict>,
    pub suspicious: Vec<SuspiciousRow>,
    pub non_nfc_rows: Vec<usize>,
    pub warnings: Vec<String>,
}

struct Column<'a> {
    role: &'a ColumnRole,
    header: String,
}

fn roles_with_headers<'a>(options: &'a ImportOptions, header: &[String]) -> Vec<Column<'a>> {
    options
        .roles
        .iter()
        .enumerate()
        .map(|(i, role)| Column {
            role,
            header: header
                .get(i)
                .cloned()
                .unwrap_or_else(|| format!("column {}", i + 1)),
        })
        .collect()
}

/// Parse a file and report what importing it would do, read-only.
pub fn import_preview(
    workspace: &Workspace,
    path: &Path,
    options: &ImportOptions,
) -> Result<Preview, ImportError> {
    let text = read_file(path)?;
    let rows = parse_records(&text, options.delimiter, options.quote);
    build_preview(workspace, &rows, options)
}

fn build_preview(
    workspace: &Workspace,
    rows: &[Vec<String>],
    options: &ImportOptions,
) -> Result<Preview, ImportError> {
    if !rows.iter().any(|r| !is_blank_row(r)) {
        return Err(ImportError::Empty);
    }
    let header_cells: Vec<String> = if options.has_header {
        rows.iter()
            .find(|r| !is_blank_row(r))
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let columns = roles_with_headers(options, &header_cells);

    let widest = rows.iter().map(Vec::len).max().unwrap_or(0);
    let data_start = if options.has_header {
        rows.iter()
            .position(|r| !is_blank_row(r))
            .map_or(0, |i| i + 1)
    } else {
        0
    };

    let mut preview = Preview {
        table: options.target_table.clone(),
        rows_total: 0,
        rows_blank: 0,
        short_rows: Vec::new(),
        placeholders: Vec::new(),
        rows_skipped: 0,
        words: 0,
        tags: Vec::new(),
        links: LinkReport::default(),
        duplicates: Vec::new(),
        suspicious: Vec::new(),
        non_nfc_rows: Vec::new(),
        warnings: Vec::new(),
    };

    let wordname_index = columns
        .iter()
        .position(|c| matches!(c.role, ColumnRole::Wordname));

    let mut tag_set: BTreeMap<String, FieldType> = BTreeMap::new();
    let mut link_rows: BTreeMap<String, (usize, String, String)> = BTreeMap::new(); // target -> (row, raw, target)
    let mut incoming: BTreeSet<String> = BTreeSet::new();
    let mut seen_rows = 0usize;

    for (offset, row) in rows.iter().enumerate().skip(data_start) {
        let line = offset + 1;
        if is_blank_row(row) {
            preview.rows_blank += 1;
            continue;
        }
        seen_rows += 1;
        preview.rows_total += 1;
        if row.len() < widest {
            preview.short_rows.push(line);
        }
        if has_combining_marks(&row.join("")) {
            preview.non_nfc_rows.push(line);
        }
        let wordname = wordname_index
            .and_then(|i| row.get(i))
            .map(|c| c.trim().to_string())
            .unwrap_or_default();
        if wordname.is_empty() {
            preview.rows_skipped += 1;
            continue;
        }
        if is_placeholder(&wordname) && options.skip_placeholders {
            preview.placeholders.push(line);
            preview.rows_skipped += 1;
            continue;
        }
        incoming.insert(wordname.clone());

        // What tags this row would introduce.
        for (i, column) in columns.iter().enumerate() {
            let Some(cell) = row.get(i) else { continue };
            match column.role {
                ColumnRole::TagFlags => {
                    for part in cell.split(options.tag_list_delimiter) {
                        let name = strip_prefix(part, &options.tag_prefix);
                        if !name.is_empty() {
                            tag_set.insert(name.to_string(), FieldType::Boolean);
                        }
                    }
                }
                ColumnRole::BooleanTag { name } if truthy(cell) => {
                    tag_set.insert(name.clone(), FieldType::Boolean);
                }
                ColumnRole::ListTag { name } if !cell.trim().is_empty() => {
                    tag_set.insert(name.clone(), FieldType::TagList);
                }
                ColumnRole::TextTag { name } if !cell.trim().is_empty() => {
                    tag_set.insert(name.clone(), FieldType::Text);
                }
                _ => {}
            }
        }

        // Reference links.
        for (i, column) in columns.iter().enumerate() {
            if !matches!(column.role, ColumnRole::Parents) {
                continue;
            }
            let Some(cell) = row.get(i) else { continue };
            for raw in raw_links(cell, options.link_syntax) {
                let target = normalize_link_target(&raw);
                if target.is_empty() {
                    continue;
                }
                preview.links.occurrences += 1;
                link_rows
                    .entry(target.clone())
                    .or_insert_with(|| (line, raw.clone(), target.clone()));
            }
            // Prose that is not a link is kept as text; nothing to resolve.
        }

        // Duplicate/placeholder sanity.
        let existing = workspace.dictionary.word_index();
        if let Some(hits) = existing.get(&wordname.to_lowercase()) {
            let tables: Vec<String> = {
                let mut set = BTreeSet::new();
                for hit in hits {
                    if hit.wordname == wordname {
                        set.insert(hit.table.clone());
                    }
                }
                set.into_iter().collect()
            };
            if !tables.is_empty() {
                preview.duplicates.push(DuplicateConflict {
                    wordname: wordname.clone(),
                    incoming_table: options.target_table.clone(),
                    existing_tables: tables,
                });
            }
        }

        // Heuristic oddities reported, never "fixed".
        for (i, column) in columns.iter().enumerate() {
            let Some(cell) = row.get(i) else { continue };
            if matches!(column.role, ColumnRole::Definition)
                && cell.trim().eq_ignore_ascii_case("indego")
            {
                preview.suspicious.push(SuspiciousRow {
                    row: line,
                    wordname: wordname.clone(),
                    reason: "definition \"indego\" may be a swapped/misplaced value".to_string(),
                });
            }
            if matches!(column.role, ColumnRole::TagFlags) {
                for part in cell.split(options.tag_list_delimiter) {
                    let name = strip_prefix(part, &options.tag_prefix);
                    if name.ends_with('s') && !name.is_empty() {
                        preview.suspicious.push(SuspiciousRow {
                            row: line,
                            wordname: wordname.clone(),
                            reason: format!("tag \"#{name}\" may be a typo (trailing s)"),
                        });
                    }
                }
            }
        }
    }

    let skipped_dupes = if options.duplicate_policy == DuplicatePolicy::Skip {
        preview.duplicates.len()
    } else {
        0
    };
    preview.words = seen_rows.saturating_sub(preview.rows_skipped + skipped_dupes);
    preview.tags = tag_set
        .into_iter()
        .map(|(name, kind)| TagProposal { name, kind })
        .collect();

    // Resolve links against the workspace *and* the words this file itself
    // will create, so the preview matches what the two-pass apply will link.
    resolve_links(
        workspace,
        options,
        &incoming,
        &link_rows,
        &mut preview.links,
    );
    preview.links.unique_targets = link_rows.len();

    if !preview.non_nfc_rows.is_empty() {
        preview.warnings.push(format!(
            "{} row(s) may not be NFC-normalized; text is left exactly as written",
            preview.non_nfc_rows.len()
        ));
    }
    if !preview.short_rows.is_empty() {
        preview.warnings.push(format!(
            "{} row(s) have fewer fields than the widest row; short rows are padded",
            preview.short_rows.len()
        ));
    }
    if !preview.duplicates.is_empty() {
        preview.warnings.push(format!(
            "{} word(s) already exist elsewhere",
            preview.duplicates.len()
        ));
    }
    Ok(preview)
}

fn resolve_links(
    workspace: &Workspace,
    options: &ImportOptions,
    incoming: &BTreeSet<String>,
    links: &BTreeMap<String, (usize, String, String)>,
    report: &mut LinkReport,
) {
    for (_, _, target) in links.values() {
        // Candidate tables for an exact name: existing words, plus the words
        // this file is about to create in the target table.
        let mut exact_tables: BTreeSet<String> = BTreeSet::new();
        let mut ci: Vec<String> = Vec::new();
        for table in workspace.dictionary.tables() {
            for entry in &table.entries {
                if entry.wordname == *target {
                    exact_tables.insert(table.name.clone());
                } else if entry.wordname.eq_ignore_ascii_case(target) {
                    ci.push(entry.wordname.clone());
                }
            }
        }
        if incoming.contains(target) {
            exact_tables.insert(options.target_table.clone());
        }
        let exact_in_target = exact_tables.contains(&options.target_table);
        let exact = exact_tables.len();
        // Prefer an exact match in the target table, else any single exact
        // match; anything with several candidate tables is ambiguous.
        match (exact, exact_in_target, ci.is_empty()) {
            (0, _, true) => report.unresolved.push(target.clone()),
            (0, _, false) => report.case_only.push((target.clone(), ci[0].clone())),
            (1, _, _) => report.exact.push(target.clone()),
            (_, true, _) => report.exact.push(target.clone()),
            _ => report.ambiguous.push(target.clone()),
        }
    }
    report.exact.sort();
    report.exact.dedup();
    report.case_only.sort();
    report.case_only.dedup();
    report.unresolved.sort();
    report.unresolved.dedup();
    report.ambiguous.sort();
    report.ambiguous.dedup();
}

// -- apply -------------------------------------------------------------------

/// How to resolve one reference target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "choice", rename_all = "snake_case")]
pub enum LinkChoice {
    /// Link to this existing word.
    UseExisting { table: String, id: Uuid },
    /// Create a `suffix`-tagged entry for the target and link to it.
    CreateSuffix,
    /// Leave the link unresolved.
    Leave,
}

/// A reviewed import ready to run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportPlan {
    pub source: PathBuf,
    pub options: ImportOptions,
    /// Per-target link decisions. Targets not listed resolve by exact match.
    pub link_choices: BTreeMap<String, LinkChoice>,
    /// Per-word duplicate decisions. Words not listed use the policy default.
    pub duplicate_choices: BTreeMap<String, DuplicatePolicy>,
}

impl ImportPlan {
    /// A plan with default decisions: exact-match links, policy-based
    /// duplicates.
    pub fn new(source: impl Into<PathBuf>, options: ImportOptions) -> Self {
        Self {
            source: source.into(),
            options,
            link_choices: BTreeMap::new(),
            duplicate_choices: BTreeMap::new(),
        }
    }
}

/// What an import did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportReport {
    pub table: String,
    pub words_created: usize,
    pub words_updated: usize,
    pub words_skipped: usize,
    pub tags_created: Vec<String>,
    pub parents_linked: usize,
    pub parents_skipped: usize,
    pub suffix_entries: usize,
    pub warnings: Vec<String>,
}

/// Two-pass import: create every word (sparse — empty cells write nothing),
/// then resolve `[[…]]` links into `parent` relations, rejecting cycles.
pub fn import_apply(
    workspace: &mut Workspace,
    plan: &ImportPlan,
) -> Result<ImportReport, ImportError> {
    let options = &plan.options;
    let text = read_file(&plan.source)?;
    let rows = parse_records(&text, options.delimiter, options.quote);
    if !rows.iter().any(|r| !is_blank_row(r)) {
        return Err(ImportError::Empty);
    }

    // Validate everything that can fail *before* writing anything, so a bad
    // plan never leaves a half-created table behind.
    let header_cells: Vec<String> = if options.has_header {
        rows.iter()
            .find(|r| !is_blank_row(r))
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let columns = roles_with_headers(options, &header_cells);
    let wordname_index = columns
        .iter()
        .position(|c| matches!(c.role, ColumnRole::Wordname))
        .ok_or(ImportError::NoWordname)?;
    let data_start = if options.has_header {
        rows.iter()
            .position(|r| !is_blank_row(r))
            .map_or(0, |i| i + 1)
    } else {
        0
    };

    // A git checkpoint before touching anything, when a repo is present.
    let checkpoint = workspace.git().is_some();
    if checkpoint {
        workspace.checkin(&format!(
            "langloom: checkpoint before importing {}",
            plan.source.display()
        ));
    }

    if workspace.dictionary.table(&options.target_table).is_none() {
        workspace.create_table(&options.target_table)?;
    }

    let mut report = ImportReport {
        table: options.target_table.clone(),
        ..Default::default()
    };
    // Rows whose parent cells still need resolving in pass two.
    let mut pending_parents: Vec<(Uuid, String, usize)> = Vec::new();

    for (offset, row) in rows.iter().enumerate().skip(data_start) {
        let line = offset + 1;
        if is_blank_row(row) {
            continue;
        }
        let wordname = row
            .get(wordname_index)
            .map(|c| c.trim().to_string())
            .unwrap_or_default();
        if wordname.is_empty() {
            report.words_skipped += 1;
            continue;
        }
        if is_placeholder(&wordname) && options.skip_placeholders {
            report.words_skipped += 1;
            continue;
        }

        let policy = plan
            .duplicate_choices
            .get(&wordname)
            .copied()
            .unwrap_or(options.duplicate_policy);
        let existing = find_exact(workspace, &wordname);

        let id = match existing {
            Some((table, id)) if policy != DuplicatePolicy::Add => {
                if policy == DuplicatePolicy::Skip {
                    report.words_skipped += 1;
                    // Still remember the row's parents if it is in our table.
                    if table == options.target_table {
                        pending_parents.push((id, wordname.clone(), line));
                    }
                    continue;
                }
                // Update: only merge into a word already in the target table.
                if table != options.target_table {
                    report.words_skipped += 1;
                    report.warnings.push(format!(
                        "\"{wordname}\" exists in table \"{table}\"; not updated in place"
                    ));
                    continue;
                }
                report.words_updated += 1;
                id
            }
            _ => match workspace.create_entry(&options.target_table, wordname.clone())? {
                Some(id) => {
                    report.words_created += 1;
                    id
                }
                None => {
                    report.words_skipped += 1;
                    continue;
                }
            },
        };

        for (i, column) in columns.iter().enumerate() {
            let Some(cell) = row.get(i) else { continue };
            if cell.trim().is_empty() {
                continue;
            }
            match column.role {
                ColumnRole::Definition => {
                    let senses: Vec<String> = cell
                        .split(options.tag_list_delimiter)
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    if !senses.is_empty() {
                        workspace.set_definition(&options.target_table, id, senses)?;
                    }
                }
                ColumnRole::Parents => {
                    workspace.set_value(
                        &options.target_table,
                        id,
                        &column.header,
                        Some(FieldValue::Text(cell.clone())),
                    )?;
                    pending_parents.push((id, cell.clone(), line));
                }
                ColumnRole::TagFlags => {
                    for part in cell.split(options.tag_list_delimiter) {
                        let name = strip_prefix(part, &options.tag_prefix);
                        if name.is_empty() {
                            continue;
                        }
                        ensure_tag(
                            workspace,
                            &options.target_table,
                            name,
                            FieldType::Boolean,
                            &mut report,
                        )?;
                        workspace.set_value(
                            &options.target_table,
                            id,
                            name,
                            Some(FieldValue::Boolean(true)),
                        )?;
                    }
                }
                ColumnRole::ListTag { name } => {
                    let items: Vec<String> = cell
                        .split(options.tag_list_delimiter)
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    if !items.is_empty() {
                        ensure_tag(
                            workspace,
                            &options.target_table,
                            name,
                            FieldType::TagList,
                            &mut report,
                        )?;
                        workspace.set_value(
                            &options.target_table,
                            id,
                            name,
                            Some(FieldValue::TagList(items)),
                        )?;
                    }
                }
                ColumnRole::BooleanTag { name } => {
                    if truthy(cell) {
                        ensure_tag(
                            workspace,
                            &options.target_table,
                            name,
                            FieldType::Boolean,
                            &mut report,
                        )?;
                        workspace.set_value(
                            &options.target_table,
                            id,
                            name,
                            Some(FieldValue::Boolean(true)),
                        )?;
                    }
                }
                ColumnRole::TextTag { name } => {
                    ensure_tag(
                        workspace,
                        &options.target_table,
                        name,
                        FieldType::Text,
                        &mut report,
                    )?;
                    workspace.set_value(
                        &options.target_table,
                        id,
                        name,
                        Some(FieldValue::Text(cell.clone())),
                    )?;
                }
                ColumnRole::Wordname | ColumnRole::Ignore => {}
            }
        }
    }

    // Pass two: resolve links into parent relations.
    for (child, cell, _line) in &pending_parents {
        for raw in raw_links(cell, options.link_syntax) {
            let target = normalize_link_target(&raw);
            if target.is_empty() {
                continue;
            }
            let choice = plan.link_choices.get(&target);
            let parent = match choice {
                Some(LinkChoice::UseExisting { table, id }) => Some((table.clone(), *id)),
                Some(LinkChoice::CreateSuffix) => {
                    create_suffix(workspace, &options.target_table, &target, &mut report)?
                }
                Some(LinkChoice::Leave) => None,
                None => match resolve_default(workspace, options, &target) {
                    Some(pair) => Some(pair),
                    None if options.create_suffix_entries => {
                        create_suffix(workspace, &options.target_table, &target, &mut report)?
                    }
                    None => None,
                },
            };
            let Some((_, parent_id)) = parent else {
                report.parents_skipped += 1;
                continue;
            };
            if workspace.add_parent(&options.target_table, *child, parent_id)? {
                report.parents_linked += 1;
            } else {
                // Cycle or self-link: rejected, never forced.
                report.parents_skipped += 1;
                report
                    .warnings
                    .push(format!("link to \"{target}\" would create a cycle"));
            }
        }
    }

    if checkpoint {
        workspace.checkin(&format!(
            "langloom: import {} word(s) into \"{}\" <CAN REVERT>",
            report.words_created + report.words_updated,
            options.target_table
        ));
    }
    Ok(report)
}

fn ensure_tag(
    workspace: &mut Workspace,
    table: &str,
    name: &str,
    kind: FieldType,
    report: &mut ImportReport,
) -> Result<(), ImportError> {
    let exists = workspace
        .dictionary
        .table(table)
        .map(|t| t.has_tag(name))
        .unwrap_or(false);
    if !exists {
        workspace.add_tag(table, TagDef::new(name, kind))?;
        report.tags_created.push(name.to_string());
    }
    Ok(())
}

fn find_exact(workspace: &Workspace, wordname: &str) -> Option<(String, Uuid)> {
    let mut found = None;
    for table in workspace.dictionary.tables() {
        for entry in &table.entries {
            if entry.wordname == wordname {
                match &found {
                    None => found = Some((table.name.clone(), entry.id)),
                    Some(_) => return found, // ambiguous; first wins here
                }
            }
        }
    }
    found
}

fn resolve_default(
    workspace: &Workspace,
    options: &ImportOptions,
    target: &str,
) -> Option<(String, Uuid)> {
    let mut exact = Vec::new();
    let mut ci = Vec::new();
    for table in workspace.dictionary.tables() {
        for entry in &table.entries {
            if entry.wordname == target {
                exact.push((table.name.clone(), entry.id));
            } else if entry.wordname.eq_ignore_ascii_case(target) {
                ci.push((table.name.clone(), entry.id));
            }
        }
    }
    if let Some(pair) = exact.iter().find(|(t, _)| t == &options.target_table) {
        return Some(pair.clone());
    }
    if !exact.is_empty() {
        return Some(exact[0].clone());
    }
    if !ci.is_empty() {
        return Some(ci[0].clone());
    }
    None
}

fn create_suffix(
    workspace: &mut Workspace,
    table: &str,
    target: &str,
    report: &mut ImportReport,
) -> Result<Option<(String, Uuid)>, ImportError> {
    ensure_tag(workspace, table, "suffix", FieldType::Boolean, report)?;
    match workspace.create_entry(table, target.to_string())? {
        Some(id) => {
            workspace.set_value(table, id, "suffix", Some(FieldValue::Boolean(true)))?;
            report.suffix_entries += 1;
            Ok(Some((table.to_string(), id)))
        }
        None => Ok(None),
    }
}

impl fmt::Display for DuplicatePolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            DuplicatePolicy::Skip => "skip",
            DuplicatePolicy::Update => "update",
            DuplicatePolicy::Add => "add",
        };
        f.write_str(name)
    }
}

/// Convenience: the definition senses of an entry, for tests and callers.
pub fn definition_senses(entry: &WordEntry) -> Vec<String> {
    match entry.get(DEFINITION_TAG) {
        Some(FieldValue::TagList(senses)) => senses.clone(),
        _ => Vec::new(),
    }
}
