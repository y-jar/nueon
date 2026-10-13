import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addElement,
  alignElements,
  allNodeRefs,
  appendNode,
  applyMatrix,
  brushContour,
  canPathfind,
  closeContour,
  cycleNodeKind,
  distributeElements,
  elementBounds,
  emptyOutline,
  hitNode,
  isContour,
  knifeCut,
  mirrorElements,
  moveNodes,
  nearestSegment,
  newContour,
  removeNodes,
  reorderElement,
  rotation,
  scaling,
  setHandle,
  setNodeKind,
  shapeContour,
  snapPoint,
  splitSegment,
  unionBounds,
} from "./writingCommands.ts";
import type { GlyphOutline } from "./api.ts";

function square(x: number, y: number, size = 100) {
  return shapeContour("rect", { x, y }, { x: x + size, y: y + size });
}

function nodesOf(outline: GlyphOutline, index = 0) {
  const element = outline.elements[index];
  assert.ok(isContour(element));
  return element.nodes;
}

test("snapPoint rounds to the grid and ignores a zero grid", () => {
  assert.deepEqual(snapPoint({ x: 13, y: 27 }, 10), { x: 10, y: 30 });
  assert.deepEqual(snapPoint({ x: 13, y: 27 }, 0), { x: 13, y: 27 });
});

test("appendNode and closeContour build a contour without mutating the input", () => {
  const base = addElement(emptyOutline(), newContour([{ x: 0, y: 0 }], false));
  const next = closeContour(
    appendNode(base, 0, { x: 10, y: 0, kind: "corner" }),
    0,
  );
  assert.equal(nodesOf(base).length, 1);
  assert.equal(nodesOf(next).length, 2);
  const element = next.elements[0];
  assert.ok(isContour(element) && element.closed);
});

test("moveNodes moves only the referenced nodes", () => {
  const outline = addElement(emptyOutline(), square(0, 0));
  const moved = moveNodes(outline, [{ element: 0, node: 0 }], 5, -5);
  assert.equal(nodesOf(moved)[0].x, 5);
  assert.equal(nodesOf(moved)[0].y, -5);
  assert.equal(nodesOf(moved)[1].x, 100);
});

test("setHandle keeps smooth handles collinear and symmetric handles equal", () => {
  let outline = addElement(emptyOutline(), square(0, 0));
  outline = setNodeKind(outline, { element: 0, node: 0 }, "symmetric");
  outline = setHandle(outline, { element: 0, node: 0 }, "out", [30, 40]);
  const n = nodesOf(outline)[0];
  assert.deepEqual(n.handle_out, [30, 40]);
  assert.deepEqual(n.handle_in, [-30, -40]);

  let smooth = addElement(emptyOutline(), square(0, 0));
  smooth = setNodeKind(smooth, { element: 0, node: 0 }, "smooth");
  smooth = setHandle(smooth, { element: 0, node: 0 }, "out", [10, 0]);
  smooth = setHandle(smooth, { element: 0, node: 0 }, "in", [-50, 0]);
  const s = nodesOf(smooth)[0];
  assert.deepEqual(s.handle_in, [-50, 0]);
  assert.deepEqual(s.handle_out, [10, 0], "smooth keeps the opposite handle's length");
});

test("a corner node leaves the opposite handle alone", () => {
  let outline = addElement(emptyOutline(), square(0, 0));
  outline = setHandle(outline, { element: 0, node: 1 }, "out", [10, 10]);
  const n = nodesOf(outline)[1];
  assert.deepEqual(n.handle_out, [10, 10]);
  assert.equal(n.handle_in, undefined);
});

test("cycleNodeKind walks corner, smooth, symmetric", () => {
  assert.equal(cycleNodeKind("corner"), "smooth");
  assert.equal(cycleNodeKind("smooth"), "symmetric");
  assert.equal(cycleNodeKind("symmetric"), "corner");
});

test("removeNodes drops nodes and removes contours left with fewer than two", () => {
  const outline = addElement(emptyOutline(), square(0, 0));
  const fewer = removeNodes(outline, [{ element: 0, node: 0 }]);
  assert.equal(nodesOf(fewer).length, 3);
  const gone = removeNodes(outline, [
    { element: 0, node: 0 },
    { element: 0, node: 1 },
    { element: 0, node: 2 },
  ]);
  assert.equal(gone.elements.length, 0);
});

