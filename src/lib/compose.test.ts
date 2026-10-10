import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultTableFor, partitionParents, rootsOf } from "./compose.ts";

const lexicon = [
  { id: "a", table: "lex", wordname: "velo" },
  { id: "b", table: "lex", wordname: "kala" },
  { id: "c", table: "roots", wordname: "paka" },
];

test("rootsOf resolves word pieces in strip order, deduped", () => {
  const roots = rootsOf(
    [
      { kind: "word", id: "a" },
      { kind: "morpheme", id: "a" },
      { kind: "word", id: "a" },
      { kind: "word", id: "c" },
      { kind: "word", id: "missing" },
    ],
    lexicon,
  );
  assert.deepEqual(roots, [
    { table: "lex", id: "a", label: "velo" },
    { table: "roots", id: "c", label: "paka" },
  ]);
});

test("defaultTableFor picks the table holding the most roots", () => {
  const roots = rootsOf(
    [
      { kind: "word", id: "c" },
      { kind: "word", id: "a" },
      { kind: "word", id: "b" },
    ],
    lexicon,
  );
  assert.equal(defaultTableFor(roots), "lex");
  assert.equal(defaultTableFor([]), "");
});

test("defaultTableFor breaks ties toward the first root's table", () => {
  const roots = rootsOf(
    [
      { kind: "word", id: "c" }, // roots
      { kind: "word", id: "a" }, // lex
    ],
    lexicon,
  );
  assert.equal(defaultTableFor(roots), "roots");
});

test("partitionParents flags roots from another table as not linked", () => {
  const roots = rootsOf(
    [
      { kind: "word", id: "a" },
      { kind: "word", id: "c" },
    ],
    lexicon,
  );
  assert.deepEqual(partitionParents(roots, "lex"), [
    { root: { table: "lex", id: "a", label: "velo" }, linked: true },
    { root: { table: "roots", id: "c", label: "paka" }, linked: false },
  ]);
  assert.deepEqual(
    partitionParents(roots, "roots").map((entry) => entry.linked),
    [false, true],
  );
});
