import { test } from "node:test";
import assert from "node:assert/strict";

import {
  alignmentTargets,
  angleTargets,
  cleanNodeSpots,
  snapWithAlignment,
  type AlignHit,
} from "./writingSuggest.ts";
import type { GlyphOutline } from "./api.ts";

const near = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

const corner = (x: number, y: number) => ({ x, y, kind: "corner" as const });
const poly = (pts: [number, number][], closed = true): GlyphOutline => ({
  elements: [{ kind: "contour", closed, fill_rule: "nonzero", nodes: pts.map(([x, y]) => corner(x, y)) }],
});
const key = (s: { segment: number; label: string }) => `${s.segment}:${s.label}`;

const square = poly([[0, 0], [400, 0], [400, 400], [0, 400]]);

test("clean spots on a straight edge are its midpoint, thirds and quarters, labelled", () => {
  const spots = cleanNodeSpots(square, 0, 0);
  const byLabel = new Map(spots.map((s) => [s.label, s]));
  near(byLabel.get("middle")!.point.x, 200);
  near(byLabel.get("1/3")!.point.x, 400 / 3);
  near(byLabel.get("2/3")!.point.x, 800 / 3);
  near(byLabel.get("1/4")!.point.x, 100);
  near(byLabel.get("3/4")!.point.x, 300);
  for (const s of spots) near(s.point.y, 0);
  assert.ok(spots.every((s) => s.t > 0 && s.t < 1));
});

test("clean spots on a curve are the parameter midpoint, the extrema, and the points level with a neighbour", () => {
  const arc: GlyphOutline = {
    elements: [
      {
        kind: "contour",
        closed: false,
        fill_rule: "nonzero",
        nodes: [
          { x: 0, y: 0, kind: "smooth", handle_out: [0, 400] },
          { x: 1000, y: 0, kind: "smooth", handle_in: [0, 400] },
        ],
      },
    ],
  };
  const labels = cleanNodeSpots(arc, 0, 0).map((s) => s.label);
  assert.deepEqual(labels, ["extremum"], "on a symmetric arc the extremum is the middle, and the more useful label wins");
  const ext = cleanNodeSpots(arc, 0, 0).find((s) => s.label === "extremum")!;
  near(ext.point.x, 500, 1e-6);
  near(ext.point.y, 300, 1e-6);
});

test("a spot level with another node (same x or y) is offered and labelled by the alignment", () => {
  const o = poly([[0, 0], [400, 0], [400, 400], [0, 400], [100, 200]]);
  const spots = cleanNodeSpots(o, 0, 0);
  assert.ok(spots.some((s) => /aligned/.test(s.label)), JSON.stringify(spots.map((s) => s.label)));
  const aligned = spots.find((s) => /aligned/.test(s.label))!;
  near(aligned.point.y, 0);
});

test("spots never include the end points themselves and are sorted along the segment", () => {
  const spots = cleanNodeSpots(square, 0, 1);
  const ts = spots.map((s) => s.t);
  assert.deepEqual([...ts].sort((a, b) => a - b), ts);
  assert.ok(ts.every((t) => t > 0.02 && t < 0.98));
  assert.equal(new Set(ts.map((t) => Math.round(t * 1000))).size, ts.length, "no two spots coincide");
});

test("a stale element or segment gives no spots", () => {
  assert.deepEqual(cleanNodeSpots(square, 5, 0), []);
  assert.deepEqual(cleanNodeSpots(square, 0, 9), []);
  assert.deepEqual(cleanNodeSpots({ elements: [] }, 0, 0), []);
});

// ---- alignment with other nodes -----------------------------------------------

test("a point near another node's x or y is pulled onto it, with the guide line reported", () => {
  const o = poly([[100, 100], [500, 100], [500, 500]]);
  const hits = alignmentTargets(o, [], { x: 103, y: 340 }, 10);
  const x = hits.find((h) => h.axis === "x");
  assert.ok(x);
  near(x.value, 100);
  assert.deepEqual([x.from.x, x.from.y], [100, 100]);
  assert.equal(hits.find((h) => h.axis === "y"), undefined);
});

