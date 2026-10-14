//! Setting a node's type (corner, smooth, symmetric), growing handles when it has none.
import type { GlyphContour, GlyphNode, GlyphOutline, NodeKind } from "./api";

export interface Ref {
  element: number;
  node: number;
}

type V = [number, number];

const len = (v: V) => Math.hypot(v[0], v[1]);
const scaleTo = (v: V, l: number): V => {
  const c = len(v);
  return c === 0 ? [0, 0] : [(v[0] / c) * l, (v[1] / c) * l];
};
const neg = (v: V): V => [-v[0], -v[1]];

const HANDLE_FRACTION = 1 / 3;

/**
 * Handles for a node that has none: along the line from the previous to the
 * next node (or the one neighbour an open end has), a third of the nearer
 * neighbour's distance, so a handle never reaches past the node beside it.
 */
function grownHandles(c: GlyphContour, index: number): { in?: V; out?: V } {
  const n = c.nodes.length;
  const here = c.nodes[index];
  const prev = index > 0 ? c.nodes[index - 1] : c.closed && n > 2 ? c.nodes[n - 1] : null;
  const next = index < n - 1 ? c.nodes[index + 1] : c.closed && n > 2 ? c.nodes[0] : null;
  if (!prev && !next) return {};
  const dPrev = prev ? Math.hypot(prev.x - here.x, prev.y - here.y) : Infinity;
  const dNext = next ? Math.hypot(next.x - here.x, next.y - here.y) : Infinity;
  const reach = Math.min(dPrev, dNext) * HANDLE_FRACTION;
  if (!isFinite(reach) || reach === 0) return {};
  let dir: V;
  if (prev && next) dir = [next.x - prev.x, next.y - prev.y];
  else if (next) dir = [next.x - here.x, next.y - here.y];
  else dir = [here.x - prev!.x, here.y - prev!.y];
  if (len(dir) === 0) return {};
  const out = scaleTo(dir, reach);
  const result: { in?: V; out?: V } = {};
  if (next) result.out = out;
  if (prev) result.in = neg(out);
  return result;
}

function withKind(c: GlyphContour, index: number, kind: NodeKind): GlyphNode {
  const node = c.nodes[index];
  const next: GlyphNode = { ...node, kind };
  if (kind === "corner") return next;
  const hin = node.handle_in ?? null;
  const hout = node.handle_out ?? null;
  if (!hin && !hout) {
    const grown = grownHandles(c, index);
    if (grown.in) next.handle_in = grown.in;
    if (grown.out) next.handle_out = grown.out;
    return next;
  }
  if (kind === "symmetric") {
    const longest = Math.max(hin ? len(hin) : 0, hout ? len(hout) : 0);
    if (hin && hout) {
      next.handle_out = scaleTo(hout, longest);
      next.handle_in = scaleTo(neg(hout), longest);
    } else if (hout) next.handle_in = neg(hout);
    else if (hin) next.handle_out = neg(hin);
    return next;
  }
  if (hin && hout) next.handle_in = scaleTo(neg(hout), len(hin));
  else if (hout) next.handle_in = neg(hout);
  else if (hin) next.handle_out = neg(hin);
  return next;
}

/** Set the type of every listed node; stale references are ignored. */
export function setKinds(outline: GlyphOutline, refs: Ref[], kind: NodeKind): GlyphOutline {
  const byElement = new Map<number, Set<number>>();
  for (const ref of refs) {
    const set = byElement.get(ref.element) ?? new Set<number>();
    set.add(ref.node);
    byElement.set(ref.element, set);
  }
  if (byElement.size === 0) return outline;
  return {
    ...outline,
    elements: outline.elements.map((el, ei) => {
      const wanted = byElement.get(ei);
      if (!wanted || el.kind !== "contour") return el;
      return {
        ...el,
        nodes: el.nodes.map((n, ni) => (wanted.has(ni) ? withKind(el, ni, kind) : n)),
      };
    }),
  };
}

export function commonKind(kinds: NodeKind[]): NodeKind | null {
  if (kinds.length === 0) return null;
  return kinds.every((k) => k === kinds[0]) ? kinds[0] : null;
}

/** The type shared by every selected node, or null when mixed, empty or stale. */
export function kindOfSelection(outline: GlyphOutline, refs: Ref[]): NodeKind | null {
  const kinds: NodeKind[] = [];
  for (const ref of refs) {
    const el = outline.elements[ref.element];
    const n = el && el.kind === "contour" ? el.nodes[ref.node] : undefined;
    if (n) kinds.push(n.kind);
  }
  return commonKind(kinds);
}
