//! Pure filtering and grouping for the Writing System sidebar glyph list.
import type { GlyphMeta, Phoneme } from "./api.ts";
import { groupGlyphs, soundCoverage } from "./writing.ts";

export interface SidebarGroup {
  name: string;
  glyphs: GlyphMeta[];
}

/** Glyphs whose name, group or mapped sound symbols match the filter text. */
export function filterGlyphs(
  glyphs: GlyphMeta[],
  phonemes: Phoneme[],
  filter: string,
): GlyphMeta[] {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return glyphs;
  const symbolOf = new Map(phonemes.map((p) => [p.id ?? p.symbol, p.symbol]));
  return glyphs.filter((glyph) => {
    const sounds = glyph.phonemes.map((id) => symbolOf.get(id) ?? id).join(" ");
    return `${glyph.name} ${glyph.group} ${sounds}`.toLowerCase().includes(needle);
  });
}

/** Filtered glyphs grouped like the navigator, groups sorted by name. */
export function sidebarGroups(
  glyphs: GlyphMeta[],
  phonemes: Phoneme[],
  filter: string,
): SidebarGroup[] {
  const grouped = groupGlyphs(filterGlyphs(glyphs, phonemes, filter));
  return [...grouped.entries()]
    .map(([name, list]) => ({ name, glyphs: list }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function sidebarCoverage(glyphs: GlyphMeta[], phonemes: Phoneme[]) {
  return soundCoverage(
    glyphs,
    phonemes.map((p) => p.id ?? p.symbol),
  );
}
