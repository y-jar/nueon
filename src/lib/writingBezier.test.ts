import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HANDLE_HIT_PX,
  NODE_HIT_PX,
  addExtrema,
  constrainHandle,
  curvePoint,
  dragSegment,
  hitTarget,
  pullHandles,
  segmentPathData,
  setHandleBroken,
  toggleNode,
  visibleHandles,
} from "./writingBezier.ts";
import type { GlyphNode, GlyphOutline } from "./api.ts";

const near = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

const corner = (x: number, y: number, extra: Partial<GlyphNode> = {}): GlyphNode => ({ x, y, kind: "corner", ...extra });
const contour = (nodes: GlyphNode[], closed = true) => ({
  kind: "contour" as const,
  closed,
  fill_rule: "nonzero" as const,
  nodes,
});
const outlineOf = (...cs: ReturnType<typeof contour>[]): GlyphOutline => ({ elements: cs });
const nodesOf = (o: GlyphOutline, e = 0) => {
  const el = o.elements[e];
  assert.ok(el.kind === "contour");
  return el.nodes;
};
const len = (h: [number, number]) => Math.hypot(h[0], h[1]);

const square = outlineOf(contour([corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)]));

function pointOnSegment(o: GlyphOutline, seg: number, t: number) {
  const ns = nodesOf(o);
  return curvePoint(ns[seg], ns[(seg + 1) % ns.length], t);
}

test("curvePoint walks a straight segment linearly and hits both ends", () => {
  const a = corner(0, 0);
  const b = corner(90, 30);
  assert.deepEqual(curvePoint(a, b, 0), { x: 0, y: 0 });
  assert.deepEqual(curvePoint(a, b, 1), { x: 90, y: 30 });
  const m = curvePoint(a, b, 0.5);
  near(m.x, 45);
  near(m.y, 15);
});

test("dragging a segment moves the point under the cursor by exactly the pointer delta", () => {
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const rest = dragSegment(square, 0, 0, t, { x: 0, y: 0 });
    const before = pointOnSegment(rest, 0, t);
    const out = dragSegment(square, 0, 0, t, { x: 12, y: 34 });
    const after = pointOnSegment(out, 0, t);
    near(after.x, before.x + 12);
    near(after.y, before.y + 34);
  }
});

test("a zero drag turns a straight segment into the same line, so the shape does not change", () => {
  const rest = dragSegment(square, 0, 0, 0.5, { x: 0, y: 0 });
  const ns = nodesOf(rest);
  for (let k = 0; k <= 10; k++) {
    const p = curvePoint(ns[0], ns[1], k / 10);
    near(p.y, 0);
    assert.ok(p.x >= -1e-9 && p.x <= 100 + 1e-9);
  }
});

test("dragging a segment never moves the segment's end nodes, or any other node", () => {
  const out = dragSegment(square, 0, 1, 0.4, { x: 30, y: -20 });
  const ns = nodesOf(out);
  const orig = nodesOf(square);
  for (let i = 0; i < ns.length; i++) {
    near(ns[i].x, orig[i].x);
    near(ns[i].y, orig[i].y);
  }
});

test("a straight segment becomes a curve with handles at a third and two thirds first", () => {
  const out = dragSegment(square, 0, 0, 0.5, { x: 0, y: 0 });
  const ns = nodesOf(out);
  near(ns[0].handle_out![0], 100 / 3);
  near(ns[0].handle_out![1], 0);
  near(ns[1].handle_in![0], -100 / 3);
});

test("dragging only the one segment leaves the other segments' handles alone", () => {
  const out = dragSegment(square, 0, 0, 0.5, { x: 0, y: 40 });
  const ns = nodesOf(out);
  assert.equal(ns[2].handle_in ?? null, null);
  assert.equal(ns[2].handle_out ?? null, null);
  assert.equal(ns[3].handle_in ?? null, null);
});

