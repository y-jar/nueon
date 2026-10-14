import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IDENTITY,
  applyPoint,
  boxCentre,
  cornerPoint,
  dialogMatrix,
  hitTransformHandle,
  isIdentity,
  multiply,
  rotateMatrix,
  scaleMatrix,
  selectionBox,
  skewMatrix,
  transformElements,
  DEFAULT_DIALOG,
  type Box,
} from "./writingTransform.ts";
import type { GlyphOutline } from "./api.ts";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);
const nearPt = (p: { x: number; y: number }, x: number, y: number, eps = 1e-9) => {
  near(p.x, x, eps);
  near(p.y, y, eps);
};

const box: Box = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const pivot = { x: 50, y: 50 };

test("multiply applies the first matrix and then the second", () => {
  const move = [1, 0, 0, 1, 10, 0] as const;
  const double = [2, 0, 0, 2, 0, 0] as const;
  nearPt(applyPoint(multiply([...move], [...double]), { x: 1, y: 1 }), 22, 2);
  nearPt(applyPoint(multiply([...double], [...move]), { x: 1, y: 1 }), 12, 2);
});

test("IDENTITY leaves points alone and isIdentity recognises it", () => {
  nearPt(applyPoint(IDENTITY, { x: 3, y: 4 }), 3, 4);
  assert.equal(isIdentity(IDENTITY), true);
  assert.equal(isIdentity([1, 0, 0, 1, 0.5, 0]), false);
});

test("cornerPoint uses y-up: nw is top-left, se is bottom-right", () => {
  assert.deepEqual(cornerPoint(box, "nw"), { x: 0, y: 100 });
  assert.deepEqual(cornerPoint(box, "se"), { x: 100, y: 0 });
  assert.deepEqual(boxCentre(box), { x: 50, y: 50 });
});

test("dragging a corner scales about the opposite corner, which stays put", () => {
  const m = scaleMatrix(box, "ne", { x: 150, y: 200 }, { keepRatio: false, fromPivot: false, pivot });
  nearPt(applyPoint(m, { x: 100, y: 100 }), 150, 200);
  nearPt(applyPoint(m, { x: 0, y: 0 }), 0, 0);
  nearPt(applyPoint(m, { x: 100, y: 0 }), 150, 0);
});

test("Shift keeps the ratio by using the larger scale on both axes", () => {
  const m = scaleMatrix(box, "ne", { x: 150, y: 120 }, { keepRatio: true, fromPivot: false, pivot });
  nearPt(applyPoint(m, { x: 100, y: 100 }), 150, 150);
  nearPt(applyPoint(m, { x: 0, y: 0 }), 0, 0);
});

test("Alt scales from the pivot (the centre by default)", () => {
  const m = scaleMatrix(box, "ne", { x: 150, y: 150 }, { keepRatio: false, fromPivot: true, pivot });
  nearPt(applyPoint(m, { x: 100, y: 100 }), 150, 150);
  nearPt(applyPoint(m, { x: 0, y: 0 }), -50, -50);
  nearPt(applyPoint(m, pivot), 50, 50);
});

test("scaling past the opposite edge flips the shape", () => {
  const m = scaleMatrix(box, "ne", { x: -100, y: 100 }, { keepRatio: false, fromPivot: false, pivot });
  nearPt(applyPoint(m, { x: 100, y: 100 }), -100, 100);
  assert.ok(m[0] < 0);
});

test("a corner handle on a flat box cannot divide by zero", () => {
  const flat: Box = { minX: 0, minY: 5, maxX: 100, maxY: 5 };
  const m = scaleMatrix(flat, "ne", { x: 150, y: 50 }, { keepRatio: false, fromPivot: false, pivot: { x: 50, y: 5 } });
  assert.ok(m.every(Number.isFinite));
  near(m[3], 1);
});

