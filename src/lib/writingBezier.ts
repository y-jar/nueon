//! Bezier editing helpers for the Direct tool: segment drag, handle visibility, hit priority, extrema.
import type { GlyphContour, GlyphNode, GlyphOutline } from "./api";
import { setKinds } from "./writingNodeType.ts";
import { splitSegment } from "./writingCommands.ts";

export interface Pt {
  x: number;
  y: number;
}

export interface Ref {
  element: number;
  node: number;
}

type V = [number, number];

/** Reach of a click, in screen pixels. */
export const NODE_HIT_PX = 10;
export const HANDLE_HIT_PX = 12;
export const SEGMENT_HIT_PX = 8;
/** A selected node keeps a click this close to its centre, even if a handle overlaps it. */
export const NODE_KEEP_PX = 4;

const T_MIN = 0.1;
const T_MAX = 0.9;
const MIN_PULL = 1;

const len = (v: V) => Math.hypot(v[0], v[1]);
const neg = (v: V): V => [-v[0], -v[1]];
const scaleTo = (v: V, l: number): V => {
  const c = len(v);
  return c === 0 ? [0, 0] : [(v[0] / c) * l, (v[1] / c) * l];
};

function contourAt(outline: GlyphOutline, element: number): GlyphContour | null {
  const el = outline.elements[element];
  return el && el.kind === "contour" ? el : null;
}

function segmentCount(c: GlyphContour): number {
  return c.closed ? c.nodes.length : Math.max(0, c.nodes.length - 1);
}

function controls(a: GlyphNode, b: GlyphNode): [Pt, Pt, Pt, Pt] {
  return [
    { x: a.x, y: a.y },
    { x: a.x + (a.handle_out?.[0] ?? 0), y: a.y + (a.handle_out?.[1] ?? 0) },
    { x: b.x + (b.handle_in?.[0] ?? 0), y: b.y + (b.handle_in?.[1] ?? 0) },
    { x: b.x, y: b.y },
  ];
}

