//! Pure edit operations on glyph outlines: nodes, shapes, transforms, brush.
import type {
  GlyphContour,
  GlyphElement,
  GlyphNode,
  GlyphOutline,
  NodeKind,
} from "./api";

export interface Point {
  x: number;
  y: number;
}

export interface NodeRef {
  element: number;
  node: number;
}

/** Affine matrix `[a, b, c, d, e, f]`: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Matrix = [number, number, number, number, number, number];

export type ContourElement = { kind: "contour" } & GlyphContour;
export type ShapeKind = "rect" | "ellipse" | "polygon" | "star" | "line";
export type AlignMode = "left" | "right" | "hcenter" | "top" | "bottom" | "vcenter";
export type OrderMove = "front" | "back" | "up" | "down";

const KAPPA = 0.5522847498307936;

export function isContour(element: GlyphElement | null | undefined): element is ContourElement {
  return !!element && element.kind === "contour";
}

/** A pen draft points at an element that no longer exists, or is not a contour. */
export function staleDraft(outline: GlyphOutline, draft: { element: number } | null): boolean {
  if (!draft) return false;
  return !isContour(outline.elements[draft.element]);
}

function corner(x: number, y: number): GlyphNode {
  return { x, y, kind: "corner" };
}

export function snapPoint(point: Point, grid: number): Point {
  if (!(grid > 0)) return point;
  return {
    x: Math.round(point.x / grid) * grid,
    y: Math.round(point.y / grid) * grid,
  };
}

export function emptyOutline(): GlyphOutline {
  return { elements: [], advance: null, lsb: null, rsb: null };
}

function mapContour(
  outline: GlyphOutline,
  index: number,
  fn: (contour: ContourElement) => ContourElement,
): GlyphOutline {
  const element = outline.elements[index];
  if (!element || !isContour(element)) return outline;
  const elements = outline.elements.slice();
  elements[index] = fn(element);
  return { ...outline, elements };
}

export function newContour(points: Point[], closed: boolean): ContourElement {
  return {
    kind: "contour",
    nodes: points.map((p) => corner(p.x, p.y)),
    closed,
    fill_rule: "nonzero",
  };
}

export function addElement(outline: GlyphOutline, element: GlyphElement): GlyphOutline {
  return { ...outline, elements: [...outline.elements, element] };
}

export function appendNode(
  outline: GlyphOutline,
  element: number,
  node: GlyphNode,
): GlyphOutline {
  return mapContour(outline, element, (c) => ({ ...c, nodes: [...c.nodes, node] }));
}

export function closeContour(outline: GlyphOutline, element: number): GlyphOutline {
  return mapContour(outline, element, (c) => ({ ...c, closed: true }));
}

export function moveNodes(
  outline: GlyphOutline,
  refs: NodeRef[],
  dx: number,
  dy: number,
): GlyphOutline {
  let result = outline;
  const byElement = new Map<number, Set<number>>();
  for (const ref of refs) {
    const set = byElement.get(ref.element) ?? new Set<number>();
    set.add(ref.node);
    byElement.set(ref.element, set);
  }
  for (const [element, nodes] of byElement) {
    result = mapContour(result, element, (c) => ({
      ...c,
      nodes: c.nodes.map((n, i) =>
        nodes.has(i) ? { ...n, x: n.x + dx, y: n.y + dy } : n,
      ),
    }));
  }
  return result;
}

function negate(h: [number, number]): [number, number] {
  return [0 - h[0], 0 - h[1]];
}

function length(h: [number, number]): number {
  return Math.hypot(h[0], h[1]);
}

function scaleTo(h: [number, number], len: number): [number, number] {
  const current = length(h);
  if (current === 0) return [0, 0];
  return [(h[0] / current) * len, (h[1] / current) * len];
}

/** Set one Bezier handle; smooth and symmetric nodes keep the opposite handle aligned. */
export function setHandle(
  outline: GlyphOutline,
  ref: NodeRef,
  which: "in" | "out",
  offset: [number, number] | null,
): GlyphOutline {
  return mapContour(outline, ref.element, (c) => ({
    ...c,
    nodes: c.nodes.map((n, i) => {
      if (i !== ref.node) return n;
      const next: GlyphNode = { ...n };
      if (which === "in") next.handle_in = offset;
      else next.handle_out = offset;
      if (offset && n.kind !== "corner") {
        const other = which === "in" ? n.handle_out : n.handle_in;
        const opposite = negate(offset);
        const mirrored =
          n.kind === "symmetric" || !other
            ? opposite
            : scaleTo(opposite, length(other));
        if (which === "in") next.handle_out = mirrored;
        else next.handle_in = mirrored;
      }
      return next;
    }),
  }));
}

