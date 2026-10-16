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
  | "select"
  | "direct"
  | "hand"
  | "zoom"
  | "pen"
  | "node"
  | "brush"
  | "shapes"
  | "mirror"
  | "eraser"
  | "knife"
  | "measure"
  | "freehand";

export interface Tool {
  id: ToolId;
  label: string;
  shortcut: string;
  /** A lucide icon component name, resolved by the toolbox. */
  icon: string;
  tooltip: string;
}

/** The tool a glyph opens on. */
export const DEFAULT_TOOL: ToolId = "select";

export const TOOL_SHORTCUTS: Record<ToolId, string> = {
  select: "V",
  direct: "A",
  hand: "H",
  zoom: "Z",
  pen: "P",
  node: "N",
  brush: "B",
  shapes: "S",
  mirror: "M",
  eraser: "E",
  knife: "K",
  measure: "R",
  freehand: "F",
};

/**
 * Letters the canvas key handler uses for something other than a tool, in
 * lower case. A tool shortcut must never be one of these. (Shift+H, Shift+J
 * and Shift+B are shifted combinations and do not use the bare letter.)
 */
export const RESERVED_KEYS: string[] = ["0", "1"];

const TOOL_META: Record<ToolId, { label: string; icon: string; what: string }> = {
  select: { label: "Select", icon: "MousePointer2", what: "Select whole shapes" },
  direct: { label: "Direct Select", icon: "MousePointer", what: "Edit nodes and handles" },
  hand: { label: "Hand", icon: "Hand", what: "Drag to pan" },
  zoom: { label: "Zoom", icon: "ZoomIn", what: "Click to zoom in, Alt-click to zoom out, drag a box to fit it" },
  pen: { label: "Pen", icon: "PenTool", what: "Draw paths" },
  node: { label: "Node Mod", icon: "CircleDot", what: "Change node type, add nodes" },
  brush: { label: "Brush", icon: "Brush", what: "Calligraphic stroke" },
  knife: { label: "Knife", icon: "Scissors", what: "Click a contour to cut it open exactly there" },
  measure: { label: "Measure", icon: "RulerDimensionLine", what: "Drag between two points to read their distance and angle" },
  freehand: { label: "Freehand", icon: "Spline", what: "Draw a path; it becomes a few fitted Bezier nodes" },
  shapes: { label: "Shapes", icon: "Shapes", what: "Rectangle, ellipse, polygon, star, line" },
  mirror: { label: "Mirror/Flip", icon: "FlipHorizontal2", what: "Flip the selection" },
  eraser: { label: "Eraser", icon: "Eraser", what: "Delete nodes, cut edges" },
};

const ORDER: ToolId[] = [
  "select", "direct", "hand", "zoom", "measure", "pen", "freehand", "node", "brush", "shapes", "mirror", "eraser", "knife",
];

export const TOOLS: Tool[] = ORDER.map((id) => {
  const meta = TOOL_META[id];
  const shortcut = TOOL_SHORTCUTS[id];
  return {
    id,
    label: meta.label,
    shortcut,
    icon: meta.icon,
    tooltip: `${meta.label} (${shortcut}): ${meta.what}`,
  };
});

export const TOOL_GROUPS: { id: string; tools: ToolId[] }[] = [
  { id: "select", tools: ["select", "direct"] },
  { id: "view", tools: ["hand", "zoom", "measure"] },
  { id: "draw", tools: ["pen", "freehand", "brush", "shapes"] },
  { id: "edit", tools: ["node", "mirror", "eraser", "knife"] },
];

/** The tool bound to a pressed key, ignoring case. */
export function toolByKey(key: string): ToolId | undefined {
  if (key.length !== 1) return undefined;
  const upper = key.toUpperCase();
  return ORDER.find((id) => TOOL_SHORTCUTS[id] === upper);
}

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

/** FontForge's defaults for a 1000 em font: ascent 800, descent 200. */
export const DEFAULT_GUIDES = {
  ascender: 800,
  cap_height: 700,
  x_height: 500,
  descender: -200,
} as const;

/** A guide height, falling back to the default when it is unset (0). */
export function guideHeight(
  config: WritingConfig,
  key: keyof typeof DEFAULT_GUIDES,
): number {
  const value = config[key];
  return value === 0 || !Number.isFinite(value) ? DEFAULT_GUIDES[key] : value;
}

/** The guide rails for a writing config, ordered top to bottom. */
export function guideLines(config: WritingConfig): GuideLine[] {
  return [
    { key: "ascender", y: guideHeight(config, "ascender"), dashed: false },
    { key: "cap_height", y: guideHeight(config, "cap_height"), dashed: false },
    { key: "x_height", y: guideHeight(config, "x_height"), dashed: true },
    { key: "baseline", y: 0, dashed: true },
    { key: "descender", y: guideHeight(config, "descender"), dashed: false },
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


/** First and last codepoints of the Private Use Area used for glyphs. */
export const PUA_START = 0xe000;
export const PUA_END = 0xf8ff;

/** The lowest free Private Use Area codepoint, or null when the area is full. */
export function nextCodepoint(glyphs: GlyphMeta[]): number | null {
  const used = new Set(glyphs.map((glyph) => glyph.codepoint));
  for (let cp = PUA_START; cp <= PUA_END; cp++) {
    if (!used.has(cp)) return cp;
  }
  return null;
}

/** Codepoints used by more than one glyph, with the glyphs that share each. */
export function codepointConflicts(glyphs: GlyphMeta[]): Map<number, string[]> {
  const byCodepoint = new Map<number, string[]>();
  for (const glyph of glyphs) {
    const list = byCodepoint.get(glyph.codepoint) ?? [];
    list.push(glyph.name);
    byCodepoint.set(glyph.codepoint, list);
  }
  for (const [cp, names] of byCodepoint) {
    if (names.length < 2) byCodepoint.delete(cp);
  }
  return byCodepoint;
}