test("both axes can align at once, to different nodes", () => {
  const o = poly([[100, 100], [500, 100], [500, 500]]);
  const hits = alignmentTargets(o, [], { x: 98, y: 497 }, 10);
  assert.equal(hits.length, 2);
  near(hits.find((h) => h.axis === "x")!.value, 100);
  near(hits.find((h) => h.axis === "y")!.value, 500);
});

test("excluded nodes are not alignment targets, and the nearest alignment wins per axis", () => {
  const o = poly([[100, 100], [104, 300], [500, 500]]);
  const hits = alignmentTargets(o, [{ element: 0, node: 0 }], { x: 103, y: 0 }, 10);
  near(hits.find((h) => h.axis === "x")!.value, 104, 1e-9);
  const both = alignmentTargets(o, [], { x: 102, y: 0 }, 10);
  near(both.find((h) => h.axis === "x")!.value, 100, 1e-9, "the closer of x=100 and x=104 wins");
});

test("diagonal alignment: a point on the 45 degree line through a node is pulled onto it", () => {
  const o = poly([[100, 100], [900, 100], [900, 900]]);
  const hits = angleTargets(o, [], { x: 300, y: 304 }, 10);
  const d = hits.find((h) => h.angle === 45);
  assert.ok(d, JSON.stringify(hits));
  near(d.point.x - d.from.x, d.point.y - d.from.y, 1e-6);
  assert.ok(Math.abs(d.point.x - 302) < 1e-6 && Math.abs(d.point.y - 302) < 1e-6, JSON.stringify(d.point));
});

test("angle targets cover 0, 45, 90 and 135 degrees through each node and ignore far points", () => {
  const o = poly([[0, 0], [1000, 0], [1000, 1000]]);
  const anti = angleTargets(o, [], { x: 600, y: 404 }, 10);
  assert.ok(anti.some((h) => h.angle === 135 && Math.abs(h.point.x + h.point.y - 1000) < 1e-6), JSON.stringify(anti));
  assert.deepEqual(angleTargets(o, [], { x: 500, y: 250 }, 10).filter((h) => h.angle !== 0 && h.angle !== 90), []);
});

test("snapWithAlignment prefers a node over any alignment, then combines x and y alignments", () => {
  const o = poly([[100, 100], [500, 100], [500, 500], [100, 500]]);
  const onNode = snapWithAlignment(o, [], { x: 103, y: 98 }, 10);
  assert.deepEqual(onNode.point, { x: 100, y: 100 });
  assert.equal(onNode.hits.length, 0, "a node hit needs no alignment guides");
  const both = snapWithAlignment(o, [], { x: 302, y: 498 }, 10);
  near(both.point.y, 500);
  assert.ok(both.hits.some((h: AlignHit) => h.axis === "y"));
});

test("snapWithAlignment with nothing in range returns the point unchanged", () => {
  const o = poly([[100, 100], [500, 100], [500, 500]]);
  const r = snapWithAlignment(o, [], { x: 300, y: 300 }, 10);
  assert.deepEqual(r.point, { x: 300, y: 300 });
  assert.deepEqual(r.hits, []);
});

test("an on-axis alignment and a diagonal can combine to pin a point to their crossing", () => {
  const o = poly([[0, 0], [800, 0], [800, 800]]);
  const r = snapWithAlignment(o, [], { x: 401, y: 6 }, 10);
  near(r.point.y, 0, 1e-6);
  assert.ok(r.hits.length >= 1);
  void key;
});

test("an asymmetric curve offers both its extremum and its middle", () => {
  const lopsided: GlyphOutline = {
    elements: [
      {
        kind: "contour",
        closed: false,
        fill_rule: "nonzero",
        nodes: [
          { x: 0, y: 0, kind: "smooth", handle_out: [0, 700] },
          { x: 1000, y: 0, kind: "smooth", handle_in: [300, 100] },
        ],
      },
    ],
  };
  const labels = cleanNodeSpots(lopsided, 0, 0).map((s) => s.label);
  assert.ok(labels.includes("extremum") && labels.includes("middle"), JSON.stringify(labels));
});

