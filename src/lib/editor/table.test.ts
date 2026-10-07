import { test } from "node:test";
import assert from "node:assert/strict";
import { GFM, parser } from "@lezer/markdown";

import {
  addColumn,
  addRow,
  clusterWidth,
  deleteColumn,
  deleteRow,
  displayWidth,
  generateTable,
  graphemes,
  moveColumn,
  moveRow,
  parseTable,
  serializeTable,
  setAlignment,
  type TableModel,
} from "./table.ts";

const md = parser.configure([GFM]);

/** The cell texts lezer's GFM parser produces for a block, in document order. */
function lezerCells(text: string): string[] {
  const tree = md.parse(text);
  const out: string[] = [];
  tree.iterate({
    enter(node) {
      if (node.name === "TableCell") out.push(text.slice(node.from, node.to));
    },
  });
  return out;
}

/** Our cells, flattened header-then-rows, for the same comparison. */
function modelCells(model: TableModel): string[] {
  return [...model.header, ...model.rows.flat()];
}

// -- parsing -----------------------------------------------------------------

test("a simple table parses into header + rows", () => {
  const model = parseTable("| a | b |\n| --- | --- |\n| c | d |\n");
  assert.deepEqual(model, {
    alignments: ["none", "none"],
    header: ["a", "b"],
    rows: [["c", "d"]],
  });
});

test("a non-table returns null", () => {
  assert.equal(parseTable("just a paragraph"), null);
  assert.equal(parseTable("| a | b |\nnot a delimiter\n"), null);
  // Header/delimiter cell-count mismatch is not a table (mirrors lezer).
  assert.equal(parseTable("| a | b |\n| --- |\n"), null);
});

test("alignment colons are read from the delimiter row", () => {
  const model = parseTable("| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n");
  assert.deepEqual(model?.alignments, ["left", "center", "right"]);
});

test("ragged rows are normalised to the header length", () => {
  const model = parseTable("| a | b |\n| --- | --- |\n| x |\n| x | y | z |\n");
  assert.deepEqual(model?.rows, [
    ["x", ""],
    ["x", "y"],
  ]);
});

test("empty cells are preserved so columns keep their positions", () => {
  const model = parseTable("|  |  |\n| --- | --- |\n|  | x |\n");
  assert.deepEqual(model?.header, ["", ""]);
  assert.deepEqual(model?.rows, [["", "x"]]);
});

test("cell text is kept raw: escaped pipes are not unescaped", () => {
  const model = parseTable("| a \\| b | c |\n| --- | --- |\n");
  assert.deepEqual(model?.header, ["a \\| b", "c"]);
});

test("an escaped backslash is not an escape for the following pipe", () => {
  // `\\|` is a literal backslash then a real separator.
  const model = parseTable("| a \\\\| b |\n| --- | --- |\n");
  assert.deepEqual(model?.header, ["a \\\\", "b"]);
});

test("a pipe inside backticks still splits (GFM requires \\|)", () => {
  const model = parseTable("| `a|b` | c | d |\n| --- | --- | --- | --- |\n");
  assert.deepEqual(model?.header, ["`a", "b`", "c", "d"]);
});

// -- parity with @lezer/markdown --------------------------------------------

test("our cell splitting matches @lezer/markdown on every sample", () => {
  const samples = [
    "| a | b |\n| --- | --- |\n| c | d |\n",
    "| a \\| b | c |\n| --- | --- |\n| \\| | d |\n",
    "| a \\\\| b |\n| --- | --- |\n",
    "| `a|b` | c | d |\n| --- | --- | --- | --- |\n| `x|y` | z | w |\n",
    "a | b\n--- | ---\nc | d\n",
    "| a | b |\n| --- | --- |\n| c | d |\n| e | f |\n",
  ];
  for (const text of samples) {
    const model = parseTable(text);
    assert.ok(model, `expected a table for ${JSON.stringify(text)}`);
    assert.deepEqual(
      modelCells(model),
      lezerCells(text),
      `cell mismatch for ${JSON.stringify(text)}`,
    );
  }
});

// -- widths ------------------------------------------------------------------

test("displayWidth counts grapheme clusters, not code units", () => {
  assert.equal(displayWidth("abc"), 3);
  // Precomposed vs decomposed accent are both one visible column.
  assert.equal(displayWidth("ʃáɾa"), 4);
  assert.equal(displayWidth("ã̠"), 1);
  // Widened scripts count as two columns.
  assert.equal(displayWidth("你好"), 4);
  assert.equal(displayWidth("日本語"), 6);
  // Emoji sequences are one wide cluster.
  assert.equal(displayWidth("👨‍👩‍👧"), 2);
  assert.equal(displayWidth("🇯🇵"), 2);
});