test("hitNode finds the topmost node within a radius", () => {
  const outline = addElement(emptyOutline(), square(0, 0));
  assert.deepEqual(hitNode(outline, { x: 101, y: 1 }, 5), { element: 0, node: 1 });
  assert.equal(hitNode(outline, { x: 50, y: 50 }, 5), null);
});

test("splitSegment on a straight edge inserts a corner at the midpoint", () => {
  const outline = addElement(emptyOutline(), square(0, 0));
  const split = splitSegment(outline, 0, 0, 0.5);
  const nodes = nodesOf(split);
  assert.equal(nodes.length, 5);
  assert.equal(nodes[1].x, 50);
  assert.equal(nodes[1].y, 0);
  assert.equal(nodes[1].kind, "corner");
});

test("splitSegment on a curve keeps the curve and adds smooth handles", () => {
  const outline = addElement(
    emptyOutline(),
    shapeContour("ellipse", { x: -100, y: -100 }, { x: 100, y: 100 }),
  );
  const before = nodesOf(outline);
  const split = splitSegment(outline, 0, 0, 0.5);
  const nodes = nodesOf(split);
  assert.equal(nodes.length, before.length + 1);
  assert.equal(nodes[1].kind, "smooth");
  assert.ok(nodes[1].handle_in && nodes[1].handle_out);
  const onCircle = Math.hypot(nodes[1].x, nodes[1].y);
  assert.ok(Math.abs(onCircle - 100) < 1, `split point stays on the arc: ${onCircle}`);
});

test("nearestSegment finds a point on an edge", () => {
  const outline = addElement(emptyOutline(), square(0, 0));
  const hit = nearestSegment(outline, { x: 50, y: 2 }, 5);
  assert.ok(hit);
  assert.equal(hit.segment, 0);
  assert.ok(Math.abs(hit.t - 0.5) < 0.05);
  assert.equal(nearestSegment(outline, { x: 50, y: 50 }, 5), null);
});

test("knifeCut opens a closed contour and splits an open one", () => {
  const closed = addElement(emptyOutline(), square(0, 0));
  const opened = knifeCut(closed, 0, 0);
  const el = opened.elements[0];
  assert.ok(isContour(el) && !el.closed);
  assert.equal(el.nodes.length, 4);

  const line = addElement(
    emptyOutline(),
    newContour(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 30, y: 0 },
      ],
      false,
    ),
  );
  const parts = knifeCut(line, 0, 1);
  assert.equal(parts.elements.length, 2);
});

test("shapeContour builds each shape kind", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 200 };
  assert.equal(shapeContour("rect", a, b).nodes.length, 4);
  assert.equal(shapeContour("ellipse", a, b).nodes.length, 4);
  assert.ok(shapeContour("ellipse", a, b).nodes.every((n) => n.handle_in && n.handle_out));
  assert.equal(shapeContour("polygon", a, b, 6).nodes.length, 6);
  assert.equal(shapeContour("star", a, b, 5).nodes.length, 10);
  const line = shapeContour("line", a, b);
  assert.equal(line.nodes.length, 2);
  assert.equal(line.closed, false);
});

test("shapeContour normalises a drag in any direction", () => {
  const rect = shapeContour("rect", { x: 100, y: 100 }, { x: 0, y: 0 });
  const xs = rect.nodes.map((n) => n.x);
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.max(...xs), 100);
});

test("applyMatrix scales nodes and handles but only translates points", () => {
  const outline = addElement(
    emptyOutline(),
    shapeContour("ellipse", { x: 0, y: 0 }, { x: 100, y: 100 }),
  );
  const handle = nodesOf(outline)[0].handle_out!;
  const scaled = applyMatrix(outline, [0], scaling(2, 2));
  const n = nodesOf(scaled)[0];
  assert.equal(n.x, nodesOf(outline)[0].x * 2);
  assert.deepEqual(n.handle_out, [handle[0] * 2, handle[1] * 2]);
});

