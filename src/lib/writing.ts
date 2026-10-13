//! Pure writing-system helpers: glyph grouping, ordering and geometry.
import type {
  GlyphMeta,
  GlyphOutline,
  GlyphContour,
  GlyphNode,
  GlyphComponent,
  WritingConfig,
} from "./api";

/** Glyphs without a group land in the `ungrouped` bucket. */
export const UNGROUPED = "ungrouped";

/**
 * Group glyphs by their `group` field and sort each group by `order` (then
 * name for stability), returning groups in insertion order.
 */
export function groupGlyphs(glyphs: GlyphMeta[]): Map<string, GlyphMeta[]> {
  const groups = new Map<string, GlyphMeta[]>();
  for (const glyph of glyphs) {
    const key = glyph.group || UNGROUPED;
    const list = groups.get(key) ?? [];
    list.push(glyph);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }
  return groups;
}

/** How many phoneme ids are covered by at least one glyph. */
export function soundCoverage(
  glyphs: GlyphMeta[],
  phonemeIds: string[],
): { total: number; mapped: number } {
  const covered = new Set<string>();
  for (const glyph of glyphs) {
    for (const id of glyph.phonemes) covered.add(id);
  }
  const mapped = phonemeIds.filter((id) => covered.has(id)).length;
  return { total: phonemeIds.length, mapped };
}

/** The editor's tool set, in toolbox order. */
export type ToolId =
  | "pen"
  | "direct"
  | "node"
  | "brush"
  | "shapes"
  | "mirror"
  | "eraser";

export interface Tool {
  id: ToolId;
  label: string;
  shortcut: string;
}

export const TOOLS: Tool[] = [
  { id: "pen", label: "Pen", shortcut: "P" },
  { id: "direct", label: "Direct Select", shortcut: "A" },
  { id: "node", label: "Node Mod", shortcut: "N" },
  { id: "brush", label: "Brush", shortcut: "B" },
  { id: "shapes", label: "Shapes", shortcut: "S" },
  { id: "mirror", label: "Mirror/Flip", shortcut: "M" },
  { id: "eraser", label: "Eraser", shortcut: "E" },
];

/** The y-up bounding box of a glyph's contours, or `null` when empty. */
export interface Bounds {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

export function outlineBounds(outline: GlyphOutline): Bounds | null {
  let min_x = Infinity;
  let min_y = Infinity;
  let max_x = -Infinity;
  let max_y = -Infinity;
  let seen = false;
  for (const element of outline.elements) {
    if (element.kind !== "contour") continue;
    for (const node of element.nodes) {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
      seen = true;
      min_x = Math.min(min_x, node.x);
      max_x = Math.max(max_x, node.x);
      min_y = Math.min(min_y, node.y);
      max_y = Math.max(max_y, node.y);
    }
  }
  return seen ? { min_x, min_y, max_x, max_y } : null;
}

/** A typographic guide rail. `y` is in storage (y-up) coordinates. */
export interface GuideLine {
  key: "ascender" | "cap_height" | "x_height" | "baseline" | "descender";
  y: number;
  dashed: boolean;
}

/** The guide rails for a writing config, ordered top to bottom. */
export function guideLines(config: WritingConfig): GuideLine[] {
  return [
    { key: "ascender", y: config.ascender, dashed: false },
    { key: "cap_height", y: config.cap_height, dashed: false },
    { key: "x_height", y: config.x_height, dashed: true },
    { key: "baseline", y: 0, dashed: true },
    { key: "descender", y: config.descender, dashed: false },
  ];
}

/** Flip a storage (y-up) coordinate into an SVG (y-down) one. */
export function flipY(y: number): number {
  return -y;
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function segment(prev: GlyphNode, cur: GlyphNode, cy: (y: number) => number): string {
  if (prev.handle_out && cur.handle_in) {
    return ` C ${fmt(prev.x + prev.handle_out[0])} ${fmt(cy(prev.y + prev.handle_out[1]))} ${fmt(
      cur.x + cur.handle_in[0],
    )} ${fmt(cy(cur.y + cur.handle_in[1]))} ${fmt(cur.x)} ${fmt(cy(cur.y))}`;
  }
  return ` L ${fmt(cur.x)} ${fmt(cy(cur.y))}`;
}

/** The SVG path `d` for one contour, optionally y-flipped. */
export function contourPathData(contour: GlyphContour, yFlip: boolean): string {
  const nodes = contour.nodes;
  if (nodes.length === 0) return "";
  const cy = (y: number) => (yFlip ? -y : y);
  let d = `M ${fmt(nodes[0].x)} ${fmt(cy(nodes[0].y))}`;
  for (let i = 1; i < nodes.length; i++) {
    d += segment(nodes[i - 1], nodes[i], cy);
  }
  if (contour.closed && nodes.length > 1) {
    d += segment(nodes[nodes.length - 1], nodes[0], cy);
  }
  if (contour.closed) d += " Z";
  return d;
}

/** The SVG path `d` for a glyph's contours (components are skipped). */
export function outlinePathData(outline: GlyphOutline, yFlip: boolean): string {
  let d = "";
  for (const element of outline.elements) {
    if (element.kind === "contour") d += contourPathData(element, yFlip);
  }
  return d;
}

/** A component instance referencing another glyph. */
export function componentElement(
  glyphId: string,
  dx = 0,
  dy = 0,
): { kind: "component" } & GlyphComponent {
  return {
    kind: "component",
    glyph: glyphId,
    dx,
    dy,
    scale_x: 1,
    scale_y: 1,
    rotation: 0,
  };
}

/** A new glyph composed of two component references (row + column radicals). */
export function compositeOutline(rowId: string, colId: string): GlyphOutline {
  return {
    elements: [componentElement(rowId), componentElement(colId, 500)],
    advance: null,
    lsb: null,
    rsb: null,
  };
}