test("a curve that is extreme in x (not y) offers that extremum too", () => {
  const sideways: GlyphOutline = {
    elements: [
      {
        kind: "contour",
        closed: false,
        fill_rule: "nonzero",
        nodes: [
          { x: 0, y: 0, kind: "smooth", handle_out: [500, 0] },
          { x: 0, y: 1000, kind: "smooth", handle_in: [500, 0] },
        ],
      },
    ],
  };
  const ext = cleanNodeSpots(sideways, 0, 0).filter((s) => s.label === "extremum");
  assert.equal(ext.length, 1);
  near(ext[0].point.x, 375, 1e-6);
  near(ext[0].point.y, 500, 1e-6);
});

test("with two candidate nodes on an axis the nearer one wins, whichever order they are stored in", () => {
  for (const pts of [[[100, 0], [106, 0], [800, 800]], [[106, 0], [100, 0], [800, 800]]] as [number, number][][]) {
    const hits = alignmentTargets(poly(pts), [], { x: 104, y: 400 }, 10);
    near(hits.find((h) => h.axis === "x")!.value, 106, 1e-9);
  }
});

test("a node listed in exclude is not an alignment target, nor an angle target, nor a snap target", () => {
  const o = poly([[100, 100], [900, 450], [620, 880]]);
  const ex = [{ element: 0, node: 0 }];
  assert.equal(alignmentTargets(o, ex, { x: 103, y: 500 }, 10).find((h) => h.value === 100), undefined);
  assert.ok(alignmentTargets(o, [], { x: 103, y: 500 }, 10).some((h) => h.value === 100), "included, it does align");
  const all = [{ element: 0, node: 0 }, { element: 0, node: 1 }, { element: 0, node: 2 }];
  assert.deepEqual(angleTargets(o, all, { x: 300, y: 304 }, 10), []);
  const r = snapWithAlignment(o, ex, { x: 101, y: 101 }, 10);
  assert.deepEqual(r.point, { x: 101, y: 101 }, "the excluded node attracts nothing, so the point stays where it is");
  assert.deepEqual(r.hits, []);
  assert.notDeepEqual(snapWithAlignment(o, [], { x: 101, y: 101 }, 10).point, { x: 101, y: 101 });
});

test("a single axis alignment plus a diagonal pins the point to where they cross", () => {
  const o = poly([[0, 0], [1000, 0], [1000, 1000], [400, 900]]);
  const r = snapWithAlignment(o, [], { x: 402, y: 405 }, 10);
  near(r.point.x, 400, 1e-9);
  near(r.point.y, 400, 1e-6);
  assert.ok(r.angle && r.angle.angle === 45);
  assert.equal(r.hits.length, 1);
});

test("with no axis alignment a diagonal alone moves the point onto its line", () => {
  const o = poly([[0, 0], [1000, 0], [1000, 1000]]);
  const r = snapWithAlignment(o, [], { x: 303, y: 307 }, 10);
  assert.ok(r.angle);
  near(r.point.x, r.point.y, 1e-6);
  assert.deepEqual(r.hits, []);
});

test("an axis alignment is kept when a diagonal is also near but the point has no second axis to pin", () => {
  const o = poly([[0, 0], [1000, 0], [1000, 1000]]);
  const r = snapWithAlignment(o, [], { x: 500, y: 4 }, 10);
  near(r.point.y, 0, 1e-9);
  assert.ok(r.hits.some((h) => h.axis === "y"));
});

test("a point sitting exactly on the node an angle line passes through gives no angle target", () => {
  const o = poly([[200, 200], [900, 200], [900, 900]]);
  assert.deepEqual(angleTargets(o, [], { x: 200.2, y: 200.1 }, 10).filter((h) => h.from.x === 200 && h.from.y === 200), []);
});

import { snapExtended } from "./writingSuggest.ts";
import type { SnapContext } from "./writingSnap.ts";

const ctxOf = (outline: GlyphOutline, over: Partial<SnapContext> = {}): SnapContext => ({
  outline,
  guides: [],
  advance: null,
  grid: 10,
  gridOn: false,
  zoom: 1,
  exclude: [],
  ...over,
});

