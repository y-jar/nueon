/**
 * Pure Markdown table model: parse, serialize, width and structural edits.
 *
 * No CodeMirror/DOM/Svelte imports, by design: a future table widget reuses
 * this untouched. Cell text is kept exactly as written (escaped `\|` is not
 * unescaped) so `parseTable(serializeTable(model))` round-trips losslessly.
 *
 * Cell splitting mirrors `@lezer/markdown`'s GFM table parser (its `parseRow`):
 * a cell boundary is any `|` not preceded by an odd run of backslashes; a pipe
 * inside a backtick code span still splits. Widths pad the serialized source
 * only — they never affect how a table renders.
 */

/** Column alignment taken from the delimiter row. */
export type Align = "none" | "left" | "center" | "right";

/** A parsed Markdown table. */
export interface TableModel {
  /** Per-column alignment, from `:--`, `:-:`, `--:`. */
  alignments: Align[];
  /** Header cell text. */
  header: string[];
  /** Body rows, each normalised to `header.length`. */
  rows: string[][];
}

const PIPE = 124;
const BACKSLASH = 92;
const SPACE = 32;
const TAB = 9;

/** GFM delimiter row (as `@lezer/markdown` accepts it). */
const DELIMITER = /^[>\s]*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;

/** Whether the line contains a `|` that is not escaped. */
function hasUnescapedPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === PIPE) return true;
    if (code === BACKSLASH) i += 1;
  }
  return false;
}

/**
 * Split a table line into cells exactly as lezer's GFM parser counts them:
 * boundaries are unescaped `|`, surrounding spaces/tabs are dropped, and
 * backslashes are left in the text.
 *
 * Unlike lezer (which emits no node for an empty cell), we keep empty cells so
 * column positions survive; an all-empty header line still yields its columns.
 */
function splitCells(line: string): string[] {
  const cells: string[] = [];
  let first = true;
  let cellStart = -1;
  let cellEnd = -1;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === PIPE && !escaped) {
      if (!first || cellStart > -1) {
        cells.push(cellStart > -1 ? line.slice(cellStart, cellEnd) : "");
      }
      first = false;
      cellStart = cellEnd = -1;
    } else if (escaped || (code !== SPACE && code !== TAB)) {
      if (cellStart < 0) cellStart = i;
      cellEnd = i + 1;
    }
    escaped = !escaped && code === BACKSLASH;
  }
  if (cellStart > -1) cells.push(line.slice(cellStart, cellEnd));
  return cells;
}

function alignmentOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return "none";
}

function normalise(cells: string[], length: number): string[] {
  const out = cells.slice(0, length);
  while (out.length < length) out.push("");
  return out;
}

/**
 * Parse a Markdown table block, or `null` when it is not one.
 *
 * A table needs a first line containing a pipe, a second line matching the GFM
 * delimiter row with the **same cell count**, and then any number of body rows
 * (ragged rows are padded to the header length).
 */
export function parseTable(text: string): TableModel | null {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 2) return null;

  const [headerLine, delimiterLine] = lines;
  if (!hasUnescapedPipe(headerLine)) return null;
  if (!DELIMITER.test(delimiterLine)) return null;

  const header = splitCells(headerLine);
  const delimiter = splitCells(delimiterLine);
  if (header.length === 0 || header.length !== delimiter.length) return null;

  const alignments = delimiter.map(alignmentOf);
  const rows = lines
    .slice(2)
    .map((line) => normalise(splitCells(line), header.length));
  return { alignments, header, rows };
}

// -- display width -----------------------------------------------------------

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const COMBINING = /[\p{Mn}\p{Me}]/u;
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xfe0e, 0xfe0f]);

/** Split text into user-perceived grapheme clusters. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** Code points that occupy two monospace columns (wide/fullwidth/emoji). */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f1e6 && code <= 0x1f1ff) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** The monospace width of one grapheme cluster. */
export function clusterWidth(cluster: string): number {
  let width = 0;
  let sawBase = false;
  for (const char of cluster) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (ZERO_WIDTH.has(code) || COMBINING.test(char)) continue;
    sawBase = true;
    width = Math.max(width, isWide(code) ? 2 : 1);
  }
  if (!sawBase) return 0;
  // A variation selector promotes a narrow base to emoji presentation.
  if (cluster.includes("\u{fe0f}") && width < 2) return 2;
  return width;
}