export function setNodeKind(
  outline: GlyphOutline,
  ref: NodeRef,
  kind: NodeKind,
): GlyphOutline {
  return mapContour(outline, ref.element, (c) => ({
    ...c,
    nodes: c.nodes.map((n, i) => {
      if (i !== ref.node) return n;
      const next: GlyphNode = { ...n, kind };
      if (kind === "corner") return next;
      const hin = n.handle_in ?? null;
      const hout = n.handle_out ?? null;
      if (hout && (!hin || kind === "symmetric")) next.handle_in = negate(hout);
      else if (hin && !hout) next.handle_out = negate(hin);
      else if (hin && hout) next.handle_in = scaleTo(negate(hout), length(hin));
      return next;
    }),
  }));
}

export function cycleNodeKind(kind: NodeKind): NodeKind {
  return kind === "corner" ? "smooth" : kind === "smooth" ? "symmetric" : "corner";
}

export function removeNodes(outline: GlyphOutline, refs: NodeRef[]): GlyphOutline {
  const byElement = new Map<number, Set<number>>();
  for (const ref of refs) {
    const set = byElement.get(ref.element) ?? new Set<number>();
    set.add(ref.node);
    byElement.set(ref.element, set);
  }
  const elements: GlyphElement[] = [];
  outline.elements.forEach((element, index) => {
    const drop = byElement.get(index);
    if (!drop || !isContour(element)) {
      elements.push(element);
      return;
    }
    const nodes = element.nodes.filter((_, i) => !drop.has(i));
    if (nodes.length >= 2) elements.push({ ...element, nodes });
  });
  return { ...outline, elements };
}

export function removeElements(outline: GlyphOutline, indexes: number[]): GlyphOutline {
  const drop = new Set(indexes);
  return {
    ...outline,
    elements: outline.elements.filter((_, i) => !drop.has(i)),
  };
}

export function allNodeRefs(outline: GlyphOutline): NodeRef[] {
  const refs: NodeRef[] = [];
  outline.elements.forEach((element, ei) => {
    if (!isContour(element)) return;
    element.nodes.forEach((_, ni) => refs.push({ element: ei, node: ni }));
  });
  return refs;
}

/** The indexes of elements touched by a node selection (all elements when empty). */
export function selectedElements(outline: GlyphOutline, refs: NodeRef[]): number[] {
  if (refs.length === 0) {
    return outline.elements
      .map((element, i) => (isContour(element) ? i : -1))
      .filter((i) => i >= 0);
  }
  return [...new Set(refs.map((ref) => ref.element))].sort((a, b) => a - b);
}

export function hitNode(
  outline: GlyphOutline,
  point: Point,
  radius: number,
): NodeRef | null {
  for (let ei = outline.elements.length - 1; ei >= 0; ei--) {
    const element = outline.elements[ei];
    if (!isContour(element)) continue;
    for (let ni = element.nodes.length - 1; ni >= 0; ni--) {
      const n = element.nodes[ni];
      if (Math.hypot(n.x - point.x, n.y - point.y) <= radius) {
        return { element: ei, node: ni };
      }
    }
  }
  return null;
}

export function hitHandle(
  outline: GlyphOutline,
  point: Point,
  radius: number,
): { ref: NodeRef; which: "in" | "out" } | null {
  for (let ei = outline.elements.length - 1; ei >= 0; ei--) {
    const element = outline.elements[ei];
    if (!isContour(element)) continue;
    for (let ni = element.nodes.length - 1; ni >= 0; ni--) {
      const n = element.nodes[ni];
      for (const which of ["out", "in"] as const) {
        const h = which === "in" ? n.handle_in : n.handle_out;
        if (!h) continue;
        if (Math.hypot(n.x + h[0] - point.x, n.y + h[1] - point.y) <= radius) {
          return { ref: { element: ei, node: ni }, which };
        }
      }
    }
  }
  return null;
}

