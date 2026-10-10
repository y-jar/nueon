import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseHeadings,
  parseWikiLinks,
  rankCompletions,
  resolveWikiTarget,
} from "./wikilink.ts";

test("parses plain, aliased and embed links", () => {
  assert.deepEqual(parseWikiLinks("see [[kala]] here"), [
    { from: 4, to: 12, target: "kala", alias: null, heading: null, embed: false },
  ]);
  assert.deepEqual(parseWikiLinks("[[kala|dog]]"), [
    { from: 0, to: 12, target: "kala", alias: "dog", heading: null, embed: false },
  ]);
  assert.deepEqual(parseWikiLinks("![[kala]]"), [
    { from: 0, to: 9, target: "kala", alias: null, heading: null, embed: true },
  ]);
});

test("parses heading and heading-with-alias forms", () => {
  assert.deepEqual(parseWikiLinks("[[kala#nouns]]"), [
    { from: 0, to: 14, target: "kala", alias: null, heading: "nouns", embed: false },
  ]);
  assert.deepEqual(parseWikiLinks("[[kala#nouns|dog]]"), [
    { from: 0, to: 18, target: "kala", alias: "dog", heading: "nouns", embed: false },
  ]);
  assert.deepEqual(parseWikiLinks("![[note#head]]"), [
    { from: 0, to: 14, target: "note", alias: null, heading: "head", embed: true },
  ]);
});

test("parses several links on one line with offsets", () => {
  assert.deepEqual(parseWikiLinks("[[a]] and [[b]]"), [
    { from: 0, to: 5, target: "a", alias: null, heading: null, embed: false },
    { from: 10, to: 15, target: "b", alias: null, heading: null, embed: false },
  ]);
});

test("targets may not contain newlines or a closing bracket", () => {
  assert.deepEqual(parseWikiLinks("[[a\nb]]"), []);
  assert.deepEqual(parseWikiLinks("[[a]b]]"), []);
});

test("parseHeadings finds ATX headings and skips fenced code", () => {
  assert.deepEqual(
    parseHeadings("# Title\n## Sub\n```\n# not a heading\n```\n### Last"),
    ["Title", "Sub", "Last"],
  );
});

test("parseHeadings drops trailing # marks and strips inline formatting", () => {
  assert.deepEqual(
    parseHeadings("## [A link](url) and **bold** and `code` ##"),
    ["A link and bold and code"],
  );
});

test("parseHeadings ignores setext-style underlines", () => {
  assert.deepEqual(parseHeadings("Title\n===\nbody"), []);
});

test("parseHeadings keeps duplicate headings in order", () => {
  assert.deepEqual(parseHeadings("# A\n## B\n# A"), ["A", "B", "A"]);
});

test("resolves a word first, case-insensitively", () => {
  const index = {
    kala: [{ id: "1", table: "lex", wordname: "kala", senses: ["dog"], tags: [] }],
  };
  const result = resolveWikiTarget("KALA", null, index, new Set());
  assert.equal(result.kind, "word");
  if (result.kind === "word") assert.equal(result.id, "1");
});

test("resolves a note by path or basename", () => {
  const index = {};
  const notes = new Set(["Grammar/Phonology.md", "alpha.md"]);
  assert.deepEqual(resolveWikiTarget("Grammar/Phonology", null, index, notes), {
    kind: "note",
    path: "Grammar/Phonology.md",
    heading: null,
    headingResolved: null,
  });
  assert.deepEqual(resolveWikiTarget("alpha", null, index, notes), {
    kind: "note",
    path: "alpha.md",
    heading: null,
    headingResolved: null,
  });
});

test("a heading resolves the note and its heading", () => {
  const index = {};
  const notes = new Set(["alpha.md"]);
  const headings = { "alpha.md": ["Nouns", "Verbs"] };
  assert.deepEqual(resolveWikiTarget("alpha", "Nouns", index, notes, headings), {
    kind: "note",
    path: "alpha.md",
    heading: "Nouns",
    headingResolved: true,
  });
  assert.deepEqual(resolveWikiTarget("alpha", "Missing", index, notes, headings), {
    kind: "note",
    path: "alpha.md",
    heading: "Missing",
    headingResolved: false,
  });
});

test("an uncached note heading is optimistic", () => {
  const index = {};
  const notes = new Set(["alpha.md"]);
  const result = resolveWikiTarget("alpha", "Nouns", index, notes, {});
  assert.deepEqual(result, {
    kind: "note",
    path: "alpha.md",
    heading: "Nouns",
    headingResolved: null,
  });
});

test("a heading makes a note win over a same-named word", () => {
  const index = {
    alpha: [{ id: "1", table: "lex", wordname: "alpha", senses: ["x"], tags: [] }],
  };
  const notes = new Set(["alpha.md"]);
  const headings = { "alpha.md": ["Intro"] };
  const result = resolveWikiTarget("alpha", "Intro", index, notes, headings);
  assert.equal(result.kind, "note");

  // Without a heading the word still wins.
  const word = resolveWikiTarget("alpha", null, index, notes, headings);
  assert.equal(word.kind, "word");
});

test("a word target with a heading ignores the heading", () => {
  const index = {
    kala: [{ id: "1", table: "lex", wordname: "kala", senses: ["dog"], tags: [] }],
  };
  const result = resolveWikiTarget("kala", "Nouns", index, new Set(), {});
  assert.equal(result.kind, "word");
});

test("reports missing targets", () => {
  assert.deepEqual(resolveWikiTarget("nope", null, {}, new Set()), { kind: "missing" });
});

test("rankCompletions orders prefix, word-boundary, then substring", () => {
  const names = (list: { name: string }[]) => list.map((candidate) => candidate.name);
  const candidates = [
    { name: "uene" },
    { name: "phonology" },
    { name: "sound-phonology" },
    { name: "phone" },
  ];
  // "phon" is a prefix of "phone" and "phonology" (alphabetical tie-break), a
  // word-boundary match of "sound-phonology"; substring "ene" matches "uene".
  assert.deepEqual(names(rankCompletions("phon", candidates)), [
    "phone",
    "phonology",
    "sound-phonology",
  ]);
  assert.deepEqual(names(rankCompletions("ene", candidates)), ["uene"]);
});

test("rankCompletions ranks a boundary match before a substring", () => {
  const candidates = [{ name: "ab" }, { name: "cab" }, { name: "a-b" }];
  // "b" is a word-boundary match of "a-b", a substring of "ab" and "cab".
  const result = rankCompletions("b", candidates).map((candidate) => candidate.name);
  assert.deepEqual(result, ["a-b", "ab", "cab"]);
});