/** The point at parameter `t` on the segment from `a` to `b`. */
export function curvePoint(a: GlyphNode, b: GlyphNode, t: number): Pt {
  const [p0, p1, p2, p3] = controls(a, b);
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return {
    x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
    y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
  };
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** SVG path data for one segment (y flipped when `yFlip`), for hover highlighting. */
export function segmentPathData(a: GlyphNode, b: GlyphNode, yFlip: boolean): string {
  const y = (v: number) => fmt(yFlip ? -v : v);
  if (!a.handle_out && !b.handle_in) return `M ${fmt(a.x)} ${y(a.y)} L ${fmt(b.x)} ${y(b.y)}`;
  const [, p1, p2] = controls(a, b);
  return `M ${fmt(a.x)} ${y(a.y)} C ${fmt(p1.x)} ${y(p1.y)} ${fmt(p2.x)} ${y(p2.y)} ${fmt(b.x)} ${y(b.y)}`;
}

/** After one handle of a smooth or symmetric node changed, realign the one that already exists. */
function realign(node: GlyphNode, changed: "in" | "out"): GlyphNode {
  if (node.kind === "corner") return node;
  const moved = changed === "in" ? node.handle_in : node.handle_out;
  const other = changed === "in" ? node.handle_out : node.handle_in;
  if (!moved || !other) return node;
  const mirrored = node.kind === "symmetric" ? neg(moved) : scaleTo(neg(moved), len(other));
  return changed === "in" ? { ...node, handle_out: mirrored } : { ...node, handle_in: mirrored };
}

function clampT(t: number): number {
  if (!Number.isFinite(t)) return 0.5;
  return Math.min(T_MAX, Math.max(T_MIN, t));
}

/**
 * Drag the curve through its parameter `t` by `delta`. Both control points move
 * by the least amount that carries that point with the pointer:
 * d * Bi / (B1^2 + B2^2), B1 = 3(1-t)^2 t, B2 = 3(1-t) t^2. The segment's end
 * nodes do not move. A straight segment first gets handles at a third and two
 * thirds. Smooth and symmetric end nodes keep their constraint.
 */
export function dragSegment(
  outline: GlyphOutline,
  element: number,
  segment: number,
  t: number,
  delta: Pt,
): GlyphOutline {
  const c = contourAt(outline, element);
  if (!c || segment < 0 || segment >= segmentCount(c)) return outline;
  const ai = segment;
  const bi = (segment + 1) % c.nodes.length;
  const a = c.nodes[ai];
  const b = c.nodes[bi];
  if (!a || !b || ai === bi) return outline;

  let out: V = a.handle_out ?? [0, 0];
  let inn: V = b.handle_in ?? [0, 0];
  if (!a.handle_out && !b.handle_in) {
    out = [(b.x - a.x) / 3, (b.y - a.y) / 3];
    inn = [(a.x - b.x) / 3, (a.y - b.y) / 3];
  }

  const tt = clampT(t);
  const b1 = 3 * (1 - tt) ** 2 * tt;
  const b2 = 3 * (1 - tt) * tt ** 2;
  const den = b1 * b1 + b2 * b2;
  out = [out[0] + (delta.x * b1) / den, out[1] + (delta.y * b1) / den];
  inn = [inn[0] + (delta.x * b2) / den, inn[1] + (delta.y * b2) / den];

  const nodes = c.nodes.slice();
  nodes[ai] = realign({ ...a, handle_out: out }, "out");
  nodes[bi] = realign({ ...b, handle_in: inn }, "in");
  const elements = outline.elements.slice();
  elements[element] = { ...c, kind: "contour", nodes };
  return { ...outline, elements };
}

export interface HandleRef {
  ref: Ref;
  which: "in" | "out";
}

/**
 * The handles to draw and grab. A selected node shows both of its handles; its
 * neighbours show only the one that faces it. `showAll` lists every handle.
 */
export function visibleHandles(outline: GlyphOutline, selection: Ref[], showAll: boolean): HandleRef[] {
  const found = new Map<string, HandleRef>();
  const add = (element: number, node: number, which: "in" | "out") => {
    const c = contourAt(outline, element);
    const n = c?.nodes[node];
    if (!n || !(which === "in" ? n.handle_in : n.handle_out)) return;
    found.set(`${element}:${node}:${which}`, { ref: { element, node }, which });
  };
  if (showAll) {
    outline.elements.forEach((el, ei) => {
      if (el.kind !== "contour") return;
      el.nodes.forEach((_, ni) => {
        add(ei, ni, "in");
        add(ei, ni, "out");
      });
    });
    return [...found.values()];
  }
  for (const s of selection) {
    const c = contourAt(outline, s.element);
    if (!c || !c.nodes[s.node]) continue;
    const n = c.nodes.length;
    add(s.element, s.node, "in");
    add(s.element, s.node, "out");
    const prev = s.node > 0 ? s.node - 1 : c.closed && n > 1 ? n - 1 : -1;
    const next = s.node < n - 1 ? s.node + 1 : c.closed && n > 1 ? 0 : -1;
    if (prev >= 0 && prev !== s.node) add(s.element, prev, "out");
    if (next >= 0 && next !== s.node) add(s.element, next, "in");
  }
  return [...found.values()];
}

export type Target =
  | { kind: "node"; ref: Ref }
  | { kind: "handle"; ref: Ref; which: "in" | "out" }
  | { kind: "segment"; element: number; segment: number; t: number; point: Pt };

function nearestOnSegment(a: GlyphNode, b: GlyphNode, p: Pt): { t: number; d: number } {
  let bestT = 0;
  let bestD = Infinity;
  const steps = 32;
  for (let k = 0; k <= steps; k++) {
    const q = curvePoint(a, b, k / steps);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) {
      bestD = d;
      bestT = k / steps;
    }
  }
  let lo = Math.max(0, bestT - 1 / steps);
  let hi = Math.min(1, bestT + 1 / steps);
  for (let i = 0; i < 24; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const q1 = curvePoint(a, b, m1);
    const q2 = curvePoint(a, b, m2);
    if (Math.hypot(q1.x - p.x, q1.y - p.y) < Math.hypot(q2.x - p.x, q2.y - p.y)) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2;
  const q = curvePoint(a, b, t);
  return { t, d: Math.hypot(q.x - p.x, q.y - p.y) };
}

/**
 * What a click at `point` lands on. `zoom` is screen pixels per font unit, so
 * reach stays constant on screen. Order: node, handle, segment. A handle is only
 * grabbable if it is visible. If both a node and a handle are in reach the node
 * wins, unless that node is already selected and the pointer is more than 4 px
 * from its centre.
 */
export function hitTarget(
  outline: GlyphOutline,
  selection: Ref[],
  point: Pt,
  zoom: number,
  showAll: boolean,
): Target | null {
  const unit = 1 / Math.max(zoom, 1e-6);
  const nodeReach = NODE_HIT_PX * unit;
  const handleReach = HANDLE_HIT_PX * unit;

  let node: { ref: Ref; d: number } | null = null;
  outline.elements.forEach((el, ei) => {
    if (el.kind !== "contour") return;
    el.nodes.forEach((n, ni) => {
      const d = Math.hypot(n.x - point.x, n.y - point.y);
      if (d <= nodeReach && (!node || d <= node.d)) node = { ref: { element: ei, node: ni }, d };
    });
  });

  let handle: { h: HandleRef; d: number } | null = null;
  for (const h of visibleHandles(outline, selection, showAll)) {
    const n = contourAt(outline, h.ref.element)!.nodes[h.ref.node];
    const off = (h.which === "in" ? n.handle_in : n.handle_out)!;
    const d = Math.hypot(n.x + off[0] - point.x, n.y + off[1] - point.y);
    if (d <= handleReach && (!handle || d < handle.d)) handle = { h, d };
  }

  const picked = node as { ref: Ref; d: number } | null;
  if (picked && handle) {
    const selected = selection.some((s) => s.element === picked.ref.element && s.node === picked.ref.node);
    if (!(selected && picked.d > NODE_KEEP_PX * unit)) return { kind: "node", ref: picked.ref };
    return { kind: "handle", ref: handle.h.ref, which: handle.h.which };
  }
  if (picked) return { kind: "node", ref: picked.ref };
  if (handle) return { kind: "handle", ref: handle.h.ref, which: handle.h.which };

  const reach = SEGMENT_HIT_PX * unit;
  let best: { element: number; segment: number; t: number; d: number } | null = null;
  outline.elements.forEach((el, ei) => {
    if (el.kind !== "contour") return;
    const count = segmentCount(el);
    for (let si = 0; si < count; si++) {
      const a = el.nodes[si];
      const b = el.nodes[(si + 1) % el.nodes.length];
      const r = nearestOnSegment(a, b, point);
      if (r.d <= reach && (!best || r.d < best.d)) best = { element: ei, segment: si, t: r.t, d: r.d };
    }
  });
  const seg = best as { element: number; segment: number; t: number; d: number } | null;
  if (!seg) return null;
  const c = contourAt(outline, seg.element)!;
  const a = c.nodes[seg.segment];
  const b = c.nodes[(seg.segment + 1) % c.nodes.length];
  return { kind: "segment", element: seg.element, segment: seg.segment, t: seg.t, point: curvePoint(a, b, seg.t) };
}

const EXTREMUM_EDGE = 1e-3;

/** Roots in (0, 1) of the derivative of a cubic with control values p0..p3. */
function derivativeRoots(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      roots.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    }
  }
  return roots.filter((t) => t > EXTREMUM_EDGE && t < 1 - EXTREMUM_EDGE);
}