test("the control points move by the minimum-norm amounts d*Bi/(B1^2+B2^2)", () => {
  const t = 0.3;
  const b1 = 3 * (1 - t) ** 2 * t;
  const b2 = 3 * (1 - t) * t ** 2;
  const den = b1 * b1 + b2 * b2;
  const d = { x: 20, y: 50 };
  const base = dragSegment(square, 0, 0, t, { x: 0, y: 0 });
  const out = dragSegment(square, 0, 0, t, d);
  const ba = nodesOf(base);
  const oa = nodesOf(out);
  near(oa[0].handle_out![0] - ba[0].handle_out![0], (d.x * b1) / den, 1e-6);
  near(oa[0].handle_out![1] - ba[0].handle_out![1], (d.y * b1) / den, 1e-6);
  near(oa[1].handle_in![0] - ba[1].handle_in![0], (d.x * b2) / den, 1e-6);
});

test("t is clamped to 0.1..0.9, so a drag at an end is finite and bounded", () => {
  for (const t of [0, 1, -3, 7, Number.NaN]) {
    const out = dragSegment(square, 0, 0, t, { x: 10, y: 10 });
    const ns = nodesOf(out);
    for (const h of [ns[0].handle_out!, ns[1].handle_in!]) {
      assert.ok(h.every(Number.isFinite), `t=${t}`);
      assert.ok(len(h) < 100, `t=${t}: ${len(h)}`);
    }
  }
});

test("smooth neighbours stay collinear after a segment drag", () => {
  const k = 55.2;
  const circle = outlineOf(
    contour([
      { x: 100, y: 0, kind: "smooth", handle_in: [0, -k], handle_out: [0, k] },
      { x: 0, y: 100, kind: "smooth", handle_in: [k, 0], handle_out: [-k, 0] },
      { x: -100, y: 0, kind: "smooth", handle_in: [0, k], handle_out: [0, -k] },
      { x: 0, y: -100, kind: "smooth", handle_in: [-k, 0], handle_out: [k, 0] },
    ]),
  );
  const out = dragSegment(circle, 0, 0, 0.5, { x: 25, y: 18 });
  const ns = nodesOf(out);
  for (const n of ns) {
    const [ix, iy] = n.handle_in!;
    const [ox, oy] = n.handle_out!;
    near(ix * oy - iy * ox, 0, 1e-6);
    assert.ok(ix * ox + iy * oy < 0, "the handles point opposite ways");
  }
  near(ns[0].x, 100);
  near(ns[1].x, 0);
});

test("a symmetric neighbour keeps equal handle lengths after a segment drag", () => {
  const o = outlineOf(
    contour([
      { x: 0, y: 0, kind: "symmetric", handle_in: [-30, 0], handle_out: [30, 0] },
      corner(100, 0),
      corner(100, 100),
    ]),
  );
  const out = dragSegment(o, 0, 0, 0.5, { x: 0, y: 40 });
  const n = nodesOf(out)[0];
  near(len(n.handle_in!), len(n.handle_out!), 1e-6);
});

test("an open contour's segments are draggable and a stale reference changes nothing", () => {
  const open = outlineOf(contour([corner(0, 0), corner(60, 0), corner(60, 60)], false));
  const out = dragSegment(open, 0, 1, 0.5, { x: 10, y: 0 });
  assert.notDeepEqual(out, open);
  assert.equal(dragSegment(open, 0, 2, 0.5, { x: 1, y: 1 }), open, "an open contour has no closing segment");
  assert.equal(dragSegment(open, 5, 0, 0.5, { x: 1, y: 1 }), open);
  assert.equal(dragSegment(open, 0, 9, 0.5, { x: 1, y: 1 }), open);
});

test("segmentPathData draws a straight segment as a line and a curved one as a cubic", () => {
  assert.equal(segmentPathData(corner(0, 0), corner(10, 20), true), "M 0 0 L 10 -20");
  const d = segmentPathData(corner(0, 0, { handle_out: [5, 0] }), corner(10, 20), true);
  assert.ok(d.startsWith("M 0 0 C "), d);
});

// ---- visible handles ----------------------------------------------------

const smoothSquare = outlineOf(
  contour([
    { x: 0, y: 0, kind: "smooth", handle_in: [-10, -10], handle_out: [10, 10] },
    { x: 100, y: 0, kind: "smooth", handle_in: [-10, 10], handle_out: [10, -10] },
    { x: 100, y: 100, kind: "smooth", handle_in: [10, 10], handle_out: [-10, -10] },
    { x: 0, y: 100, kind: "smooth", handle_in: [-10, 10], handle_out: [10, -10] },
  ]),
);

