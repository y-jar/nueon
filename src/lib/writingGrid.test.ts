import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CELL_SIZES,
  LABEL_HEIGHT,
  buildCells,
  cellViewBox,
  clampCell,
  effectiveAdvance,
  gridLayout,
  isDrawn,
  previewOf,
  progressOf,
  soundKindOf,
  visibleRows,
} from "./writingGrid.ts";
import type { GlyphMeta, GlyphOutline, Phoneme } from "./api.ts";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

const meta = (id: string, over: Partial<GlyphMeta> = {}): GlyphMeta => ({
  id,
  name: id,
  codepoint: 0xe000,
  phonemes: [],
  order: 0,
  group: "",
  ...over,
});
const ph = (id: string, kind: Phoneme["kind"]): Phoneme => ({ id, symbol: id, kind });

const corner = (x: number, y: number) => ({ x, y, kind: "corner" as const });
const rect = (x: number, y: number, w: number, h: number) => ({
  kind: "contour" as const,
  closed: true,
  fill_rule: "nonzero" as const,
  nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)],
});
const drawn = (over: Partial<GlyphOutline> = {}): GlyphOutline => ({ elements: [rect(0, 0, 400, 700)], ...over });
const blank: GlyphOutline = { elements: [] };

test("effectiveAdvance uses the stored advance, else the ink's right edge plus 50, else 600", () => {
  assert.equal(effectiveAdvance(drawn({ advance: 450 })), 450);
  assert.equal(effectiveAdvance(drawn()), 450);
  assert.equal(effectiveAdvance(blank), 600);
  assert.equal(effectiveAdvance(undefined), 600);
  assert.equal(effectiveAdvance(drawn({ advance: 0 })), 450, "0 means unset, as in the compiler");
});

test("the cell view box is a square centred on the advance and on the em, so every glyph shares one scale", () => {
  const box = cellViewBox(500, 800, -200);
  near(box.w, 1000);
  near(box.h, 1000);
  near(box.x + box.w / 2, 250, 1e-9);
  near(box.y + box.h / 2, -(800 + -200) / 2, 1e-9);
  const thin = cellViewBox(120, 800, -200);
  near(thin.w, box.w, 1e-9);
});

test("a very wide advance widens the box instead of clipping the glyph", () => {
  const box = cellViewBox(1600, 800, -200);
  assert.ok(box.w >= 1700 && box.h === box.w);
  near(box.x + box.w / 2, 800, 1e-9);
});

test("previewOf draws a contour as y-flipped path data and reports the advance", () => {
  const p = previewOf(drawn({ advance: 500 }));
  assert.ok(p.d.startsWith("M 0 0 L 400 0 L 400 -700"), p.d);
  assert.equal(p.advance, 500);
  assert.equal(p.drawn, true);
});

test("previewOf includes component contours with their transform, and survives a missing or cyclic component", () => {
  const comp = { kind: "component" as const, glyph: "base", dx: 100, dy: 0, scale_x: 1, scale_y: 1, rotation: 0 };
  const lookup = (id: string): GlyphOutline | null => (id === "base" ? { elements: [rect(0, 0, 50, 50)] } : null);
  const p = previewOf({ elements: [comp] }, lookup);
  assert.ok(p.d.includes("M 100 0"), p.d);
  assert.equal(p.drawn, true);
  assert.equal(previewOf({ elements: [{ ...comp, glyph: "gone" }] }, lookup).drawn, false);
  const loop = (id: string): GlyphOutline | null => ({ elements: [{ ...comp, glyph: id }] });
  assert.equal(previewOf({ elements: [{ ...comp, glyph: "x" }] }, loop).drawn, false);
});

test("a glyph with no contours, or only single points, is not drawn", () => {
  assert.equal(isDrawn(blank), false);
  assert.equal(isDrawn(undefined), false);
  assert.equal(isDrawn({ elements: [{ kind: "contour", closed: false, fill_rule: "nonzero", nodes: [corner(1, 1)] }] }), false);
  assert.equal(isDrawn(drawn()), true);
});

