//! Fitting a freehand stroke into a few Bezier nodes: a standard
//! simplify-then-fit pass over the drawn points, pure so it can be
//! tested and mutation-checked without the DOM.

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

/** Catmull-Rom tangents turned into Bezier handles, a third of each chord. */
function buildNodes(kept: Pt[]): FitNode[] {
  return kept.map((p, i) => {
    const prev = kept[Math.max(0, i - 1)];
    const next = kept[Math.min(kept.length - 1, i + 1)];
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
      handle_in: i > 0 ? ([-tx * back, -ty * back] as [number, number]) : undefined,
      handle_out: i < kept.length - 1 ? ([tx * forth, ty * forth] as [number, number]) : undefined,
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

/** Each drawn point's distance to the fitted path: the fit's error budget. */
function pointDistances(nodes: FitNode[], points: Pt[]): number[] {
  let samples: Pt[] = [];
  for (let i = 0; i + 1 < nodes.length; i++) samples = samples.concat(sampleCurve(nodes[i], nodes[i + 1], 32));
  return points.map((p) => {
    let best = Infinity;
    for (const q of samples) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    return best;
  });
}

/**
 * Fit a freehand stroke into an open contour of a few Bezier nodes: the
 * stroke is thinned, a straight one collapses to its two ends, and otherwise
 * the two ends become smooth nodes whose handles follow Catmull-Rom tangents
 * and the drawn point the path misses most adds a node there, until every
 * drawn point is within [`FIT_ERROR`] or the path reaches [`MAX_NODES`]
 * nodes. A stroke too short to have a direction fits nothing.
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

  let kept: Pt[] = [endA, endB];
  let nodes = buildNodes(kept);
  let distances = pointDistances(nodes, drawn);
  while (nodes.length < MAX_NODES && Math.max(...distances) > FIT_ERROR) {
    let worst = 0;
    for (let i = 1; i < distances.length; i++) if (distances[i] > distances[worst]) worst = i;
    kept = insertSorted(kept, drawn[worst]);
    nodes = buildNodes(kept);
    distances = pointDistances(nodes, drawn);
  }

  return {
    kind: "contour",
    nodes,
    closed: false,
    fill_rule: "nonzero",
  };
}

/** Insert a point between its nearest kept neighbours, in stroke order. */
function insertSorted(kept: Pt[], p: Pt): Pt[] {
  let at = kept.length - 1;
  for (let i = 0; i + 1 < kept.length; i++) {
    const a = kept[i];
    const b = kept[i + 1];
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const along = chord === 0 ? 0 : ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (chord * chord);
    if (along >= 0 && along <= 1) {
      at = i + 1;
      break;
    }
  }
  return [...kept.slice(0, at), p, ...kept.slice(at)];
}

