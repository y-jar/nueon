import { test } from "node:test";
import assert from "node:assert/strict";

import {
  constrainAngle,
  constrainAxis,
  isOpenEndpoint,
  snapPoint,
  snapRadius,
  type SnapContext,
} from "./writingSnap.ts";
import { addElement, emptyOutline, newContour, shapeContour } from "./writingCommands.ts";

const guides = [
  { y: 800, label: "ascender" },
  { y: 0, label: "baseline" },
];

function ctx(overrides: Partial<SnapContext> = {}): SnapContext {
  return {
    outline: emptyOutline(),
    guides,
    advance: 600,
    grid: 10,
    gridOn: false,
    zoom: 1,
    exclude: [],
    ...overrides,
  };
}

test("the snap radius is 10 screen pixels divided by zoom", () => {
  assert.equal(snapRadius(1), 10);
  assert.equal(snapRadius(2), 5);
  assert.equal(snapRadius(0.5), 20);
});

test("a point snaps to a guide rail on y only", () => {
  const r = snapPoint(ctx(), { x: 123, y: 4 });
  assert.deepEqual(r.point, { x: 123, y: 0 });
  assert.equal(r.locked, false);
  assert.equal(r.hits[0].kind, "guide");
});

test("the left edge and the advance line snap x", () => {
  assert.equal(snapPoint(ctx(), { x: 3, y: 300 }).point.x, 0);
  assert.equal(snapPoint(ctx(), { x: 597, y: 300 }).point.x, 600);
  assert.equal(snapPoint(ctx(), { x: 300, y: 300 }).point.x, 300, "far from both: no snap");
});

test("nothing is within range so the point is untouched", () => {
  const r = snapPoint(ctx(), { x: 250, y: 400 });
  assert.deepEqual(r.point, { x: 250, y: 400 });
  assert.equal(r.hits.length, 0);
});

test("the grid is only a fallback for axes nothing else claimed", () => {
  const r = snapPoint(ctx({ gridOn: true }), { x: 123, y: 4 });
  assert.equal(r.point.x, 120, "x falls back to the grid");
  assert.equal(r.point.y, 0, "y is claimed by the baseline");
});

test("a node target locks both axes and beats lines", () => {
  const outline = addElement(emptyOutline(), shapeContour("rect", { x: 100, y: 5 }, { x: 200, y: 105 }));
  const r = snapPoint(ctx({ outline }), { x: 103, y: 2 });
  assert.deepEqual(r.point, { x: 100, y: 5 }, "locks to the node, not the baseline");
  assert.equal(r.locked, true);
  assert.equal(r.hits[0].kind, "node");
});

test("dragged nodes are never their own snap target", () => {
  const outline = addElement(emptyOutline(), shapeContour("rect", { x: 100, y: 5 }, { x: 200, y: 105 }));
  const r = snapPoint(ctx({ outline, exclude: [{ element: 0, node: 0 }] }), { x: 101, y: 5 });
  assert.equal(r.locked, false);
});

test("a straight edge midpoint is a snap target", () => {
  const outline = addElement(emptyOutline(), shapeContour("rect", { x: 100, y: 100 }, { x: 300, y: 300 }));
  const r = snapPoint(ctx({ outline }), { x: 203, y: 98 });
  assert.deepEqual(r.point, { x: 200, y: 100 });
  assert.equal(r.hits[0].kind, "midpoint");
});

test("zooming in shrinks the snap range", () => {
  assert.equal(snapPoint(ctx({ zoom: 4 }), { x: 100, y: 4 }).point.y, 4, "4 units is 16px: out of range");
  assert.equal(snapPoint(ctx({ zoom: 1 }), { x: 100, y: 4 }).point.y, 0);
});

const openPath = () =>
  addElement(
    emptyOutline(),
    newContour(
      [
        { x: 0, y: 100 },
        { x: 50, y: 150 },
        { x: 100, y: 100 },
      ],
      false,
    ),
  );

test("open contour endpoints are weld candidates, interior nodes and closed contours are not", () => {
  const outline = openPath();
  assert.equal(isOpenEndpoint(outline, { element: 0, node: 0 }), true);
  assert.equal(isOpenEndpoint(outline, { element: 0, node: 2 }), true);
  assert.equal(isOpenEndpoint(outline, { element: 0, node: 1 }), false);
  const closed = addElement(emptyOutline(), shapeContour("rect", { x: 0, y: 0 }, { x: 10, y: 10 }));
  assert.equal(isOpenEndpoint(closed, { element: 0, node: 0 }), false);
});

test("dropping an open endpoint on another open endpoint reports a weld", () => {
  const outline = addElement(
    openPath(),
    newContour(
      [
        { x: 300, y: 100 },
        { x: 350, y: 150 },
      ],
      false,
    ),
  );
  // Drag the second path's first endpoint near the first path's last endpoint.
  const r = snapPoint(ctx({ outline, exclude: [{ element: 1, node: 0 }], dragging: { element: 1, node: 0 } }), {
    x: 102,
    y: 101,
  });
  assert.equal(r.locked, true);
  assert.deepEqual(r.weld, { element: 0, node: 2 });
  assert.deepEqual(r.point, { x: 100, y: 100 });
});

test("snapping onto an interior node locks but does not offer a weld", () => {
  const outline = addElement(openPath(), newContour([{ x: 300, y: 100 }, { x: 350, y: 150 }], false));
  const r = snapPoint(ctx({ outline, exclude: [{ element: 1, node: 0 }], dragging: { element: 1, node: 0 } }), {
    x: 51,
    y: 149,
  });
  assert.equal(r.locked, true);
  assert.equal(r.weld, null);
});

test("constrainAngle snaps to 45 degree steps and keeps length", () => {
  const p = constrainAngle({ x: 0, y: 0 }, { x: 100, y: 12 });
  assert.ok(Math.abs(p.y) < 1e-9, "near-horizontal becomes horizontal");
  const d = constrainAngle({ x: 0, y: 0 }, { x: 70, y: 80 });
  assert.ok(Math.abs(d.x - d.y) < 1e-9, "near-diagonal becomes diagonal");
  assert.ok(Math.abs(Math.hypot(d.x, d.y) - Math.hypot(70, 80)) < 1e-9);
  assert.deepEqual(constrainAngle({ x: 1, y: 1 }, { x: 1, y: 1 }), { x: 1, y: 1 });
});

test("constrainAxis keeps the dominant axis", () => {
  assert.deepEqual(constrainAxis({ x: 0, y: 0 }, { x: 50, y: 9 }), { x: 50, y: 0 });
  assert.deepEqual(constrainAxis({ x: 0, y: 0 }, { x: 5, y: 90 }), { x: 0, y: 90 });
});
