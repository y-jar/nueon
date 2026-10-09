/**
 * CodeMirror glue for editing GFM tables: cursor detection, Tab/Enter
 * navigation and structural commands. This is the only table file that knows
 * about CodeMirror; the model itself lives in `table.ts`.
 *
 * Cells are located by counting unescaped pipes on the line (the same rule as
 * `table.ts`), never by looking up `TableCell` nodes — lezer emits no node for
 * an empty cell, so node lookup would miss them.
 *
 * Tables nested in blockquotes or list items are deliberately not handled:
 * their line prefixes vary and a wrong guess corrupts the note, so
 * `getTableAtCursor` returns `null` and the raw text stays editable.
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { Command, EditorView, KeyBinding } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { TABLE_KEYBINDS } from "../keybindings.ts";
import {
  addColumn,
  addRow,
  cellIndexAt,
  cellRanges,
  deleteColumn as removeColumn,
  deleteRow as removeRow,
  moveColumn as reorderColumn,
  moveRow as reorderRow,
  parseTable,
  serializeTable,
  setAlignment,
  type Align,
  type TableModel,
} from "./table.ts";

/** The table under the cursor, with the cursor's position inside it. */
export interface TableContext {
  /** Start of the first table line (includes its leading spaces). */
  from: number;
  /** End of the last table line. */
  to: number;
  model: TableModel;
  /** `-1` for the header (and the delimiter row), `0…` for body rows. */
  row: number;
  col: number;
  /** Document offsets of the cursor's cell. */
  cellFrom: number;
  cellTo: number;
  cellText: string;
  /** Alignment of the cursor's column. */
  align: Align;
}

function treeOf(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length, 2000) ?? syntaxTree(state);
}

function tableNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = treeOf(state).resolveInner(pos, -1);
  while (node && node.name !== "Table") node = node.parent;
  return node;
}

/**
 * The table at the main cursor, or `null` when there is none — including
 * tables inside a blockquote or list item, which are left to raw editing.
 */
export function getTableAtCursor(state: EditorState): TableContext | null {
  const pos = state.selection.main.head;
  const node = tableNodeAt(state, pos);
  if (!node) return null;

  const first = state.doc.lineAt(node.from);
  const prefix = first.text.slice(0, node.from - first.from);
  if (!/^ {0,3}$/.test(prefix)) return null;

  const model = parseTable(state.doc.sliceString(node.from, node.to));
  if (!model) return null;

  const cursorLine = state.doc.lineAt(pos);
  let row: number;
  if (cursorLine.number <= first.number + 1) {
    row = -1; // header or delimiter row
  } else {
    row = cursorLine.number - first.number - 2;
  }
  row = Math.max(-1, Math.min(row, model.rows.length - 1));

  const cells = cellRanges(cursorLine.text);
  if (cells.length === 0) return null;
  const col = cellIndexAt(cursorLine.text, pos - cursorLine.from);
  const cell = cells[Math.min(col, cells.length - 1)];

  return {
    from: first.from,
    to: node.to,
    model,
    row,
    col,
    cellFrom: cursorLine.from + cell.from,
    cellTo: cursorLine.from + cell.to,
    cellText: cell.text,
    align: model.alignments[col] ?? "none",
  };
}

/** The leading spaces of the first table line (0–3, established by detection). */
function prefixOf(state: EditorState, ctx: TableContext): string {
  const first = state.doc.lineAt(ctx.from);
  return first.text.slice(0, ctx.from - first.from);
}

/** The document offset of cell (`row`, `col`) in the current document. */
function cellOffset(
  state: EditorState,
  ctx: TableContext,
  row: number,
  col: number,
): number {
  const first = state.doc.lineAt(ctx.from);
  const number = row < 0 ? first.number : first.number + row + 2;
  const line = state.doc.line(Math.min(number, state.doc.lines));
  const cells = cellRanges(line.text);
  const cell = cells[Math.min(col, cells.length - 1)] ?? cells[0];
  return line.from + (cell?.from ?? 0);
}

