import { test } from "node:test";
import assert from "node:assert/strict";

import { FIT_ERROR, MAX_NODES, fitFreehand, freehandPreview } from "./writingFreehand.ts";
import { isContour } from "./writingCommands.ts";

interface Pt {
  x: number;
  y: number;
}

/** A quarter circle sampled the way a drag would produce points. */
function arc(center: Pt, radius: number, from: number, to: number, count: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= count; i++) {
    const a = ((from + ((to - from) * i) / count) * Math.PI) / 180;
    out.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return out;
}

/** Distance from a point to a fitted path, by dense sampling of its curves. */
function distToPath(
  p: Pt,
  nodes: { x: number; y: number; handle_in?: number[]; handle_out?: number[] }[],
  closed = false,
): number {
  let best = Infinity;
  const segments = nodes.length - (closed ? 0 : 1);
  for (let i = 0; i < segments; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    for (let k = 0; k <= 64; k++) {
      const t = k / 64;
      const u = 1 - t;
      const x =
        u * u * u * a.x +
        3 * u * u * t * (a.x + (a.handle_out?.[0] ?? 0)) +
        3 * u * t * t * (b.x + (b.handle_in?.[0] ?? 0)) +
        t * t * t * b.x;
      const y =
        u * u * u * a.y +
        3 * u * u * t * (a.y + (a.handle_out?.[1] ?? 0)) +
        3 * u * t * t * (b.y + (b.handle_in?.[1] ?? 0)) +
        t * t * t * b.y;
      best = Math.min(best, Math.hypot(p.x - x, p.y - y));
    }
  }
  return best;
}

test("a straight stroke collapses to two plain corner nodes", () => {
  const line = Array.from({ length: 30 }, (_, i) => ({ x: i * 10, y: i * 3 + 0.2 }));
  const fitted = fitFreehand(line);
  assert.ok(fitted && isContour(fitted));
  assert.equal(fitted.closed, false);
  assert.equal(fitted.nodes.length, 2);
  assert.equal(fitted.nodes[0].handle_in, undefined);
  assert.equal(fitted.nodes[0].handle_out, undefined);
  assert.equal(fitted.nodes[1].handle_in, undefined);
  assert.equal(fitted.nodes[1].handle_out, undefined);
  assert.deepEqual([fitted.nodes[0].x, fitted.nodes[0].y], [0, 0.2]);
  assert.deepEqual([fitted.nodes[1].x, fitted.nodes[1].y], [290, 87.2]);
});

test("a quarter circle fits inside the error budget with few nodes", () => {
  const drawn = arc({ x: 100, y: 100 }, 300, 180, 270, 60);
  const fitted = fitFreehand(drawn);
  assert.ok(fitted && isContour(fitted), "a stroke fits");
  assert.ok(fitted.nodes.length >= 2, "at least the two ends");
  assert.ok(fitted.nodes.length <= MAX_NODES, `at most ${MAX_NODES} nodes, got ${fitted.nodes.length}`);
  let worst = 0;
  for (const p of drawn) worst = Math.max(worst, distToPath(p, fitted.nodes));
  assert.ok(worst <= FIT_ERROR + 0.1, `every drawn point within ${FIT_ERROR} units: ${worst.toFixed(3)}`);
  assert.ok(
    fitted.nodes.some((n) => n.handle_in || n.handle_out),
    "a curved stroke carries handles",
  );
});

test("a half circle needs refinement beyond its two ends", () => {
  const drawn = arc({ x: 100, y: 100 }, 300, 180, 360, 80);
  const fitted = fitFreehand(drawn);
  assert.ok(fitted && isContour(fitted));
  assert.ok(fitted.nodes.length >= 3, "the two ends alone cannot hold a half circle");
  let worst = 0;
  for (const p of drawn) worst = Math.max(worst, distToPath(p, fitted.nodes));
  assert.ok(worst <= FIT_ERROR + 0.1, `every drawn point within ${FIT_ERROR} units: ${worst.toFixed(3)}`);
});

test("the fitted path follows the stroke's order and ends clean", () => {
  const drawn = arc({ x: 100, y: 100 }, 300, 180, 270, 60);
  const fitted = fitFreehand(drawn);
  assert.ok(fitted && isContour(fitted));
  const xs = fitted.nodes.map((n) => n.x);
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] >= xs[i - 1] - 1e-9, `nodes follow the stroke's direction: ${xs.join(",")}`);
  }
  assert.equal(fitted.nodes[0].handle_in, undefined, "the first node has no handle in");
  assert.equal(fitted.nodes[fitted.nodes.length - 1].handle_out, undefined, "the last node has no handle out");
});

