//! Fitting a freehand stroke into a few Bezier nodes: a standard
//! worst-point refinement over the drawn points, pure so it can be tested
//! and mutation-checked without the DOM. A stroke that ends where it began
//! is fitted as a closed contour (a hand-drawn circle), with the stroke's own
//! order — never geometry — placing every added node.

import { newContour, type ContourElement } from "./writingCommands.ts";

/** Largest distance (font units) between a drawn point and the fitted path. */
export const FIT_ERROR = 2;
/** Most nodes a fitted path may carry; the fit settles there rather than chase. */
export const MAX_NODES = 12;
/** Points closer than this to the last kept one are noise, not drawing. */
export const THIN_EPSILON = 0.5;

interface Pt {
  x: number;
  y: number;
}

/**
 * The raw stroke as a corner-node path, for the preview while drawing: what
 * you see is exactly what you drew, before any fitting.
 */
export function freehandPreview(points: Pt[]): ContourElement | null {
  if (points.length < 2) return null;
  return newContour(points.map((p) => ({ x: p.x, y: p.y })), false);
}

/** Drop points that hug the last kept one: they carry no direction. */
function thin(points: Pt[]): Pt[] {
  const kept: Pt[] = [];
  for (const p of points) {
    const last = kept[kept.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= THIN_EPSILON) kept.push(p);
  }
  return kept;
}

function distanceToLine(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

interface FitNode {
  x: number;
  y: number;
  kind: "smooth";
  handle_in?: [number, number];
  handle_out?: [number, number];
}

/**
 * The kept points (as indices into the stroke, in stroke order) become smooth
 * nodes whose handles follow Catmull-Rom tangents, a third of each chord. A
 * cyclic fit has no ends: neighbours wrap, and every node carries both
 * handles; an open fit leaves its two end nodes clean.
 */
function buildNodes(drawn: Pt[], kept: number[], cyclic: boolean): FitNode[] {
  return kept.map((ki, i) => {
    const p = drawn[ki];
    const prevI = cyclic
      ? kept[(i - 1 + kept.length) % kept.length]
      : kept[Math.max(0, i - 1)];
    const nextI = cyclic
      ? kept[(i + 1) % kept.length]
      : kept[Math.min(kept.length - 1, i + 1)];
    const prev = drawn[prevI];
    const next = drawn[nextI];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const tlen = Math.hypot(tx, ty);
    if (tlen === 0) {
      tx = 1;
      ty = 0;
    } else {
      tx /= tlen;
      ty /= tlen;
    }
    const back = Math.hypot(p.x - prev.x, p.y - prev.y) / 3;
    const forth = Math.hypot(next.x - p.x, next.y - p.y) / 3;
    return {
      x: p.x,
      y: p.y,
      kind: "smooth" as const,
      handle_in: cyclic || i > 0 ? ([-tx * back, -ty * back] as [number, number]) : undefined,
      handle_out:
        cyclic || i < kept.length - 1 ? ([tx * forth, ty * forth] as [number, number]) : undefined,
    };
  });
}

/** A cubic through `a` and `b` (their handles), sampled at `steps` params. */
function sampleCurve(a: FitNode, b: FitNode, steps: number): Pt[] {
  const out: Pt[] = [];
  const p0 = { x: a.x, y: a.y };
  const p1 = { x: a.x + (a.handle_out?.[0] ?? 0), y: a.y + (a.handle_out?.[1] ?? 0) };
  const p2 = { x: b.x + (b.handle_in?.[0] ?? 0), y: b.y + (b.handle_in?.[1] ?? 0) };
  const p3 = { x: b.x, y: b.y };
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return out;
}

/**
 * Each drawn point's distance to the fitted path: the fit's error budget. A
 * cyclic path's segments wrap around from the last node back to the first.
 */
function pointDistances(drawn: Pt[], nodes: FitNode[], cyclic: boolean): number[] {
  let samples: Pt[] = [];
  const segments = nodes.length - (cyclic ? 0 : 1);
  for (let i = 0; i < segments; i++) {
    samples = samples.concat(sampleCurve(nodes[i], nodes[(i + 1) % nodes.length], 32));
  }
  return drawn.map((p) => {
    let best = Infinity;
    for (const q of samples) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    return best;
  });
}

/**
 * Fit a freehand stroke into a contour of a few Bezier nodes. The stroke is
 * thinned; a near-straight one collapses to its two ends; one that ends where
 * it began (and has enough room to have gone anywhere) is fitted as a closed
 * contour. Otherwise the two ends become smooth nodes with Catmull-Rom
 * handles, and the drawn point the path misses most adds a node there —
 * placed by the stroke's own order — until every drawn point is within
 * [`FIT_ERROR`] or the path reaches [`MAX_NODES`] nodes. A stroke too short to
 * have a direction fits nothing.
 */
export function fitFreehand(points: Pt[]): ContourElement | null {
  const drawn = thin(points);
  if (drawn.length < 2) return null;

  const endA = drawn[0];
  const endB = drawn[drawn.length - 1];
  const straightness = drawn.reduce(
    (worst, p) => Math.max(worst, distanceToLine(p, endA, endB)),
    0,
  );
  if (straightness <= THIN_EPSILON) {
    return newContour([endA, endB], false);
  }

  const xs = drawn.map((p) => p.x);
  const ys = drawn.map((p) => p.y);
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const cyclic =
    drawn.length >= 8 &&
    extent > 4 * FIT_ERROR &&
    Math.hypot(endB.x - endA.x, endB.y - endA.y) <= Math.max(2 * FIT_ERROR, 0.04 * extent);
  if (cyclic) return fitCyclic(drawn);
  return fitOpen(drawn);
}

function fitOpen(drawn: Pt[]): ContourElement {
  return fit(drawn, [0, drawn.length - 1], false);
}

function fitCyclic(drawn: Pt[]): ContourElement {
  const quarter = Math.floor(drawn.length / 4);
  return fit(drawn, [0, quarter, 2 * quarter, 3 * quarter], true);
}

function fit(drawn: Pt[], initial: number[], cyclic: boolean): ContourElement {
  let kept = initial.slice().sort((a, b) => a - b);
  let nodes = buildNodes(drawn, kept, cyclic);
  let distances = pointDistances(drawn, nodes, cyclic);
  while (nodes.length < MAX_NODES && Math.max(...distances) > FIT_ERROR) {
    let worst = 0;
    for (let i = 1; i < distances.length; i++) if (distances[i] > distances[worst]) worst = i;
    kept = [...kept, worst].sort((a, b) => a - b);
    nodes = buildNodes(drawn, kept, cyclic);
    distances = pointDistances(drawn, nodes, cyclic);
  }
  return {
    kind: "contour",
    nodes,
    closed: cyclic,
    fill_rule: "nonzero",
  };
}
