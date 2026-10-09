import { test } from "node:test";
import assert from "node:assert/strict";
import { markdown } from "@codemirror/lang-markdown";
import { history, indentWithTab, undo } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { GFM } from "@lezer/markdown";

import {
  buildTableKeymap,
  enterRow,
  getTableAtCursor,
  insertRowBelow,
  nextCell,
  prevCell,
} from "./tableEditing.ts";
import { resolveKeybinds } from "../keybindings.ts";

/** A state with the same language/history stack the editor uses. */
function state(doc: string, anchor: number): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ extensions: [GFM] }), history()],
  });
}

/** The minimal `{ state, dispatch }` shape CodeMirror commands rely on. */
function agent(initial: EditorState) {
  const host = {
    _state: initial,
    get state() {
      return host._state;
    },
    dispatch(spec: Transaction | object) {
      host._state =
        spec instanceof Transaction
          ? spec.state
          : host._state.update(spec as never).state;
    },
  };
  return host;
}

const TABLE = "| a | b |\n| --- | --- |\n| c | d |\n";
// Offsets within TABLE: "a"=2, "b"=6, "c"=26, "d"=30, delimiter=12.

// -- detection ---------------------------------------------------------------

test("getTableAtCursor finds the header and body cells", () => {
  const header = getTableAtCursor(state(TABLE, 6));
  assert.equal(header?.row, -1);
  assert.equal(header?.col, 1);

  const body = getTableAtCursor(state(TABLE, 30));
  assert.equal(body?.row, 0);
  assert.equal(body?.col, 1);

  assert.equal(getTableAtCursor(state("plain text\n", 3)), null);
});

test("getTableAtCursor locates a cursor in an empty cell", () => {
  const doc = "| a | | c |\n| --- | --- | --- |\n| x | y | z |\n";
  const ctx = getTableAtCursor(state(doc, 5));
  assert.equal(ctx?.row, -1);
  assert.equal(ctx?.col, 1);
  assert.equal(ctx?.cellText, "");
});

test("the delimiter row is treated as the header", () => {
  const ctx = getTableAtCursor(state(TABLE, 12));
  assert.equal(ctx?.row, -1);
});

test("tables in blockquotes and list items are not editable", () => {
  const quote = "> | a | b |\n> | --- | --- |\n> | c | d |\n";
  const list = "- | a | b |\n  | --- | --- |\n  | c | d |\n";
  assert.equal(getTableAtCursor(state(quote, 6)), null);
  assert.equal(getTableAtCursor(state(list, 6)), null);

  const quoteView = agent(state(quote, 6));
  assert.equal(nextCell(quoteView), false);
  assert.equal(insertRowBelow(quoteView), false);
  assert.equal(quoteView.state.doc.toString(), quote);
});

// -- navigation --------------------------------------------------------------

test("Tab moves to the next cell and skips the delimiter row", () => {
  const forward = agent(state(TABLE, 2));
  assert.equal(nextCell(forward), true);
  assert.equal(forward.state.selection.main.head, 6);

  // From the header's last cell, the next cell is body row 0 col 0.
  const skip = agent(state(TABLE, 6));
  assert.equal(nextCell(skip), true);
  assert.equal(skip.state.selection.main.head, 26);

  // From the delimiter row's last cell, Tab also lands in body row 0 col 0.
  const delimiter = agent(state(TABLE, 20));
  assert.equal(nextCell(delimiter), true);
  assert.equal(delimiter.state.selection.main.head, 26);
});

test("Tab past the last cell appends a row and lands in its first cell", () => {
  const view = agent(state(TABLE, 30)); // last body cell
  assert.equal(nextCell(view), true);
  const lines = view.state.doc.toString().split("\n").filter(Boolean);
  assert.equal(lines.length, 4);
  const ctx = getTableAtCursor(view.state);
  assert.equal(ctx?.row, 1);
  assert.equal(ctx?.col, 0);
});

test("Shift-Tab moves back and stays put in the first cell", () => {
  const back = agent(state(TABLE, 6));
  assert.equal(prevCell(back), true);
  assert.equal(back.state.selection.main.head, 2);

  const first = agent(state(TABLE, 2));
  assert.equal(prevCell(first), true);
  assert.equal(first.state.selection.main.head, 2);
});

// -- Enter -------------------------------------------------------------------

test("Enter on a non-empty last row appends a row", () => {
  const view = agent(state(TABLE, 30)); // last body cell "d"
  assert.equal(enterRow(view), true);
  const lines = view.state.doc.toString().split("\n").filter(Boolean);
  assert.equal(lines.length, 4);
  const ctx = getTableAtCursor(view.state);
  assert.equal(ctx?.row, 1);
  assert.equal(ctx?.col, 1);
});

test("Enter on an empty last row leaves the table and adds a blank line", () => {
  const doc = "| a | b |\n| --- | --- |\n|  |  |\n";
  const view = agent(state(doc, 26)); // the empty body row
  assert.equal(enterRow(view), true);
  const text = view.state.doc.toString();
  // The row is gone; the line after the table is blank and holds the cursor.
  assert.equal(text, "| a   | b   |\n| --- | --- |\n\n");
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head);
  assert.equal(cursorLine.text, "");
  assert.ok(
    view.state.doc.line(cursorLine.number - 1).text.startsWith("| ---"),
    "cursor is on the blank line right after the table",
  );
});

// -- structural edits & undo -------------------------------------------------

test("one Ctrl+Z reverts exactly one structural edit", () => {
  const view = agent(state(TABLE, 30));
  const before = view.state.doc.toString();
  assert.equal(insertRowBelow(view), true);
  assert.notEqual(view.state.doc.toString(), before);
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), before);
});

// -- keymap composition ------------------------------------------------------

test("outside a table the Tab binding falls through to indentation", () => {
  const view = agent(state("hello\n", 0));
  assert.equal(nextCell(view), false); // the table handler declines
  const binding = buildTableKeymap(resolveKeybinds({})).find(
    (entry) => entry.key === "Tab",
  );
  assert.ok(binding?.run);
  assert.equal(indentWithTab.run?.(view), true); // the default still indents
  assert.equal(view.state.doc.toString(), "  hello\n");
});