const key = (h: { ref: { element: number; node: number }; which: string }) => `${h.ref.element}:${h.ref.node}:${h.which}`;

test("with nothing selected no handles are visible", () => {
  assert.deepEqual(visibleHandles(smoothSquare, [], false), []);
});

test("a selected node shows both handles, and each neighbour shows only the one facing it", () => {
  const keys = visibleHandles(smoothSquare, [{ element: 0, node: 1 }], false).map(key).sort();
  assert.deepEqual(keys, ["0:0:out", "0:1:in", "0:1:out", "0:2:in"].sort());
});

test("neighbours wrap around a closed contour", () => {
  const keys = visibleHandles(smoothSquare, [{ element: 0, node: 0 }], false).map(key).sort();
  assert.deepEqual(keys, ["0:0:in", "0:0:out", "0:1:in", "0:3:out"].sort());
});

test("an open contour has no neighbour past its ends", () => {
  const open = outlineOf(
    contour(
      [
        { x: 0, y: 0, kind: "smooth", handle_in: [-5, 0], handle_out: [5, 0] },
        { x: 50, y: 0, kind: "smooth", handle_in: [-5, 0], handle_out: [5, 0] },
        { x: 100, y: 0, kind: "smooth", handle_in: [-5, 0], handle_out: [5, 0] },
      ],
      false,
    ),
  );
  const keys = visibleHandles(open, [{ element: 0, node: 0 }], false).map(key).sort();
  assert.deepEqual(keys, ["0:0:in", "0:0:out", "0:1:in"].sort());
});

test("only handles that exist are listed, and a stale selection is ignored", () => {
  const keys = visibleHandles(square, [{ element: 0, node: 1 }], false);
  assert.deepEqual(keys, []);
  assert.deepEqual(visibleHandles(smoothSquare, [{ element: 7, node: 0 }, { element: 0, node: 99 }], false), []);
});

test("show-all lists every handle of every node", () => {
  assert.equal(visibleHandles(smoothSquare, [], true).length, 8);
});

// ---- hit priority -----------------------------------------------------------

test("the hit radii are 10 px for nodes and 12 px for handles", () => {
  assert.equal(NODE_HIT_PX, 10);
  assert.equal(HANDLE_HIT_PX, 12);
});

test("a node is hit within 10 px and not beyond, at any zoom", () => {
  const sel: { element: number; node: number }[] = [];
  assert.equal(hitTarget(square, sel, { x: 109, y: 0 }, 1, false)?.kind, "node");
  assert.equal(hitTarget(square, sel, { x: 111, y: 0 }, 1, false)?.kind, undefined);
  assert.equal(hitTarget(square, sel, { x: 130, y: 0 }, 0.25, false)?.kind, "node", "zoomed out, a pixel is 4 units");
  assert.equal(hitTarget(square, sel, { x: 103, y: 0 }, 4, false)?.kind, undefined, "zoomed in, 3 units is 12 pixels");
  assert.equal(hitTarget(square, sel, { x: 102, y: 0 }, 4, false)?.kind, "node", "zoomed in, 2 units is 8 pixels");
});

test("the nearest node wins when two are in range", () => {
  const o = outlineOf(contour([corner(0, 0), corner(14, 0), corner(14, 14)]));
  const hit = hitTarget(o, [], { x: 9, y: 0 }, 1, false);
  assert.equal(hit?.kind, "node");
  assert.deepEqual(hit && hit.kind === "node" ? hit.ref : null, { element: 0, node: 1 });
});

test("a handle of an unselected node can never be grabbed", () => {
  const hit = hitTarget(smoothSquare, [], { x: 110, y: 0 - 10 }, 1, false);
  assert.notEqual(hit?.kind, "handle");
});

test("a visible handle is grabbed within 12 px", () => {
  const sel = [{ element: 0, node: 1 }];
  const hit = hitTarget(smoothSquare, sel, { x: 110 + 11, y: -10 }, 1, false);
  assert.equal(hit?.kind, "handle");
  assert.deepEqual(hit && hit.kind === "handle" ? [hit.ref.node, hit.which] : null, [1, "out"]);
});