test("rotating about the pivot turns the start direction to the pointer direction", () => {
  const m = rotateMatrix(pivot, { x: 100, y: 50 }, { x: 50, y: 100 }, false);
  nearPt(applyPoint(m, { x: 100, y: 50 }), 50, 100);
  nearPt(applyPoint(m, pivot), 50, 50);
  nearPt(applyPoint(m, { x: 0, y: 50 }), 50, 0);
});

test("rotation by distance from the pivot, not by how far the pointer travelled", () => {
  const near1 = rotateMatrix(pivot, { x: 60, y: 50 }, { x: 50, y: 60 }, false);
  const far = rotateMatrix(pivot, { x: 200, y: 50 }, { x: 50, y: 200 }, false);
  near(near1[0], far[0]);
  near(near1[1], far[1]);
});

test("Shift snaps the total rotation to 15 degrees", () => {
  const at = (deg: number) => ({
    x: 50 + 100 * Math.cos((deg * Math.PI) / 180),
    y: 50 + 100 * Math.sin((deg * Math.PI) / 180),
  });
  const angleOf = (m: ReturnType<typeof rotateMatrix>) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  near(angleOf(rotateMatrix(pivot, at(0), at(20), true)), 15, 1e-6);
  near(angleOf(rotateMatrix(pivot, at(0), at(40), true)), 45, 1e-6);
  near(angleOf(rotateMatrix(pivot, at(0), at(-100), true)), -105, 1e-6);
  near(angleOf(rotateMatrix(pivot, at(0), at(20), false)), 20, 1e-6);
});

test("a pointer on the pivot gives no rotation", () => {
  assert.ok(isIdentity(rotateMatrix(pivot, { x: 100, y: 50 }, pivot, false)));
});

test("rotation takes the short way round across the 180 degree line", () => {
  const m = rotateMatrix(pivot, { x: -50, y: 49 }, { x: -50, y: 51 }, false);
  const deg = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  assert.ok(Math.abs(deg) < 5, String(deg));
});

test("dragging the top edge skews horizontally about the pivot", () => {
  const m = skewMatrix(box, "n", { x: 70, y: 100 }, pivot);
  nearPt(applyPoint(m, { x: 50, y: 100 }), 70, 100);
  nearPt(applyPoint(m, { x: 50, y: 0 }), 30, 0);
  nearPt(applyPoint(m, pivot), 50, 50);
  near(applyPoint(m, { x: 10, y: 77 }).y, 77);
});

test("dragging the right edge skews vertically about the pivot", () => {
  const m = skewMatrix(box, "e", { x: 100, y: 70 }, pivot);
  nearPt(applyPoint(m, { x: 100, y: 50 }), 100, 70);
  nearPt(applyPoint(m, { x: 0, y: 50 }), 0, 30);
  near(applyPoint(m, { x: 33, y: 10 }).x, 33);
});

test("skewing an edge that sits on the pivot does nothing, and huge drags are clamped", () => {
  assert.ok(isIdentity(skewMatrix(box, "n", { x: 90, y: 100 }, { x: 50, y: 100 })));
  const m = skewMatrix(box, "n", { x: 1e9, y: 100 }, pivot);
  assert.ok(Math.abs(m[2]) <= 10.0001);
});

test("every transform leaves its pivot where it was", () => {
  const p = { x: 30, y: 70 };
  const ms = [
    scaleMatrix(box, "se", { x: 140, y: -40 }, { keepRatio: false, fromPivot: true, pivot: p }),
    rotateMatrix(p, { x: 90, y: 70 }, { x: 10, y: 120 }, false),
    skewMatrix(box, "w", { x: 0, y: 90 }, p),
  ];
  for (const m of ms) nearPt(applyPoint(m, p), p.x, p.y, 1e-9);
});