function segmentPoints(a: GlyphNode, b: GlyphNode): [Point, Point, Point, Point] {
  return [
    { x: a.x, y: a.y },
    a.handle_out ? { x: a.x + a.handle_out[0], y: a.y + a.handle_out[1] } : { x: a.x, y: a.y },
    b.handle_in ? { x: b.x + b.handle_in[0], y: b.y + b.handle_in[1] } : { x: b.x, y: b.y },
    { x: b.x, y: b.y },
  ];
}

function lerp(p: Point, q: Point, t: number): Point {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
}

export function segmentAt(a: GlyphNode, b: GlyphNode, t: number): Point {
  const [p0, p1, p2, p3] = segmentPoints(a, b);
  const ab = lerp(p0, p1, t);
  const bc = lerp(p1, p2, t);
  const cd = lerp(p2, p3, t);
  return lerp(lerp(ab, bc, t), lerp(bc, cd, t), t);
}

function segmentCount(c: GlyphContour): number {
  return c.closed ? c.nodes.length : Math.max(0, c.nodes.length - 1);
}

export interface SegmentHit {
  element: number;
  segment: number;
  t: number;
  distance: number;
  point: Point;
}

/** The parameter and distance of the closest point on one segment: coarse scan, then a ternary refine. */
function closestOnSegment(a: GlyphNode, b: GlyphNode, p: Point): { t: number; distance: number; point: Point } {
  const steps = 32;
  let bestT = 0;
  let bestD = Infinity;
  for (let k = 0; k <= steps; k++) {
    const q = segmentAt(a, b, k / steps);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) {
      bestD = d;
      bestT = k / steps;
    }
  }
  let lo = Math.max(0, bestT - 1 / steps);
  let hi = Math.min(1, bestT + 1 / steps);
  for (let i = 0; i < 28; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const q1 = segmentAt(a, b, m1);
    const q2 = segmentAt(a, b, m2);
    if (Math.hypot(q1.x - p.x, q1.y - p.y) < Math.hypot(q2.x - p.x, q2.y - p.y)) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2;
  const point = segmentAt(a, b, t);
  return { t, distance: Math.hypot(point.x - p.x, point.y - p.y), point };
}

export function nearestSegment(
  outline: GlyphOutline,
  point: Point,
  radius: number,
): SegmentHit | null {
  let best: SegmentHit | null = null;
  outline.elements.forEach((element, ei) => {
    if (!isContour(element)) return;
    const count = segmentCount(element);
    for (let si = 0; si < count; si++) {
      const a = element.nodes[si];
      const b = element.nodes[(si + 1) % element.nodes.length];
      const r = closestOnSegment(a, b, point);
      if (r.distance <= radius && (!best || r.distance < best.distance)) {
        best = { element: ei, segment: si, t: r.t, distance: r.distance, point: r.point };
      }
    }
  });
  return best;
}

export function splitSegment(
  outline: GlyphOutline,
  element: number,
  segment: number,
  t: number,
): GlyphOutline {
  return mapContour(outline, element, (c) => {
    const nodes = c.nodes.slice();
    const a = nodes[segment];
    const bIndex = (segment + 1) % nodes.length;
    const b = nodes[bIndex];
    const [p0, p1, p2, p3] = segmentPoints(a, b);
    const ab = lerp(p0, p1, t);
    const bc = lerp(p1, p2, t);
    const cd = lerp(p2, p3, t);
    const abc = lerp(ab, bc, t);
    const bcd = lerp(bc, cd, t);
    const mid = lerp(abc, bcd, t);
    const curved = !!(a.handle_out || b.handle_in);
    const updatedA: GlyphNode = {
      ...a,
      handle_out: curved ? [ab.x - a.x, ab.y - a.y] : a.handle_out,
    };
    const updatedB: GlyphNode = {
      ...b,
      handle_in: curved ? [cd.x - b.x, cd.y - b.y] : b.handle_in,
    };
    const inserted: GlyphNode = {
      x: mid.x,
      y: mid.y,
      kind: curved ? "smooth" : "corner",
      handle_in: curved ? [abc.x - mid.x, abc.y - mid.y] : undefined,
      handle_out: curved ? [bcd.x - mid.x, bcd.y - mid.y] : undefined,
    };
    nodes[segment] = updatedA;
    nodes[bIndex] = updatedB;
    nodes.splice(segment + 1, 0, inserted);
    return { ...c, nodes };
  });
}