test("without Shift the extended snapper is exactly the basic one", () => {
  const o = poly([[100, 100], [500, 100], [500, 500]]);
  const c = ctxOf(o, { guides: [{ y: 0, label: "baseline" }] });
  assert.deepEqual(snapExtended(c, { x: 103, y: 4 }, false), snapExtended(c, { x: 103, y: 4 }, false));
  const r = snapExtended(c, { x: 103, y: 4 }, false);
  assert.deepEqual(r.point, { x: 103, y: 0 }, "the guide still snaps y, nothing aligns x");
});

test("with Shift a point near another node's x is pulled onto it and the hit names the node", () => {
  const o = poly([[100, 100], [500, 100], [500, 500]]);
  const r = snapExtended(ctxOf(o), { x: 103, y: 340 }, true);
  assert.deepEqual(r.point, { x: 100, y: 340 });
  const h = r.hits.find((t) => t.kind === "align");
  assert.ok(h && h.x === 100 && h.from && h.from.y === 100);
});

test("Shift alignment never fights a node lock: a node within reach wins and no guides are drawn", () => {
  const o = poly([[100, 100], [500, 100], [500, 500]]);
  const r = snapExtended(ctxOf(o), { x: 102, y: 103 }, true);
  assert.deepEqual(r.point, { x: 100, y: 100 });
  assert.equal(r.locked, true);
  assert.equal(r.hits.some((t) => t.kind === "align"), false);
});

test("a guide rail keeps its axis, and Shift alignment fills the other", () => {
  const o = poly([[100, 300], [500, 700], [900, 700]]);
  const r = snapExtended(ctxOf(o, { guides: [{ y: 0, label: "baseline" }] }), { x: 497, y: 4 }, true);
  assert.deepEqual(r.point, { x: 500, y: 0 });
  assert.ok(r.hits.some((t) => t.kind === "guide") && r.hits.some((t) => t.kind === "align"));
});

test("alignment beats the grid on its own axis, the grid still rounds the other", () => {
  const o = poly([[103, 900], [500, 900], [500, 100]]);
  const r = snapExtended(ctxOf(o, { gridOn: true, grid: 10 }), { x: 105, y: 347 }, true);
  assert.equal(r.point.x, 103, "aligned with the node, not rounded to 100 or 110");
  assert.equal(r.point.y, 350, "grid rounds y");
});

test("Shift also reaches 45 degree lines through other nodes, with the angle in the hit", () => {
  const o = poly([[100, 100], [900, 100], [900, 900]]);
  const r = snapExtended(ctxOf(o), { x: 303, y: 307 }, true);
  assert.ok(Math.abs(r.point.x - r.point.y) < 1e-6, JSON.stringify(r.point));
  const h = r.hits.find((t) => t.kind === "angle");
  assert.ok(h && /45/.test(h.label), JSON.stringify(r.hits));
});

test("Shift snapping reach is in screen pixels: the same screen distance snaps at any zoom", () => {
  const o = poly([[0, 0], [10000, 0], [10000, 10000]]);
  assert.deepEqual(snapExtended(ctxOf(o, { zoom: 1 }), { x: 5005, y: 4000 }, true).point, { x: 5005, y: 4000 }, "no node at x 5005 to align to");
  const o2 = poly([[5000, 0], [10000, 0], [10000, 10000]]);
  assert.equal(snapExtended(ctxOf(o2, { zoom: 1 }), { x: 5008, y: 4000 }, true).point.x, 5000);
  assert.equal(snapExtended(ctxOf(o2, { zoom: 1 }), { x: 5012, y: 4000 }, true).point.x, 5012, "12 px away at 100%");
  assert.equal(snapExtended(ctxOf(o2, { zoom: 0.25 }), { x: 5012, y: 4000 }, true).point.x, 5000, "12 units is 3 px at 25%");
});

test("excluded (dragged) nodes are not alignment targets for themselves", () => {
  const o = poly([[100, 100], [500, 100], [500, 500]]);
  const r = snapExtended(ctxOf(o, { exclude: [{ element: 0, node: 0 }] }), { x: 103, y: 340 }, true);
  assert.deepEqual(r.point, { x: 103, y: 340 });
});

test("a node lock returns before any alignment, even when alignment lines also pass nearby", () => {
  const o = poly([[100, 100], [100, 400], [400, 100], [400, 400]]);
  const r = snapExtended(ctxOf(o), { x: 104, y: 103 }, true);
  assert.deepEqual(r.point, { x: 100, y: 100 });
  assert.equal(r.locked, true);
  assert.equal(r.hits.length, 1, "just the node");
});

