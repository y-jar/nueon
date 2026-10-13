//! Pure writing-system helpers: glyph grouping and ordering.
import type { GlyphMeta } from "./api";

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