test("a badly drawn circle becomes one closed path around, not spaghetti", () => {
  const drawn: Pt[] = [];
  const n = 60;
  for (let i = 0; i <= n; i++) {
    const a = ((i / n) * Math.PI * 2);
    const wobble = 1 + 0.12 * Math.sin(a * 5) + (i % 3 === 0 ? 0.06 : -0.02);
    drawn.push({ x: 500 + 300 * wobble * Math.cos(a), y: 500 + 300 * wobble * Math.sin(a) });
  }
  const fitted = fitFreehand(drawn);
  assert.ok(fitted && isContour(fitted), "the stroke fits");
  assert.equal(fitted.closed, true, "a stroke that ends where it began is a closed contour");
  assert.ok(fitted.nodes.length <= MAX_NODES, "within the node cap");
  // The nodes follow the stroke around, once: their angle about the centre is
  // monotonic. Scrambled order (the spaghetti failure) is not.
  const centre = { x: 500, y: 500 };
  let angle = Math.atan2(fitted.nodes[0].y - centre.y, fitted.nodes[0].x - centre.x);
  let unwound = 0;
  for (let i = 1; i < fitted.nodes.length; i++) {
    const next = Math.atan2(fitted.nodes[i].y - centre.y, fitted.nodes[i].x - centre.x);
    let delta = next - angle;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    unwound += delta;
    angle = next;
  }
  assert.ok(
    Math.abs(unwound) > Math.PI && Math.abs(unwound) < 3 * Math.PI,
    `the nodes wind around once, in order: unwound ${unwound.toFixed(2)} radians`,
  );
  // A small clean circle fits inside the budget; a big one is limited by the
  // node cap, but stays smooth and in order (never spaghetti).
  for (const radius of [80, 120]) {
    const clean: Pt[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = ((i / 64) * Math.PI * 2);
      clean.push({ x: 500 + radius * Math.cos(a), y: 500 + radius * Math.sin(a) });
    }
    const tidy = fitFreehand(clean);
    assert.ok(tidy && isContour(tidy) && tidy.closed, `a clean r=${radius} circle closes`);
    let worstClean = 0;
    for (const p of clean) worstClean = Math.max(worstClean, distToPath(p, tidy.nodes, true));
    assert.ok(
      worstClean <= FIT_ERROR + 0.1,
      `a clean r=${radius} circle fits within ${FIT_ERROR} units: ${worstClean.toFixed(3)}`,
    );
  }
  const big: Pt[] = [];
  for (let i = 0; i <= 64; i++) {
    const a = ((i / 64) * Math.PI * 2);
    big.push({ x: 500 + 300 * Math.cos(a), y: 500 + 300 * Math.sin(a) });
  }
  const bigFit = fitFreehand(big);
  assert.ok(bigFit && isContour(bigFit) && bigFit.closed, "a clean r=300 circle closes");
  assert.ok(bigFit.nodes.length <= MAX_NODES, "it stays within the node cap");
  let worstBig = 0;
  for (const p of big) worstBig = Math.max(worstBig, distToPath(p, bigFit.nodes, true));
  assert.ok(
    worstBig <= 6.5,
    `a r=300 circle at the 12-node cap is off by its Catmull-Rom dip, not spaghetti: ${worstBig.toFixed(2)}`,
  );
});

test("a stroke ending a little off its start still closes; a six-point blob does not", () => {
  // A big circle whose last point lands 12 units off its start: inside the
  // closure allowance (4% of a 600-unit extent), far outside a dust threshold.
  const nearly: Pt[] = [];
  for (let i = 0; i < 64; i++) {
    const a = ((i / 64) * Math.PI * 2);
    nearly.push({ x: 500 + 300 * Math.cos(a), y: 500 + 300 * Math.sin(a) });
  }
  nearly.push({ x: nearly[0].x + 12, y: nearly[0].y });
  const closed = fitFreehand(nearly);
  assert.ok(closed && isContour(closed) && closed.closed, "a 12-unit gap on a 600-unit loop still closes");

  // A six-point scribble loop is too little drawing to be a shape.
  const blob: Pt[] = [
    { x: 100, y: 100 },
    { x: 160, y: 95 },
    { x: 185, y: 140 },
    { x: 150, y: 185 },
    { x: 105, y: 170 },
    { x: 102, y: 102 },
  ];
  const open = fitFreehand(blob);
  assert.ok(open && isContour(open), "the blob still fits");
  assert.equal(open.closed, false, "six points are not enough to claim a closed shape");
});

test("a busy S-curve reaches the node cap rather than exceeding the budget blindly", () => {
  const drawn: Pt[] = [];
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    drawn.push({ x: t * 400, y: 200 * Math.sin(t * Math.PI * 4) * (0.5 + 0.5 * Math.sin(t * 20)) + 60 * t });
  }
  const fitted = fitFreehand(drawn);
  assert.ok(fitted && isContour(fitted));
  assert.ok(fitted.nodes.length <= MAX_NODES, "never more than the cap");
  assert.ok(fitted.nodes.length >= 3, "a busy curve needs more than its two ends");
});

test("too short or too still a stroke fits nothing", () => {
  assert.equal(fitFreehand([]), null);
  assert.equal(fitFreehand([{ x: 0, y: 0 }]), null);
  assert.equal(fitFreehand([{ x: 0, y: 0 }, { x: 0.3, y: 0.1 }]), null, "closer than the thinning epsilon");
});

test("freehandPreview shows the raw stroke as corner nodes", () => {
  assert.equal(freehandPreview([]), null);
  assert.equal(freehandPreview([{ x: 1, y: 1 }]), null);
  const preview = freehandPreview([
    { x: 0, y: 0 },
    { x: 50, y: 50 },
  ]);
  assert.ok(preview && isContour(preview));
  assert.equal(preview.nodes.length, 2);
  assert.equal(preview.nodes[0].kind, "corner");
  assert.equal(preview.nodes[0].handle_out, undefined);
});
