import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bearingsOf,
  copySpacing,
  inkBounds,
  pairText,
  setAdvance,
  setLeftBearing,
  setRightBearing,
  setSpacing,
  applyBearings,
  type Spacing,
} from "./writingSpacing.ts";
import type { GlyphOutline } from "./api.ts";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

const corner = (x: number, y: number) => ({ x, y, kind: "corner" as const });
const rect = (x: number, y: number, w: number, h: number) => ({
  kind: "contour" as const,
  closed: true,
  fill_rule: "nonzero" as const,
  nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)],
});
const comp = (glyph: string, dx: number) => ({
  kind: "component" as const, glyph, dx, dy: 0, scale_x: 1, scale_y: 1, rotation: 0,
});

const g = (over: Partial<GlyphOutline> = {}): GlyphOutline => ({
  elements: [rect(50, 0, 300, 700)],
  advance: 450,
  ...over,
});
const xs = (o: GlyphOutline, e = 0) => {
  const el = o.elements[e];
  assert.ok(el.kind === "contour");
  return el.nodes.map((n) => n.x);
};

test("inkBounds covers contours and handles' nodes, and is null for an empty glyph", () => {
  assert.deepEqual(inkBounds(g()), { minX: 50, maxX: 350, minY: 0, maxY: 700 });
  assert.equal(inkBounds({ elements: [] }), null);
  const two = g({ elements: [rect(50, 0, 100, 100), rect(300, 50, 80, 80)] });
  assert.deepEqual(inkBounds(two), { minX: 50, maxX: 380, minY: 0, maxY: 130 });
});

test("inkBounds includes component ink through the lookup, with its transform", () => {
  const o: GlyphOutline = { elements: [comp("base", 200)], advance: 500 };
  const lookup = (id: string) => (id === "base" ? { elements: [rect(10, 0, 100, 100)] } : null);
  assert.deepEqual(inkBounds(o, lookup), { minX: 210, maxX: 310, minY: 0, maxY: 100 });
  assert.equal(inkBounds(o), null, "without a lookup a component has no known ink");
});

test("bearings derive from the ink and the advance", () => {
  const b = bearingsOf(g());
  assert.deepEqual(b, { lsb: 50, rsb: 100, advance: 450 });
});

test("an unset advance is the ink's right edge plus 50, like the compiler", () => {
  const b = bearingsOf(g({ advance: null }));
  assert.deepEqual(b, { lsb: 50, rsb: 50, advance: 400 });
  assert.equal(bearingsOf(g({ advance: 0 })).advance, 400, "0 means unset");
});

test("an empty glyph has no bearings, only an advance", () => {
  assert.deepEqual(bearingsOf({ elements: [], advance: 300 }), { lsb: null, rsb: null, advance: 300 });
  assert.deepEqual(bearingsOf({ elements: [] }), { lsb: null, rsb: null, advance: 600 });
});

test("setLeftBearing shifts the ink and the advance together, so the right bearing is unchanged", () => {
  const out = setLeftBearing(g(), 80);
  assert.deepEqual(xs(out), [80, 380, 380, 80]);
  assert.equal(out.advance, 480);
  assert.deepEqual(bearingsOf(out), { lsb: 80, rsb: 100, advance: 480 });
});

test("setLeftBearing can shrink to zero and go negative, shifting left", () => {
  const out = setLeftBearing(g(), -20);
  assert.deepEqual(xs(out), [-20, 280, 280, -20]);
  assert.equal(out.advance, 380);
  assert.equal(bearingsOf(out).lsb, -20);
});

test("setRightBearing changes only the advance and never moves the ink", () => {
  const out = setRightBearing(g(), 20);
  assert.deepEqual(xs(out), [50, 350, 350, 50]);
  assert.equal(out.advance, 370);
  assert.deepEqual(bearingsOf(out), { lsb: 50, rsb: 20, advance: 370 });
});

test("setRightBearing may go negative, for overlapping letters", () => {
  assert.equal(setRightBearing(g(), -30).advance, 320);
});

test("setAdvance changes only the advance, so the right bearing absorbs the difference", () => {
  const out = setAdvance(g(), 600);
  assert.deepEqual(xs(out), [50, 350, 350, 50]);
  assert.deepEqual(bearingsOf(out), { lsb: 50, rsb: 250, advance: 600 });
});

test("setSpacing sets the left bearing and the advance in one step", () => {
  const out = setSpacing(g(), { lsb: 30, rsb: 40 });
  assert.deepEqual(bearingsOf(out), { lsb: 30, rsb: 40, advance: 30 + 300 + 40 });
  assert.deepEqual(xs(out), [30, 330, 330, 30]);
});

