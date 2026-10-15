import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SIZE,
  MIN_SIZE,
  clampSize,
  linesFor,
  glyphPlacements,
  lineMetrics,
  sampleText,
  scaleOf,
  textFor,
  wrapRuns,
  type ShapedRun,
} from "./typePreview.ts";
import type { GlyphMeta, Phoneme } from "./api.ts";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

const run = (ids: number[], adv: number, clusters?: number[]): ShapedRun => ({
  glyphs: ids.map((id, i) => ({ id, cluster: clusters?.[i] ?? i, advance: adv, x_offset: 0, y_offset: 0 })),
  advance: ids.length * adv,
  upem: 1000,
});

test("the size range is 12 to 300 px, clamped, with a sane fallback", () => {
  assert.equal(MIN_SIZE, 12);
  assert.equal(MAX_SIZE, 300);
  assert.equal(clampSize(3), 12);
  assert.equal(clampSize(9999), 300);
  assert.equal(clampSize(48.4), 48);
  assert.equal(clampSize(Number.NaN), 48);
});

test("scaleOf is pixels per font unit", () => {
  near(scaleOf(100, 1000), 0.1);
  near(scaleOf(300, 1000), 0.3);
  near(scaleOf(48, 0), 0.048, 1e-9);
});

test("linesFor splits text into lines, drops a trailing empty line and keeps blank ones in the middle", () => {
  assert.deepEqual(linesFor("a\nb"), ["a", "b"]);
  assert.deepEqual(linesFor("a\n\nb"), ["a", "", "b"]);
  assert.deepEqual(linesFor("a\n"), ["a"]);
  assert.deepEqual(linesFor(""), []);
  assert.deepEqual(linesFor("a\r\nb"), ["a", "b"]);
});

test("glyphPlacements puts each glyph at the running x, scaled, with offsets applied", () => {
  const r: ShapedRun = {
    glyphs: [
      { id: 1, cluster: 0, advance: 400, x_offset: 0, y_offset: 0 },
      { id: 2, cluster: 1, advance: 250, x_offset: 30, y_offset: -20 },
    ],
    advance: 650,
    upem: 1000,
  };
  const p = glyphPlacements(r, 0.1);
  assert.deepEqual(p.map((g) => g.id), [1, 2]);
  near(p[0].x, 0);
  near(p[1].x, 40 + 3, 1e-9);
  near(p[1].y, -(-20) * 0.1, 1e-9);
  near(p[0].width, 40);
  near(p[1].width, 25);
});

test("lineMetrics gives the line height from the ascender and descender and the width from the run", () => {
  const m = lineMetrics(run([1, 2], 400), 0.1, 800, -200);
  near(m.width, 80);
  near(m.height, 100);
  near(m.baseline, 80);
  near(m.ascent, 80);
  near(m.descent, 20);
});

test("wrapRuns breaks a long line into rows no wider than the width, by whole glyphs", () => {
  const r = run([1, 2, 3, 4, 5, 6], 400);
  const rows = wrapRuns(r, 0.1, 100);
  assert.deepEqual(rows.map((row) => row.glyphs.length), [2, 2, 2]);
  for (const row of rows) assert.ok(row.advance * 0.1 <= 100 + 1e-9);
});

test("wrapRuns keeps a glyph wider than the width on its own row and never loops", () => {
  const r = run([1, 2, 3], 400);
  const rows = wrapRuns(r, 0.1, 10);
  assert.deepEqual(rows.map((row) => row.glyphs.length), [1, 1, 1]);
});

test("wrapRuns on a short line or an empty run returns it as is", () => {
  assert.equal(wrapRuns(run([1, 2], 100), 0.1, 500).length, 1);
  assert.deepEqual(wrapRuns(run([], 100), 0.1, 500), []);
  assert.equal(wrapRuns(run([1, 2, 3], 100), 0.1, 0).length, 1, "no width means no wrapping");
});

test("wrapRuns keeps the total advance of every row consistent with its glyphs", () => {
  const rows = wrapRuns(run([1, 2, 3, 4, 5], 300), 0.1, 70);
  for (const row of rows) assert.equal(row.advance, row.glyphs.reduce((a, g) => a + g.advance, 0));
  assert.equal(rows.reduce((n, row) => n + row.glyphs.length, 0), 5);
});

const glyph = (id: string, name: string, cp: number, phonemes: string[] = []): GlyphMeta => ({
  id, name, codepoint: cp, phonemes, order: 0, group: "",
});
const glyphs = [glyph("g1", "ka", 0xe000, ["k"]), glyph("g2", "tu", 0xe001, ["t"]), glyph("g3", "x", 0xe002)];
const phonemes: Phoneme[] = [
  { id: "k", symbol: "k", kind: "consonant" },
  { id: "t", symbol: "t", kind: "consonant" },
];

test("sampleText 'all' lists every glyph's codepoint, one wrapped line", () => {
  assert.equal(sampleText({ source: "all" }, glyphs, phonemes), "\ue000\ue001\ue002");
});

