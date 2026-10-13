//! Pure batch operations over the glyph index (multi-select actions).
import type { GlyphMeta } from "./api";

/** Toggle one id in a selection, keeping its order of insertion. */
export function toggleSelected(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

/** Remove the selected glyphs from the index. */
export function deleteGlyphs(glyphs: GlyphMeta[], ids: string[]): GlyphMeta[] {
  const drop = new Set(ids);
  return glyphs
    .filter((g) => !drop.has(g.id))
    .map((g, order) => ({ ...g, order }));
}

/** Move the selected glyphs into a group (blank means ungrouped). */
export function moveToGroup(glyphs: GlyphMeta[], ids: string[], group: string): GlyphMeta[] {
  const pick = new Set(ids);
  return glyphs.map((g) => (pick.has(g.id) ? { ...g, group: group.trim() } : g));
}

/** Ids that other glyphs reference as components (and would break if deleted). */
export function dependents(
  outlines: Record<string, { elements: { kind: string; glyph?: string }[] }>,
  ids: string[],
): string[] {
  const targets = new Set(ids);
  const broken: string[] = [];
  for (const [id, outline] of Object.entries(outlines)) {
    if (targets.has(id)) continue;
    const uses = outline.elements.some(
      (element) => element.kind === "component" && element.glyph && targets.has(element.glyph),
    );
    if (uses) broken.push(id);
  }
  return broken;
}