test("every edit leaves the input untouched", () => {
  const o = g();
  const snapshot = JSON.stringify(o);
  setLeftBearing(o, 5);
  setRightBearing(o, 5);
  setAdvance(o, 5);
  setSpacing(o, { lsb: 1, rsb: 2 });
  assert.equal(JSON.stringify(o), snapshot);
});

test("edits on a glyph with no ink only change the advance", () => {
  const empty: GlyphOutline = { elements: [], advance: 300 };
  assert.equal(setLeftBearing(empty, 50).advance, 300 + 0, "there is nothing to shift, and no ink to measure from");
  assert.equal(setRightBearing(empty, 50).advance, 300);
  assert.equal(setAdvance(empty, 500).advance, 500);
  assert.equal(setSpacing(empty, { lsb: 10, rsb: 10 }).advance, 300);
});

test("left bearing on a glyph with a component moves the component and contours together", () => {
  const o: GlyphOutline = { elements: [rect(50, 0, 100, 100), comp("base", 200)], advance: 600 };
  const lookup = (id: string) => (id === "base" ? { elements: [rect(10, 0, 100, 100)] } : null);
  const out = setLeftBearing(o, 100, lookup);
  const c = out.elements[1];
  assert.ok(c.kind === "component");
  assert.equal(c.dx, 250, "the component moved by the same 50 as the contour");
  assert.deepEqual(xs(out, 0).slice(0, 2), [100, 200]);
  assert.equal(out.advance, 650);
});

test("applyBearings with a single field leaves the other as it is", () => {
  const out = applyBearings(g(), { lsb: 70 });
  assert.deepEqual(bearingsOf(out), { lsb: 70, rsb: 100, advance: 470 });
  const out2 = applyBearings(g(), { rsb: 10 });
  assert.deepEqual(bearingsOf(out2), { lsb: 50, rsb: 10, advance: 360 });
  assert.deepEqual(bearingsOf(applyBearings(g(), {})), bearingsOf(g()));
});

test("copySpacing gives a glyph the same bearings as another, whatever its own width", () => {
  const donor = g({ elements: [rect(20, 0, 500, 700)], advance: 560 });
  const target = g({ elements: [rect(90, 0, 100, 300)], advance: 400 });
  const out = copySpacing(target, bearingsOf(donor));
  assert.deepEqual(bearingsOf(out), { lsb: 20, rsb: 40, advance: 20 + 100 + 40 });
  assert.deepEqual(xs(out), [20, 120, 120, 20]);
});

test("copySpacing from a glyph with no ink changes nothing", () => {
  const out = copySpacing(g(), { lsb: null, rsb: null, advance: 300 });
  assert.deepEqual(out, g());
});

test("pairs are lists of glyph ids: the glyph beside itself and beside its neighbours, both sides", () => {
  assert.deepEqual(pairText("n", ["a", "b"]), [["n", "n"], ["a", "n"], ["n", "a"], ["b", "n"], ["n", "b"]]);
  assert.deepEqual(pairText("n", []), [["n", "n"]]);
  assert.deepEqual(pairText("n", ["n", "a"]), [["n", "n"], ["a", "n"], ["n", "a"]], "a neighbour equal to the glyph is not repeated");
  assert.deepEqual(pairText("x", ["y", "y"]), [["x", "x"], ["y", "x"], ["x", "y"]], "duplicate neighbours are listed once");
});

test("ids longer than one character stay whole in a pair", () => {
  assert.deepEqual(pairText("s-a", ["s-b"]), [["s-a", "s-a"], ["s-b", "s-a"], ["s-a", "s-b"]]);
});

test("Spacing type is the three numbers the popover edits", () => {
  const s: Spacing = { lsb: 1, rsb: 2, advance: 3 };
  assert.equal(s.advance, 3);
});

test("inkBounds reports the vertical extent, including negative heights", () => {
  const o = g({ elements: [rect(10, -150, 100, 400), rect(200, 300, 50, 500)] });
  const b = inkBounds(o)!;
  assert.equal(b.minY, -150);
  assert.equal(b.maxY, 800);
});

