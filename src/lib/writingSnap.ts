//! Pure snapping: nodes, guide rails, bearing lines, edge midpoints and the grid.
import type { GlyphOutline } from "./api.ts";
import { isContour, type NodeRef, type Point } from "./writingCommands.ts";

export type SnapKind =
  | "node"
  | "guide"
  | "origin"
  | "advance"
  | "midpoint"
  | "grid"
  | "align"
  | "angle";

export interface SnapTarget {
  kind: SnapKind;
  /** Where the point lands. A line target fixes only one axis. */
  x?: number;
  y?: number;
  label: string;
  node?: NodeRef;
  /** The node an alignment or angle line runs through, so the canvas can draw the guide. */
  from?: Point;
}

export interface SnapResult {
  point: Point;
  /** The targets that were applied (one per axis, or a single node). */
  hits: SnapTarget[];
  /** True when the snap is to a node, which is the strongest lock. */
  locked: boolean;
  /** True when the dragged node would weld to this open endpoint on drop. */
  weld: NodeRef | null;
}

/** Inkscape's default is 10 screen pixels; it is divided by zoom. */
export const SNAP_PIXELS = 10;

export function snapRadius(zoom: number): number {
  return SNAP_PIXELS / Math.max(zoom, 0.01);
}

export interface SnapContext {
  outline: GlyphOutline;
  /** Y heights of the horizontal guide rails (storage coordinates). */
  guides: { y: number; label: string }[];
  /** X positions of the vertical guides dragged out of the left ruler. */
  verticals?: { x: number; label: string }[];
  advance: number | null;
  grid: number;
  gridOn: boolean;
  zoom: number;
  /** Nodes that are being dragged and so cannot be their own target. */
  exclude: NodeRef[];
  /** The contour whose open endpoint is dragged, to find weld partners. */
  dragging?: NodeRef | null;
}

function excluded(ctx: SnapContext, ref: NodeRef): boolean {
  return ctx.exclude.some((e) => e.element === ref.element && e.node === ref.node);
}

/** Nodes are endpoints of an open contour when they are its first or last node. */
export function isOpenEndpoint(outline: GlyphOutline, ref: NodeRef): boolean {
  const element = outline.elements[ref.element];
  if (!element || !isContour(element) || element.closed) return false;
  return ref.node === 0 || ref.node === element.nodes.length - 1;
}

/** Candidate targets near a point, in no particular order. */
export function snapTargets(ctx: SnapContext, point: Point, radius: number): SnapTarget[] {
  const targets: SnapTarget[] = [];
  ctx.outline.elements.forEach((element, ei) => {
    if (!isContour(element)) return;
    element.nodes.forEach((n, ni) => {
      const ref = { element: ei, node: ni };
      if (excluded(ctx, ref)) return;
      if (Math.hypot(n.x - point.x, n.y - point.y) <= radius) {
        targets.push({ kind: "node", x: n.x, y: n.y, label: "node", node: ref });
      }
    });
    const count = element.closed ? element.nodes.length : element.nodes.length - 1;
    for (let i = 0; i < count; i++) {
      const a = element.nodes[i];
      const b = element.nodes[(i + 1) % element.nodes.length];
      if (a.handle_out || b.handle_in) continue;
      if (excluded(ctx, { element: ei, node: i })) continue;
      if (excluded(ctx, { element: ei, node: (i + 1) % element.nodes.length })) continue;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (Math.hypot(mx - point.x, my - point.y) <= radius) {
        targets.push({ kind: "midpoint", x: mx, y: my, label: "midpoint" });
      }
    }
  });
  for (const guide of ctx.guides) {
    if (Math.abs(guide.y - point.y) <= radius) {
      targets.push({ kind: "guide", y: guide.y, label: guide.label });
    }
  }
  for (const vertical of ctx.verticals ?? []) {
    if (Math.abs(vertical.x - point.x) <= radius) {
      targets.push({ kind: "guide", x: vertical.x, label: vertical.label });
    }
  }
  if (Math.abs(point.x) <= radius) targets.push({ kind: "origin", x: 0, label: "left edge" });
  if (ctx.advance !== null && Math.abs(ctx.advance - point.x) <= radius) {
    targets.push({ kind: "advance", x: ctx.advance, label: "advance" });
  }
  return targets;
}

/**
 * Snap a point. A node target wins over everything (it locks both axes);
 * otherwise each axis snaps to its nearest line target, and the grid is the
 * fallback for an axis nothing else claimed. This mirrors Inkscape's rule that
 * the nearest candidate wins and a node beats a path intersection.
 */
export function snapPoint(ctx: SnapContext, point: Point): SnapResult {
  const radius = snapRadius(ctx.zoom);
  const targets = snapTargets(ctx, point, radius);

  const nodes = targets
    .filter((t) => t.kind === "node" || t.kind === "midpoint")
    .sort(
      (a, b) =>
        Math.hypot((a.x ?? 0) - point.x, (a.y ?? 0) - point.y) -
        Math.hypot((b.x ?? 0) - point.x, (b.y ?? 0) - point.y) ||
        (a.kind === "node" ? -1 : 1),
    );
  const best = nodes[0];
  if (best && best.x !== undefined && best.y !== undefined) {
    const weld =
      best.kind === "node" && best.node && isOpenEndpoint(ctx.outline, best.node)
        ? best.node
        : null;
    return {
      point: { x: best.x, y: best.y },
      hits: [best],
      locked: true,
      weld: ctx.dragging && isOpenEndpoint(ctx.outline, ctx.dragging) ? weld : null,
    };
  }

  let { x, y } = point;
  const hits: SnapTarget[] = [];
  const xs = targets.filter((t) => t.x !== undefined && t.y === undefined);
  const ys = targets.filter((t) => t.y !== undefined && t.x === undefined);
  const nearestX = xs.sort((a, b) => Math.abs((a.x ?? 0) - x) - Math.abs((b.x ?? 0) - x))[0];
  const nearestY = ys.sort((a, b) => Math.abs((a.y ?? 0) - y) - Math.abs((b.y ?? 0) - y))[0];
  if (nearestX && nearestX.x !== undefined) {
    x = nearestX.x;
    hits.push(nearestX);
  }
  if (nearestY && nearestY.y !== undefined) {
    y = nearestY.y;
    hits.push(nearestY);
  }
  if (ctx.gridOn && ctx.grid > 0) {
    if (!nearestX) x = Math.round(x / ctx.grid) * ctx.grid;
    if (!nearestY) y = Math.round(y / ctx.grid) * ctx.grid;
    if (!nearestX || !nearestY) hits.push({ kind: "grid", label: "grid" });
  }
  return { point: { x, y }, hits, locked: false, weld: null };
}

/** Constrain a point to the nearest 0, 45 or 90 degree direction from an origin. */
export function constrainAngle(origin: Point, point: Point, stepDegrees = 45): Point {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return point;
  const step = (stepDegrees * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: origin.x + Math.cos(angle) * length, y: origin.y + Math.sin(angle) * length };
}

/** Constrain a drag to the dominant axis (Ctrl while dragging a node). */
export function constrainAxis(origin: Point, point: Point): Point {
  return Math.abs(point.x - origin.x) >= Math.abs(point.y - origin.y)
    ? { x: point.x, y: origin.y }
    : { x: origin.x, y: point.y };
}
