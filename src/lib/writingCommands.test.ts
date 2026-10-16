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
  breakNode,
  closeContour,
  deleteNodePreservingShape,
  joinSelected,
  nodesInBox,
  nudgeNodes,
  stepSelection,
  weldNodes,
  cycleNodeKind,
  distributeElements,
  elementBounds,
  emptyOutline,
  hitNode,
  isContour,
  knifeCut,
  knifeCutAt,
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
import { curvePoint } from "./writingBezier.ts";

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

/** Two curve points are the same geometric point (exact for de Casteljau). */
function samePoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
  where: string,
  eps = 1e-9,
) {
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < eps, `${where}: ${a.x},${a.y} vs ${b.x},${b.y}`);
}

test("knifeCutAt opens a closed contour through the exact click point, shape kept", () => {
  const circle = addElement(emptyOutline(), shapeContour("ellipse", { x: 0, y: 0 }, { x: 100, y: 100 }));
  const before = nodesOf(circle);
  const n = before.length;
  const after = knifeCutAt(circle, 0, 0, 0.5);
  const nodes = nodesOf(after);
  assert.ok(isContour(after.elements[0]) && !after.elements[0].closed, "opened");
  assert.equal(nodes.length, n + 2, "the cut point appears at both ends");
  samePoint(nodes[0], nodes[nodes.length - 1], "the two ends are the cut point");
  const exact = curvePoint(before[0], before[1], 0.5);
  samePoint(nodes[0], exact, "the exact point of the segment at t");
  for (const u of [0.2, 0.7]) {
    samePoint(
      curvePoint(nodes[0], nodes[1], u),
      curvePoint(before[0], before[1], 0.5 + u * 0.5),
      "the path out of the cut is the segment's second half",
    );
    samePoint(
      curvePoint(nodes[n - 1 + 1], nodes[n + 1], u),
      curvePoint(before[0], before[1], u * 0.5),
      "the path into the cut is the segment's first half",
    );
    samePoint(curvePoint(nodes[1], nodes[2], u), curvePoint(before[1], before[2], u), "the next segment is intact");
    samePoint(
      curvePoint(nodes[n - 1], nodes[n], u),
      curvePoint(before[n - 1], before[0], u),
      "the segment before the cut node is intact",
    );
  }
});

test("knifeCutAt splits an open contour into two at the click point", () => {
  const line = addElement(
    emptyOutline(),
    newContour(
      [
        { x: 0, y: 0 },
        { x: 100, y: 10 },
        { x: 200, y: 0 },
      ],
      false,
    ),
  );
  const before = nodesOf(line);
  const parts = knifeCutAt(line, 0, 0, 0.5);
  assert.equal(parts.elements.length, 2, "two open paths");
  const head = nodesOf(parts, 0);
  const tail = nodesOf(parts, 1);
  assert.equal(head.length + tail.length, before.length + 2, "the cut point appears at both ends");
  samePoint(head[head.length - 1], tail[0], "both paths meet at the cut point");
  for (const u of [0.2, 0.7]) {
    samePoint(
      curvePoint(head[0], head[1], u),
      curvePoint(before[0], before[1], u * 0.5),
      "the head ends on the segment's first half",
    );
    samePoint(
      curvePoint(tail[0], tail[1], u),
      curvePoint(before[0], before[1], 0.5 + u * 0.5),
      "the tail leaves on the segment's second half",
    );
    samePoint(curvePoint(tail[1], tail[2], u), curvePoint(before[1], before[2], u), "the next segment is intact");
  }
});

test("knifeCutAt clamps a wild t and refuses a bad segment", () => {
  const box = addElement(emptyOutline(), square(0, 0));
  assert.deepEqual(knifeCutAt(box, 0, 0, -0.4), knifeCut(box, 0, 0), "a t before the segment cuts its boundary");
  assert.equal(
    knifeCutAt(box, 0, 0, 1.4).elements.length,
    1,
    "a t past the segment cuts the next boundary",
  );
  assert.deepEqual(knifeCutAt(box, 0, 99, 0.5), box, "a segment out of range changes nothing");
  assert.deepEqual(knifeCutAt(box, 0, 0, Number.NaN), box, "a non-finite t changes nothing");
});