test("a node beats an overlapping handle unless the node is already selected and the pointer is over 4 px away", () => {
  const o = outlineOf(
    contour([
      { x: 0, y: 0, kind: "smooth", handle_in: [-3, 0], handle_out: [3, 0] },
      corner(100, 0),
      corner(100, 100),
    ]),
  );
  const sel = [{ element: 0, node: 0 }];
  assert.equal(hitTarget(o, [], { x: 3, y: 0 }, 1, false)?.kind, "node", "not selected: node wins");
  assert.equal(hitTarget(o, sel, { x: 2, y: 0 }, 1, false)?.kind, "node", "selected but within 4 px of its centre");
  assert.equal(hitTarget(o, sel, { x: 5, y: 0 }, 1, false)?.kind, "handle", "selected and over 4 px away");
});

test("a short handle cannot steal a click on its own selected node's centre", () => {
  const o = outlineOf(
    contour([
      { x: 0, y: 0, kind: "smooth", handle_in: [-2, 0], handle_out: [2, 0] },
      corner(100, 0),
      corner(100, 100),
    ]),
  );
  assert.equal(hitTarget(o, [{ element: 0, node: 0 }], { x: 0, y: 0 }, 1, false)?.kind, "node");
});

test("with no node or handle in range a click on the curve hits the segment, with its parameter", () => {
  const hit = hitTarget(square, [], { x: 50, y: 4 }, 1, false);
  assert.equal(hit?.kind, "segment");
  if (hit?.kind === "segment") {
    assert.equal(hit.element, 0);
    assert.equal(hit.segment, 0);
    near(hit.t, 0.5, 0.02);
  }
  assert.equal(hitTarget(square, [], { x: 50, y: 30 }, 1, false), null);
});

test("show-all makes every handle grabbable", () => {
  const hit = hitTarget(smoothSquare, [], { x: 110, y: -10 }, 1, true);
  assert.equal(hit?.kind, "handle");
});

// ---- extrema ----------------------------------------------------------------

test("an arc with a hidden extremum gets a node there, with a horizontal tangent", () => {
  const arc = outlineOf(
    contour(
      [
        { x: 0, y: 0, kind: "smooth", handle_out: [0, 60] },
        { x: 100, y: 0, kind: "smooth", handle_in: [0, 60] },
      ],
      false,
    ),
  );
  const out = addExtrema(arc, [0]);
  const ns = nodesOf(out);
  assert.equal(ns.length, 3);
  const mid = ns[1];
  near(mid.handle_in![1], 0, 1e-9);
  near(mid.handle_out![1], 0, 1e-9);
  near(mid.y, 45, 1e-9);
  near(mid.x, 50, 1e-9);
});

test("a diagonal curve gets both a horizontal and a vertical extremum", () => {
  const s = outlineOf(
    contour(
      [
        { x: 0, y: 0, kind: "smooth", handle_out: [80, 0] },
        { x: 60, y: 60, kind: "smooth", handle_in: [0, -80] },
      ],
      false,
    ),
  );
  const out = addExtrema(s, [0]);
  assert.ok(nodesOf(out).length >= 3);
});

test("a segment whose extrema are already nodes gets no new node", () => {
  const k = 55.2;
  const circle = outlineOf(
    contour([
      { x: 100, y: 0, kind: "smooth", handle_in: [0, -k], handle_out: [0, k] },
      { x: 0, y: 100, kind: "smooth", handle_in: [k, 0], handle_out: [-k, 0] },
      { x: -100, y: 0, kind: "smooth", handle_in: [0, k], handle_out: [0, -k] },
      { x: 0, y: -100, kind: "smooth", handle_in: [-k, 0], handle_out: [k, 0] },
    ]),
  );
  assert.equal(nodesOf(addExtrema(circle, [0])).length, 4);
});

test("straight segments never get an extremum node", () => {
  assert.equal(nodesOf(addExtrema(square, [0])).length, 4);
});

