import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contourDirection,
  contourStart,
  formatAngle,
  formatCoord,
  formatDistance,
  guideLabel,
  guideLabelPlacement,
  infoReadout,
  measureFrom,
  openEnds,
  zoomLabel,
  GUIDE_LABELS,
} from "./writingInfo.ts";
import type { GlyphContour } from "./api.ts";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

const c = (points: [number, number][], closed = true): GlyphContour => ({
  closed,
  fill_rule: "nonzero",
  nodes: points.map(([x, y]) => ({ x, y, kind: "corner" as const })),
});

test("guide labels are short, readable names", () => {
  assert.equal(guideLabel("ascender"), "ascender");
  assert.equal(guideLabel("cap_height"), "cap height");
  assert.equal(guideLabel("x_height"), "x-height");
  assert.equal(guideLabel("baseline"), "baseline");
  assert.equal(guideLabel("descender"), "descender");
  assert.equal(guideLabel("mystery"), "mystery");
  assert.deepEqual(Object.keys(GUIDE_LABELS).sort(), ["ascender", "baseline", "cap_height", "descender", "x_height"]);
});

test("a guide label with its height reads 'baseline 0' and 'x-height 500'", () => {
  assert.equal(guideLabelPlacement("baseline", 0, 0).text, "baseline 0");
  assert.equal(guideLabelPlacement("x_height", 500, 0).text, "x-height 500");
  assert.equal(guideLabelPlacement("descender", -200, 0).text, "descender -200");
});

test("labels sit at the left edge of the view, so they stay visible when panned", () => {
  assert.equal(guideLabelPlacement("baseline", 0, -340).x, -340);
  assert.equal(guideLabelPlacement("baseline", 0, 55).x, 55);
});

test("coordinates are whole font units, with a clean zero and a minus sign", () => {
  assert.equal(formatCoord(12.4), "12");
  assert.equal(formatCoord(12.5), "13");
  assert.equal(formatCoord(-0.2), "0");
  assert.equal(formatCoord(-7.6), "-8");
  assert.equal(formatCoord(Number.NaN), "0");
});

test("distance is whole units and angle is degrees in y-up space", () => {
  assert.equal(formatDistance(100.4), "100");
  near(measureFrom({ x: 0, y: 0 }, { x: 3, y: 4 }).distance, 5);
  near(measureFrom({ x: 0, y: 0 }, { x: 1, y: 0 }).angle, 0);
  near(measureFrom({ x: 0, y: 0 }, { x: 0, y: 1 }).angle, 90);
  near(measureFrom({ x: 0, y: 0 }, { x: -1, y: 0 }).angle, 180);
  near(measureFrom({ x: 0, y: 0 }, { x: 0, y: -1 }).angle, 270);
  near(measureFrom({ x: 5, y: 5 }, { x: 6, y: 6 }).angle, 45);
  assert.equal(measureFrom({ x: 2, y: 2 }, { x: 2, y: 2 }).distance, 0);
});

test("formatAngle wraps into 0..359 and rounds to a whole degree", () => {
  assert.equal(formatAngle(0), "0\u00b0");
  assert.equal(formatAngle(44.6), "45\u00b0");
  assert.equal(formatAngle(359.6), "0\u00b0");
  assert.equal(formatAngle(-90), "270\u00b0");
});

test("zoom label is the scale in percent", () => {
  assert.equal(zoomLabel(1), "100%");
  assert.equal(zoomLabel(0.5), "50%");
  assert.equal(zoomLabel(0.1), "10%");
  assert.equal(zoomLabel(32), "3200%");
  assert.equal(zoomLabel(0.3333), "33%");
});

test("infoReadout shows the cursor and tool, and adds distance and angle only while dragging", () => {
  const idle = infoReadout({ cursor: { x: 120.4, y: -30.6 }, from: null, scale: 0.5, tool: "Select", layer: "Fore" });
  assert.equal(idle.cursor, "x 120  y -31");
  assert.equal(idle.measure, null);
  assert.equal(idle.zoom, "50%");
  assert.equal(idle.tool, "Select");
  assert.equal(idle.layer, "Fore");
  const drag = infoReadout({ cursor: { x: 30, y: 40 }, from: { x: 0, y: 0 }, scale: 1, tool: "Pen", layer: "Fore" });
  assert.equal(drag.measure, "d 50  \u2220 53\u00b0");
});

test("infoReadout with no cursor yet shows dashes, not a stale or NaN position", () => {
  const r = infoReadout({ cursor: null, from: null, scale: 1, tool: "Pen", layer: "Fore" });
  assert.equal(r.cursor, "x \u2013  y \u2013");
});