test("soundKindOf follows the mapped sound, and is unmapped for a glyph with none", () => {
  const phonemes = [ph("k", "consonant"), ph("a", "vowel"), ph("h", "other")];
  assert.equal(soundKindOf(meta("g", { phonemes: ["k"] }), phonemes), "consonant");
  assert.equal(soundKindOf(meta("g", { phonemes: ["a"] }), phonemes), "vowel");
  assert.equal(soundKindOf(meta("g", { phonemes: ["h"] }), phonemes), "other");
  assert.equal(soundKindOf(meta("g"), phonemes), "unmapped");
  assert.equal(soundKindOf(meta("g", { phonemes: ["zz"] }), phonemes), "unmapped");
  assert.equal(soundKindOf(meta("g", { phonemes: ["zz", "a"] }), phonemes), "vowel", "first known sound wins");
});

const phonemes = [ph("k", "consonant"), ph("t", "consonant"), ph("a", "vowel")];
const glyphs = [
  meta("gk", { name: "ka", phonemes: ["k"], group: "consonants", order: 0 }),
  meta("ga", { name: "aa", phonemes: ["a"], group: "vowels", order: 1 }),
  meta("gx", { name: "stray", order: 2 }),
];
const outlines = { gk: drawn(), ga: blank };
const all = { group: null, sound: "all", fill: "all", text: "" } as const;

test("cells are the glyphs followed by an empty slot for every sound that has no glyph", () => {
  const cells = buildCells(glyphs, phonemes, outlines, all);
  assert.deepEqual(
    cells.map((c) => (c.kind === "glyph" ? `g:${c.glyph.id}` : `e:${c.phoneme.id}`)),
    ["g:gk", "g:ga", "g:gx", "e:t"],
  );
});

test("a glyph cell knows its symbols and whether it is drawn", () => {
  const cells = buildCells(glyphs, phonemes, outlines, all);
  const [a, b] = cells;
  assert.ok(a.kind === "glyph" && b.kind === "glyph");
  assert.deepEqual(a.symbols, ["k"]);
  assert.equal(a.drawn, true);
  assert.equal(b.drawn, false);
});

test("the fill filter shows only drawn glyphs, or only what still needs drawing", () => {
  const ids = (f: "drawn" | "empty") =>
    buildCells(glyphs, phonemes, outlines, { ...all, fill: f }).map((c) =>
      c.kind === "glyph" ? c.glyph.id : c.phoneme.id,
    );
  assert.deepEqual(ids("drawn"), ["gk"]);
  assert.deepEqual(ids("empty"), ["ga", "gx", "t"], "undrawn glyphs and empty slots");
});

test("the sound filter keeps glyphs and empty slots of that kind", () => {
  const ids = (s: "consonant" | "vowel" | "unmapped") =>
    buildCells(glyphs, phonemes, outlines, { ...all, sound: s }).map((c) =>
      c.kind === "glyph" ? c.glyph.id : c.phoneme.id,
    );
  assert.deepEqual(ids("consonant"), ["gk", "t"]);
  assert.deepEqual(ids("vowel"), ["ga"]);
  assert.deepEqual(ids("unmapped"), ["gx"]);
});

test("the navigator group limits glyphs to that group and slots to sounds of that kind", () => {
  const ids = (g: string) =>
    buildCells(glyphs, phonemes, outlines, { ...all, group: g }).map((c) =>
      c.kind === "glyph" ? c.glyph.id : c.phoneme.id,
    );
  assert.deepEqual(ids("consonants"), ["gk", "t"]);
  assert.deepEqual(ids("vowels"), ["ga"]);
  assert.deepEqual(ids("ungrouped"), ["gx"]);
});

test("text filters by glyph name, sound symbol or group, case-insensitively", () => {
  const ids = (text: string) =>
    buildCells(glyphs, phonemes, outlines, { ...all, text }).map((c) =>
      c.kind === "glyph" ? c.glyph.id : c.phoneme.id,
    );
  assert.deepEqual(ids("KA"), ["gk"]);
  assert.deepEqual(ids("stray"), ["gx"]);
  assert.deepEqual(ids("t"), ["gk", "gx", "t"], "ka (group consonants), stray, and the sound t");
  assert.deepEqual(ids("nothing"), []);
});

test("progress counts drawn glyphs out of every slot (glyphs plus empty sounds)", () => {
  assert.deepEqual(progressOf(glyphs, phonemes, outlines), { drawn: 1, total: 4 });
  assert.deepEqual(progressOf([], phonemes, {}), { drawn: 0, total: 3 });
  assert.deepEqual(progressOf([], [], {}), { drawn: 0, total: 0 });
});

