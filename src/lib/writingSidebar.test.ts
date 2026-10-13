import { test } from "node:test";
import assert from "node:assert/strict";

import { filterGlyphs, sidebarCoverage, sidebarGroups } from "./writingSidebar.ts";
import type { GlyphMeta, Phoneme } from "./api.ts";

const glyph = (id: string, name: string, group: string, phonemes: string[] = []): GlyphMeta => ({
  id,
  name,
  codepoint: 0xe000,
  phonemes,
  order: 0,
  group,
});

const phonemes: Phoneme[] = [
  { id: "p1", symbol: "k", kind: "consonant" },
  { id: "p2", symbol: "a", kind: "vowel" },
];

const glyphs = [
  glyph("1", "ka", "consonants", ["p1"]),
  glyph("2", "alpha", "vowels", ["p2"]),
  glyph("3", "blob", ""),
];

test("an empty filter returns every glyph", () => {
  assert.equal(filterGlyphs(glyphs, phonemes, "  ").length, 3);
});

test("the filter matches name, group and the mapped sound symbol", () => {
  assert.deepEqual(filterGlyphs(glyphs, phonemes, "alp").map((g) => g.id), ["2"]);
  assert.deepEqual(filterGlyphs(glyphs, phonemes, "VOWEL").map((g) => g.id), ["2"]);
  assert.deepEqual(filterGlyphs(glyphs, phonemes, "k").map((g) => g.id), ["1"]);
  assert.equal(filterGlyphs(glyphs, phonemes, "zzz").length, 0);
});

test("groups are sorted by name with ungrouped glyphs bucketed", () => {
  const groups = sidebarGroups(glyphs, phonemes, "");
  assert.deepEqual(groups.map((g) => g.name), ["consonants", "ungrouped", "vowels"]);
});

test("coverage counts sounds that have a glyph", () => {
  assert.deepEqual(sidebarCoverage(glyphs, phonemes), { total: 2, mapped: 2 });
  assert.deepEqual(sidebarCoverage([], phonemes), { total: 2, mapped: 0 });
});
