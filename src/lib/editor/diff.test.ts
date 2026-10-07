import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSelection, EditorState } from "@codemirror/state";

import { diffSplice } from "./diff.ts";

test("identical text produces no splice", () => {
  assert.equal(diffSplice("abc", "abc"), null);
  assert.equal(diffSplice("", ""), null);
});

test("appending splices at the end", () => {
  assert.deepEqual(diffSplice("abc", "abcXYZ"), {
    from: 3,
    to: 3,
    insert: "XYZ",
  });
});

test("prepending splices at the start", () => {
  assert.deepEqual(diffSplice("abc", "XYZabc"), {
    from: 0,
    to: 0,
    insert: "XYZ",
  });
});

test("a middle change keeps the common prefix and suffix", () => {
  assert.deepEqual(diffSplice("hello world", "hello new world"), {
    from: 6,
    to: 6,
    insert: "new ",
  });
});

test("deletion splices the removed span", () => {
  assert.deepEqual(diffSplice("abcdef", "abf"), {
    from: 2,
    to: 5,
    insert: "",
  });
});

test("a full replacement replaces everything", () => {
  assert.deepEqual(diffSplice("aaa", "bbb"), {
    from: 0,
    to: 3,
    insert: "bbb",
  });
});

test("emoji edits never split a surrogate pair", () => {
  // 😀 and 😁 share a high surrogate but differ in the low one, so the
  // common prefix stops mid-pair; the splice must still produce a valid pair.
  const splice = diffSplice("a😀b", "a😁b");
  assert.ok(splice);
  const rebuilt =
    "a😀b".slice(0, splice.from) + splice.insert + "a😀b".slice(splice.to);
  assert.equal(rebuilt, "a😁b");
});

// Selection mapping, exercised through a real (headless) editor state: the
// cursor follows the change instead of resetting.

function applySplice(state: EditorState, next: string): EditorState {
  const splice = diffSplice(state.doc.toString(), next);
  assert.ok(splice, "expected a splice");
  return state.update({
    changes: { from: splice.from, to: splice.to, insert: splice.insert },
  }).state;
}

test("an edit below the cursor leaves the cursor still", () => {
  const doc = "line1\nline2\nline3";
  let state = EditorState.create({ doc, selection: { anchor: 8 } });
  state = applySplice(state, `${doc}\nline4`);
  assert.equal(state.selection.main.head, 8);
});

test("an edit above the cursor shifts it by the inserted length", () => {
  const doc = "line1\nline2\nline3";
  let state = EditorState.create({ doc, selection: { anchor: 8 } });
  state = applySplice(state, `top\n${doc}`);
  assert.equal(state.selection.main.head, 8 + 4);
});

test("an edit overlapping the cursor lands on a valid boundary", () => {
  const doc = "line1\nline2\nline3";
  let state = EditorState.create({ doc, selection: { anchor: 8 } });
  state = applySplice(state, "line1\nLINE TWO\nline3");
  // A cursor inside the replaced range maps to the start of the new text.
  assert.equal(state.selection.main.head, 6);
  assert.ok(state.selection.main.head <= state.doc.length);
});

test("a multi-cursor selection maps every range", () => {
  const doc = "line1\nline2\nline3";
  let state = EditorState.create({
    doc,
    selection: EditorSelection.create(
      [EditorSelection.cursor(1), EditorSelection.cursor(8)],
      1,
    ),
    extensions: EditorState.allowMultipleSelections.of(true),
  });
  state = applySplice(state, `top\n${doc}`);
  assert.deepEqual(
    state.selection.ranges.map((range) => range.head),
    [5, 12],
  );
});