test("knifeCutAt on a node or a bad target is a boundary cut or no-op", () => {
  const box = addElement(emptyOutline(), square(0, 0));
  const boundary = knifeCut(box, 0, 0);
  assert.deepEqual(knifeCutAt(box, 0, 0, 0), boundary, "t on a node cuts the boundary");
  assert.equal(knifeCutAt(box, 0, 0, 1).elements.length, 1, "t on the far node rotates the same contour open");
  assert.equal(nodesOf(knifeCutAt(box, 0, 0, 1)).length, 4, "opened at the next node, nothing inserted");
  assert.equal(knifeCutAt(box, 9, 0, 0.5).elements.length, 1, "a bad element is a no-op");
  const straight = nodesOf(knifeCutAt(box, 0, 0, 0.5));
  assert.equal(straight.length, 6, "a square's mid-edge cut inserts the point at both ends");
  assert.equal(straight[0].handle_in, undefined, "a straight segment's cut point carries no handle in");
  assert.equal(straight[0].handle_out, undefined, "a straight segment's cut point carries no handle out");
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

const path = (pts: [number, number][], closed = false) =>
  newContour(pts.map(([x, y]) => ({ x, y })), closed);

test("welding endpoints of two contours merges them into one open path", () => {
  let o = addElement(emptyOutline(), path([[0, 0], [50, 0]]));
  o = addElement(o, path([[100, 0], [150, 0]]));
  const welded = weldNodes(o, { element: 0, node: 1 }, { element: 1, node: 0 }, { x: 75, y: 0 })!;
  assert.equal(welded.elements.length, 1);
  const nodes = nodesOf(welded);
  assert.deepEqual(nodes.map((n) => [n.x, n.y]), [[0, 0], [75, 0], [150, 0]]);
});

test("welding works whichever ends are chosen (the second path is reversed as needed)", () => {
  let o = addElement(emptyOutline(), path([[0, 0], [50, 0]]));
  o = addElement(o, path([[150, 0], [100, 0]]));
  const welded = weldNodes(o, { element: 0, node: 1 }, { element: 1, node: 1 }, { x: 75, y: 0 })!;
  assert.deepEqual(nodesOf(welded).map((n) => n.x), [0, 75, 150]);
});

test("a weld keeps the handles that point away from the join", () => {
  let o = addElement(emptyOutline(), path([[0, 0], [50, 0]]));
  o = addElement(o, path([[100, 0], [150, 0]]));
  o = setHandle(o, { element: 0, node: 1 }, "in", [-10, 5]);
  o = setHandle(o, { element: 1, node: 0 }, "out", [10, -5]);
  const nodes = nodesOf(weldNodes(o, { element: 0, node: 1 }, { element: 1, node: 0 })!);
  assert.deepEqual(nodes[1].handle_in, [-10, 5]);
  assert.deepEqual(nodes[1].handle_out, [10, -5]);
  assert.equal(nodes[1].x, 75, "default is the midpoint");
});

test("welding the two ends of one open contour closes it", () => {
  const o = addElement(emptyOutline(), path([[0, 0], [100, 0], [50, 80], [2, 1]]));
  const welded = weldNodes(o, { element: 0, node: 0 }, { element: 0, node: 3 })!;
  const el = welded.elements[0];
  assert.ok(isContour(el) && el.closed);
  assert.equal(el.nodes.length, 3, "the two end nodes became one");
});

test("welding rejects interior nodes, closed contours and the same node", () => {
  const o = addElement(emptyOutline(), path([[0, 0], [50, 0], [100, 0]]));
  assert.equal(weldNodes(o, { element: 0, node: 1 }, { element: 0, node: 2 }), null);
  assert.equal(weldNodes(o, { element: 0, node: 0 }, { element: 0, node: 0 }), null);
  const closed = addElement(emptyOutline(), square(0, 0));
  assert.equal(weldNodes(closed, { element: 0, node: 0 }, { element: 0, node: 1 }), null);
});

test("joinSelected needs exactly two endpoints", () => {
  let o = addElement(emptyOutline(), path([[0, 0], [50, 0]]));
  o = addElement(o, path([[100, 0], [150, 0]]));
  assert.ok(joinSelected(o, [{ element: 0, node: 1 }, { element: 1, node: 0 }]));
  assert.equal(joinSelected(o, [{ element: 0, node: 1 }]), null);
});

test("breaking a closed contour opens it with a doubled node", () => {
  const o = addElement(emptyOutline(), square(0, 0));
  const broken = breakNode(o, { element: 0, node: 1 })!;
  const el = broken.elements[0];
  assert.ok(isContour(el) && !el.closed);
  assert.equal(el.nodes.length, 5);
  assert.deepEqual([el.nodes[0].x, el.nodes[4].x], [100, 100], "both ends sit where it broke");
});

test("breaking an interior node of an open contour splits it in two; endpoints cannot break", () => {
  const o = addElement(emptyOutline(), path([[0, 0], [50, 0], [100, 0]]));
  const broken = breakNode(o, { element: 0, node: 1 })!;
  assert.equal(broken.elements.length, 2);
  assert.equal(breakNode(o, { element: 0, node: 0 }), null);
});

test("weld then break is a round trip of positions", () => {
  let o = addElement(emptyOutline(), path([[0, 0], [50, 0]]));
  o = addElement(o, path([[50, 0], [100, 0]]));
  const welded = weldNodes(o, { element: 0, node: 1 }, { element: 1, node: 0 })!;
  const broken = breakNode(welded, { element: 0, node: 1 })!;
  assert.equal(broken.elements.length, 2);
  assert.deepEqual(nodesOf(broken, 0).map((n) => n.x), [0, 50]);
  assert.deepEqual(nodesOf(broken, 1).map((n) => n.x), [50, 100]);
});

test("deleting a smooth node keeps the curve: split then delete restores the arc", () => {
  const circle = addElement(
    emptyOutline(),
    shapeContour("ellipse", { x: -100, y: -100 }, { x: 100, y: 100 }),
  );
  const original = nodesOf(circle);
  const split = splitSegment(circle, 0, 0, 0.5);
  const restored = deleteNodePreservingShape(split, { element: 0, node: 1 });
  const nodes = nodesOf(restored);
  assert.equal(nodes.length, original.length);
  const close = (a: [number, number] | undefined, b: [number, number] | undefined) =>
    Math.hypot(a![0] - b![0], a![1] - b![1]) < 1e-6;
  assert.ok(close(nodes[0].handle_out, original[0].handle_out), "outgoing handle restored");
  assert.ok(close(nodes[1].handle_in, original[1].handle_in), "incoming handle restored");
});

test("deleting a corner node is a plain removal", () => {
  const o = addElement(emptyOutline(), square(0, 0));
  assert.equal(nodesOf(deleteNodePreservingShape(o, { element: 0, node: 0 })).length, 3);
});

test("nudgeNodes moves by whole steps", () => {
  const o = addElement(emptyOutline(), square(0, 0));
  const moved = nudgeNodes(o, [{ element: 0, node: 0 }], 10, -1);
  assert.deepEqual([nodesOf(moved)[0].x, nodesOf(moved)[0].y], [10, -1]);
});

test("nodesInBox selects the nodes inside a rubber band in any drag direction", () => {
  const o = addElement(emptyOutline(), square(0, 0));
  assert.equal(nodesInBox(o, { x: -5, y: -5 }, { x: 105, y: 50 }).length, 2);
  assert.equal(nodesInBox(o, { x: 105, y: 105 }, { x: -5, y: -5 }).length, 4);
  assert.equal(nodesInBox(o, { x: 200, y: 200 }, { x: 300, y: 300 }).length, 0);
});

test("stepSelection walks nodes in order and wraps", () => {
  const o = addElement(emptyOutline(), square(0, 0));
  assert.deepEqual(stepSelection(o, null, 1), { element: 0, node: 0 });
  assert.deepEqual(stepSelection(o, { element: 0, node: 3 }, 1), { element: 0, node: 0 });
  assert.deepEqual(stepSelection(o, { element: 0, node: 0 }, -1), { element: 0, node: 3 });
  assert.equal(stepSelection(emptyOutline(), null, 1), null);
});

test("isContour is false for a missing element instead of throwing", () => {
  assert.equal(isContour(undefined as never), false);
  assert.equal(isContour(null as never), false);
});

import { staleDraft } from "./writingCommands.ts";

test("staleDraft is true when the drafted element is gone or is not a contour", () => {
  const outline = {
    elements: [
      { kind: "contour" as const, closed: false, fill_rule: "nonzero" as const, nodes: [{ x: 0, y: 0, kind: "corner" as const }] },
      { kind: "component" as const, glyph: "a", dx: 0, dy: 0, scale_x: 1, scale_y: 1, rotation: 0 },
    ],
  };
  assert.equal(staleDraft(outline, { element: 0 }), false);
  assert.equal(staleDraft(outline, { element: 1 }), true, "a component cannot be drafted");
  assert.equal(staleDraft(outline, { element: 5 }), true, "past the end");
  assert.equal(staleDraft({ elements: [] }, { element: 0 }), true);
  assert.equal(staleDraft(outline, null), false, "no draft is not stale");
});

test("every command that takes an element index leaves the outline alone when the index is stale", () => {
  const outline = { elements: [] as never[] };
  assert.equal(appendNode(outline, 3, { x: 0, y: 0, kind: "corner" }), outline);
  assert.equal(closeContour(outline, 3), outline);
  assert.equal(setNodeKind(outline, { element: 3, node: 0 }, "smooth"), outline);
  assert.equal(moveNodes(outline, [{ element: 3, node: 0 }], 1, 1), outline);
});

test("nearestSegment finds a long straight edge anywhere along it, not only near sampled points", () => {
  const edge: GlyphOutline = {
    elements: [
      {
        kind: "contour",
        closed: false,
        fill_rule: "nonzero",
        nodes: [
          { x: 0, y: 0, kind: "corner" },
          { x: 1000, y: 0, kind: "corner" },
        ],
      },
    ],
  };
  for (const x of [20, 61, 333, 507, 990]) {
    const hit = nearestSegment(edge, { x, y: 3 }, 8);
    assert.ok(hit, `a click ${3} units off the edge at x=${x} should hit it`);
    assert.ok(Math.abs(hit.distance - 3) < 0.01, `distance ${hit.distance}`);
    assert.ok(Math.abs(hit.point.x - x) < 0.5 && Math.abs(hit.point.y) < 0.01);
  }
  assert.equal(nearestSegment(edge, { x: 500, y: 9 }, 8), null, "beyond the radius is a miss");
  assert.equal(nearestSegment(edge, { x: 1030, y: 0 }, 8), null, "past the end is a miss");
});

test("nearestSegment on a curve returns the true closest point, not the closest sample", () => {
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
  const hit = nearestSegment(arc, { x: 500, y: 300 + 2 }, 6);
  assert.ok(hit);
  assert.ok(Math.abs(hit.t - 0.5) < 0.01, `t ${hit.t}`);
  assert.ok(hit.distance < 3.01, `distance ${hit.distance}`);
});
