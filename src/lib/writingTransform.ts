//! Pure transform maths for the Select tool's transform box and the Transform dialog.
import type { GlyphComponent, GlyphContour, GlyphElement, GlyphOutline } from "./api";
import { elementPathBounds, type Pt } from "./writingSelect.ts";
import type { GlyphLookup } from "./writingComponents.ts";

/** `[a, b, c, d, e, f]`: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Matrix = [number, number, number, number, number, number];

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Corner = "nw" | "ne" | "sw" | "se";
export type Edge = "n" | "s" | "e" | "w";

export type TransformHandle =
  | { kind: "scale"; which: Corner }
  | { kind: "rotate"; which: Corner }
  | { kind: "skew"; which: Edge }
  | { kind: "pivot"; which: "c" };

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const EPS = 1e-12;
const SKEW_LIMIT = 10;
const SNAP_DEGREES = 15;

/** Screen-pixel reach of each handle; rotation is the ring just outside a corner. */
const PIVOT_PX = 5;
const SCALE_PX = 6;
const SKEW_PX = 6;
const ROTATE_PX = 22;

export function isIdentity(m: Matrix): boolean {
  return (
    Math.abs(m[0] - 1) < EPS &&
    Math.abs(m[1]) < EPS &&
    Math.abs(m[2]) < EPS &&
    Math.abs(m[3] - 1) < EPS &&
    Math.abs(m[4]) < EPS &&
    Math.abs(m[5]) < EPS
  );
}

export function applyPoint(m: Matrix, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** The matrix that applies `first`, then `second`. */
export function multiply(first: Matrix, second: Matrix): Matrix {
  return [
    second[0] * first[0] + second[2] * first[1],
    second[1] * first[0] + second[3] * first[1],
    second[0] * first[2] + second[2] * first[3],
    second[1] * first[2] + second[3] * first[3],
    second[0] * first[4] + second[2] * first[5] + second[4],
    second[1] * first[4] + second[3] * first[5] + second[5],
  ];
}

export function boxCentre(box: Box): Pt {
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
}

/** Glyph space is y-up, so "n" is the top (maxY). */
export function cornerPoint(box: Box, corner: Corner): Pt {
  return {
    x: corner.endsWith("w") ? box.minX : box.maxX,
    y: corner.startsWith("n") ? box.maxY : box.minY,
  };
}

const OPPOSITE: Record<Corner, Corner> = { nw: "se", ne: "sw", sw: "ne", se: "nw" };

export function edgePoint(box: Box, edge: Edge): Pt {
  const c = boxCentre(box);
  if (edge === "n") return { x: c.x, y: box.maxY };
  if (edge === "s") return { x: c.x, y: box.minY };
  if (edge === "e") return { x: box.maxX, y: c.y };
  return { x: box.minX, y: c.y };
}

export interface ScaleOptions {
  keepRatio: boolean;
  fromPivot: boolean;
  pivot: Pt;
}

const sign = (v: number) => (v < 0 ? -1 : 1);

/** Dragging a corner handle: scale about the opposite corner, or about the pivot with Alt. */
export function scaleMatrix(box: Box, corner: Corner, pointer: Pt, options: ScaleOptions): Matrix {
  const anchor = options.fromPivot ? options.pivot : cornerPoint(box, OPPOSITE[corner]);
  const handle = cornerPoint(box, corner);
  const dx = handle.x - anchor.x;
  const dy = handle.y - anchor.y;
  let sx = Math.abs(dx) < EPS ? 1 : (pointer.x - anchor.x) / dx;
  let sy = Math.abs(dy) < EPS ? 1 : (pointer.y - anchor.y) / dy;
  if (options.keepRatio) {
    const s = Math.max(Math.abs(sx), Math.abs(sy));
    sx = sign(sx) * s;
    sy = sign(sy) * s;
  }
  if (!Number.isFinite(sx)) sx = 1;
  if (!Number.isFinite(sy)) sy = 1;
  return [sx, 0, 0, sy, anchor.x - sx * anchor.x, anchor.y - sy * anchor.y];
}

export function rotationAbout(radians: number, pivot: Pt): Matrix {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    cos,
    sin,
    -sin,
    cos,
    pivot.x - cos * pivot.x + sin * pivot.y,
    pivot.y - sin * pivot.x - cos * pivot.y,
  ];
}