/** The offset of cell (`row`, `col`) within a serialized table block. */
function textCellOffset(text: string, row: number, col: number): number {
  const lines = text.split("\n");
  const index = Math.min(row < 0 ? 0 : row + 2, lines.length - 1);
  const cells = cellRanges(lines[index] ?? "");
  const cell = cells[Math.min(col, cells.length - 1)];
  let offset = cell?.from ?? 0;
  for (let i = 0; i < index; i++) offset += lines[i].length + 1;
  return offset;
}

function serializeWithPrefix(
  state: EditorState,
  ctx: TableContext,
  model: TableModel,
): string {
  const prefix = prefixOf(state, ctx);
  const body = serializeTable(model).replace(/\n$/, "");
  return body
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

/** Replace the table with `model` as ONE transaction, cursor in `target`. */
function dispatchModel(
  view: EditorView,
  ctx: TableContext,
  model: TableModel,
  target: { row: number; col: number },
): boolean {
  const text = serializeWithPrefix(view.state, ctx, model);
  if (view.state.doc.sliceString(ctx.from, ctx.to) === text) return true;
  const anchor = ctx.from + textCellOffset(text, target.row, target.col);
  view.dispatch({
    changes: { from: ctx.from, to: ctx.to, insert: text },
    selection: EditorSelection.cursor(anchor),
    scrollIntoView: true,
    userEvent: "input.table",
  });
  return true;
}

/** Parse → transform → serialize → one replace dispatch, cursor in a cell. */
function applyEdit(
  view: EditorView,
  edit: (model: TableModel) => TableModel,
  target: { row: number; col: number },
): boolean {
  const ctx = getTableAtCursor(view.state);
  if (!ctx) return false;
  const next = edit(ctx.model);
  if (next === ctx.model) return true;
  return dispatchModel(view, ctx, next, target);
}

/** Tab: the next cell; past the last cell of the last row, a new row. */
export const nextCell: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx) return false;
  const columns = ctx.model.header.length;
  const order = (ctx.row < 0 ? 0 : ctx.row + 1) * columns + ctx.col;
  const total = (ctx.model.rows.length + 1) * columns;
  if (order + 1 >= total) {
    const row = ctx.model.rows.length;
    return applyEdit(view, (model) => addRow(model), { row, col: 0 });
  }
  const nextOrder = order + 1;
  const row = Math.floor(nextOrder / columns) - 1;
  const col = nextOrder % columns;
  view.dispatch({
    selection: EditorSelection.cursor(cellOffset(view.state, ctx, row, col)),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};

/** Shift-Tab: the previous cell; stays put in the first cell. */
export const prevCell: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx) return false;
  const columns = ctx.model.header.length;
  const order = (ctx.row < 0 ? 0 : ctx.row + 1) * columns + ctx.col;
  if (order === 0) return true;
  const prevOrder = order - 1;
  const row = Math.floor(prevOrder / columns) - 1;
  const col = prevOrder % columns;
  view.dispatch({
    selection: EditorSelection.cursor(cellOffset(view.state, ctx, row, col)),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};

/**
 * Enter: a new body row below the cursor's. On a completely empty last body
 * row it instead removes that row and leaves a blank line after the table, so
 * a table at the end of a note never traps the cursor.
 */
export const enterRow: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx) return false;
  const last = ctx.model.rows.length - 1;
  const lastRow = ctx.model.rows[last];
  if (ctx.row === last && last >= 0 && lastRow.every((cell) => cell.trim() === "")) {
    const text = `${serializeWithPrefix(view.state, ctx, removeRow(ctx.model, last))}\n`;
    view.dispatch({
      changes: { from: ctx.from, to: ctx.to, insert: text },
      selection: EditorSelection.cursor(ctx.from + text.length),
      scrollIntoView: true,
      userEvent: "input.table",
    });
    return true;
  }
  const row = ctx.row < 0 ? 0 : ctx.row + 1;
  return applyEdit(view, (model) => addRow(model, row), { row, col: ctx.col });
};

