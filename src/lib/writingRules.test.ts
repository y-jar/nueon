import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addRule,
  describeRule,
  formatTargets,
  moveRule,
  parseTargets,
  removeRule,
  updateRule,
} from "./writingRules.ts";
import type { GlyphMeta, OrthographyRule } from "./api.ts";

const glyph = (id: string, name: string): GlyphMeta => ({
  id,
  name,
  codepoint: 0xe000,
  phonemes: [],
  order: 0,
  group: "",
});

const glyphs = [glyph("id-ka", "ka"), glyph("id-ta", "ta"), glyph("id-x", "ka")];

const rule = (from: string, to: string[] = []): OrthographyRule => ({ from, to });

test("parseTargets maps glyph names to ids and reports names it cannot find", () => {
  assert.deepEqual(parseTargets("ka, ta", glyphs), { ids: ["id-ka", "id-ta"], unknown: [] });
  assert.deepEqual(parseTargets("ka ta", glyphs), { ids: ["id-ka", "id-ta"], unknown: [] });
  assert.deepEqual(parseTargets("ka, nope, ta", glyphs), {
    ids: ["id-ka", "id-ta"],
    unknown: ["nope"],
  });
  assert.deepEqual(parseTargets("", glyphs), { ids: [], unknown: [] });
});

test("parseTargets accepts a raw glyph id and prefers the first of two equal names", () => {
  assert.deepEqual(parseTargets("id-x", glyphs).ids, ["id-x"]);
  assert.deepEqual(parseTargets("ka", glyphs).ids, ["id-ka"]);
});

test("formatTargets shows names, and falls back to the id for a deleted glyph", () => {
  assert.equal(formatTargets(["id-ka", "id-ta"], glyphs), "ka, ta");
  assert.equal(formatTargets(["gone"], glyphs), "gone");
  assert.equal(formatTargets([], glyphs), "");
});

test("formatTargets then parseTargets round-trips known glyphs", () => {
  const ids = ["id-ta", "id-ka"];
  assert.deepEqual(parseTargets(formatTargets(ids, glyphs), glyphs).ids, ids);
});

test("addRule, updateRule and removeRule are immutable", () => {
  const start: OrthographyRule[] = [rule("a")];
  const added = addRule(start);
  assert.equal(added.length, 2);
  assert.equal(start.length, 1);
  assert.deepEqual(added[1], { from: "", to: [], left: "", right: "" });

  const edited = updateRule(added, 1, { from: "ka" });
  assert.equal(edited[1].from, "ka");
  assert.equal(added[1].from, "");

  assert.deepEqual(removeRule(edited, 0).map((r) => r.from), ["ka"]);
  assert.equal(removeRule(edited, 9).length, 2);
});

test("moveRule swaps neighbours and ignores moves off either end", () => {
  const rules = [rule("a"), rule("b"), rule("c")];
  assert.deepEqual(moveRule(rules, 1, -1).map((r) => r.from), ["b", "a", "c"]);
  assert.deepEqual(moveRule(rules, 1, 1).map((r) => r.from), ["a", "c", "b"]);
  assert.deepEqual(moveRule(rules, 0, -1).map((r) => r.from), ["a", "b", "c"]);
  assert.deepEqual(moveRule(rules, 2, 1).map((r) => r.from), ["a", "b", "c"]);
});

test("describeRule reads like the rule and marks an incomplete one", () => {
  assert.equal(describeRule({ from: "ka", to: ["id-ka"] }, glyphs), "ka \u2192 ka");
  assert.equal(
    describeRule({ from: "a", to: ["id-ta"], left: "C", right: "#" }, glyphs),
    "a \u2192 ta / C_#",
  );
  assert.equal(describeRule({ from: "", to: [] }, glyphs), "(empty rule)");
});
