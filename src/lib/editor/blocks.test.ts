import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { WidgetType } from "@codemirror/view";

import {
  codeLines,
  makeBlockField,
  scanBlocks,
  type BlockRange,
} from "./blocks.ts";

const md = (...lines: string[]) => `${lines.join("\n")}\n`;

function kinds(ranges: BlockRange[]): string[] {
  return ranges.map((range) => range.kind);
}

class FakeWidget extends WidgetType {}

function fielded(doc: string, anchor = 0) {
  const field = makeBlockField(() => new FakeWidget());
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [field],
  });
  return { field, state };
}

// -- detection rules (ported verbatim) ---------------------------------------

test("a multi-line table scans as one table block", () => {
  const doc = md("| a | b |", "| --- | --- |", "| c | d |");
  const ranges = scanBlocks(EditorState.create({ doc }));
  assert.deepEqual(ranges, [{ kind: "table", from: 0, to: doc.trimEnd().length }]);
});

test("a multi-line $$ block scans as one math block", () => {
  const ranges = scanBlocks(EditorState.create({ doc: md("$$", "x^2", "$$") }));
  assert.deepEqual(kinds(ranges), ["math"]);
});

test("a multi-line HTML block scans as one html block", () => {
  const ranges = scanBlocks(
    EditorState.create({ doc: md("<div>", "hello", "</div>") }),
  );
  assert.deepEqual(kinds(ranges), ["html"]);
});

test("single-line math and HTML stay in the plugin", () => {
  const math = EditorState.create({ doc: md("$$ x $$") });
  const html = EditorState.create({ doc: md("<div>x</div>") });
  assert.deepEqual(scanBlocks(math), []);
  assert.deepEqual(scanBlocks(html), []);
});

test("an unclosed $$ block is not a block", () => {
  const ranges = scanBlocks(EditorState.create({ doc: md("$$", "x^2") }));
  assert.deepEqual(ranges, []);
});

// -- fences and indented code ------------------------------------------------

test("a table inside a ``` fence stays plain", () => {
  const doc = md("```", "| a | b |", "| --- | --- |", "```");
  assert.deepEqual(scanBlocks(EditorState.create({ doc })), []);
});

test("a $$ block inside a ~~~ fence stays plain", () => {
  const doc = md("~~~", "$$", "x^2", "$$", "~~~");
  assert.deepEqual(scanBlocks(EditorState.create({ doc })), []);
});

test("an HTML block in indented code stays plain", () => {
  const doc = md("    <div>", "    hello", "    </div>");
  assert.deepEqual(scanBlocks(EditorState.create({ doc })), []);
});

test("blocks re-render right after a closed fence", () => {
  const doc = md("```", "code", "```", "| a | b |", "| --- | --- |");
  assert.deepEqual(kinds(scanBlocks(EditorState.create({ doc }))), ["table"]);
});

test("an unclosed fence hides everything after it", () => {
  const doc = md("```", "| a | b |", "| --- | --- |");
  const state = EditorState.create({ doc });
  assert.deepEqual(scanBlocks(state), []);
  // The unclosed fence runs through the trailing empty line to EOF.
  assert.deepEqual([...codeLines(state)], [1, 2, 3, 4]);
});

// -- field: selection reveals raw text, and reused within a block ------------

for (const [name, doc, inside, deeper] of [
  [
    "table",
    md("para", "", "| a | b |", "| --- | --- |", "| c | d |"),
    "| a | b |",
    "| c | d |",
  ],
  ["math", md("para", "", "$$", "x^2", "$$"), "$$", "x^2"],
  ["html", md("para", "", "<div>", "hello", "</div>"), "<div>", "hello"],
] as const) {
  test(`${name}: entering reveals raw text; moving inside reuses the value`, () => {
    const { field, state } = fielded(doc, 1); // cursor on "para", outside
    const outside = state.field(field);
    assert.equal(outside.ranges.length, 1);
    assert.equal(outside.activeFlags[0], false);
    assert.equal(outside.decorations.size, 1);

    const insideOffset = doc.indexOf(inside) + 1;
    const entered = state.update({ selection: { anchor: insideOffset } }).state;
    const active = entered.field(field);
    assert.notEqual(active, outside);
    assert.equal(active.activeFlags[0], true);
    assert.equal(active.decorations.size, 0);

    // Moving to another line of the SAME block must not rebuild the value.
    const deeperOffset = doc.indexOf(deeper) + 1;
    const moved = entered.update({ selection: { anchor: deeperOffset } }).state;
    assert.equal(moved.field(field), active);

    // Leaving re-renders the widget.
    const left = moved.update({ selection: { anchor: 1 } }).state;
    const restored = left.field(field);
    assert.notEqual(restored, active);
    assert.equal(restored.activeFlags[0], false);
    assert.equal(restored.decorations.size, 1);
  });
}

// -- performance -------------------------------------------------------------

test("scanning a few thousand lines stays well under the ceiling", () => {
  const lines: string[] = [];
  for (let i = 0; i < 3000; i += 1) {
    if (i % 100 === 0) lines.push("| a | b |", "| --- | --- |", "| c | d |");
    else if (i % 100 === 10) lines.push("$$", "x^2", "$$");
    else if (i % 100 === 20) lines.push("<div>", "hello", "</div>");
    else lines.push(`line ${i} with some ordinary words`);
  }
  const state = EditorState.create({ doc: `${lines.join("\n")}\n` });

  scanBlocks(state); // warm up
  const runs = 20;
  const started = performance.now();
  for (let i = 0; i < runs; i += 1) scanBlocks(state);
  const perScan = (performance.now() - started) / runs;
  console.log(`scanBlocks: ${state.doc.lines} lines, ${perScan.toFixed(2)} ms/scan`);
  assert.ok(perScan < 50, `scan took ${perScan.toFixed(2)} ms`);
});
