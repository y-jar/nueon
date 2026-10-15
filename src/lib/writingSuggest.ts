//! Clean node spots on a segment, and alignment/angle snapping to other nodes.
import type { GlyphNode, GlyphOutline } from "./api.ts";
import { curvePoint } from "./writingBezier.ts";
import type { NodeRef, Point } from "./writingCommands.ts";
import { snapPoint, snapRadius, type SnapContext, type SnapResult, type SnapTarget } from "./writingSnap.ts";

export interface Spot {
  segment: number;
  t: number;
  point: Point;
  label: string;
}

const EDGE = 0.02;
const ALIGN_TOLERANCE = 0.5;

function contourOf(outline: GlyphOutline, element: number) {
  const el = outline.elements[element];
  return el && el.kind === "contour" ? el : null;
}

function segmentCount(closed: boolean, n: number): number {
  return closed ? n : Math.max(0, n - 1);
}

function controls(a: GlyphNode, b: GlyphNode): [Point, Point, Point, Point] {
  return [
    { x: a.x, y: a.y },
    { x: a.x + (a.handle_out?.[0] ?? 0), y: a.y + (a.handle_out?.[1] ?? 0) },
    { x: b.x + (b.handle_in?.[0] ?? 0), y: b.y + (b.handle_in?.[1] ?? 0) },
    { x: b.x, y: b.y },
  ];
}

function derivativeRoots(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      const s = Math.sqrt(d);
      roots.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return roots.filter((t) => t > EDGE && t < 1 - EDGE);
}

/** Parameters at which the curve is level (same x or same y) with a given value, found by bisection. */
function levelCrossings(a: GlyphNode, b: GlyphNode, axis: "x" | "y", value: number): number[] {
  const f = (t: number) => curvePoint(a, b, t)[axis] - value;
  const out: number[] = [];
  const steps = 48;
  let prev = f(0);
  for (let i = 1; i <= steps; i++) {
    const cur = f(i / steps);
    if (prev === 0 || prev * cur < 0) {
      let lo = (i - 1) / steps;
      let hi = i / steps;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (f(lo) * f(mid) <= 0) hi = mid;
        else lo = mid;
      }
      out.push((lo + hi) / 2);
    }
    prev = cur;
  }
  return out.filter((t) => t > EDGE && t < 1 - EDGE);
}

/**
 * Positions on one segment where a new node would sit cleanly: simple fractions
 * of a straight edge, the middle and extrema of a curve, and the points level
 * (same x or y) with another node. Sorted along the segment, no two coinciding.
 */
export function cleanNodeSpots(outline: GlyphOutline, element: number, segment: number): Spot[] {
  const c = contourOf(outline, element);
  if (!c || segment < 0 || segment >= segmentCount(c.closed, c.nodes.length)) return [];
  const a = c.nodes[segment];
  const bi = (segment + 1) % c.nodes.length;
  const b = c.nodes[bi];
  const curved = !!(a.handle_out || b.handle_in);
  const spots: Spot[] = [];
  const add = (t: number, label: string) => {
    if (t <= EDGE || t >= 1 - EDGE) return;
    spots.push({ segment, t, point: curvePoint(a, b, t), label });
  };

  if (!curved) {
    add(0.5, "middle");
    add(1 / 3, "1/3");
    add(2 / 3, "2/3");
    add(0.25, "1/4");
    add(0.75, "3/4");
  } else {
    add(0.5, "middle");
    const [p0, p1, p2, p3] = controls(a, b);
    for (const t of derivativeRoots(p0.x, p1.x, p2.x, p3.x)) add(t, "extremum");
    for (const t of derivativeRoots(p0.y, p1.y, p2.y, p3.y)) add(t, "extremum");
  }

  const seen = new Set<string>();
  c.nodes.forEach((n, i) => {
    if (i === segment || i === bi) return;
    for (const axis of ["x", "y"] as const) {
      const key = `${axis}:${Math.round(n[axis] * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const t of levelCrossings(a, b, axis, n[axis])) {
        add(t, `aligned ${axis === "x" ? "vertically" : "horizontally"} with a node`);
      }
    }
  });
  outline.elements.forEach((el, ei) => {
    if (ei === element || el.kind !== "contour") return;
    for (const n of el.nodes) {
      for (const axis of ["x", "y"] as const) {
        const key = `${axis}:${Math.round(n[axis] * 10)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const t of levelCrossings(a, b, axis, n[axis])) {
          add(t, `aligned ${axis === "x" ? "vertically" : "horizontally"} with a node`);
        }
      }
    }
  });

  const rank = (label: string) => (label === "extremum" ? 2 : label.startsWith("aligned") ? 1 : 0);
  spots.sort((p, q) => p.t - q.t);
  const unique: Spot[] = [];
  for (const s of spots) {
    const last = unique[unique.length - 1];
    if (last && Math.abs(last.t - s.t) < 0.004) {
      if (rank(s.label) > rank(last.label)) unique[unique.length - 1] = s;
      continue;
    }
    unique.push(s);
  }
  return unique;
}