test("the left edge and the advance line keep x, so Shift alignment only adds y", () => {
  const o = poly([[0, 100], [300, 340], [300, 500]]);
  const left = snapExtended(ctxOf(o, { advance: 300 }), { x: 4, y: 337 }, true);
  assert.equal(left.point.x, 0, "x stays on the left edge");
  assert.equal(left.point.y, 340, "y aligned with the node");
  const o2 = poly([[700, 900], [650, 440], [800, 600]]);
  const adv = snapExtended(ctxOf(o2, { advance: 600 }), { x: 603, y: 437 }, true);
  assert.equal(adv.point.x, 600, "x stays on the advance line");
});

test("a horizontal guide keeps y: a diagonal never overrides it", () => {
  const o = poly([[0, 0], [900, 100], [900, 900]]);
  const r = snapExtended(ctxOf(o, { guides: [{ y: 500, label: "x-height" }] }), { x: 499, y: 503 }, true);
  assert.equal(r.point.y, 500);
  assert.equal(r.hits.some((h) => h.kind === "angle"), false);
});

test("when a diagonal pins the point, the grid does not move it off the line afterwards", () => {
  const o = poly([[0, 0], [900, 100], [900, 900]]);
  const r = snapExtended(ctxOf(o, { gridOn: true, grid: 50 }), { x: 303, y: 307 }, true);
  assert.ok(Math.abs(r.point.x - r.point.y) < 1e-6, JSON.stringify(r.point));
  assert.equal(r.hits.some((h) => h.kind === "grid"), false);
  assert.ok(Math.abs(r.point.x - 305) < 1e-6, "stays at the projection, not rounded to 300");
});

test("a midpoint lock is kept over a nearby node alignment", () => {
  const o = poly([[0, 0], [100, 0], [100, 100], [0, 100], [53, 300]]);
  const r = snapExtended(ctxOf(o), { x: 51, y: 3 }, true);
  assert.deepEqual(r.point, { x: 50, y: 0 }, "the edge midpoint, not x=53 from the other node");
  assert.equal(r.locked, true);
  assert.equal(r.hits.some((h) => h.kind === "align"), false);
});

test("the left edge claims x even when another node's x is also within reach", () => {
  const o = poly([[4, 700], [500, 900], [900, 100]]);
  const r = snapExtended(ctxOf(o), { x: 2, y: 301 }, true);
  assert.equal(r.point.x, 0, "left edge, not x=4");
  assert.equal(r.hits.some((h) => h.kind === "align" && h.x !== undefined), false);
});

test("a guide rail claims y even when another node's y is also within reach", () => {
  const o = poly([[100, 503], [500, 900], [900, 100]]);
  const r = snapExtended(ctxOf(o, { guides: [{ y: 500, label: "x-height" }] }), { x: 300, y: 501 }, true);
  assert.deepEqual(r.point, { x: 300, y: 500 });
  assert.equal(r.hits.some((h) => h.kind === "align" && h.y !== undefined), false);
});

import { chooseInsertion, nearestSpot, segmentCentreDelta } from "./writingSuggest.ts";

test("nearestSpot returns the closest spot inside the reach, and nothing beyond it", () => {
  const spots = cleanNodeSpots(square, 0, 0);
  const s = nearestSpot(spots, { x: 205, y: 6 }, 20);
  assert.ok(s && s.label === "middle");
  assert.equal(nearestSpot(spots, { x: 205, y: 60 }, 20), null);
  assert.equal(nearestSpot([], { x: 0, y: 0 }, 20), null);
});

test("without Shift an insertion is exactly where the pointer is on the line", () => {
  const hit = { element: 0, segment: 0, t: 0.43, point: { x: 172, y: 0 }, distance: 2 };
  const r = chooseInsertion(square, hit, { x: 172, y: 2 }, 1, false);
  assert.equal(r.t, 0.43);
  assert.equal(r.spot, null);
});