test("hit testing: pivot, then corner scale, then edge skew, then the outside rotate ring", () => {
  const unit = 1;
  assert.deepEqual(hitTransformHandle(box, pivot, { x: 50, y: 50 }, unit), { kind: "pivot", which: "c" });
  assert.deepEqual(hitTransformHandle(box, pivot, { x: 101, y: 99 }, unit), { kind: "scale", which: "ne" });
  assert.deepEqual(hitTransformHandle(box, pivot, { x: 2, y: 2 }, unit), { kind: "scale", which: "sw" });
  assert.deepEqual(hitTransformHandle(box, pivot, { x: 50, y: 101 }, unit), { kind: "skew", which: "n" });
  assert.deepEqual(hitTransformHandle(box, pivot, { x: 99, y: 50 }, unit), { kind: "skew", which: "e" });
  assert.deepEqual(hitTransformHandle(box, pivot, { x: 112, y: 112 }, unit), { kind: "rotate", which: "ne" });
  assert.deepEqual(hitTransformHandle(box, pivot, { x: -10, y: -10 }, unit), { kind: "rotate", which: "sw" });
});

test("hit testing: nothing in empty space, inside the box, or far outside", () => {
  assert.equal(hitTransformHandle(box, pivot, { x: 25, y: 25 }, 1), null);
  assert.equal(hitTransformHandle(box, pivot, { x: 300, y: 300 }, 1), null);
  assert.equal(hitTransformHandle(box, pivot, { x: 50, y: 150 }, 1), null, "far above an edge is not a handle");
});

test("hit radii are in screen pixels, so they grow when the view is zoomed out", () => {
  assert.equal(hitTransformHandle(box, pivot, { x: 120, y: 120 }, 1), null);
  assert.deepEqual(hitTransformHandle(box, pivot, { x: 120, y: 120 }, 4), { kind: "rotate", which: "ne" });
  assert.deepEqual(hitTransformHandle(box, pivot, { x: 130, y: 130 }, 4), { kind: "rotate", which: "ne" });
});

const corner = (x: number, y: number) => ({ x, y, kind: "corner" as const });
const rect = (x: number, y: number, w: number, h: number) => ({
  kind: "contour" as const,
  closed: true,
  fill_rule: "nonzero" as const,
  nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)],
});
const comp = (dx: number, dy: number, over = {}) => ({
  kind: "component" as const,
  glyph: "a",
  dx,
  dy,
  scale_x: 1,
  scale_y: 1,
  rotation: 0,
  ...over,
});

test("selectionBox is the union of the selected elements' nodes", () => {
  const o: GlyphOutline = { elements: [rect(0, 0, 10, 10), rect(100, 50, 20, 20), rect(500, 500, 5, 5)] };
  assert.deepEqual(selectionBox(o, [0, 1]), { minX: 0, minY: 0, maxX: 120, maxY: 70 });
  assert.equal(selectionBox(o, []), null);
  assert.equal(selectionBox(o, [9]), null);
});

test("transformElements moves only the chosen contours and leaves the input alone", () => {
  const o: GlyphOutline = { elements: [rect(0, 0, 10, 10), rect(100, 0, 10, 10)] };
  const r = transformElements(o, [1], [1, 0, 0, 1, 5, 7]);
  assert.equal(r.skipped, 0);
  const moved = r.outline.elements[1];
  assert.ok(moved.kind === "contour");
  assert.deepEqual([moved.nodes[0].x, moved.nodes[0].y], [105, 7]);
  assert.deepEqual(r.outline.elements[0], o.elements[0]);
  const orig = o.elements[1];
  assert.ok(orig.kind === "contour" && orig.nodes[0].x === 100);
});

test("transformElements carries handles through the linear part only", () => {
  const o: GlyphOutline = {
    elements: [
      {
        kind: "contour",
        closed: false,
        fill_rule: "nonzero",
        nodes: [{ x: 0, y: 0, kind: "smooth", handle_out: [10, 0] }, corner(50, 0)],
      },
    ],
  };
  const r = transformElements(o, [0], [2, 0, 0, 2, 100, 100]);
  const c = r.outline.elements[0];
  assert.ok(c.kind === "contour");
  assert.deepEqual(c.nodes[0].handle_out, [20, 0]);
  assert.equal(c.nodes[0].x, 100);
});