test("progress ignores filters, so the line always describes the whole set", () => {
  const filtered = buildCells(glyphs, phonemes, outlines, { ...all, fill: "drawn" });
  assert.equal(filtered.length, 1);
  assert.equal(progressOf(glyphs, phonemes, outlines).total, 4);
});

test("cell sizes are S, M, L and clamp into a usable range", () => {
  assert.ok(CELL_SIZES.S < CELL_SIZES.M && CELL_SIZES.M < CELL_SIZES.L);
  assert.equal(clampCell(10), 48);
  assert.equal(clampCell(9999), 240);
  assert.equal(clampCell(100.6), 101);
  assert.equal(clampCell(Number.NaN), CELL_SIZES.M);
});

test("gridLayout fits as many columns as the width allows, at least one", () => {
  assert.equal(gridLayout(100, 500, 96, 8).cols, 4);
  assert.equal(gridLayout(100, 40, 96, 8).cols, 1);
  assert.equal(gridLayout(100, 0, 96, 8).cols, 1);
  const l = gridLayout(10, 500, 96, 8);
  assert.equal(l.rows, Math.ceil(10 / l.cols));
  assert.equal(l.rowHeight, 96 + LABEL_HEIGHT + 8);
  assert.equal(gridLayout(0, 500, 96, 8).rows, 0);
});

test("gridLayout columns exactly fill without overflowing the width", () => {
  for (const width of [200, 333, 500, 1000, 1234]) {
    const l = gridLayout(1000, width, 96, 8);
    assert.ok(l.cols * 96 + (l.cols - 1) * 8 <= width || l.cols === 1, `width ${width} cols ${l.cols}`);
    assert.ok((l.cols + 1) * 96 + l.cols * 8 > width, `one more column would fit at ${width}`);
  }
});

test("visibleRows returns the rows in view plus overscan, clamped to the grid", () => {
  assert.deepEqual(visibleRows(0, 300, 100, 50, 2), { first: 0, last: 4 });
  assert.deepEqual(visibleRows(1000, 300, 100, 50, 2), { first: 8, last: 14 });
  assert.deepEqual(visibleRows(99999, 300, 100, 50, 2), { first: 45, last: 49 }, "scrolled past the end shows the last rows");
  assert.deepEqual(visibleRows(0, 300, 100, 0, 2), { first: 0, last: -1 }, "no rows, nothing to draw");
  const w = visibleRows(5000, 400, 100, 500, 3);
  assert.ok(w.last - w.first < 20, "the window stays small however large the grid is");
});

test("visibleRows with a nonsense height or row size still returns a usable window", () => {
  const zero = visibleRows(0, 0, 100, 10, 1);
  assert.ok(zero.first === 0 && zero.last >= 0 && zero.last <= 9);
  const bad = visibleRows(0, 300, 0, 10, 1);
  assert.ok(bad.first === 0 && bad.last >= 0 && bad.last <= 9);
  const nan = visibleRows(Number.NaN, 300, 100, 10, 1);
  assert.equal(nan.first, 0);
});

test("glyphs are ordered by their order field, then by name when the order ties", () => {
  const tied = [meta("b", { name: "beta" }), meta("a", { name: "alpha" }), meta("c", { name: "gamma", order: -1 })];
  const ids = buildCells(tied, [], {}, all).map((c) => (c.kind === "glyph" ? c.glyph.id : ""));
  assert.deepEqual(ids, ["c", "a", "b"]);
});

test("a single-point contour draws nothing in the preview", () => {
  const dot: GlyphOutline = {
    elements: [{ kind: "contour", closed: false, fill_rule: "nonzero", nodes: [corner(5, 5)] }],
  };
  const p = previewOf(dot);
  assert.equal(p.d, "");
  assert.equal(p.drawn, false);
});

import { shouldApplyReload } from "./writingGrid.ts";

test("a reloaded config replaces the local one only when it differs and no local edit is waiting to save", () => {
  const a = { glyphs: [1], rules: [] };
  const same = { glyphs: [1], rules: [] };
  const other = { glyphs: [1, 2], rules: [] };
  assert.equal(shouldApplyReload(a, same, false), false, "identical: nothing to do");
  assert.equal(shouldApplyReload(a, other, false), true, "changed elsewhere: take it");
  assert.equal(shouldApplyReload(a, other, true), false, "a local edit is pending: never overwrite it");
  assert.equal(shouldApplyReload(a, same, true), false);
});