/** Cut a contour at a segment: a closed contour opens, an open one splits in two. */
export function knifeCut(
  outline: GlyphOutline,
  element: number,
  segment: number,
): GlyphOutline {
  const source = outline.elements[element];
  if (!source || !isContour(source)) return outline;
  const nodes = source.nodes;
  const cutA = (n: GlyphNode): GlyphNode => ({ ...n, handle_out: undefined });
  const cutB = (n: GlyphNode): GlyphNode => ({ ...n, handle_in: undefined });
  const replace = (parts: ContourElement[]): GlyphOutline => {
    const elements = outline.elements.slice();
    elements.splice(element, 1, ...parts);
    return { ...outline, elements };
  };
  if (source.closed) {
    const n = nodes.length;
    const rotated: GlyphNode[] = [];
    for (let k = 0; k < n; k++) rotated.push(nodes[(segment + 1 + k) % n]);
    rotated[0] = cutB(rotated[0]);
    rotated[n - 1] = cutA(rotated[n - 1]);
    return replace([{ ...source, nodes: rotated, closed: false }]);
  }
  const head = nodes.slice(0, segment + 1);
  const tail = nodes.slice(segment + 1);
  if (head.length === 0 || tail.length === 0) return outline;
  head[head.length - 1] = cutA(head[head.length - 1]);
  tail[0] = cutB(tail[0]);
  const parts: ContourElement[] = [];
  if (head.length >= 2) parts.push({ ...source, nodes: head });
  if (tail.length >= 2) parts.push({ ...source, nodes: tail });
  return replace(parts);
}

/** A contour for a shape dragged from `a` to `b`. */
export function shapeContour(
  kind: ShapeKind,
  a: Point,
  b: Point,
  sides = 5,
): ContourElement {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = (maxX - minX) / 2;
  const ry = (maxY - minY) / 2;
  if (kind === "line") return newContour([a, b], false);
  if (kind === "rect") {
    return newContour(
      [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ],
      true,
    );
  }
  if (kind === "ellipse") {
    const kx = rx * KAPPA;
    const ky = ry * KAPPA;
    return {
      kind: "contour",
      closed: true,
      fill_rule: "nonzero",
      nodes: [
        { x: cx + rx, y: cy, kind: "smooth", handle_in: [0, -ky], handle_out: [0, ky] },
        { x: cx, y: cy + ry, kind: "smooth", handle_in: [kx, 0], handle_out: [-kx, 0] },
        { x: cx - rx, y: cy, kind: "smooth", handle_in: [0, ky], handle_out: [0, -ky] },
        { x: cx, y: cy - ry, kind: "smooth", handle_in: [-kx, 0], handle_out: [kx, 0] },
      ],
    };
  }
  const count = Math.max(3, Math.round(sides));
  const total = kind === "star" ? count * 2 : count;
  const points: Point[] = [];
  for (let i = 0; i < total; i++) {
    const angle = Math.PI / 2 + (2 * Math.PI * i) / total;
    const scale = kind === "star" && i % 2 === 1 ? 0.45 : 1;
    points.push({
      x: cx + Math.cos(angle) * rx * scale,
      y: cy + Math.sin(angle) * ry * scale,
    });
  }
  return newContour(points, true);
}

export function translation(dx: number, dy: number): Matrix {
  return [1, 0, 0, 1, dx, dy];
}