/** Rotate by the angle the pointer has swept around the pivot since the drag began. */
export function rotateMatrix(pivot: Pt, start: Pt, now: Pt, snap: boolean): Matrix {
  const v1x = start.x - pivot.x;
  const v1y = start.y - pivot.y;
  const v2x = now.x - pivot.x;
  const v2y = now.y - pivot.y;
  if (Math.hypot(v2x, v2y) < EPS || Math.hypot(v1x, v1y) < EPS) return IDENTITY;
  let angle = Math.atan2(v2y, v2x) - Math.atan2(v1y, v1x);
  if (snap) {
    const step = (SNAP_DEGREES * Math.PI) / 180;
    angle = Math.round(angle / step) * step;
  }
  return rotationAbout(angle, pivot);
}

/** Dragging an edge handle: shear along that edge, keeping the pivot fixed. */
export function skewMatrix(box: Box, edge: Edge, pointer: Pt, pivot: Pt): Matrix {
  const mid = edgePoint(box, edge);
  if (edge === "n" || edge === "s") {
    const run = mid.y - pivot.y;
    if (Math.abs(run) < EPS) return IDENTITY;
    const k = Math.max(-SKEW_LIMIT, Math.min(SKEW_LIMIT, (pointer.x - mid.x) / run));
    return [1, 0, k, 1, -k * pivot.y, 0];
  }
  const run = mid.x - pivot.x;
  if (Math.abs(run) < EPS) return IDENTITY;
  const k = Math.max(-SKEW_LIMIT, Math.min(SKEW_LIMIT, (pointer.y - mid.y) / run));
  return [1, k, 0, 1, 0, -k * pivot.x];
}

/**
 * Which handle of the transform box is under `point`. `unit` is glyph units per
 * screen pixel (1 / zoom), so reach stays the same on screen at any zoom. Order:
 * pivot, corner scale, edge skew, then the rotate ring outside a corner.
 */
export function hitTransformHandle(
  box: Box,
  pivot: Pt,
  point: Pt,
  unit: number,
): TransformHandle | null {
  const dist = (p: Pt) => Math.hypot(p.x - point.x, p.y - point.y);
  if (dist(pivot) <= PIVOT_PX * unit) return { kind: "pivot", which: "c" };
  const corners: Corner[] = ["nw", "ne", "sw", "se"];
  let best: { which: Corner; d: number } | null = null;
  for (const which of corners) {
    const d = dist(cornerPoint(box, which));
    if (d <= SCALE_PX * unit && (!best || d < best.d)) best = { which, d };
  }
  if (best) return { kind: "scale", which: best.which };
  const edges: Edge[] = ["n", "s", "e", "w"];
  let edge: { which: Edge; d: number } | null = null;
  for (const which of edges) {
    const d = dist(edgePoint(box, which));
    if (d <= SKEW_PX * unit && (!edge || d < edge.d)) edge = { which, d };
  }
  if (edge) return { kind: "skew", which: edge.which };
  const outside = point.x < box.minX || point.x > box.maxX || point.y < box.minY || point.y > box.maxY;
  if (outside) {
    let ring: { which: Corner; d: number } | null = null;
    for (const which of corners) {
      const d = dist(cornerPoint(box, which));
      if (d <= ROTATE_PX * unit && (!ring || d < ring.d)) ring = { which, d };
    }
    if (ring) return { kind: "rotate", which: ring.which };
  }
  return null;
}

/** The box around the selected elements, or null when nothing selected has nodes. */
export function selectionBox(
  outline: GlyphOutline,
  indexes: number[],
  lookup?: GlyphLookup,
): Box | null {
  let box: Box | null = null;
  for (const i of indexes) {
    const b = elementPathBounds(outline, i, lookup);
    if (!b) continue;
    box = box
      ? {
          minX: Math.min(box.minX, b.minX),
          minY: Math.min(box.minY, b.minY),
          maxX: Math.max(box.maxX, b.maxX),
          maxY: Math.max(box.maxY, b.maxY),
        }
      : { ...b };
  }
  return box;
}

