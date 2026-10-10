import { test } from "node:test";
import assert from "node:assert/strict";

import { parseWikiLinks, resolveWikiTarget } from "./wikilink.ts";

test("parses plain, aliased and embed links", () => {
  assert.deepEqual(parseWikiLinks("see [[kala]] here"), [
    { from: 4, to: 12, target: "kala", alias: null, embed: false },
  ]);
  assert.deepEqual(parseWikiLinks("[[kala|dog]]"), [
    { from: 0, to: 12, target: "kala", alias: "dog", embed: false },
  ]);
  assert.deepEqual(parseWikiLinks("![[kala]]"), [
    { from: 0, to: 9, target: "kala", alias: null, embed: true },
  ]);
});

test("parses several links on one line with offsets", () => {
  assert.deepEqual(parseWikiLinks("[[a]] and [[b]]"), [
    { from: 0, to: 5, target: "a", alias: null, embed: false },
    { from: 10, to: 15, target: "b", alias: null, embed: false },
  ]);
});

test("targets may not contain newlines or a closing bracket", () => {
  assert.deepEqual(parseWikiLinks("[[a\nb]]"), []);
  assert.deepEqual(parseWikiLinks("[[a]b]]"), []);
});

test("resolves a word first, case-insensitively", () => {
  const index = {
    kala: [{ id: "1", table: "lex", wordname: "kala", senses: ["dog"], tags: [] }],
  };
  const result = resolveWikiTarget("KALA", index, new Set());
  assert.equal(result.kind, "word");
  if (result.kind === "word") assert.equal(result.id, "1");
});

test("resolves a note by path or basename", () => {
  const index = {};
  const notes = new Set(["Grammar/Phonology.md", "alpha.md"]);
  assert.deepEqual(resolveWikiTarget("Grammar/Phonology", index, notes), {
    kind: "note",
    path: "Grammar/Phonology.md",
  });
  assert.deepEqual(resolveWikiTarget("alpha", index, notes), {
    kind: "note",
    path: "alpha.md",
  });
});

test("reports missing targets", () => {
  assert.deepEqual(resolveWikiTarget("nope", {}, new Set()), { kind: "missing" });
});
