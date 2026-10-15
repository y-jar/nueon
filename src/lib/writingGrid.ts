//! Pure logic for the glyph grid: cells, filters, progress, cell geometry and the virtual window.
import type { GlyphMeta, GlyphOutline, Phoneme } from "./api";
import { flattenElements, type GlyphLookup } from "./writingComponents.ts";
import { contourPathData } from "./writing.ts";

export const CELL_SIZES = { S: 64, M: 96, L: 144 } as const;
export const MIN_CELL = 48;
export const MAX_CELL = 240;
/** Height of the label strip above each cell's drawing, in pixels. */
export const LABEL_HEIGHT = 18;
const DEFAULT_ADVANCE = 600;
const EM = 1000;

export function clampCell(px: number): number {
  if (!Number.isFinite(px)) return CELL_SIZES.M;
  return Math.min(MAX_CELL, Math.max(MIN_CELL, Math.round(px)));
}

/** The advance a glyph will have in the font: stored, else ink right edge + 50, else 600. */
export function effectiveAdvance(outline: GlyphOutline | null | undefined): number {
  if (outline?.advance) return outline.advance;
  if (!outline) return DEFAULT_ADVANCE;
  let max = -Infinity;
  for (const el of outline.elements) {
    if (el.kind !== "contour") continue;
    for (const n of el.nodes) max = Math.max(max, n.x);
  }
  return Number.isFinite(max) ? Math.round(max + 50) : DEFAULT_ADVANCE;
}

/**
 * A square view box in y-flipped SVG space, centred on the advance box and on
 * the em. Every cell uses the same scale, so glyphs compare by size and a wide
 * advance widens the box rather than clipping.
 */
export function cellViewBox(advance: number, ascender: number, descender: number) {
  const em = Math.max(EM, ascender - descender);
  const size = Math.max(em, advance + 100);
  return {
    x: advance / 2 - size / 2,
    y: -(ascender + descender) / 2 - size / 2,
    w: size,
    h: size,
  };
}

export interface Preview {
  d: string;
  advance: number;
  drawn: boolean;
}

function hasInk(d: string): boolean {
  return d.length > 0;
}

/** Path data for a glyph's own contours and its components' (transformed), y-flipped. */
export function previewOf(outline: GlyphOutline | null | undefined, lookup?: GlyphLookup): Preview {
  if (!outline) return { d: "", advance: DEFAULT_ADVANCE, drawn: false };
  let d = "";
  for (const el of outline.elements) {
    if (el.kind === "contour" && el.nodes.length >= 2) d += contourPathData(el, true);
  }
  if (lookup) {
    for (const flat of flattenElements(outline, lookup)) {
      for (const c of flat.contours) if (c.nodes.length >= 2) d += contourPathData(c, true);
    }
  }
  return { d, advance: effectiveAdvance(outline), drawn: hasInk(d) };
}

/** True when the outline has at least one contour with two or more points. */
export function isDrawn(outline: GlyphOutline | null | undefined): boolean {
  if (!outline) return false;
  return outline.elements.some(
    (el) => el.kind === "component" || (el.kind === "contour" && el.nodes.length >= 2),
  );
}

export type SoundKind = "consonant" | "vowel" | "other" | "unmapped";

export function soundKindOf(glyph: GlyphMeta, phonemes: Phoneme[]): SoundKind {
  const byId = new Map(phonemes.map((p) => [p.id ?? p.symbol, p.kind]));
  for (const id of glyph.phonemes) {
    const kind = byId.get(id);
    if (kind) return kind;
  }
  return "unmapped";
}

export interface GridFilter {
  /** A navigator group name, or null for all. */
  group: string | null;
  sound: "all" | SoundKind;
  fill: "all" | "drawn" | "empty";
  text: string;
}

export type Cell =
  | { kind: "glyph"; glyph: GlyphMeta; symbols: string[]; drawn: boolean; sound: SoundKind }
  | { kind: "empty"; phoneme: Phoneme; sound: SoundKind };

const GROUP_OF_KIND: Record<string, string> = { consonant: "consonants", vowel: "vowels", other: "other" };

