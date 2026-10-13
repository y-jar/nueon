import { test } from "node:test";
import assert from "node:assert/strict";

import { deleteGlyphs, dependents, moveToGroup, toggleSelected } from "./writingBatch.ts";
import type { GlyphMeta } from "./api.ts";

const glyph = (id: string, order: number, group = ""): GlyphMeta => ({
  id,
  name: id,
  codepoint: 0xe000 + order,
  phonemes: [],
  order,
  group,
});

test("toggleSelected adds then removes an id", () => {
  assert.deepEqual(toggleSelected([], "a"), ["a"]);
  assert.deepEqual(toggleSelected(["a", "b"], "a"), ["b"]);
});

test("deleteGlyphs removes the selection and renumbers the order", () => {
  const result = deleteGlyphs([glyph("a", 0), glyph("b", 1), glyph("c", 2)], ["b"]);
  assert.deepEqual(result.map((g) => [g.id, g.order]), [["a", 0], ["c", 1]]);
});

test("moveToGroup only touches the selected glyphs", () => {
  const result = moveToGroup([glyph("a", 0, "x"), glyph("b", 1, "x")], ["b"], " radicals ");
  assert.equal(result[0].group, "x");
  assert.equal(result[1].group, "radicals");
});

test("dependents lists glyphs that reference a deleted component", () => {
  const outlines = {
    a: { elements: [{ kind: "contour" }] },
    b: { elements: [{ kind: "component", glyph: "a" }] },
    c: { elements: [{ kind: "component", glyph: "z" }] },
  };
  assert.deepEqual(dependents(outlines, ["a"]), ["b"]);
  assert.deepEqual(dependents(outlines, ["b"]), []);
});