export interface AlignHit {
  axis: "x" | "y";
  value: number;
  from: Point;
}

function otherNodes(outline: GlyphOutline, exclude: NodeRef[]): { ref: NodeRef; x: number; y: number }[] {
  const out: { ref: NodeRef; x: number; y: number }[] = [];
  outline.elements.forEach((el, ei) => {
    if (el.kind !== "contour") return;
    el.nodes.forEach((n, ni) => {
      if (exclude.some((e) => e.element === ei && e.node === ni)) return;
      out.push({ ref: { element: ei, node: ni }, x: n.x, y: n.y });
    });
  });
  return out;
}

/** Other nodes whose x or y lies within `radius` of the point: the nearest per axis. */
export function alignmentTargets(
  outline: GlyphOutline,
  exclude: NodeRef[],
  point: Point,
  radius: number,
): AlignHit[] {
  let bestX: { d: number; hit: AlignHit } | null = null;
  let bestY: { d: number; hit: AlignHit } | null = null;
  for (const n of otherNodes(outline, exclude)) {
    const dx = Math.abs(n.x - point.x);
    const dy = Math.abs(n.y - point.y);
    if (dx <= radius && (!bestX || dx < bestX.d)) {
      bestX = { d: dx, hit: { axis: "x", value: n.x, from: { x: n.x, y: n.y } } };
    }
    if (dy <= radius && (!bestY || dy < bestY.d)) {
      bestY = { d: dy, hit: { axis: "y", value: n.y, from: { x: n.x, y: n.y } } };
    }
  }
  return [bestX?.hit, bestY?.hit].filter((h): h is AlignHit => !!h);
}

export interface AngleHit {
  angle: 0 | 45 | 90 | 135;
  from: Point;
  /** The point projected onto the line through `from` at this angle. */
  point: Point;
  distance: number;
}

const ANGLES: [0 | 45 | 90 | 135, number, number][] = [
  [0, 1, 0],
  [45, Math.SQRT1_2, Math.SQRT1_2],
  [90, 0, 1],
  [135, -Math.SQRT1_2, Math.SQRT1_2],
];

/** Lines through other nodes at 0/45/90/135 degrees that pass within `radius` of the point. */
export function angleTargets(
  outline: GlyphOutline,
  exclude: NodeRef[],
  point: Point,
  radius: number,
): AngleHit[] {
  const hits: AngleHit[] = [];
  for (const n of otherNodes(outline, exclude)) {
    for (const [angle, ux, uy] of ANGLES) {
      const rx = point.x - n.x;
      const ry = point.y - n.y;
      const along = rx * ux + ry * uy;
      const px = n.x + ux * along;
      const py = n.y + uy * along;
      const distance = Math.hypot(point.x - px, point.y - py);
      if (distance <= radius && Math.hypot(rx, ry) > ALIGN_TOLERANCE) {
        hits.push({ angle, from: { x: n.x, y: n.y }, point: { x: px, y: py }, distance });
      }
    }
  }
  return hits.sort((a, b) => a.distance - b.distance);
}

export interface AlignSnap {
  point: Point;
  hits: AlignHit[];
  angle: AngleHit | null;
}

/**
 * Snap a point to other nodes: a node itself beats everything; otherwise the
 * nearest horizontal/vertical alignment per axis; with no axis alignment the
 * nearest 45 or 135 degree line; and when one axis aligned, a diagonal that
 * crosses it pins the point to the crossing.
 */
export function snapWithAlignment(
  outline: GlyphOutline,
  exclude: NodeRef[],
  point: Point,
  radius: number,
): AlignSnap {
  for (const n of otherNodes(outline, exclude)) {
    if (Math.hypot(n.x - point.x, n.y - point.y) <= radius) {
      return { point: { x: n.x, y: n.y }, hits: [], angle: null };
    }
  }
  const hits = alignmentTargets(outline, exclude, point, radius);
  let p = { ...point };
  for (const h of hits) p[h.axis] = h.value;
  const diagonals = angleTargets(outline, exclude, p, radius).filter((a) => a.angle === 45 || a.angle === 135);
  let angle: AngleHit | null = null;
  const best = diagonals[0];
  if (best) {
    if (hits.length === 0) {
      p = { ...best.point };
      angle = best;
    } else if (hits.length === 1) {
      const h = hits[0];
      const slope = best.angle === 45 ? 1 : -1;
      if (h.axis === "x") p = { x: h.value, y: best.from.y + slope * (h.value - best.from.x) };
      else p = { x: best.from.x + (h.value - best.from.y) / slope, y: h.value };
      angle = best;
    }
  }
  return { point: p, hits, angle };
}

