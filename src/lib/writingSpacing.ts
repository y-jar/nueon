//! Spacing maths: bearings are derived from the ink and the advance; only the advance is stored.
import type { GlyphOutline } from "./api";
import { flattenElements, type GlyphLookup } from "./writingComponents.ts";
import { translateElements } from "./writingSelect.ts";

export interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The three numbers the spacing UI shows. Bearings are null for a glyph with no ink. */
export interface Spacing {
  lsb: number | null;
  rsb: number | null;
  advance: number;
}

const DEFAULT_ADVANCE = 600;
const ADVANCE_MARGIN = 50;

/** The box of a glyph's ink: its contours' nodes, and its components' resolved nodes when a lookup is given. */
export function inkBounds(outline: GlyphOutline, lookup?: GlyphLookup): Box | null {
  let box: Box | null = null;
  const grow = (x: number, y: number) => {
    box = box
      ? {
          minX: Math.min(box.minX, x),
          maxX: Math.max(box.maxX, x),
          minY: Math.min(box.minY, y),
          maxY: Math.max(box.maxY, y),
        }
      : { minX: x, maxX: x, minY: y, maxY: y };
  };
  for (const el of outline.elements) {
    if (el.kind !== "contour") continue;
    for (const n of el.nodes) grow(n.x, n.y);
  }
  if (lookup) {
    for (const flat of flattenElements(outline, lookup)) {
      for (const c of flat.contours) for (const n of c.nodes) grow(n.x, n.y);
    }
  }
  return box;
}

/** The advance the font will use: stored, else the ink's right edge plus 50, else 600. */
function effectiveAdvance(outline: GlyphOutline, ink: Box | null): number {
  if (outline.advance) return outline.advance;
  return ink ? Math.round(ink.maxX + ADVANCE_MARGIN) : DEFAULT_ADVANCE;
}

export function bearingsOf(outline: GlyphOutline, lookup?: GlyphLookup): Spacing {
  const ink = inkBounds(outline, lookup);
  const advance = effectiveAdvance(outline, ink);
  if (!ink) return { lsb: null, rsb: null, advance };
  return { lsb: ink.minX, rsb: advance - ink.maxX, advance };
}

function shifted(outline: GlyphOutline, dx: number): GlyphOutline {
  if (dx === 0) return outline;
  const all = outline.elements.map((_, i) => i);
  return translateElements(outline, all, dx, 0);
}

/**
 * Set the left bearing: the ink moves and the advance moves with it, so the
 * right bearing is unchanged (FontForge's behaviour). A glyph with no ink has
 * nothing to move and keeps its advance.
 */
export function setLeftBearing(outline: GlyphOutline, lsb: number, lookup?: GlyphLookup): GlyphOutline {
  const ink = inkBounds(outline, lookup);
  if (!ink) return outline;
  const advance = effectiveAdvance(outline, ink);
  const dx = lsb - ink.minX;
  return { ...shifted(outline, dx), advance: advance + dx };
}

/** Set the right bearing: only the advance changes. */
export function setRightBearing(outline: GlyphOutline, rsb: number, lookup?: GlyphLookup): GlyphOutline {
  const ink = inkBounds(outline, lookup);
  if (!ink) return outline;
  return { ...outline, advance: ink.maxX + rsb };
}

/** Set the advance directly; the right bearing absorbs the difference. */
export function setAdvance(outline: GlyphOutline, advance: number): GlyphOutline {
  return { ...outline, advance };
}

/** Set both bearings in one step. */
export function setSpacing(
  outline: GlyphOutline,
  want: { lsb: number; rsb: number },
  lookup?: GlyphLookup,
): GlyphOutline {
  const left = setLeftBearing(outline, want.lsb, lookup);
  return setRightBearing(left, want.rsb, lookup);
}

/** Apply whichever of the two bearings are given, leaving the other as it is. */
export function applyBearings(
  outline: GlyphOutline,
  want: { lsb?: number; rsb?: number },
  lookup?: GlyphLookup,
): GlyphOutline {
  let out = outline;
  if (want.lsb !== undefined) out = setLeftBearing(out, want.lsb, lookup);
  if (want.rsb !== undefined) out = setRightBearing(out, want.rsb, lookup);
  return out;
}

/** Give a glyph the same bearings as a donor; a donor with no ink changes nothing. */
export function copySpacing(outline: GlyphOutline, from: Spacing, lookup?: GlyphLookup): GlyphOutline {
  if (from.lsb === null || from.rsb === null) return outline;
  return setSpacing(outline, { lsb: from.lsb, rsb: from.rsb }, lookup);
}

/** Test pairs for the popover, as lists of glyph ids: the glyph beside itself and beside each distinct neighbour, both sides. */
export function pairText(glyph: string, neighbours: string[]): string[][] {
  const out: string[][] = [[glyph, glyph]];
  const seen = new Set<string>([glyph]);
  for (const n of neighbours) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push([n, glyph], [glyph, n]);
  }
  return out;
}

export type BearingLine = "lsb" | "advance";