test("sampleText 'pairs' lists every glyph beside every glyph, a row per first glyph", () => {
  const t = sampleText({ source: "pairs" }, glyphs.slice(0, 2), phonemes);
  assert.equal(t, "\ue000\ue000 \ue000\ue001\n\ue001\ue000 \ue001\ue001");
});

test("sampleText 'custom' is the typed text and 'words' joins the picked words", () => {
  assert.equal(sampleText({ source: "custom", custom: "katu" }, glyphs, phonemes), "katu");
  assert.equal(sampleText({ source: "words", words: ["kata", "tuka"] }, glyphs, phonemes), "kata\ntuka");
  assert.equal(sampleText({ source: "words", words: [] }, glyphs, phonemes), "");
});

test("textFor with a limit caps very long text so a huge input cannot freeze the preview", () => {
  const long = "a".repeat(50000);
  assert.equal(textFor(long, 1000).length, 1000);
  assert.equal(textFor("short", 1000), "short");
});

test("a row that exactly fills the width keeps its last glyph: only an overflow wraps", () => {
  const rows = wrapRuns(run([1, 2, 3, 4], 500), 0.1, 100);
  assert.deepEqual(rows.map((r) => r.glyphs.length), [2, 2], "two 50 px glyphs exactly fill 100 px");
  const tight = wrapRuns(run([1, 2, 3], 500), 0.1, 99);
  assert.deepEqual(tight.map((r) => r.glyphs.length), [1, 1, 1], "99 px cannot hold two 50 px glyphs");
});

import { gapAt, gapDragEdits, GAP_HIT_PX, type GapTarget } from "./typePreview.ts";

const placed = (xs: number[], widths: number[]) =>
  xs.map((x, i) => ({ id: i + 1, cluster: i, x, y: 0, width: widths[i] }));

test("gaps sit on the boundary between two glyphs' advance boxes", () => {
  const p = placed([0, 40, 65], [40, 25, 30]);
  const g = gapAt(p, 41, [true, true, true]);
  assert.ok(g);
  assert.equal(g.left, 0);
  assert.equal(g.right, 1);
  const h = gapAt(p, 64, [true, true, true]);
  assert.deepEqual([h!.left, h!.right], [1, 2]);
});

test("a gap is hit within the pixel reach and the nearer boundary wins", () => {
  const p = placed([0, 40, 65], [40, 25, 30]);
  assert.equal(GAP_HIT_PX, 6);
  assert.equal(gapAt(p, 46, [true, true, true])?.left, 0, "6 px from the boundary at 40");
  assert.equal(gapAt(p, 47, [true, true, true]), null);
  assert.equal(gapAt(p, 52, [true, true, true]), null, "inside a glyph, away from a boundary");
  const tight = placed([0, 10, 12], [10, 2, 10]);
  assert.equal(gapAt(tight, 11, [true, true, true])?.left, 0, "the nearer of boundaries at 10 and 12");
  assert.equal(gapAt(tight, 11.8, [true, true, true])?.left, 1);
});

test("a gap beside a glyph that cannot be edited (a hidden letter, notdef) is not offered", () => {
  const p = placed([0, 40, 65], [40, 25, 30]);
  assert.equal(gapAt(p, 41, [true, false, true]), null);
  assert.equal(gapAt(p, 64, [true, false, true]), null);
  assert.equal(gapAt(p, 41, [false, true, true]), null);
});

test("there is no gap before the first glyph or after the last", () => {
  const p = placed([0, 40], [40, 25]);
  assert.equal(gapAt(p, 0, [true, true]), null);
  assert.equal(gapAt(p, 65, [true, true]), null);
  assert.equal(gapAt([], 5, []), null);
});

const target: GapTarget = { left: 0, right: 1 };

test("dragging a gap by dx pixels widens it by that many units, split between the two glyphs' bearings", () => {
  const e = gapDragEdits(4, 0.1, "split");
  near(e.leftRsb, 20);
  near(e.rightLsb, 20);
});

test("a gap drag can instead change only the left glyph's right bearing or only the right glyph's left bearing", () => {
  const l = gapDragEdits(3, 0.1, "left");
  near(l.leftRsb, 30);
  near(l.rightLsb, 0);
  const r = gapDragEdits(3, 0.1, "right");
  near(r.leftRsb, 0);
  near(r.rightLsb, 30);
});

test("dragging left tightens, with negative deltas; zero scale cannot divide by zero", () => {
  const e = gapDragEdits(-2, 0.1, "split");
  near(e.leftRsb, -10);
  near(e.rightLsb, -10);
  const z = gapDragEdits(5, 0, "split");
  assert.equal(z.leftRsb, 0);
  assert.equal(z.rightLsb, 0);
});

test("a gap drag in a right-to-left run widens the gap when dragged the other way", () => {
  const e = gapDragEdits(4, 0.1, "split", true);
  near(e.leftRsb, -20);
  near(e.rightLsb, -20);
});