test("setSpacing gives the same result whichever bearing is thought of first", () => {
  const a = setSpacing(g(), { lsb: 12, rsb: 34 });
  const b = setRightBearing(setLeftBearing(g(), 12), 34);
  const c = setLeftBearing(setRightBearing(g(), 34), 12);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

import {
  BEARING_HIT_PX,
  dragBearing,
  hitBearingLine,
  type BearingLine,
} from "./writingSpacing.ts";

test("the draggable lines are the left bearing (ink left edge) and the advance edge", () => {
  const hit = (x: number, zoom = 1) => hitBearingLine(g(), { x, y: 300 }, zoom);
  assert.equal(hit(52), "lsb", "2 units from the ink's left edge");
  assert.equal(hit(449), "advance", "1 unit from the advance edge");
  assert.equal(hit(200), null, "inside the glyph, away from both");
  assert.equal(hit(60), null, "10 units from the left edge at 100% is beyond the reach");
});

test("a bearing line is only hit at a height where the cursor is over the glyph's row, so the whole column works", () => {
  assert.equal(hitBearingLine(g(), { x: 52, y: -9000 }, 1), "lsb");
  assert.equal(hitBearingLine(g(), { x: 52, y: 9000 }, 1), "lsb");
});

test("hit reach is in screen pixels", () => {
  assert.equal(BEARING_HIT_PX, 8);
  assert.equal(hitBearingLine(g(), { x: 58, y: 0 }, 1), "lsb", "8 units is 8 px at 100%");
  assert.equal(hitBearingLine(g(), { x: 59, y: 0 }, 1), null);
  assert.equal(hitBearingLine(g(), { x: 80, y: 0 }, 0.25), "lsb", "30 units is 7.5 px at 25%");
  assert.equal(hitBearingLine(g(), { x: 54, y: 0 }, 4), null, "4 units is 16 px at 400%");
});

test("when the two lines are close the nearer one wins", () => {
  const tight = g({ elements: [rect(50, 0, 300, 700)], advance: 352 });
  assert.equal(hitBearingLine(tight, { x: 351, y: 0 }, 1), "advance", "advance edge 352, ink right edge 350");
});

test("an empty glyph only has an advance line", () => {
  const empty: GlyphOutline = { elements: [], advance: 300 };
  assert.equal(hitBearingLine(empty, { x: 2, y: 0 }, 1), null);
  assert.equal(hitBearingLine(empty, { x: 300, y: 0 }, 1), "advance");
});

test("dragging the left-bearing line to x puts the ink's left edge at x and keeps the right bearing", () => {
  const out = dragBearing(g(), "lsb", 120, false, 10);
  assert.deepEqual(bearingsOf(out), { lsb: 120, rsb: 100, advance: 520 });
});

test("dragging the advance line to x sets the advance, so the right bearing follows the line", () => {
  const out = dragBearing(g(), "advance", 520, false, 10);
  assert.equal(out.advance, 520);
  assert.deepEqual(xs(out), [50, 350, 350, 50]);
});

test("a drag rounds to whole units, or to the grid when snapping is on", () => {
  assert.equal(dragBearing(g(), "advance", 520.6, false, 10).advance, 521);
  assert.equal(dragBearing(g(), "advance", 523, true, 10).advance, 520);
  assert.equal(dragBearing(g(), "advance", 526, true, 10).advance, 530);
  assert.equal(bearingsOf(dragBearing(g(), "lsb", 63, true, 10)).lsb, 60);
});

test("the advance cannot be dragged to or below zero, and the left bearing line cannot push it there", () => {
  assert.equal(dragBearing(g(), "advance", -40, false, 10).advance, 1);
  assert.equal(dragBearing(g(), "advance", 0, false, 10).advance, 1);
  const out = dragBearing(g(), "lsb", -9999, false, 10);
  assert.ok((out.advance ?? 0) >= 1, String(out.advance));
});

test("a glyph without ink ignores a left-bearing drag", () => {
  const empty: GlyphOutline = { elements: [], advance: 300 };
  assert.deepEqual(dragBearing(empty, "lsb", 50, false, 10), empty);
});

test("BearingLine is the two names a drag can have", () => {
  const l: BearingLine[] = ["lsb", "advance"];
  assert.equal(l.length, 2);
});

test("with both lines in reach, whichever is nearer wins from either side", () => {
  const tight = g({ elements: [rect(50, 0, 300, 700)], advance: 356 });
  assert.equal(hitBearingLine(tight, { x: 353, y: 0 }, 1), "advance", "advance edge is the only line near 353");
  const close = g({ elements: [rect(50, 0, 300, 700)], advance: 55 });
  assert.equal(hitBearingLine(close, { x: 52, y: 0 }, 1), "lsb", "2 from the ink edge at 50, 3 from the advance at 55");
  assert.equal(hitBearingLine(close, { x: 54, y: 0 }, 1), "advance", "1 from the advance at 55, 4 from the ink edge");
});

import {
  cellEdgeHit,
  cellXToGlyph,
  glyphXToCell,
  spacingDragResult,
} from "./writingSpacing.ts";

test("a cell maps glyph x to pixels and back using its view box", () => {
  const box = { x: -250, w: 1000 };
  near(glyphXToCell(box, 100, 0), 25);
  near(glyphXToCell(box, 100, 250), 50);
  near(glyphXToCell(box, 100, -250), 0);
  near(glyphXToCell(box, 100, 750), 100);
  near(cellXToGlyph(box, 100, glyphXToCell(box, 100, 321)), 321);
  assert.equal(cellXToGlyph(box, 0, 5), box.x, "a zero-width cell does not divide by zero");
});

test("the cell edges are the ink's left edge (as the left bearing) and the advance edge", () => {
  const box = { x: -250, w: 1000 };
  const o = g();
  const px = (x: number) => glyphXToCell(box, 100, x);
  assert.equal(cellEdgeHit(o, box, 100, px(50) + 2), "lsb");
  assert.equal(cellEdgeHit(o, box, 100, px(450) - 3), "advance");
  assert.equal(cellEdgeHit(o, box, 100, px(200)), null);
  assert.equal(cellEdgeHit(o, box, 100, px(50) + 9), null, "9 px away is out of reach");
});

test("in a cell the edge reach is fixed in pixels, even for a tiny cell", () => {
  const box = { x: -250, w: 1000 };
  const px = (x: number) => glyphXToCell(box, 48, x);
  assert.equal(cellEdgeHit(g(), box, 48, px(450) + 5), "advance");
});

test("dragging an edge by pixels changes the glyph by the matching units", () => {
  const box = { x: -250, w: 1000 };
  const start = g();
  const px0 = glyphXToCell(box, 100, 450);
  const out = spacingDragResult(start, "advance", box, 100, px0 + 10, false, 10);
  assert.equal(out.advance, 450 + 100, "10 px in a 100 px cell showing 1000 units is 100 units");
  const lsb = spacingDragResult(start, "lsb", box, 100, glyphXToCell(box, 100, 50) + 5, false, 10);
  assert.equal(bearingsOf(lsb).lsb, 100);
  assert.equal(bearingsOf(lsb).rsb, 100, "right bearing is unchanged by a left-bearing drag");
});

test("a spacing drag snaps to the grid when asked", () => {
  const box = { x: -250, w: 1000 };
  const px0 = glyphXToCell(box, 100, 450);
  assert.equal(spacingDragResult(g(), "advance", box, 100, px0 + 1.3, true, 50).advance, 450);
  assert.equal(spacingDragResult(g(), "advance", box, 100, px0 + 3, true, 50).advance, 500);
});

import { pairLayout, pickNeighbours } from "./writingSpacing.ts";

const mk = (ink: [number, number], adv: number | null): GlyphOutline => ({
  elements: [rect(ink[0], 0, ink[1] - ink[0], 600)],
  advance: adv,
});

test("pairLayout places each glyph's advance box after the previous one", () => {
  const a = mk([50, 350], 400);
  const b = mk([20, 220], 260);
  const lay = pairLayout([a, b]);
  assert.deepEqual(lay.offsets, [0, 400]);
  assert.equal(lay.total, 660);
});

test("pairLayout gaps are the whitespace between the ink of neighbouring glyphs", () => {
  const a = mk([50, 350], 450);
  const b = mk([30, 230], 280);
  const lay = pairLayout([a, b]);
  assert.deepEqual(lay.gaps, [100 + 30]);
  const c = mk([0, 100], 100);
  assert.deepEqual(pairLayout([c, c]).gaps, [0], "touching letters have no gap");
});

test("a glyph with no ink has no gap on either side and still advances", () => {
  const space: GlyphOutline = { elements: [], advance: 250 };
  const a = mk([50, 350], 400);
  const lay = pairLayout([a, space, a]);
  assert.deepEqual(lay.offsets, [0, 400, 650]);
  assert.deepEqual(lay.gaps, [null, null]);
});

test("pairLayout of one glyph or none has no gaps", () => {
  assert.deepEqual(pairLayout([mk([0, 10], 20)]).gaps, []);
  assert.deepEqual(pairLayout([]), { offsets: [], total: 0, gaps: [] });
});

test("pickNeighbours takes the glyphs before and after in order, without the glyph itself, wrapping at the ends", () => {
  const ids = ["a", "b", "c", "d", "e"];
  assert.deepEqual(pickNeighbours(ids, "c", 1), ["b", "d"]);
  assert.deepEqual(pickNeighbours(ids, "a", 1), ["e", "b"]);
  assert.deepEqual(pickNeighbours(ids, "e", 2), ["c", "d", "a", "b"]);
  assert.deepEqual(pickNeighbours(["a"], "a", 1), []);
  assert.deepEqual(pickNeighbours(["a", "b"], "a", 1), ["b"], "a single other glyph is listed once");
  assert.deepEqual(pickNeighbours(ids, "zz", 1), []);
});

test("a neighbour list never includes the glyph itself, even when wrapping lands on it", () => {
  assert.equal(pickNeighbours(["a", "b", "c"], "a", 3).includes("a"), false);
  assert.deepEqual(pickNeighbours(["a", "b", "c"], "b", 3).sort(), ["a", "c"]);
  assert.deepEqual(pickNeighbours(["x", "y"], "x", 4), ["y"]);
});
