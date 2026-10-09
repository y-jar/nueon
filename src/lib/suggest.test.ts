import { test } from "node:test";
import assert from "node:assert/strict";

import { filterSuggestions } from "./suggest.ts";

test("an empty draft offers every value, alphabetical", () => {
  assert.deepEqual(filterSuggestions(["verb", "noun", "adj"], ""), [
    "adj",
    "noun",
    "verb",
  ]);
});

test("prefix matches rank before substring matches", () => {
  assert.deepEqual(filterSuggestions(["pronoun", "noun", "noun phrase"], "no"), [
    "noun",
    "noun phrase",
    "pronoun",
  ]);
});

test("matching is case-insensitive and deduplicated", () => {
  const out = filterSuggestions(["Noun", "noun", "Noun", "VERB"], "n");
  assert.equal(out.length, 2); // "Noun" deduped, "VERB" excluded
  assert.ok(out.includes("Noun") && out.includes("noun"));
});

test("results are capped", () => {
  const many = Array.from({ length: 20 }, (_, i) => `v${i}`);
  assert.equal(filterSuggestions(many, "", 5).length, 5);
});