/**
 * The basic snap, plus (with `extended`, i.e. Shift held) alignment with other
 * nodes horizontally and vertically, and along 45 and 135 degree lines through
 * them. A node lock wins and draws no guides; a guide rail, the origin and the
 * advance keep their own axis; alignment beats the grid on the axis it claims.
 */
export function snapExtended(ctx: SnapContext, point: Point, extended: boolean): SnapResult {
  const basic = snapPoint(ctx, point);
  if (!extended || basic.locked) return basic;

  const radius = snapRadius(ctx.zoom);
  const xClaimed = basic.hits.some((h) => h.kind === "origin" || h.kind === "advance");
  const yClaimed = basic.hits.some((h) => h.kind === "guide");
  const snap = snapWithAlignment(ctx.outline, ctx.exclude, point, radius);
  if (snap.hits.length === 0 && !snap.angle) return basic;

  const out = { ...basic.point };
  const hits: SnapTarget[] = basic.hits.filter((h) => h.kind !== "grid");
  let gridAxes = { x: !xClaimed, y: !yClaimed };
  for (const h of snap.hits) {
    if (h.axis === "x" && !xClaimed) {
      out.x = h.value;
      gridAxes.x = false;
      hits.push({ kind: "align", x: h.value, label: "aligned with node", from: h.from });
    }
    if (h.axis === "y" && !yClaimed) {
      out.y = h.value;
      gridAxes.y = false;
      hits.push({ kind: "align", y: h.value, label: "aligned with node", from: h.from });
    }
  }
  if (snap.angle && !xClaimed && !yClaimed) {
    out.x = snap.point.x;
    out.y = snap.point.y;
    gridAxes = { x: false, y: false };
    hits.push({ kind: "angle", label: `${snap.angle.angle}\u00b0 line`, from: snap.angle.from });
  }
  if (ctx.gridOn && ctx.grid > 0 && (gridAxes.x || gridAxes.y)) {
    if (gridAxes.x) out.x = Math.round(point.x / ctx.grid) * ctx.grid;
    if (gridAxes.y) out.y = Math.round(point.y / ctx.grid) * ctx.grid;
    hits.push({ kind: "grid", label: "grid" });
  }
  return { point: out, hits, locked: false, weld: null };
}

/** Screen-pixel reach for jumping a click to a suggested spot. */
export const SPOT_REACH_PX = 24;

/** The spot closest to `point` within `reach` font units, or null. */
export function nearestSpot(spots: Spot[], point: Point, reach: number): Spot | null {
  let best: Spot | null = null;
  let bestD = Infinity;
  for (const s of spots) {
    const d = Math.hypot(s.point.x - point.x, s.point.y - point.y);
    if (d <= reach && d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

export interface Insertion {
  element: number;
  segment: number;
  t: number;
  spot: Spot | null;
}

/**
 * Where a Node Mod click on a line inserts its node: the exact point on the
 * line, or, with Shift, the suggested clean spot if one is within reach.
 */
export function chooseInsertion(
  outline: GlyphOutline,
  hit: { element: number; segment: number; t: number },
  pointer: Point,
  zoom: number,
  shift: boolean,
): Insertion {
  if (!shift) return { element: hit.element, segment: hit.segment, t: hit.t, spot: null };
  const spots = cleanNodeSpots(outline, hit.element, hit.segment);
  const spot = nearestSpot(spots, pointer, SPOT_REACH_PX / Math.max(zoom, 0.01));
  return { element: hit.element, segment: hit.segment, t: spot ? spot.t : hit.t, spot };
}

/**
 * Dragging a line with Shift moves its centre (the point at t = 0.5) and that
 * centre snaps like a node does. Returns the delta to apply to the segment.
 */
export function segmentCentreDelta(
  ctx: SnapContext,
  element: number,
  segment: number,
  pointerDelta: Point,
): Point {
  const c = contourOf(ctx.outline, element);
  if (!c || segment < 0 || segment >= segmentCount(c.closed, c.nodes.length)) return pointerDelta;
  const a = c.nodes[segment];
  const b = c.nodes[(segment + 1) % c.nodes.length];
  const centre = curvePoint(a, b, 0.5);
  const wanted = { x: centre.x + pointerDelta.x, y: centre.y + pointerDelta.y };
  const snapped = snapExtended(ctx, wanted, true);
  return { x: snapped.point.x - centre.x, y: snapped.point.y - centre.y };
}