test("a component takes a move, a uniform scale and a rotation by composing them", () => {
  const o: GlyphOutline = { elements: [comp(10, 20)] };
  const moved = transformElements(o, [0], [1, 0, 0, 1, 5, 5]);
  const a = moved.outline.elements[0];
  assert.ok(a.kind === "component");
  assert.deepEqual([a.dx, a.dy, a.scale_x, a.rotation], [15, 25, 1, 0]);

  const grown = transformElements(o, [0], [2, 0, 0, 2, 0, 0]);
  const b = grown.outline.elements[0];
  assert.ok(b.kind === "component");
  assert.deepEqual([b.dx, b.dy, b.scale_x, b.scale_y], [20, 40, 2, 2]);

  const turned = transformElements(o, [0], [0, 1, -1, 0, 0, 0]);
  const c = turned.outline.elements[0];
  assert.ok(c.kind === "component");
  near(c.rotation, Math.PI / 2);
  near(c.dx, -20);
  near(c.dy, 10);
});

test("a component cannot take a skew, a flip or a stretch, so it is skipped and counted", () => {
  const o: GlyphOutline = { elements: [comp(0, 0), rect(0, 0, 4, 4)] };
  for (const m of [
    [1, 0, 0.5, 1, 0, 0],
    [-1, 0, 0, 1, 0, 0],
    [2, 0, 0, 1, 0, 0],
  ] as const) {
    const r = transformElements(o, [0, 1], [...m]);
    assert.equal(r.skipped, 1, JSON.stringify(m));
    assert.deepEqual(r.outline.elements[0], o.elements[0]);
    const c = r.outline.elements[1];
    assert.ok(c.kind === "contour" && c.nodes[2].x !== 4);
  }
});

test("dialogMatrix with the defaults is the identity", () => {
  assert.ok(isIdentity(dialogMatrix(DEFAULT_DIALOG, pivot)));
});

test("dialogMatrix scales, skews, rotates about the pivot and then moves", () => {
  nearPt(applyPoint(dialogMatrix({ ...DEFAULT_DIALOG, sx: 200, sy: 200 }, pivot), { x: 100, y: 50 }), 150, 50);
  nearPt(applyPoint(dialogMatrix({ ...DEFAULT_DIALOG, rotate: 90 }, pivot), { x: 100, y: 50 }), 50, 100);
  nearPt(applyPoint(dialogMatrix({ ...DEFAULT_DIALOG, dx: 10, dy: -5 }, pivot), { x: 1, y: 1 }), 11, -4);
  nearPt(applyPoint(dialogMatrix({ ...DEFAULT_DIALOG, skewX: 45 }, pivot), { x: 50, y: 100 }), 100, 100, 1e-9);
  nearPt(applyPoint(dialogMatrix({ ...DEFAULT_DIALOG, sx: 200, rotate: 90, dx: 3 }, pivot), { x: 100, y: 50 }), 53, 150);
  nearPt(applyPoint(dialogMatrix({ ...DEFAULT_DIALOG, sx: 300, rotate: 33, skewY: 10 }, pivot), pivot), 50, 50, 1e-9);
});

test("dialogMatrix ignores a non-finite or zero scale instead of collapsing the shape", () => {
  const m = dialogMatrix({ ...DEFAULT_DIALOG, sx: 0, sy: Number.NaN }, pivot);
  assert.ok(m.every(Number.isFinite));
  assert.ok(Math.abs(m[0]) > 0 && Math.abs(m[3]) > 0);
});