/** Screen-pixel reach of a bearing line. */
export const BEARING_HIT_PX = 8;

/**
 * Which bearing line is under the pointer, comparing x only (a line runs the
 * full height of the canvas). The left-bearing line is the ink's left edge; the
 * advance line is the advance edge. The nearer wins when both are in reach.
 */
export function hitBearingLine(
  outline: GlyphOutline,
  point: { x: number; y: number },
  zoom: number,
  lookup?: GlyphLookup,
): BearingLine | null {
  const reach = BEARING_HIT_PX / Math.max(zoom, 0.01);
  const b = bearingsOf(outline, lookup);
  const ink = inkBounds(outline, lookup);
  let best: { line: BearingLine; d: number } | null = null;
  const consider = (line: BearingLine, x: number) => {
    const d = Math.abs(point.x - x);
    if (d <= reach && (!best || d < best.d)) best = { line, d };
  };
  if (ink) consider("lsb", ink.minX);
  consider("advance", b.advance);
  return (best as { line: BearingLine } | null)?.line ?? null;
}

/**
 * Drag a bearing line to glyph x: the left-bearing line moves the ink and the
 * advance together, the advance line changes only the advance. The position is
 * rounded to whole units, or to the grid when snapping is on, and the advance
 * never drops below 1.
 */
export function dragBearing(
  outline: GlyphOutline,
  line: BearingLine,
  x: number,
  snapToGrid: boolean,
  grid: number,
  lookup?: GlyphLookup,
): GlyphOutline {
  const at = snapToGrid && grid > 0 ? Math.round(x / grid) * grid : Math.round(x);
  if (line === "advance") return setAdvance(outline, Math.max(1, at));
  const out = setLeftBearing(outline, at, lookup);
  if (out === outline) return outline;
  return (out.advance ?? 1) >= 1 ? out : { ...out, advance: 1 };
}

/** The horizontal span of a grid cell's view box, in glyph units. */
export interface CellBox {
  x: number;
  w: number;
}

/** Edge reach in a grid cell, in pixels. */
export const CELL_EDGE_PX = 8;

/** Glyph x to a pixel offset inside a cell `size` pixels wide. */
export function glyphXToCell(box: CellBox, size: number, x: number): number {
  return ((x - box.x) / box.w) * size;
}

/** A pixel offset inside a cell to glyph x. */
export function cellXToGlyph(box: CellBox, size: number, px: number): number {
  if (size <= 0) return box.x;
  return box.x + (px / size) * box.w;
}

/** Which edge (left bearing or advance) a pointer at pixel `px` inside a cell is on. */
export function cellEdgeHit(
  outline: GlyphOutline,
  box: CellBox,
  size: number,
  px: number,
  lookup?: GlyphLookup,
): BearingLine | null {
  const b = bearingsOf(outline, lookup);
  const ink = inkBounds(outline, lookup);
  let best: { line: BearingLine; d: number } | null = null;
  const consider = (line: BearingLine, x: number) => {
    const d = Math.abs(px - glyphXToCell(box, size, x));
    if (d <= CELL_EDGE_PX && (!best || d < best.d)) best = { line, d };
  };
  if (ink) consider("lsb", ink.minX);
  consider("advance", b.advance);
  return (best as { line: BearingLine } | null)?.line ?? null;
}

/** The glyph after dragging an edge to pixel `px` inside a cell. */
export function spacingDragResult(
  outline: GlyphOutline,
  line: BearingLine,
  box: CellBox,
  size: number,
  px: number,
  snapToGrid: boolean,
  grid: number,
  lookup?: GlyphLookup,
): GlyphOutline {
  return dragBearing(outline, line, cellXToGlyph(box, size, px), snapToGrid, grid, lookup);
}

/** Where each glyph of a run starts, the run's width, and the white gap between neighbouring ink. */
export function pairLayout(
  outlines: GlyphOutline[],
  lookup?: GlyphLookup,
): { offsets: number[]; total: number; gaps: (number | null)[] } {
  const offsets: number[] = [];
  const spacing = outlines.map((o) => bearingsOf(o, lookup));
  let x = 0;
  for (const s of spacing) {
    offsets.push(x);
    x += s.advance;
  }
  const gaps: (number | null)[] = [];
  for (let i = 0; i + 1 < spacing.length; i++) {
    const left = spacing[i];
    const right = spacing[i + 1];
    gaps.push(left.rsb === null || right.lsb === null ? null : left.rsb + right.lsb);
  }
  return { offsets, total: x, gaps };
}

/** The `each` glyphs before and after `id` in `ids`, wrapping, without `id` and without repeats. */
export function pickNeighbours(ids: string[], id: string, each: number): string[] {
  const at = ids.indexOf(id);
  if (at < 0 || ids.length < 2) return [];
  const out: string[] = [];
  const add = (i: number) => {
    const n = ids[((i % ids.length) + ids.length) % ids.length];
    if (n !== id && !out.includes(n)) out.push(n);
  };
  for (let k = each; k >= 1; k--) add(at - k);
  for (let k = 1; k <= each; k++) add(at + k);
  return out;
}