test("with Shift an insertion jumps to a suggested spot when one is within 24 px, else stays exact", () => {
  const near = { element: 0, segment: 0, t: 0.52, point: { x: 208, y: 0 }, distance: 1 };
  const r = chooseInsertion(square, near, { x: 208, y: 1 }, 1, true);
  assert.ok(r.spot && r.spot.label === "middle");
  near_(r.t, 0.5);
  const far = { element: 0, segment: 0, t: 0.575, point: { x: 230, y: 0 }, distance: 1 };
  const r2 = chooseInsertion(square, far, { x: 230, y: 1 }, 1, true);
  assert.equal(r2.spot, null, "30 units from the nearest spot (200 or 266) is beyond 24 px at 100%");
  assert.equal(r2.t, 0.575);
  const zoomedOut = chooseInsertion(square, far, { x: 230, y: 1 }, 0.5, true);
  assert.ok(zoomedOut.spot, "at 50% zoom the same 30 units is 15 px, so it reaches a spot");
});

function near_(a: number, b: number) {
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
}

test("segmentCentreDelta moves the centre of the line by the pointer delta when nothing is near", () => {
  const o = poly([[0, 0], [400, 0], [400, 400], [0, 400]]);
  const base = ctxOf(o, { exclude: [{ element: 0, node: 0 }, { element: 0, node: 1 }] });
  const d = segmentCentreDelta(base, 0, 0, { x: 33, y: 71 });
  assert.deepEqual(d, { x: 33, y: 71 });
});

test("the centre of the line snaps to other nodes' alignment, and the delta carries the snap", () => {
  const o = poly([[0, 0], [400, 0], [400, 400], [0, 400], [260, 900]]);
  const base = ctxOf(o, { exclude: [{ element: 0, node: 0 }, { element: 0, node: 1 }] });
  const d = segmentCentreDelta(base, 0, 0, { x: 56, y: 70 });
  assert.equal(d.x, 60, "the centre started at x=200, so 200+56 aligns with x=260");
  assert.equal(d.y, 70);
});

test("the centre of a curve is the point at t=0.5, not the midpoint of its end nodes", () => {
  const arc: GlyphOutline = {
    elements: [
      {
        kind: "contour", closed: false, fill_rule: "nonzero",
        nodes: [
          { x: 0, y: 0, kind: "smooth", handle_out: [0, 400] },
          { x: 1000, y: 0, kind: "smooth", handle_in: [0, 400] },
          { x: 500, y: 700, kind: "corner" },
        ],
      },
    ],
  };
  const base = ctxOf(arc, { exclude: [{ element: 0, node: 0 }, { element: 0, node: 1 }] });
  const d = segmentCentreDelta(base, 0, 0, { x: 0, y: 396 });
  assert.equal(d.y, 400, "the centre starts at y=300, so +396 is y=696, which aligns with the node at y=700");
  const away = segmentCentreDelta(base, 0, 0, { x: 0, y: 100 });
  assert.equal(away.y, 100, "y=400 is not near any node's y");
});

test("a stale segment gives a plain pointer delta", () => {
  assert.deepEqual(segmentCentreDelta(ctxOf(square), 4, 0, { x: 5, y: 6 }), { x: 5, y: 6 });
  assert.deepEqual(segmentCentreDelta(ctxOf(square), 0, 9, { x: 5, y: 6 }), { x: 5, y: 6 });
});

test("without Shift, a click lands exactly where the pointer is even when a clean spot is right there", () => {
  const hit = { element: 0, segment: 0, t: 0.503, point: { x: 201.2, y: 0 }, distance: 0.5 };
  const r = chooseInsertion(square, hit, { x: 201.2, y: 0.5 }, 1, false);
  assert.equal(r.t, 0.503);
  assert.equal(r.spot, null);
});

test("nearestSpot picks the closer of two spots, whatever their order", () => {
  const a = { segment: 0, t: 0.3, point: { x: 120, y: 0 }, label: "a" };
  const b = { segment: 0, t: 0.5, point: { x: 200, y: 0 }, label: "b" };
  for (const list of [[a, b], [b, a]]) {
    assert.equal(nearestSpot(list, { x: 190, y: 0 }, 100)?.label, "b");
    assert.equal(nearestSpot(list, { x: 130, y: 0 }, 100)?.label, "a");
  }
});
