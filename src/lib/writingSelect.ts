//! Element-level selection for the Select tool: hit testing, marquee, move, duplicate.
import type { GlyphComponent, GlyphContour, GlyphElement, GlyphOutline } from "./api";
import { flattenElements, transformContour, type GlyphLookup } from "./writingComponents.ts";

export interface Pt {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Selected element indexes, kept sorted and unique. */
export type ElementSelection = number[];

export const selectOnly = (index: number): ElementSelection => [index];

export function toggleElement(selection: ElementSelection, index: number): ElementSelection {
  return selection.includes(index)
    ? selection.filter((i) => i !== index)
    : [...selection, index].sort((a, b) => a - b);
}

export function selectAllElements(outline: GlyphOutline): ElementSelection {
  return outline.elements.map((_, i) => i);
}

export function pruneSelection(selection: ElementSelection, count: number): ElementSelection {
  return selection.filter((i) => i >= 0 && i < count);
}

const STEPS = 16;

function cubic(a: GlyphContour["nodes"][number], b: GlyphContour["nodes"][number], t: number): Pt {
  const p1 = { x: a.x + (a.handle_out?.[0] ?? 0), y: a.y + (a.handle_out?.[1] ?? 0) };
  const p2 = { x: b.x + (b.handle_in?.[0] ?? 0), y: b.y + (b.handle_in?.[1] ?? 0) };
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * b.y,
  };
}

/** A contour as a closed polyline, curves sampled. */
function flatten(contour: GlyphContour): Pt[] {
  const nodes = contour.nodes;
  if (nodes.length < 2) return nodes.map((n) => ({ x: n.x, y: n.y }));
  const out: Pt[] = [];
  const segments = contour.closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < segments; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    const curved = a.handle_out || b.handle_in;
    const steps = curved ? STEPS : 1;
    for (let k = 0; k < steps; k++) out.push(curved ? cubic(a, b, k / steps) : { x: a.x, y: a.y });
  }
  if (!contour.closed) out.push({ x: nodes[nodes.length - 1].x, y: nodes[nodes.length - 1].y });
  return out;
}

function windingOf(poly: Pt[], p: Pt): number {
  let winding = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.y <= p.y) {
      if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) winding++;
    } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) {
      winding--;
    }
  }
  return winding;
}

function edgeDistance(poly: Pt[], p: Pt, closed: boolean): number {
  let best = Infinity;
  const last = closed ? poly.length : poly.length - 1;
  for (let i = 0; i < last; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

function contoursOfElement(
  outline: GlyphOutline,
  index: number,
  lookup?: GlyphLookup,
): GlyphContour[] {
  const el = outline.elements[index];
  if (!el) return [];
  if (el.kind === "contour") return [el];
  if (!lookup) return [];
  const flat = flattenElements({ elements: [el] }, lookup);
  return flat[0]?.contours ?? [];
}

/**
 * The topmost element under `p`. A point counts as inside when the whole
 * outline's non-zero winding there is not zero (so a hole is a miss; an open
 * contour is filled as if closed, like the canvas and the font), and as
 * on an element when it lies within `tolerance` font units of its edge.
 */
export function hitElement(
  outline: GlyphOutline,
  tolerance: number,
  p: Pt,
  lookup?: GlyphLookup,
): number | null {
  const shapes = outline.elements.map((_, i) =>
    contoursOfElement(outline, i, lookup).map((c) => ({ c, poly: flatten(c) })),
  );
  let total = 0;
  for (const list of shapes) for (const s of list) if (s.poly.length > 2) total += windingOf(s.poly, p);
  if (total !== 0) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      if (shapes[i].some((s) => s.poly.length > 2 && windingOf(s.poly, p) !== 0)) return i;
    }
  }
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (shapes[i].some((s) => s.poly.length > 1 && edgeDistance(s.poly, p, s.c.closed) <= tolerance)) {
      return i;
    }
  }
  return null;
}

/** The box of an element's nodes (a component's resolved nodes when `lookup` is given). */
export function elementPathBounds(
  outline: GlyphOutline,
  index: number,
  lookup?: GlyphLookup,
): Bounds | null {
  let box: Bounds | null = null;
  for (const c of contoursOfElement(outline, index, lookup)) {
    for (const n of c.nodes) {
      box = box
        ? {
            minX: Math.min(box.minX, n.x),
            minY: Math.min(box.minY, n.y),
            maxX: Math.max(box.maxX, n.x),
            maxY: Math.max(box.maxY, n.y),
          }
        : { minX: n.x, minY: n.y, maxX: n.x, maxY: n.y };
    }
  }
  return box;
}

/** Elements whose whole box lies inside the dragged rectangle, in either direction. */
export function elementsInBox(
  outline: GlyphOutline,
  a: Pt,
  b: Pt,
  lookup?: GlyphLookup,
): ElementSelection {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const out: number[] = [];
  outline.elements.forEach((_, i) => {
    const box = elementPathBounds(outline, i, lookup);
    if (box && box.minX >= minX && box.maxX <= maxX && box.minY >= minY && box.maxY <= maxY) {
      out.push(i);
    }
  });
  return out;
}

function shifted(el: GlyphElement, dx: number, dy: number): GlyphElement {
  if (el.kind === "component") return { ...el, dx: el.dx + dx, dy: el.dy + dy };
  return {
    ...el,
    nodes: el.nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy })),
  };
}

export function translateElements(
  outline: GlyphOutline,
  selection: ElementSelection,
  dx: number,
  dy: number,
): GlyphOutline {
  const set = new Set(selection);
  return {
    ...outline,
    elements: outline.elements.map((el, i) => (set.has(i) ? shifted(el, dx, dy) : el)),
  };
}

/** Arrow-key nudge: 1 font unit, 10 with Shift. */
export function nudgeElements(
  outline: GlyphOutline,
  selection: ElementSelection,
  dx: number,
  dy: number,
  big: boolean,
): GlyphOutline {
  const step = big ? 10 : 1;
  return translateElements(outline, selection, dx * step, dy * step);
}

/** Append offset copies of the selected elements; the copies become the selection. */
export function duplicateElements(
  outline: GlyphOutline,
  selection: ElementSelection,
  offset: number,
): { outline: GlyphOutline; selection: ElementSelection } {
  if (selection.length === 0) return { outline, selection: [] };
  const sorted = [...selection].sort((a, b) => a - b);
  const copies = sorted
    .map((i) => outline.elements[i])
    .filter((el): el is GlyphElement => !!el)
    .map((el) => shifted(el, offset, offset));
  const start = outline.elements.length;
  return {
    outline: { ...outline, elements: [...outline.elements, ...copies] },
    selection: copies.map((_, i) => start + i),
  };
}

export type { GlyphComponent };
export { transformContour };
