import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSymbolList,
  pluralEnding,
  rebuildPhonemes,
  setPluralEnding,
  splitSoundClasses,
  type Morphology,
} from "./configEdit.ts";

test("parses a symbol list, dropping blanks and duplicates", () => {
  assert.deepEqual(parseSymbolList("p t  k ,m\np"), ["p", "t", "k", "m"]);
  assert.deepEqual(parseSymbolList("   "), []);
});

test("splits an inventory into consonant and vowel text", () => {
  const split = splitSoundClasses([
    { symbol: "p", kind: "consonant" },
    { symbol: "a", kind: "vowel" },
    { symbol: "k", kind: "consonant" },
    { symbol: "?", kind: "other" },
  ]);
  assert.equal(split.consonants, "p k");
  assert.equal(split.vowels, "a");
});

test("rebuilds the inventory and preserves unclassified sounds", () => {
  const others = [{ symbol: "?", kind: "other" as const }];
  assert.deepEqual(rebuildPhonemes("p k", "a i", others), [
    { symbol: "p", kind: "consonant" },
    { symbol: "k", kind: "consonant" },
    { symbol: "a", kind: "vowel" },
    { symbol: "i", kind: "vowel" },
    { symbol: "?", kind: "other" },
  ]);
});

test("reclassifies an 'other' sound instead of duplicating it", () => {
  const others = [{ symbol: "n", kind: "other" as const }];
  assert.deepEqual(rebuildPhonemes("n", "", others), [
    { symbol: "n", kind: "consonant" },
  ]);
});

test("a symbol in both lists is a consonant", () => {
  assert.deepEqual(rebuildPhonemes("a", "a i", []), [
    { symbol: "a", kind: "consonant" },
    { symbol: "i", kind: "vowel" },
  ]);
});

const emptyMorphology: Morphology = { features: [], paradigms: [] };

test("sets the noun plural ending, creating the row", () => {
  const next = setPluralEnding(emptyMorphology, "es", "suffix");
  assert.deepEqual(next.paradigms, [
    {
      class: "noun",
      rows: [{ when: { number: "plural" }, surface: "es", kind: "suffix" }],
    },
  ]);
  assert.equal(pluralEnding(next)?.surface, "es");
});

test("updates only the plural row of an existing noun paradigm", () => {
  const morphology: Morphology = {
    features: [],
    paradigms: [
      {
        class: "noun",
        rows: [
          { when: { number: "singular" }, surface: "a", kind: "suffix" },
          { when: { number: "plural" }, surface: "i", kind: "suffix" },
        ],
      },
      {
        class: "verb",
        rows: [{ when: { tense: "past" }, surface: "ed", kind: "suffix" }],
      },
    ],
  };
  const next = setPluralEnding(morphology, "es", "prefix");
  const noun = next.paradigms.find((p) => p.class === "noun");
  assert.deepEqual(noun?.rows[0], {
    when: { number: "singular" },
    surface: "a",
    kind: "suffix",
  });
  assert.deepEqual(noun?.rows[1], {
    when: { number: "plural" },
    surface: "es",
    kind: "prefix",
  });
  assert.equal(next.paradigms.length, 2);
});