test("rotation across the 180 degree line never spins the long way", () => {
  const start = { x: -50 + 0, y: 49 };
  const end = { x: -50, y: 51 };
  const m = rotateMatrix(pivot, start, end, false);
  const deg = Math.abs((Math.atan2(m[1], m[0]) * 180) / Math.PI);
  assert.ok(deg < 3, `turned ${deg} degrees for a 1 degree move`);
  const back = rotateMatrix(pivot, { x: -50, y: 51 }, { x: -50, y: 49 }, false);
  assert.ok(Math.abs((Math.atan2(back[1], back[0]) * 180) / Math.PI) < 3);
});

test("the rotate ring is only outside the box: inside, near a corner, is not a handle", () => {
  const big: Box = { minX: 0, minY: 0, maxX: 400, maxY: 400 };
  const c = { x: 200, y: 200 };
  assert.equal(hitTransformHandle(big, c, { x: 385, y: 385 }, 1), null, "inside, 15 units from the corner");
  assert.deepEqual(hitTransformHandle(big, c, { x: 415, y: 415 }, 1), { kind: "rotate", which: "ne" });
  assert.equal(hitTransformHandle(big, c, { x: 395, y: 360 }, 1), null, "inside, beside the corner");
});

test("snapped rotation across the 180 degree line snaps the short sweep, not the long one", () => {
  const at = (deg: number) => ({
    x: 50 + 100 * Math.cos((deg * Math.PI) / 180),
    y: 50 + 100 * Math.sin((deg * Math.PI) / 180),
  });
  const turned = (m: ReturnType<typeof rotateMatrix>) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  near(turned(rotateMatrix(pivot, at(170), at(-170), true)), 15, 1e-6);
  near(turned(rotateMatrix(pivot, at(-170), at(170), true)), -15, 1e-6);
  near(turned(rotateMatrix(pivot, at(175), at(-175), true)), 15, 1e-6);
  near(turned(rotateMatrix(pivot, at(160), at(-160), true)), 45, 1e-6);
  near(turned(rotateMatrix(pivot, at(179), at(-179), true)), 0, 1e-6);
});

import { applyTransform } from "./writingTransform.ts";

test("applyTransform in place moves the chosen shapes and keeps the selection", () => {
  const o: GlyphOutline = { elements: [rect(0, 0, 10, 10), rect(100, 0, 10, 10)] };
  const r = applyTransform(o, [1], [1, 0, 0, 1, 5, 0], false);
  assert.equal(r.outline.elements.length, 2);
  assert.deepEqual(r.selection, [1]);
  const el = r.outline.elements[1];
  assert.ok(el.kind === "contour" && el.nodes[0].x === 105);
});

test("applyTransform with copy leaves the originals and selects the transformed copies", () => {
  const o: GlyphOutline = { elements: [rect(0, 0, 10, 10), rect(100, 0, 10, 10), rect(500, 0, 1, 1)] };
  const r = applyTransform(o, [0, 1], [1, 0, 0, 1, 0, 50], true);
  assert.equal(r.outline.elements.length, 5);
  assert.deepEqual(r.selection, [3, 4]);
  assert.deepEqual(r.outline.elements[0], o.elements[0], "original untouched");
  assert.deepEqual(r.outline.elements[1], o.elements[1], "original untouched");
  const copy = r.outline.elements[3];
  assert.ok(copy.kind === "contour" && copy.nodes[0].y === 50 && copy.nodes[0].x === 0);
});

test("applyTransform with copy of a component that cannot take the matrix keeps an unchanged copy and counts it", () => {
  const o: GlyphOutline = { elements: [comp(0, 0)] };
  const r = applyTransform(o, [0], [1, 0, 0.5, 1, 0, 0], true);
  assert.equal(r.skipped, 1);
  assert.equal(r.outline.elements.length, 2);
  assert.deepEqual(r.outline.elements[1], o.elements[0]);
});

test("applyTransform with nothing selected changes nothing", () => {
  const o: GlyphOutline = { elements: [rect(0, 0, 10, 10)] };
  const r = applyTransform(o, [], [2, 0, 0, 2, 0, 0], false);
  assert.equal(r.outline, o);
  assert.deepEqual(r.selection, []);
});
