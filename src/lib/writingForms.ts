//! Pure helpers for a glyph's positional forms (initial, medial, final).
import type { GlyphForms, GlyphMeta } from "./api";

export const FORM_KEYS = ["initial", "medial", "final_form"] as const;
export type FormKey = (typeof FORM_KEYS)[number];

export function hasForms(glyph: GlyphMeta): boolean {
  const forms = glyph.forms;
  return !!forms && FORM_KEYS.some((key) => !!forms[key]);
}

/** A copy of the glyph with one form set; an empty value clears it, and no forms left drops the field. */
export function setForm(glyph: GlyphMeta, key: FormKey, value: string | null): GlyphMeta {
  const forms: GlyphForms = { ...glyph.forms };
  if (value) forms[key] = value;
  else delete forms[key];
  const { forms: _old, ...rest } = glyph;
  return FORM_KEYS.some((k) => !!forms[k]) ? { ...rest, forms } : rest;
}

/** The glyphs a form can point at: every glyph except the one being edited. */
export function formChoices(
  glyphs: GlyphMeta[],
  selfId: string,
): { id: string; name: string }[] {
  return glyphs.filter((g) => g.id !== selfId).map((g) => ({ id: g.id, name: g.name }));
}