test("adding extrema keeps the curve's shape", () => {
  const s = outlineOf(
    contour(
      [
        { x: 0, y: 0, kind: "smooth", handle_out: [80, 30] },
        { x: 60, y: 60, kind: "smooth", handle_in: [10, -90] },
      ],
      false,
    ),
  );
  const out = addExtrema(s, [0]);
  const before = (t: number) => curvePoint(nodesOf(s)[0], nodesOf(s)[1], t);
  const ns = nodesOf(out);
  let maxErr = 0;
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const p = before(t);
    let best = Infinity;
    for (let seg = 0; seg < ns.length - 1; seg++) {
      for (let k = 0; k <= 200; k++) {
        const q = curvePoint(ns[seg], ns[seg + 1], k / 200);
        best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
      }
    }
    maxErr = Math.max(maxErr, best);
  }
  assert.ok(maxErr < 0.5, `max deviation ${maxErr}`);
});

test("extrema are only added to the listed elements, and a closed contour's last segment is handled", () => {
  const bulge = (ox: number) =>
    contour([
      { x: ox, y: 0, kind: "smooth", handle_out: [0, 50] },
      { x: ox + 100, y: 0, kind: "smooth", handle_in: [0, 50] },
      corner(ox + 50, -80),
    ]);
  const o = outlineOf(bulge(0), bulge(300));
  const only0 = addExtrema(o, [0]);
  assert.ok(nodesOf(only0, 0).length > 3);
  assert.equal(nodesOf(only0, 1).length, 3);
  const closedLast = outlineOf(
    contour([
      corner(0, 0),
      corner(100, 0),
      { x: 50, y: -50, kind: "smooth", handle_out: [-80, 0] },
    ]),
  );
  closedLast.elements[0].nodes[0] = { x: 0, y: 0, kind: "smooth", handle_in: [0, -60] };
  assert.ok(nodesOf(addExtrema(closedLast, [0])).length > 3, "the closing segment gets its extrema");
});

test("addExtrema with no elements or stale elements changes nothing", () => {
  assert.equal(addExtrema(square, []), square);
  assert.equal(addExtrema(square, [4]), square);
});

// ---- handle drag rules --------------------------------------------------------

test("Shift constrains a handle to 0, 45 or 90 degrees, Ctrl to 15", () => {
  const deg = (v: [number, number]) => (Math.atan2(v[1], v[0]) * 180) / Math.PI;
  const at = (d: number): [number, number] => [100 * Math.cos((d * Math.PI) / 180), 100 * Math.sin((d * Math.PI) / 180)];
  near(deg(constrainHandle(at(20), { shift: true, ctrl: false })), 0, 1e-6);
  near(deg(constrainHandle(at(30), { shift: true, ctrl: false })), 45, 1e-6);
  near(deg(constrainHandle(at(80), { shift: true, ctrl: false })), 90, 1e-6);
  near(deg(constrainHandle(at(-100), { shift: true, ctrl: false })), -90, 1e-6);
  near(deg(constrainHandle(at(40), { shift: false, ctrl: true })), 45, 1e-6);
  near(deg(constrainHandle(at(37), { shift: false, ctrl: true })), 30, 1e-6);
  assert.deepEqual(constrainHandle(at(33), { shift: false, ctrl: false }), at(33));
  near(len(constrainHandle(at(33), { shift: true, ctrl: false })), 100, 1e-9);
});

test("setHandleBroken moves one handle only and makes the node a corner", () => {
  const o = outlineOf(
    contour([{ x: 0, y: 0, kind: "smooth", handle_in: [-20, 0], handle_out: [20, 0] }, corner(100, 0), corner(100, 100)]),
  );
  const out = setHandleBroken(o, { element: 0, node: 0 }, "out", [0, 30]);
  const n = nodesOf(out)[0];
  assert.deepEqual(n.handle_out, [0, 30]);
  assert.deepEqual(n.handle_in, [-20, 0], "the other handle is untouched");
  assert.equal(n.kind, "corner");
  assert.equal(setHandleBroken(o, { element: 9, node: 0 }, "out", [1, 1]), o);
});