test("graphemes returns user-perceived clusters", () => {
  assert.deepEqual(graphemes("a\u{0301}b"), ["a\u{0301}", "b"]);
  assert.deepEqual(graphemes("👨‍👩‍👧x"), ["👨‍👩‍👧", "x"]);
  assert.deepEqual(graphemes(""), []);
});

test("clusterWidth classifies combining, wide and emoji clusters", () => {
  assert.equal(clusterWidth("a"), 1);
  assert.equal(clusterWidth("\u{0301}"), 0); // lone combining mark
  assert.equal(clusterWidth("あ"), 2);
  assert.equal(clusterWidth("👨‍👩‍👧"), 2);
  assert.equal(clusterWidth("\u{200d}"), 0); // ZWJ alone
});

// -- serializer --------------------------------------------------------------

test("serialize pads columns to the widest cell, minimum 3", () => {
  const model: TableModel = {
    alignments: ["left", "right"],
    header: ["a", "bb"],
    rows: [["ccccc", "d"]],
  };
  const text = serializeTable(model);
  const lines = text.split("\n");
  assert.equal(lines[0], "| a     |  bb |");
  assert.equal(lines[1], "| :---- | --: |");
  assert.equal(lines[2], "| ccccc |   d |");
});

test("serialize round-trips through parse, and is idempotent", () => {
  const model = parseTable(
    "| name | value | note |\n| :-- | :-: | --: |\n| ʃáɾa | 1 | x |\n| k͡p | yes |  |\n",
  );
  assert.ok(model);
  assert.deepEqual(parseTable(serializeTable(model)), model);
  assert.equal(
    serializeTable(parseTable(serializeTable(model))!),
    serializeTable(model),
  );
});

test("serialize emits a blank minimum-width table for an empty model", () => {
  const model: TableModel = { alignments: ["none"], header: [""], rows: [] };
  assert.equal(serializeTable(model), "|     |\n| --- |\n");
});

// -- transforms --------------------------------------------------------------

test("addRow/deleteRow operate on body rows and never remove the header", () => {
  const base = parseTable("| a |\n| --- |\n| x |\n")!;
  assert.deepEqual(addRow(base, 1).rows, [["x"], [""]]);
  assert.deepEqual(addRow(base).rows, [["x"], [""]]);
  assert.deepEqual(deleteRow(base, 0).rows, []);
  // The header is never a row, and out-of-range is a no-op.
  assert.deepEqual(deleteRow(base, 0).header, ["a"]);
  assert.deepEqual(deleteRow(base, 99), base);
});

test("addColumn/deleteColumn and the last-column guard", () => {
  const base = parseTable("| a | b |\n| --- | --- |\n| x | y |\n")!;
  const added = addColumn(base, 1);
  assert.deepEqual(added.header, ["a", "", "b"]);
  assert.deepEqual(added.alignments, ["none", "none", "none"]);
  assert.deepEqual(added.rows, [["x", "", "y"]]);
  assert.deepEqual(deleteColumn(added, 1), base);

  const single: TableModel = { alignments: ["none"], header: ["a"], rows: [["x"]] };
  assert.deepEqual(deleteColumn(single, 0), single);
});

test("moveRow and moveColumn reorder immutably", () => {
  const base = parseTable("| a | b |\n| --- | --- |\n| x | 1 |\n| y | 2 |\n")!;
  assert.deepEqual(moveRow(base, 0, 1).rows, [["y", "2"], ["x", "1"]]);
  const moved = moveColumn(base, 0, 1);
  assert.deepEqual(moved.header, ["b", "a"]);
  assert.deepEqual(moved.rows, [["1", "x"], ["2", "y"]]);
  // No mutation of the input.
  assert.deepEqual(base.header, ["a", "b"]);
});

test("setAlignment ignores out-of-range columns", () => {
  const base = parseTable("| a | b |\n| --- | --- |\n")!;
  assert.deepEqual(setAlignment(base, 1, "center").alignments, ["none", "center"]);
  assert.deepEqual(setAlignment(base, 9, "right").alignments, ["none", "none"]);
});

test("generateTable builds a blank table with the requested shape", () => {
  const model = generateTable(2, 1);
  assert.deepEqual(model.header, ["", ""]);
  assert.deepEqual(model.rows, [["", ""]]);
  assert.deepEqual(parseTable(serializeTable(model)), model);
});