/** The number of monospace columns `text` occupies. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const cluster of graphemes(text)) width += clusterWidth(cluster);
  return width;
}

// -- serializer --------------------------------------------------------------

const MIN_COLUMN_WIDTH = 3;

function columnWidths(model: TableModel): number[] {
  return model.header.map((cell, column) => {
    let width = displayWidth(cell);
    for (const row of model.rows) width = Math.max(width, displayWidth(row[column] ?? ""));
    return Math.max(MIN_COLUMN_WIDTH, width);
  });
}

function pad(text: string, width: number, align: Align): string {
  const extra = width - displayWidth(text);
  if (extra <= 0) return text;
  if (align === "right") return " ".repeat(extra) + text;
  if (align === "center") {
    const left = Math.floor(extra / 2);
    return " ".repeat(left) + text + " ".repeat(extra - left);
  }
  return text + " ".repeat(extra);
}

function delimiterCell(align: Align, width: number): string {
  switch (align) {
    case "left":
      return `:${"-".repeat(width - 1)}`;
    case "right":
      return `${"-".repeat(width - 1)}:`;
    case "center":
      return `:${"-".repeat(width - 2)}:`;
    default:
      return "-".repeat(width);
  }
}

/**
 * Render a model back to GFM source. Cells are padded by display width (never
 * below 3) so columns line up in a monospace font; the output re-parses to the
 * same model.
 */
export function serializeTable(model: TableModel): string {
  const columns = model.header.length;
  const widths = columnWidths(model);
  const row = (cells: string[]): string =>
    `| ${normalise(cells, columns)
      .map((cell, column) => pad(cell, widths[column], model.alignments[column] ?? "none"))
      .join(" | ")} |`;

  const lines = [row(model.header)];
  lines.push(
    `| ${widths
      .map((width, column) => delimiterCell(model.alignments[column] ?? "none", width))
      .join(" | ")} |`,
  );
  for (const body of model.rows) lines.push(row(body));
  return `${lines.join("\n")}\n`;
}

// -- transforms --------------------------------------------------------------

function insertAt<T>(items: T[], index: number, value: T): T[] {
  const next = items.slice();
  next.splice(index, 0, value);
  return next;
}

function clamp(index: number | undefined, length: number, fallback: number): number {
  if (index === undefined) return fallback;
  return Math.max(0, Math.min(index, length));
}

/** Insert an empty body row at `index` (default: the end). */
export function addRow(model: TableModel, index?: number): TableModel {
  const at = clamp(index, model.rows.length, model.rows.length);
  return { ...model, rows: insertAt(model.rows, at, model.header.map(() => "")) };
}

/** Delete a body row by index; out-of-range is a no-op. The header is never a row. */
export function deleteRow(model: TableModel, index: number): TableModel {
  if (index < 0 || index >= model.rows.length) return model;
  const rows = model.rows.slice();
  rows.splice(index, 1);
  return { ...model, rows };
}

/** Insert an empty column at `index` (default: the end). */
export function addColumn(model: TableModel, index?: number): TableModel {
  const at = clamp(index, model.header.length, model.header.length);
  return {
    alignments: insertAt(model.alignments, at, "none"),
    header: insertAt(model.header, at, ""),
    rows: model.rows.map((row) => insertAt(row, at, "")),
  };
}

/** Delete a column by index; never removes the last column. */
export function deleteColumn(model: TableModel, index: number): TableModel {
  if (model.header.length <= 1) return model;
  if (index < 0 || index >= model.header.length) return model;
  const drop = <T>(items: T[]): T[] => items.filter((_, i) => i !== index);
  return {
    alignments: drop(model.alignments),
    header: drop(model.header),
    rows: model.rows.map(drop),
  };
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Move a body row; out-of-range is a no-op. */
export function moveRow(model: TableModel, from: number, to: number): TableModel {
  const max = model.rows.length - 1;
  if (from < 0 || from > max || to < 0 || to > max || from === to) return model;
  return { ...model, rows: moveItem(model.rows, from, to) };
}

/** Move a column; out-of-range is a no-op. */
export function moveColumn(model: TableModel, from: number, to: number): TableModel {
  const max = model.header.length - 1;
  if (from < 0 || from > max || to < 0 || to > max || from === to) return model;
  return {
    alignments: moveItem(model.alignments, from, to),
    header: moveItem(model.header, from, to),
    rows: model.rows.map((row) => moveItem(row, from, to)),
  };
}

/** Set a column's alignment; out-of-range is a no-op. */
export function setAlignment(model: TableModel, column: number, align: Align): TableModel {
  if (column < 0 || column >= model.header.length) return model;
  const alignments = model.alignments.slice();
  alignments[column] = align;
  return { ...model, alignments };
}

/** A blank table with `columns` columns and `rows` body rows. */
export function generateTable(columns: number, rows: number): TableModel {
  const cols = Math.max(1, Math.floor(columns));
  const body = Math.max(0, Math.floor(rows));
  return {
    alignments: Array.from({ length: cols }, () => "none" as Align),
    header: Array.from({ length: cols }, () => ""),
    rows: Array.from({ length: body }, () => Array.from({ length: cols }, () => "")),
  };
}
