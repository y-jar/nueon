import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { deleteBracketPair, insertBracket } from "@codemirror/autocomplete";

import { bracketAutoClose } from "./brackets.ts";

function state(doc: string, anchor: number) {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [bracketAutoClose()],
  });
}

function run(source: EditorState, command: (view: unknown) => boolean): EditorState {
  let current = source;
  command({
    get state() {
      return current;
    },
    dispatch(tr: { state: EditorState }) {
      current = tr.state;
    },
  });
  return current;
}

test("typing ( [ { inserts the closing character and sits between", () => {
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ]) {
    const start = state("", 0);
    const transaction = insertBracket(start, open);
    assert.ok(transaction, `expected ${open} to auto-close`);
    const next = transaction.state;
    assert.equal(next.doc.toString(), open + close);
    assert.equal(next.selection.main.head, 1);
  }
});

test("typing the closing character over it skips instead of doubling", () => {
  // Build the pair through the extension so the closing bracket is tracked.
  const opened = insertBracket(state("", 0), "(");
  assert.ok(opened);
  assert.equal(opened.state.doc.toString(), "()");
  const skipped = insertBracket(opened.state, ")");
  assert.ok(skipped);
  assert.equal(skipped.state.doc.toString(), "()");
  assert.equal(skipped.state.selection.main.head, 2);
});

test("Backspace on an empty pair deletes both characters", () => {
  const start = state("()", 1);
  const next = run(start, deleteBracketPair as (view: unknown) => boolean);
  assert.equal(next.doc.toString(), "");
});

test("apostrophes and quotes do not auto-close", () => {
  for (const quote of ["'", '"']) {
    assert.equal(insertBracket(state("", 0), quote), null);
    // The editor's normal insertion path then adds exactly one character.
    const start = state("", 0);
    assert.equal(
      start.update(start.replaceSelection(quote)).state.doc.toString(),
      quote,
    );
  }
});

test("typing [[ produces [[]]", () => {
  const one = insertBracket(state("", 0), "[");
  assert.ok(one);
  assert.equal(one.state.doc.toString(), "[]");
  const two = insertBracket(one.state, "[");
  assert.ok(two);
  assert.equal(two.state.doc.toString(), "[[]]");
  assert.equal(two.state.selection.main.head, 2);
});