/**
 * Insert nodes at the horizontal and vertical extrema of the curved segments of
 * the listed elements (standard font practice). The curve's shape is unchanged.
 */
export function addExtrema(outline: GlyphOutline, elements: number[]): GlyphOutline {
  let result = outline;
  for (const element of [...new Set(elements)]) {
    const c0 = contourAt(result, element);
    if (!c0) continue;
    for (let seg = segmentCount(c0) - 1; seg >= 0; seg--) {
      const c = contourAt(result, element)!;
      const a = c.nodes[seg];
      const b = c.nodes[(seg + 1) % c.nodes.length];
      if (!a.handle_out && !b.handle_in) continue;
      const [p0, p1, p2, p3] = controls(a, b);
      const ts = [...derivativeRoots(p0.x, p1.x, p2.x, p3.x), ...derivativeRoots(p0.y, p1.y, p2.y, p3.y)].sort(
        (x, y) => x - y,
      );
      const unique: number[] = [];
      for (const t of ts) if (unique.length === 0 || t - unique[unique.length - 1] > EXTREMUM_EDGE) unique.push(t);
      let consumed = 0;
      let at = seg;
      for (const t of unique) {
        const local = (t - consumed) / (1 - consumed);
        result = splitSegment(result, element, at, local);
        consumed = t;
        at += 1;
      }
    }
  }
  return result;
}

