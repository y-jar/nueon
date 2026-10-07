import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BACKNESS,
  CONSONANTS,
  PLACES,
  VOWELS,
  chartSymbols,
} from "./ipa.ts";

test("consonant rows align with the place columns", () => {
  for (const row of CONSONANTS) {
    assert.equal(row.cells.length, PLACES.length, row.manner);
  }
});

test("vowel rows align with the backness columns", () => {
  for (const row of VOWELS) {
    assert.equal(row.cells.length, BACKNESS.length, row.height);
  }
});

test("every chart symbol is unique, non-empty and classed", () => {
  const symbols = chartSymbols();
  assert.ok(symbols.length > 50, `only ${symbols.length} symbols`);
  const seen = new Set<string>();
  for (const { symbol, kind } of symbols) {
    assert.ok(symbol.trim().length > 0);
    assert.ok(kind === "consonant" || kind === "vowel", `${symbol}: ${kind}`);
    assert.ok(!seen.has(symbol), `duplicate symbol ${symbol}`);
    seen.add(symbol);
  }
});

test("the chart includes the classic anchor points", () => {
  const symbols = new Set(chartSymbols().map((s) => s.symbol));
  for (const symbol of ["p", "t", "k", "ʔ", "m", "n", "s", "l", "i", "a", "u"]) {
    assert.ok(symbols.has(symbol), `missing ${symbol}`);
  }
  // Dental stops are base + combining mark (multi-code-point) and stay intact.
  assert.ok(symbols.has("t̪"));
});
