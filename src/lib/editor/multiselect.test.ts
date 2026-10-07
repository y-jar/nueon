import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSelection, EditorState } from "@codemirror/state";

import { multiSelect } from "./multiselect.ts";

function cursors(doc: string, ...positions: number[]): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(
      positions.map((position) => EditorSelection.cursor(position)),
    ),
    extensions: [multiSelect()],
  });
}

test("multiple selections are enabled", () => {
  assert.equal(cursors("ab", 0, 2).selection.ranges.length, 2);
});

test("typing inserts at every cursor", () => {
  const start = cursors("ab", 0, 2);
  const next = start.update(start.replaceSelection("X")).state;
  assert.equal(next.doc.toString(), "XabX");
  assert.equal(next.selection.ranges.length, 2);
});

test("without the extension CodeMirror collapses to one selection", () => {
  const without = EditorState.create({
    doc: "ab",
    selection: EditorSelection.create([
      EditorSelection.cursor(0),
      EditorSelection.cursor(2),
    ]),
  });
  assert.equal(without.selection.ranges.length, 1);
});
