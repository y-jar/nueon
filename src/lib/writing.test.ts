import { test } from "node:test";
import assert from "node:assert/strict";

import { groupGlyphs, soundCoverage, UNGROUPED } from "./writing.ts";
import type { GlyphMeta } from "./api.ts";

function glyph(id: string, group: string, order: number): GlyphMeta {
  return {
    id,
    name: id,
    codepoint: 0xe000,
    phonemes: [],
    order,
    group,
  };
}

test("groupGlyphs buckets by group, defaulting empty to ungrouped", () => {
  const glyphs = [
    glyph("a", "consonants", 0),
    glyph("b", "", 0),
    glyph("c", "vowels", 1),
    glyph("d", "vowels", 0),
  ];
  const groups = groupGlyphs(glyphs);
  assert.deepEqual([...groups.keys()].sort(), ["consonants", UNGROUPED, "vowels"]);
  assert.deepEqual(
    groups.get("vowels")!.map((g) => g.id),
    ["d", "c"],
  );
  assert.deepEqual(
    groups.get(UNGROUPED)!.map((g) => g.id),
    ["b"],
  );
});

test("groupGlyphs sorts by order then name within a group", () => {
  const glyphs = [
    glyph("z", "g", 0),
    glyph("a", "g", 0),
    glyph("m", "g", 1),
  ];
  const groups = groupGlyphs(glyphs);
  assert.deepEqual(
    groups.get("g")!.map((g) => g.id),
    ["a", "z", "m"],
  );
});

test("soundCoverage counts phoneme ids with a glyph", () => {
  const glyphs = [
    { ...glyph("a", "g", 0), phonemes: ["p1"] },
    { ...glyph("b", "g", 1), phonemes: ["p2", "p3"] },
  ];
  const coverage = soundCoverage(glyphs, ["p1", "p2", "p3", "p4"]);
  assert.deepEqual(coverage, { total: 4, mapped: 3 });
});

test("soundCoverage is zero when no glyph maps a sound", () => {
  const coverage = soundCoverage([], ["p1", "p2"]);
  assert.deepEqual(coverage, { total: 2, mapped: 0 });
});
