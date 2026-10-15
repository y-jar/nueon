//! Pure layout for the type preview: sample text, scale, placement and wrapping of shaped runs.
import type { GlyphMeta, Phoneme } from "./api";

export const MIN_SIZE = 12;
export const MAX_SIZE = 300;
const DEFAULT_SIZE = 48;
const MAX_TEXT = 20000;

export interface ShapedGlyph {
  id: number;
  cluster: number;
  advance: number;
  x_offset: number;
  y_offset: number;
}

export interface ShapedRun {
  glyphs: ShapedGlyph[];
  advance: number;
  upem: number;
}

export function clampSize(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(px)));
}

/** Pixels per font unit for a size in pixels per em. */
export function scaleOf(sizePx: number, upem: number): number {
  return sizePx / (upem > 0 ? upem : 1000);
}

/** Text lines: a trailing newline adds no empty line; blank lines in the middle stay. */
export function linesFor(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function textFor(text: string, limit = MAX_TEXT): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

export interface Placement {
  id: number;
  cluster: number;
  x: number;
  y: number;
  width: number;
}

/** Where each glyph of a run goes, in pixels, with the shaper's offsets applied (y is up in font units, so down in pixels). */
export function glyphPlacements(run: ShapedRun, scale: number): Placement[] {
  const out: Placement[] = [];
  let x = 0;
  for (const g of run.glyphs) {
    out.push({
      id: g.id,
      cluster: g.cluster,
      x: x + g.x_offset * scale,
      y: -g.y_offset * scale,
      width: g.advance * scale,
    });
    x += g.advance * scale;
  }
  return out;
}

export interface LineMetrics {
  width: number;
  height: number;
  baseline: number;
  ascent: number;
  descent: number;
}

export function lineMetrics(run: ShapedRun, scale: number, ascender: number, descender: number): LineMetrics {
  const ascent = ascender * scale;
  const descent = -descender * scale;
  return { width: run.advance * scale, height: ascent + descent, baseline: ascent, ascent, descent };
}

/** Break a run into rows no wider than `width` pixels, by whole glyphs; a glyph wider than the row sits alone. */
export function wrapRuns(run: ShapedRun, scale: number, width: number): ShapedRun[] {
  if (run.glyphs.length === 0) return [];
  if (!(width > 0)) return [run];
  const rows: ShapedRun[] = [];
  let current: ShapedGlyph[] = [];
  let used = 0;
  for (const g of run.glyphs) {
    const w = g.advance * scale;
    if (current.length > 0 && used + w > width + 1e-9) {
      rows.push({ glyphs: current, advance: current.reduce((a, c) => a + c.advance, 0), upem: run.upem });
      current = [];
      used = 0;
    }
    current.push(g);
    used += w;
  }
  if (current.length > 0) {
    rows.push({ glyphs: current, advance: current.reduce((a, c) => a + c.advance, 0), upem: run.upem });
  }
  return rows;
}

export type SampleSource =
  | { source: "custom"; custom?: string }
  | { source: "words"; words?: string[] }
  | { source: "all" }
  | { source: "pairs" };

const char = (g: GlyphMeta) => String.fromCodePoint(g.codepoint);

/** The preview text for a source: typed text, picked words, every glyph, or every glyph beside every glyph. */
export function sampleText(source: SampleSource, glyphs: GlyphMeta[], _phonemes: Phoneme[]): string {
  switch (source.source) {
    case "custom":
      return source.custom ?? "";
    case "words":
      return (source.words ?? []).join("\n");
    case "all":
      return glyphs.map(char).join("");
    case "pairs":
      return glyphs.map((a) => glyphs.map((b) => `${char(a)}${char(b)}`).join(" ")).join("\n");
  }
}

/** Pixel reach of a gap between two letters. */
export const GAP_HIT_PX = 6;

export interface GapTarget {
  /** Index of the glyph on the left of the gap (visual order), and of the one on the right. */
  left: number;
  right: number;
}

/**
 * The gap between two neighbouring glyphs under a pointer at pixel `x` of a row.
 * The gap is the boundary where one advance box ends and the next begins; both
 * glyphs must be editable (a hidden letter or `.notdef` has no spacing to edit).
 */
export function gapAt(
  placed: { x: number; width: number }[],
  x: number,
  editable: boolean[],
): GapTarget | null {
  let best: { target: GapTarget; d: number } | null = null;
  for (let i = 0; i + 1 < placed.length; i++) {
    if (!editable[i] || !editable[i + 1]) continue;
    const boundary = placed[i].x + placed[i].width;
    const d = Math.abs(x - boundary);
    if (d <= GAP_HIT_PX && (!best || d < best.d)) best = { target: { left: i, right: i + 1 }, d };
  }
  return best ? best.target : null;
}

export type GapMode = "split" | "left" | "right";

/**
 * Right-bearing change of the left glyph and left-bearing change of the right
 * glyph, in font units, for dragging a gap by `dxPixels`. "split" shares the
 * change equally; "left" and "right" put all of it on one glyph. In a
 * right-to-left row the visual left glyph is the later letter, so the sign flips.
 */
export function gapDragEdits(
  dxPixels: number,
  scale: number,
  mode: GapMode,
  rtl = false,
): { leftRsb: number; rightLsb: number } {
  if (!(scale > 0)) return { leftRsb: 0, rightLsb: 0 };
  const units = (dxPixels / scale) * (rtl ? -1 : 1);
  if (mode === "left") return { leftRsb: units, rightLsb: 0 };
  if (mode === "right") return { leftRsb: 0, rightLsb: units };
  return { leftRsb: units / 2, rightLsb: units / 2 };
}