export const insertRowAbove: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx) return false;
  const row = ctx.row < 0 ? 0 : ctx.row;
  return applyEdit(view, (model) => addRow(model, row), { row, col: ctx.col });
};

export const insertRowBelow: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx) return false;
  const row = ctx.row < 0 ? 0 : ctx.row + 1;
  return applyEdit(view, (model) => addRow(model, row), { row, col: ctx.col });
};

export const deleteTableRow: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx) return false;
  if (ctx.row < 0) return true; // the header is never a row
  const row = Math.max(0, Math.min(ctx.row, ctx.model.rows.length - 2));
  return applyEdit(view, (model) => removeRow(model, ctx.row), { row, col: ctx.col });
};

export const insertColumnLeft: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx) return false;
  return applyEdit(view, (model) => addColumn(model, ctx.col), {
    row: ctx.row,
    col: ctx.col,
  });
};

export const insertColumnRight: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx) return false;
  return applyEdit(view, (model) => addColumn(model, ctx.col + 1), {
    row: ctx.row,
    col: ctx.col + 1,
  });
};

export const deleteTableColumn: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx) return false;
  if (ctx.model.header.length <= 1) return true; // never remove the last column
  const col = Math.max(0, Math.min(ctx.col, ctx.model.header.length - 2));
  return applyEdit(view, (model) => removeColumn(model, ctx.col), {
    row: ctx.row,
    col,
  });
};

export const moveTableRowUp: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx || ctx.row <= 0) return ctx !== null;
  return applyEdit(view, (model) => reorderRow(model, ctx.row, ctx.row - 1), {
    row: ctx.row - 1,
    col: ctx.col,
  });
};

export const moveTableRowDown: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx || ctx.row < 0 || ctx.row >= ctx.model.rows.length - 1) return ctx !== null;
  return applyEdit(view, (model) => reorderRow(model, ctx.row, ctx.row + 1), {
    row: ctx.row + 1,
    col: ctx.col,
  });
};

export const moveTableColumnLeft: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx || ctx.col <= 0) return ctx !== null;
  return applyEdit(view, (model) => reorderColumn(model, ctx.col, ctx.col - 1), {
    row: ctx.row,
    col: ctx.col - 1,
  });
};

export const moveTableColumnRight: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx || ctx.col >= ctx.model.header.length - 1) return ctx !== null;
  return applyEdit(view, (model) => reorderColumn(model, ctx.col, ctx.col + 1), {
    row: ctx.row,
    col: ctx.col + 1,
  });
};

export function setColumnAlignment(align: Align): Command {
  return (view) => {
    const ctx = getTableAtCursor(view.state);
    if (!ctx) return false;
    return applyEdit(view, (model) => setAlignment(model, ctx.col, align), {
      row: ctx.row,
      col: ctx.col,
    });
  };
}

/** Re-serialize the table so its columns are padded consistently. */
export const formatTable: Command = (view) => {
  const ctx = getTableAtCursor(view.state);
  if (!ctx) return false;
  return dispatchModel(view, ctx, ctx.model, { row: ctx.row, col: ctx.col });
};

/** Every remappable table command, by id. */
export const TABLE_COMMANDS: Record<string, Command> = {
  "next-cell": nextCell,
  "prev-cell": prevCell,
  "next-row": enterRow,
};

/** Build the table keymap from resolved keys, placed before `indentWithTab`. */
export function buildTableKeymap(
  resolved: Record<string, string | null>,
): KeyBinding[] {
  const bindings: KeyBinding[] = [];
  for (const def of TABLE_KEYBINDS) {
    const key = resolved[def.id];
    if (!key) continue;
    bindings.push({ key, run: TABLE_COMMANDS[def.id], preventDefault: true });
  }
  return bindings;
}