test("rotation by 90 degrees about a centre maps points correctly", () => {
  const outline = addElement(emptyOutline(), newContour([{ x: 10, y: 0 }, { x: 20, y: 0 }], false));
  const rotated = applyMatrix(outline, [0], rotation(90, 0, 0));
  const n = nodesOf(rotated)[0];
  assert.ok(Math.abs(n.x - 0) < 1e-9 && Math.abs(n.y - 10) < 1e-9);
});

test("mirrorElements flips across the element centre and is its own inverse", () => {
  const outline = addElement(emptyOutline(), square(0, 0));
  const tri = addElement(
    emptyOutline(),
    newContour(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 0, y: 50 },
      ],
      true,
    ),
  );
  const flipped = mirrorElements(tri, [0], "h");
  assert.deepEqual(
    nodesOf(flipped).map((n) => [n.x, n.y]),
    [
      [100, 0],
      [0, 0],
      [100, 50],
    ],
  );
  const back = mirrorElements(flipped, [0], "h");
  assert.deepEqual(nodesOf(back).map((n) => [n.x, n.y]), nodesOf(tri).map((n) => [n.x, n.y]));
  assert.deepEqual(elementBounds(mirrorElements(outline, [0], "v"), 0), elementBounds(outline, 0));
});

test("alignElements lines elements up on the chosen edge", () => {
  let outline = addElement(emptyOutline(), square(0, 0, 100));
  outline = addElement(outline, square(50, 30, 20));
  const left = alignElements(outline, [0, 1], "left");
  assert.equal(elementBounds(left, 1)!.minX, 0);
  const top = alignElements(outline, [0, 1], "top");
  assert.equal(elementBounds(top, 1)!.maxY, 100);
  const centred = alignElements(outline, [0, 1], "hcenter");
  assert.equal(
    (elementBounds(centred, 1)!.minX + elementBounds(centred, 1)!.maxX) / 2,
    50,
  );
});

test("distributeElements spaces three elements evenly by centre", () => {
  let outline = addElement(emptyOutline(), square(0, 0, 10));
  outline = addElement(outline, square(20, 0, 10));
  outline = addElement(outline, square(100, 0, 10));
  const spread = distributeElements(outline, [0, 1, 2], "h");
  const centres = [0, 1, 2].map(
    (i) => (elementBounds(spread, i)!.minX + elementBounds(spread, i)!.maxX) / 2,
  );
  assert.equal(centres[1] - centres[0], centres[2] - centres[1]);
  assert.equal(distributeElements(outline, [0, 1], "h"), outline);
});

test("reorderElement moves layers and reports the new index", () => {
  let outline = addElement(emptyOutline(), square(0, 0));
  outline = addElement(outline, square(10, 10));
  outline = addElement(outline, square(20, 20));
  const front = reorderElement(outline, 0, "front");
  assert.equal(front.index, 2);
  assert.equal(nodesOf(front.outline, 2)[0].x, 0);
  const down = reorderElement(outline, 2, "down");
  assert.equal(down.index, 1);
  assert.equal(reorderElement(outline, 2, "up").outline, outline);
});

test("unionBounds spans several elements", () => {
  let outline = addElement(emptyOutline(), square(0, 0, 10));
  outline = addElement(outline, square(100, 100, 10));
  assert.deepEqual(unionBounds(outline, [0, 1]), { minX: 0, minY: 0, maxX: 110, maxY: 110 });
});

test("brushContour expands a stroke into a closed contour of nib width", () => {
  const stroke = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  const contour = brushContour(stroke, 20, 90);
  assert.ok(contour);
  assert.equal(contour.closed, true);
  const ys = contour.nodes.map((n) => n.y);
  assert.equal(Math.max(...ys) - Math.min(...ys), 20);
  assert.equal(brushContour([{ x: 0, y: 0 }], 20, 90), null);
});

test("allNodeRefs lists every node", () => {
  let outline = addElement(emptyOutline(), square(0, 0));
  outline = addElement(outline, square(10, 10));
  assert.equal(allNodeRefs(outline).length, 8);
});

test("canPathfind needs two shapes", () => {
  assert.equal(canPathfind(null), false);
  assert.equal(canPathfind(emptyOutline()), false);
  const one = addElement(emptyOutline(), square(0, 0));
  assert.equal(canPathfind(one), false);
  assert.equal(canPathfind(addElement(one, square(50, 0))), true);
});