export function scaling(sx: number, sy: number, cx = 0, cy = 0): Matrix {
  return [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
}

export function rotation(degrees: number, cx = 0, cy = 0): Matrix {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
}

export function shear(degX: number, degY: number, cx = 0, cy = 0): Matrix {
  const tx = Math.tan((degX * Math.PI) / 180);
  const ty = Math.tan((degY * Math.PI) / 180);
  return [1, ty, tx, 1, -tx * cy, -ty * cx];
}

function applyToPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function applyToVector(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

/** Apply an affine matrix to the listed elements. Handles follow the linear part. */
export function applyMatrix(
  outline: GlyphOutline,
  indexes: number[],
  m: Matrix,
): GlyphOutline {
  let result = outline;
  for (const index of indexes) {
    result = mapContour(result, index, (c) => ({
      ...c,
      nodes: c.nodes.map((n) => {
        const [x, y] = applyToPoint(m, n.x, n.y);
        return {
          ...n,
          x,
          y,
          handle_in: n.handle_in ? applyToVector(m, n.handle_in[0], n.handle_in[1]) : n.handle_in,
          handle_out: n.handle_out
            ? applyToVector(m, n.handle_out[0], n.handle_out[1])
            : n.handle_out,
        };
      }),
    }));
  }
  return result;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function elementBounds(outline: GlyphOutline, index: number): Box | null {
  const element = outline.elements[index];
  if (!element || !isContour(element) || element.nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of element.nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  return { minX, minY, maxX, maxY };
}

export function unionBounds(outline: GlyphOutline, indexes: number[]): Box | null {
  let box: Box | null = null;
  for (const index of indexes) {
    const b = elementBounds(outline, index);
    if (!b) continue;
    box = box
      ? {
          minX: Math.min(box.minX, b.minX),
          minY: Math.min(box.minY, b.minY),
          maxX: Math.max(box.maxX, b.maxX),
          maxY: Math.max(box.maxY, b.maxY),
        }
      : b;
  }
  return box;
}

/** Mirror elements across the vertical (`h`) or horizontal (`v`) axis through their centre. */
export function mirrorElements(
  outline: GlyphOutline,
  indexes: number[],
  axis: "h" | "v",
): GlyphOutline {
  const box = unionBounds(outline, indexes);
  if (!box) return outline;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  return applyMatrix(
    outline,
    indexes,
    axis === "h" ? scaling(-1, 1, cx, cy) : scaling(1, -1, cx, cy),
  );
}

export function alignElements(
  outline: GlyphOutline,
  indexes: number[],
  mode: AlignMode,
): GlyphOutline {
  const target = unionBounds(outline, indexes);
  if (!target) return outline;
  let result = outline;
  for (const index of indexes) {
    const b = elementBounds(result, index);
    if (!b) continue;
    let dx = 0;
    let dy = 0;
    if (mode === "left") dx = target.minX - b.minX;
    else if (mode === "right") dx = target.maxX - b.maxX;
    else if (mode === "hcenter")
      dx = (target.minX + target.maxX) / 2 - (b.minX + b.maxX) / 2;
    else if (mode === "bottom") dy = target.minY - b.minY;
    else if (mode === "top") dy = target.maxY - b.maxY;
    else dy = (target.minY + target.maxY) / 2 - (b.minY + b.maxY) / 2;
    result = applyMatrix(result, [index], translation(dx, dy));
  }
  return result;
}

/** Space three or more elements evenly (by centre) along an axis. */
export function distributeElements(
  outline: GlyphOutline,
  indexes: number[],
  axis: "h" | "v",
): GlyphOutline {
  if (indexes.length < 3) return outline;
  const center = (i: number): number => {
    const b = elementBounds(outline, i);
    if (!b) return 0;
    return axis === "h" ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2;
  };
  const sorted = indexes.slice().sort((a, b) => center(a) - center(b));
  const first = center(sorted[0]);
  const last = center(sorted[sorted.length - 1]);
  const step = (last - first) / (sorted.length - 1);
  let result = outline;
  sorted.forEach((index, k) => {
    const delta = first + step * k - center(index);
    result = applyMatrix(
      result,
      [index],
      axis === "h" ? translation(delta, 0) : translation(0, delta),
    );
  });
  return result;
}

export function reorderElement(
  outline: GlyphOutline,
  index: number,
  move: OrderMove,
): { outline: GlyphOutline; index: number } {
  const last = outline.elements.length - 1;
  if (index < 0 || index > last) return { outline, index };
  let target = index;
  if (move === "front") target = last;
  else if (move === "back") target = 0;
  else if (move === "up") target = Math.min(last, index + 1);
  else target = Math.max(0, index - 1);
  if (target === index) return { outline, index };
  const elements = outline.elements.slice();
  const [item] = elements.splice(index, 1);
  elements.splice(target, 0, item);
  return { outline: { ...outline, elements }, index: target };
}

/** Expand a mouse stroke into a closed contour using a fixed-angle calligraphic nib. */
export function brushContour(
  points: Point[],
  width: number,
  angleDegrees: number,
): ContourElement | null {
  const distinct: Point[] = [];
  for (const p of points) {
    const last = distinct[distinct.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 1) distinct.push(p);
  }
  if (distinct.length < 2) return null;
  const r = (angleDegrees * Math.PI) / 180;
  const nx = (Math.cos(r) * width) / 2;
  const ny = (Math.sin(r) * width) / 2;
  const left = distinct.map((p) => ({ x: p.x + nx, y: p.y + ny }));
  const right = distinct.map((p) => ({ x: p.x - nx, y: p.y - ny })).reverse();
  return newContour([...left, ...right], true);
}

/** How many drawable shapes (contours and component instances) an outline has. */
export function shapeCount(outline: GlyphOutline): number {
  return outline.elements.length;
}

/** Whether a pathfinder boolean has anything to combine (it needs two shapes). */
export function canPathfind(outline: GlyphOutline | null): boolean {
  return !!outline && shapeCount(outline) >= 2;
}

function openEndpoint(contour: ContourElement, node: number): boolean {
  return !contour.closed && (node === 0 || node === contour.nodes.length - 1);
}

/** The contour's nodes arranged so that `end` is the last node. */
function endingAt(contour: ContourElement, node: number): GlyphNode[] {
  return node === contour.nodes.length - 1
    ? contour.nodes.slice()
    : contour.nodes.slice().reverse().map(flipHandles);
}

/** The contour's nodes arranged so that `start` is the first node. */
function startingAt(contour: ContourElement, node: number): GlyphNode[] {
  return node === 0 ? contour.nodes.slice() : contour.nodes.slice().reverse().map(flipHandles);
}

function flipHandles(n: GlyphNode): GlyphNode {
  return { ...n, handle_in: n.handle_out, handle_out: n.handle_in };
}

/**
 * Weld two open endpoints into one node at `at` (default: their midpoint).
 * Endpoints on different contours merge the contours into one open path;
 * the two ends of one contour close it. Returns null if either is not an
 * open endpoint, so callers can fall back to doing nothing.
 */
export function weldNodes(
  outline: GlyphOutline,
  a: NodeRef,
  b: NodeRef,
  at?: Point,
): GlyphOutline | null {
  if (a.element === b.element && a.node === b.node) return null;
  const ea = outline.elements[a.element];
  const eb = outline.elements[b.element];
  if (!ea || !eb || !isContour(ea) || !isContour(eb)) return null;
  if (!openEndpoint(ea, a.node) || !openEndpoint(eb, b.node)) return null;
  const ax = ea.nodes[a.node];
  const bx = eb.nodes[b.node];
  const x = at?.x ?? (ax.x + bx.x) / 2;
  const y = at?.y ?? (ax.y + bx.y) / 2;

  if (a.element === b.element) {
    if (ea.nodes.length < 3) return null;
    const first = ea.nodes[0];
    const last = ea.nodes[ea.nodes.length - 1];
    const merged: GlyphNode = {
      ...first,
      x,
      y,
      handle_in: last.handle_in,
      kind: first.kind === "corner" && last.kind === "corner" ? "corner" : "smooth",
    };
    const nodes = [merged, ...ea.nodes.slice(1, -1)];
    return replaceElements(outline, [a.element], [{ ...ea, nodes, closed: true }]);
  }

  const head = endingAt(ea, a.node);
  const tail = startingAt(eb, b.node);
  const left = head[head.length - 1];
  const right = tail[0];
  const joined: GlyphNode = {
    x,
    y,
    kind: left.kind === "corner" && right.kind === "corner" ? "corner" : "smooth",
    handle_in: left.handle_in,
    handle_out: right.handle_out,
  };
  const nodes = [...head.slice(0, -1), joined, ...tail.slice(1)];
  const merged: ContourElement = { ...ea, nodes, closed: false };
  const keep = Math.min(a.element, b.element);
  const drop = Math.max(a.element, b.element);
  const elements = outline.elements.slice();
  elements[keep] = merged;
  elements.splice(drop, 1);
  return { ...outline, elements };
}

function replaceElements(
  outline: GlyphOutline,
  indexes: number[],
  replacements: GlyphElement[],
): GlyphOutline {
  const elements = outline.elements.slice();
  elements.splice(indexes[0], indexes.length, ...replacements);
  return { ...outline, elements };
}

/** Join the two selected endpoints (Shift+J); null when the selection is not exactly two endpoints. */
export function joinSelected(outline: GlyphOutline, refs: NodeRef[]): GlyphOutline | null {
  if (refs.length !== 2) return null;
  return weldNodes(outline, refs[0], refs[1]);
}

/**
 * Break a node in two (Shift+B). A closed contour opens at the node; an open
 * contour splits into two at an interior node. Endpoints cannot be broken.
 */
export function breakNode(outline: GlyphOutline, ref: NodeRef): GlyphOutline | null {
  const element = outline.elements[ref.element];
  if (!element || !isContour(element)) return null;
  const n = element.nodes.length;
  const node = element.nodes[ref.node];
  if (!node) return null;
  const endHalf: GlyphNode = { ...node, handle_out: undefined, kind: "corner" };
  const startHalf: GlyphNode = { ...node, handle_in: undefined, kind: "corner" };
  if (element.closed) {
    const rotated: GlyphNode[] = [];
    for (let k = 0; k < n; k++) rotated.push(element.nodes[(ref.node + k) % n]);
    rotated[0] = startHalf;
    rotated.push(endHalf);
    return replaceElements(outline, [ref.element], [{ ...element, nodes: rotated, closed: false }]);
  }
  if (ref.node === 0 || ref.node === n - 1) return null;
  const first: ContourElement = {
    ...element,
    nodes: [...element.nodes.slice(0, ref.node), endHalf],
  };
  const second: ContourElement = {
    ...element,
    nodes: [startHalf, ...element.nodes.slice(ref.node + 1)],
  };
  return replaceElements(outline, [ref.element], [first, second]);
}

/**
 * Delete nodes while keeping the curve's shape (Inkscape's default Delete):
 * the two segments around a smooth interior node merge into one cubic whose
 * handles are rescaled by the chord-length ratio. Corners and endpoints fall
 * back to a plain removal.
 */
export function deleteNodePreservingShape(outline: GlyphOutline, ref: NodeRef): GlyphOutline {
  const element = outline.elements[ref.element];
  if (!element || !isContour(element)) return outline;
  const n = element.nodes.length;
  const interior = element.closed ? n > 3 : ref.node > 0 && ref.node < n - 1 && n > 2;
  const node = element.nodes[ref.node];
  if (!interior || !node || node.kind === "corner" || !node.handle_in || !node.handle_out) {
    return removeNodes(outline, [ref]);
  }
  const prevIndex = (ref.node - 1 + n) % n;
  const nextIndex = (ref.node + 1) % n;
  const prev = element.nodes[prevIndex];
  const next = element.nodes[nextIndex];
  const l1 = Math.hypot(node.x - prev.x, node.y - prev.y);
  const l2 = Math.hypot(next.x - node.x, next.y - node.y);
  if (l1 === 0 || l2 === 0) return removeNodes(outline, [ref]);
  const total = l1 + l2;
  const nodes = element.nodes.slice();
  nodes[prevIndex] = {
    ...prev,
    handle_out: prev.handle_out
      ? [prev.handle_out[0] * (total / l1), prev.handle_out[1] * (total / l1)]
      : prev.handle_out,
  };
  nodes[nextIndex] = {
    ...next,
    handle_in: next.handle_in
      ? [next.handle_in[0] * (total / l2), next.handle_in[1] * (total / l2)]
      : next.handle_in,
  };
  nodes.splice(ref.node, 1);
  return replaceElements(outline, [ref.element], [{ ...element, nodes }]);
}

/** Move the selected nodes by a whole-unit step (arrow keys; FontForge defaults to 1). */
export function nudgeNodes(
  outline: GlyphOutline,
  refs: NodeRef[],
  dx: number,
  dy: number,
): GlyphOutline {
  return moveNodes(outline, refs, dx, dy);
}

/** Nodes inside an axis-aligned box (rubber-band selection). */
export function nodesInBox(
  outline: GlyphOutline,
  a: Point,
  b: Point,
): NodeRef[] {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const refs: NodeRef[] = [];
  outline.elements.forEach((element, ei) => {
    if (!isContour(element)) return;
    element.nodes.forEach((n, ni) => {
      if (n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY) {
        refs.push({ element: ei, node: ni });
      }
    });
  });
  return refs;
}

/** The next/previous node in drawing order, wrapping (Tab / Shift+Tab). */
export function stepSelection(outline: GlyphOutline, current: NodeRef | null, step: 1 | -1): NodeRef | null {
  const all = allNodeRefs(outline);
  if (all.length === 0) return null;
  if (!current) return all[step === 1 ? 0 : all.length - 1];
  const at = all.findIndex((r) => r.element === current.element && r.node === current.node);
  return all[(at + step + all.length) % all.length];
}
