//! Pure helpers for the editor's visual language: guide labels, the info bar, contour direction.
import type { GlyphContour } from "./api";

export interface Pt {
  x: number;
  y: number;
}

export const GUIDE_LABELS: Record<string, string> = {
  ascender: "ascender",
  cap_height: "cap height",
  x_height: "x-height",
  baseline: "baseline",
  descender: "descender",
};

export function guideLabel(key: string): string {
  return GUIDE_LABELS[key] ?? key;
}

/** Where a guide's label goes: the left edge of the visible area, so it stays on screen when panned. */
export function guideLabelPlacement(key: string, height: number, leftEdge: number) {
  return { text: `${guideLabel(key)} ${formatCoord(height)}`, x: leftEdge };
}

/** Whole font units, with no "-0" and no NaN. */
export function formatCoord(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const r = Math.round(value);
  return r === 0 ? "0" : String(r);
}

export function formatDistance(value: number): string {
  return formatCoord(value);
}

/** Distance and counter-clockwise angle (0..360, y up) from one point to another. */
export function measureFrom(from: Pt, to: Pt): { distance: number; angle: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return { distance, angle };
}

export function formatAngle(degrees: number): string {
  const r = Math.round(((degrees % 360) + 360) % 360) % 360;
  return `${r}\u00b0`;
}

export function zoomLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

export interface InfoInput {
  cursor: Pt | null;
  /** Where the current drag began, or null when not dragging. */
  from: Pt | null;
  scale: number;
  tool: string;
  layer: string;
}

export interface InfoReadout {
  cursor: string;
  measure: string | null;
  zoom: string;
  tool: string;
  layer: string;
}

export function infoReadout(i: InfoInput): InfoReadout {
  const cursor = i.cursor
    ? `x ${formatCoord(i.cursor.x)}  y ${formatCoord(i.cursor.y)}`
    : "x \u2013  y \u2013";
  let measure: string | null = null;
  if (i.cursor && i.from) {
    const m = measureFrom(i.from, i.cursor);
    measure = `d ${formatDistance(m.distance)}  \u2220 ${formatAngle(m.angle)}`;
  }
  return { cursor, measure, zoom: zoomLabel(i.scale), tool: i.tool, layer: i.layer };
}

/** Signed-area direction of a closed contour in y-up space; null when open or flat. */
export function contourDirection(c: GlyphContour): "cw" | "ccw" | null {
  if (!c.closed) return null;
  let area = 0;
  for (let i = 0; i < c.nodes.length; i++) {
    const a = c.nodes[i];
    const b = c.nodes[(i + 1) % c.nodes.length];
    area += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(area) < 1e-9) return null;
  return area > 0 ? "ccw" : "cw";
}

/** The first node and the unit direction the contour leaves it in, or null when undefined. */
export function contourStart(c: GlyphContour): { x: number; y: number; dx: number; dy: number } | null {
  if (c.nodes.length < 2) return null;
  const a = c.nodes[0];
  const b = c.nodes[1];
  let dx = a.handle_out ? a.handle_out[0] : b.handle_in ? b.x + b.handle_in[0] - a.x : b.x - a.x;
  let dy = a.handle_out ? a.handle_out[1] : b.handle_in ? b.y + b.handle_in[1] - a.y : b.y - a.y;
  let l = Math.hypot(dx, dy);
  if (l === 0) {
    dx = b.x - a.x;
    dy = b.y - a.y;
    l = Math.hypot(dx, dy);
  }
  if (l === 0) return null;
  return { x: a.x, y: a.y, dx: dx / l, dy: dy / l };
}

/** Indexes of the end nodes of an open contour (empty when closed). */
export function openEnds(c: GlyphContour): number[] {
  if (c.closed || c.nodes.length === 0) return [];
  if (c.nodes.length === 1) return [0];
  return [0, c.nodes.length - 1];
}

export interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The two diagonals of a square of half-size `r` around `c` (an X mark). */
export function crossLines(c: Pt, r: number): [Line, Line] {
  return [
    { x1: c.x - r, y1: c.y - r, x2: c.x + r, y2: c.y + r },
    { x1: c.x - r, y1: c.y + r, x2: c.x + r, y2: c.y - r },
  ];
}

/** Marks drawn on points: a plus on smooth on-curve nodes, an X on off-curve handles. */
export function handleMarkLines(kind: "plus" | "x", c: Pt, r: number): Line[] {
  if (kind === "x") return crossLines(c, r);
  return [
    { x1: c.x - r, y1: c.y, x2: c.x + r, y2: c.y },
    { x1: c.x, y1: c.y - r, x2: c.x, y2: c.y + r },
  ];
}