test("contourDirection: counter-clockwise has positive signed area (y up), clockwise negative", () => {
  assert.equal(contourDirection(c([[0, 0], [10, 0], [10, 10], [0, 10]])), "ccw");
  assert.equal(contourDirection(c([[0, 0], [0, 10], [10, 10], [10, 0]])), "cw");
  assert.equal(contourDirection(c([[0, 0], [10, 0]], false)), null, "an open contour has no direction");
  assert.equal(contourDirection(c([[0, 0], [1, 1], [2, 2]])), null, "a flat contour has none");
});

test("contourStart is the first node and the direction toward the second, as a unit vector", () => {
  const s = contourStart(c([[10, 10], [10, 110], [60, 110]]));
  assert.ok(s);
  assert.deepEqual([s!.x, s!.y], [10, 10]);
  near(s!.dx, 0);
  near(s!.dy, 1);
  assert.equal(contourStart(c([[5, 5]])), null);
  assert.equal(contourStart(c([[5, 5], [5, 5]])), null, "coincident nodes have no direction");
});

test("contourStart points along the handle when the first segment is curved", () => {
  const curved: GlyphContour = {
    closed: true,
    fill_rule: "nonzero",
    nodes: [
      { x: 0, y: 0, kind: "smooth", handle_out: [10, 0] },
      { x: 50, y: 50, kind: "corner" },
      { x: 0, y: 50, kind: "corner" },
    ],
  };
  const s = contourStart(curved);
  near(s!.dx, 1);
  near(s!.dy, 0);
});

test("openEnds lists the two end nodes of an open contour and nothing for a closed one", () => {
  assert.deepEqual(openEnds(c([[0, 0], [5, 5], [9, 0]], false)), [0, 2]);
  assert.deepEqual(openEnds(c([[0, 0], [5, 5], [9, 0]], true)), []);
  assert.deepEqual(openEnds(c([[0, 0]], false)), [0], "a lone node is one end");
  assert.deepEqual(openEnds(c([], false)), []);
});

test("a start arrow follows an outgoing handle even when the next node is somewhere else", () => {
  const s = contourStart({
    closed: true,
    fill_rule: "nonzero",
    nodes: [
      { x: 0, y: 0, kind: "smooth", handle_out: [0, 30] },
      { x: 100, y: 0, kind: "corner" },
      { x: 100, y: 100, kind: "corner" },
    ],
  });
  near(s!.dx, 0);
  near(s!.dy, 1);
});

test("a start arrow follows the next node's incoming handle when the first node has none", () => {
  const s = contourStart({
    closed: true,
    fill_rule: "nonzero",
    nodes: [
      { x: 0, y: 0, kind: "corner" },
      { x: 100, y: 0, kind: "smooth", handle_in: [0, -50] },
      { x: 100, y: 100, kind: "corner" },
    ],
  });
  near(s!.dx, 100 / Math.hypot(100, -50));
  near(s!.dy, -50 / Math.hypot(100, -50));
});

test("two nodes are not enough for a closed contour to have a direction", () => {
  assert.equal(contourDirection(c([[0, 0], [10, 10]])), null);
  assert.equal(contourDirection({ closed: true, fill_rule: "nonzero", nodes: [] }), null);
});

test("a contour that curves round to a stop still has the direction of its area", () => {
  const circle: GlyphContour = {
    closed: true,
    fill_rule: "nonzero",
    nodes: [
      { x: 10, y: 0, kind: "corner" },
      { x: 0, y: 10, kind: "corner" },
      { x: -10, y: 0, kind: "corner" },
      { x: 0, y: -10, kind: "corner" },
    ],
  };
  assert.equal(contourDirection(circle), "ccw");
});

import { crossLines, handleMarkLines } from "./writingInfo.ts";

test("crossLines makes the two diagonals of a square around a point, in the given half-size", () => {
  const [a, b] = crossLines({ x: 10, y: 20 }, 3);
  assert.deepEqual(a, { x1: 7, y1: 17, x2: 13, y2: 23 });
  assert.deepEqual(b, { x1: 7, y1: 23, x2: 13, y2: 17 });
});

test("an on-curve cross is a plus, an off-curve mark is an X", () => {
  const plus = handleMarkLines("plus", { x: 0, y: 0 }, 4);
  assert.deepEqual(plus, [
    { x1: -4, y1: 0, x2: 4, y2: 0 },
    { x1: 0, y1: -4, x2: 0, y2: 4 },
  ]);
  const x = handleMarkLines("x", { x: 0, y: 0 }, 4);
  assert.deepEqual(x, crossLines({ x: 0, y: 0 }, 4));
});