/** Shift snaps a handle's angle to 0/45/90 degrees, Ctrl to 15; length is kept. */
export function constrainHandle(offset: V, mods: { shift: boolean; ctrl: boolean }): V {
  const l = len(offset);
  if (l === 0 || (!mods.shift && !mods.ctrl)) return offset;
  const step = ((mods.shift ? 45 : 15) * Math.PI) / 180;
  const angle = Math.round(Math.atan2(offset[1], offset[0]) / step) * step;
  return [Math.cos(angle) * l, Math.sin(angle) * l];
}

/** Move one handle on its own (Alt while dragging): the other stays, and the node becomes a corner. */
export function setHandleBroken(outline: GlyphOutline, ref: Ref, which: "in" | "out", offset: V): GlyphOutline {
  const c = contourAt(outline, ref.element);
  const n = c?.nodes[ref.node];
  if (!c || !n) return outline;
  const next: GlyphNode = { ...n, kind: "corner" };
  if (which === "in") next.handle_in = offset;
  else next.handle_out = offset;
  const nodes = c.nodes.slice();
  nodes[ref.node] = next;
  const elements = outline.elements.slice();
  elements[ref.element] = { ...c, kind: "contour", nodes };
  return { ...outline, elements };
}

/** Alt-drag from a node: two equal, opposite handles toward the pointer; the node becomes symmetric. */
export function pullHandles(outline: GlyphOutline, ref: Ref, pointer: Pt): GlyphOutline {
  const c = contourAt(outline, ref.element);
  const n = c?.nodes[ref.node];
  if (!c || !n) return outline;
  const out: V = [pointer.x - n.x, pointer.y - n.y];
  if (len(out) < MIN_PULL) return outline;
  const nodes = c.nodes.slice();
  nodes[ref.node] = { ...n, kind: "symmetric", handle_out: out, handle_in: neg(out) };
  const elements = outline.elements.slice();
  elements[ref.element] = { ...c, kind: "contour", nodes };
  return { ...outline, elements };
}

/** Double-click: a corner becomes smooth with handles, a smooth or symmetric node retracts to a corner. */
export function toggleNode(outline: GlyphOutline, ref: Ref): GlyphOutline {
  const c = contourAt(outline, ref.element);
  const n = c?.nodes[ref.node];
  if (!c || !n) return outline;
  if (n.kind === "corner") return setKinds(outline, [ref], "smooth");
  const nodes = c.nodes.slice();
  const { handle_in: _in, handle_out: _out, ...rest } = n;
  nodes[ref.node] = { ...rest, kind: "corner" };
  const elements = outline.elements.slice();
  elements[ref.element] = { ...c, kind: "contour", nodes };
  return { ...outline, elements };
}