function contourThrough(c: GlyphContour, m: Matrix): GlyphContour {
  const vec = (h: [number, number] | null | undefined): [number, number] | null | undefined =>
    h ? [m[0] * h[0] + m[2] * h[1], m[1] * h[0] + m[3] * h[1]] : h;
  return {
    ...c,
    nodes: c.nodes.map((n) => {
      const p = applyPoint(m, { x: n.x, y: n.y });
      return { ...n, x: p.x, y: p.y, handle_in: vec(n.handle_in), handle_out: vec(n.handle_out) };
    }),
  };
}

/** A component only stores move, uniform scale and rotation, so only a similarity can be folded in. */
function componentThrough(c: GlyphComponent, m: Matrix): GlyphComponent | null {
  const [a, b, cc, d] = m;
  const tolerance = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Math.abs(a - d) > tolerance || Math.abs(b + cc) > tolerance) return null;
  const k = Math.hypot(a, b);
  if (k < EPS) return null;
  return {
    ...c,
    dx: a * c.dx + cc * c.dy + m[4],
    dy: b * c.dx + d * c.dy + m[5],
    scale_x: c.scale_x * k,
    scale_y: c.scale_y * k,
    rotation: c.rotation + Math.atan2(b, a),
  };
}

/**
 * Apply `m` to the chosen elements. A component the matrix cannot represent (a
 * skew, flip or stretch) is left alone and counted in `skipped`.
 */
export function transformElements(
  outline: GlyphOutline,
  indexes: number[],
  m: Matrix,
): { outline: GlyphOutline; skipped: number } {
  const chosen = new Set(indexes);
  let skipped = 0;
  const elements = outline.elements.map((el, i): GlyphElement => {
    if (!chosen.has(i)) return el;
    if (el.kind === "contour") return { ...contourThrough(el, m), kind: "contour" };
    const next = componentThrough(el, m);
    if (!next) {
      skipped += 1;
      return el;
    }
    return { ...next, kind: "component" };
  });
  return { outline: { ...outline, elements }, skipped };
}

/** Numbers from the Transform dialog: moves in font units, scales in percent, angles in degrees. */
export interface DialogValues {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rotate: number;
  skewX: number;
  skewY: number;
}

export const DEFAULT_DIALOG: DialogValues = {
  dx: 0,
  dy: 0,
  sx: 100,
  sy: 100,
  rotate: 0,
  skewX: 0,
  skewY: 0,
};

const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

/** Scale, then skew, then rotate (all about the pivot), then move. */
export function dialogMatrix(values: DialogValues, pivot: Pt): Matrix {
  const pct = (v: number) => {
    const f = finite(v, 100);
    return f === 0 ? 1 : f / 100;
  };
  const sx = pct(values.sx);
  const sy = pct(values.sy);
  const scale: Matrix = [sx, 0, 0, sy, pivot.x - sx * pivot.x, pivot.y - sy * pivot.y];
  const tx = Math.tan((Math.max(-80, Math.min(80, finite(values.skewX, 0))) * Math.PI) / 180);
  const ty = Math.tan((Math.max(-80, Math.min(80, finite(values.skewY, 0))) * Math.PI) / 180);
  const skew: Matrix = [1, ty, tx, 1, -tx * pivot.y, -ty * pivot.x];
  const rotate = rotationAbout((finite(values.rotate, 0) * Math.PI) / 180, pivot);
  const move: Matrix = [1, 0, 0, 1, finite(values.dx, 0), finite(values.dy, 0)];
  return multiply(multiply(multiply(scale, skew), rotate), move);
}

/**
 * Apply `m` to the selected elements, either in place or, with `copy`, to
 * appended copies. Returns the new selection (the copies when copying).
 */
export function applyTransform(
  outline: GlyphOutline,
  indexes: number[],
  m: Matrix,
  copy: boolean,
): { outline: GlyphOutline; selection: number[]; skipped: number } {
  const valid = [...new Set(indexes)].filter((i) => i >= 0 && i < outline.elements.length).sort((a, b) => a - b);
  if (valid.length === 0) return { outline, selection: [], skipped: 0 };
  if (!copy) {
    const r = transformElements(outline, valid, m);
    return { outline: r.outline, selection: valid, skipped: r.skipped };
  }
  const start = outline.elements.length;
  const grown: GlyphOutline = {
    ...outline,
    elements: [...outline.elements, ...valid.map((i) => outline.elements[i])],
  };
  const copies = valid.map((_, k) => start + k);
  const r = transformElements(grown, copies, m);
  return { outline: r.outline, selection: copies, skipped: r.skipped };
}