test("pullHandles gives a node two equal, opposite handles and makes it symmetric", () => {
  const out = pullHandles(square, { element: 0, node: 1 }, { x: 140, y: 30 });
  const n = nodesOf(out)[1];
  assert.equal(n.kind, "symmetric");
  assert.deepEqual(n.handle_out, [40, 30]);
  assert.deepEqual(n.handle_in, [-40, -30]);
});

test("pullHandles ignores a pointer that has not left the node", () => {
  assert.equal(pullHandles(square, { element: 0, node: 1 }, { x: 100.4, y: 0.2 }), square);
  assert.equal(pullHandles(square, { element: 3, node: 1 }, { x: 200, y: 0 }), square);
});

test("double-click toggles: a corner becomes smooth with handles, a smooth node becomes a corner with none", () => {
  const smooth = nodesOf(toggleNode(square, { element: 0, node: 1 }))[1];
  assert.equal(smooth.kind, "smooth");
  assert.ok(smooth.handle_in && smooth.handle_out);
  const back = nodesOf(toggleNode(toggleNode(square, { element: 0, node: 1 }), { element: 0, node: 1 }))[1];
  assert.equal(back.kind, "corner");
  assert.equal(back.handle_in ?? null, null);
  assert.equal(back.handle_out ?? null, null);
  assert.equal(toggleNode(square, { element: 2, node: 0 }), square);
});

test("a symmetric node also retracts to a corner on double-click", () => {
  const o = outlineOf(contour([{ x: 0, y: 0, kind: "symmetric", handle_in: [-9, 0], handle_out: [9, 0] }, corner(50, 0), corner(50, 50)]));
  const n = nodesOf(toggleNode(o, { element: 0, node: 0 }))[0];
  assert.equal(n.kind, "corner");
  assert.equal(n.handle_out ?? null, null);
});

test("a segment with two extrema is split twice, and the curve still follows its old path", () => {
  const s = outlineOf(
    contour(
      [
        { x: 0, y: 0, kind: "smooth", handle_out: [0, 120] },
        { x: 100, y: 0, kind: "smooth", handle_in: [0, 120] },
      ],
      false,
    ),
  );
  const two = outlineOf(
    contour(
      [
        { x: 0, y: 0, kind: "smooth", handle_out: [140, 90] },
        { x: 100, y: 50, kind: "smooth", handle_in: [-30, -140] },
      ],
      false,
    ),
  );
  for (const o of [s, two]) {
    const out = addExtrema(o, [0]);
    const ns = nodesOf(out);
    const orig = nodesOf(o);
    let worst = 0;
    for (let i = 0; i <= 50; i++) {
      const p = curvePoint(orig[0], orig[1], i / 50);
      let best = Infinity;
      for (let seg = 0; seg < ns.length - 1; seg++) {
        for (let k = 0; k <= 400; k++) {
          const q = curvePoint(ns[seg], ns[seg + 1], k / 400);
          best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
        }
      }
      worst = Math.max(worst, best);
    }
    assert.ok(worst < 0.3, `deviation ${worst} with ${ns.length} nodes`);
  }
  assert.equal(nodesOf(addExtrema(two, [0])).length, 6, "x extrema at t 0.59 and 0.76, y extrema at t 0.22 and 0.70: four new nodes");
});

test("every node that addExtrema inserts has a horizontal or a vertical tangent", () => {
  const two = outlineOf(
    contour(
      [
        { x: 0, y: 0, kind: "smooth", handle_out: [140, 90] },
        { x: 100, y: 50, kind: "smooth", handle_in: [-30, -140] },
      ],
      false,
    ),
  );
  const ns = nodesOf(addExtrema(two, [0]));
  assert.equal(ns.length, 6);
  for (const n of ns.slice(1, -1)) {
    const [ix, iy] = n.handle_in!;
    const [ox, oy] = n.handle_out!;
    const horizontal = Math.abs(iy) < 1e-6 && Math.abs(oy) < 1e-6;
    const vertical = Math.abs(ix) < 1e-6 && Math.abs(ox) < 1e-6;
    assert.ok(horizontal || vertical, `node at ${n.x.toFixed(1)},${n.y.toFixed(1)} is not on an extremum`);
  }
});