function sortGlyphs(glyphs: GlyphMeta[]): GlyphMeta[] {
  return [...glyphs].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Glyph cells (in order), then an empty slot for each sound no glyph covers. */
export function buildCells(
  glyphs: GlyphMeta[],
  phonemes: Phoneme[],
  outlines: Record<string, GlyphOutline | null | undefined>,
  filter: GridFilter,
): Cell[] {
  const symbolOf = new Map(phonemes.map((p) => [p.id ?? p.symbol, p.symbol]));
  const covered = new Set(glyphs.flatMap((g) => g.phonemes));
  const needle = filter.text.trim().toLowerCase();
  const cells: Cell[] = [];

  for (const glyph of sortGlyphs(glyphs)) {
    const symbols = glyph.phonemes.map((id) => symbolOf.get(id) ?? id);
    const drawn = isDrawn(outlines[glyph.id]);
    const sound = soundKindOf(glyph, phonemes);
    if (filter.group !== null && (glyph.group || "ungrouped") !== filter.group) continue;
    if (filter.sound !== "all" && sound !== filter.sound) continue;
    if (filter.fill === "drawn" && !drawn) continue;
    if (filter.fill === "empty" && drawn) continue;
    if (needle && !`${glyph.name} ${glyph.group} ${symbols.join(" ")}`.toLowerCase().includes(needle)) continue;
    cells.push({ kind: "glyph", glyph, symbols, drawn, sound });
  }

  for (const phoneme of phonemes) {
    if (covered.has(phoneme.id ?? phoneme.symbol)) continue;
    const sound: SoundKind = phoneme.kind;
    if (filter.group !== null && GROUP_OF_KIND[phoneme.kind] !== filter.group) continue;
    if (filter.sound !== "all" && sound !== filter.sound) continue;
    if (filter.fill === "drawn") continue;
    if (needle && !phoneme.symbol.toLowerCase().includes(needle)) continue;
    cells.push({ kind: "empty", phoneme, sound });
  }
  return cells;
}

/** "N of M drawn": every glyph plus every uncovered sound counts, whatever the filters. */
export function progressOf(
  glyphs: GlyphMeta[],
  phonemes: Phoneme[],
  outlines: Record<string, GlyphOutline | null | undefined>,
): { drawn: number; total: number } {
  const covered = new Set(glyphs.flatMap((g) => g.phonemes));
  const empty = phonemes.filter((p) => !covered.has(p.id ?? p.symbol)).length;
  const drawn = glyphs.filter((g) => isDrawn(outlines[g.id])).length;
  return { drawn, total: glyphs.length + empty };
}

export interface GridLayout {
  cols: number;
  rows: number;
  rowHeight: number;
}

/** Columns that fit `width`, rows for `count` cells, and the height of one row. */
export function gridLayout(count: number, width: number, cell: number, gap: number): GridLayout {
  const usable = Number.isFinite(width) && width > 0 ? width : 0;
  const cols = Math.max(1, Math.floor((usable + gap) / (cell + gap)));
  return { cols, rows: count === 0 ? 0 : Math.ceil(count / cols), rowHeight: cell + LABEL_HEIGHT + gap };
}

/** The inclusive range of rows to render: those in view plus `overscan` on each side. */
export function visibleRows(
  scrollTop: number,
  viewHeight: number,
  rowHeight: number,
  rows: number,
  overscan: number,
): { first: number; last: number } {
  if (rows <= 0) return { first: 0, last: -1 };
  const rh = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
  const view = Number.isFinite(viewHeight) && viewHeight > 0 ? viewHeight : rh;
  const maxTop = Math.max(0, rows * rh - view);
  const top = Math.min(maxTop, Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0);
  const first = Math.max(0, Math.min(rows - 1, Math.floor(top / rh) - overscan));
  const last = Math.min(rows - 1, Math.ceil((top + view) / rh) + overscan - 1);
  return { first, last: Math.max(first, last) };
}

/**
 * Whether a freshly loaded config should replace the one on screen: only when
 * it really differs, and never while a local edit is still waiting to be saved.
 */
export function shouldApplyReload(current: unknown, loaded: unknown, pendingLocalEdit: boolean): boolean {
  if (pendingLocalEdit) return false;
  return JSON.stringify(current) !== JSON.stringify(loaded);
}
