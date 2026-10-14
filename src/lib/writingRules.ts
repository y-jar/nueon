//! Pure helpers for editing orthography rules in the writing tab.
import type { GlyphMeta, OrthographyRule } from "./api";

/** A new, blank rule at the end of the list. */
export function addRule(rules: OrthographyRule[]): OrthographyRule[] {
  return [...rules, { from: "", to: [], left: "", right: "" }];
}

export function updateRule(
  rules: OrthographyRule[],
  index: number,
  patch: Partial<OrthographyRule>,
): OrthographyRule[] {
  return rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule));
}

export function removeRule(rules: OrthographyRule[], index: number): OrthographyRule[] {
  return rules.filter((_, i) => i !== index);
}

/** Rule order matters (earlier rules act first), so rules can be moved one step. */
export function moveRule(
  rules: OrthographyRule[],
  index: number,
  delta: -1 | 1,
): OrthographyRule[] {
  const to = index + delta;
  if (index < 0 || index >= rules.length || to < 0 || to >= rules.length) return rules;
  const next = rules.slice();
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** Glyph ids from typed names (comma or space separated); a raw id is accepted too. */
export function parseTargets(
  text: string,
  glyphs: GlyphMeta[],
): { ids: string[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const word of text.split(/[\s,]+/).filter(Boolean)) {
    const found = glyphs.find((g) => g.name === word) ?? glyphs.find((g) => g.id === word);
    if (found) ids.push(found.id);
    else unknown.push(word);
  }
  return { ids, unknown };
}

/** Glyph names for display; a glyph that no longer exists shows its id. */
export function formatTargets(ids: string[], glyphs: GlyphMeta[]): string {
  return ids.map((id) => glyphs.find((g) => g.id === id)?.name ?? id).join(", ");
}

/** A one-line reading of a rule, e.g. `a -> ta / C_#`. */
export function describeRule(rule: OrthographyRule, glyphs: GlyphMeta[]): string {
  if (!rule.from && rule.to.length === 0) return "(empty rule)";
  const context = rule.left || rule.right ? ` / ${rule.left ?? ""}_${rule.right ?? ""}` : "";
  return `${rule.from} \u2192 ${formatTargets(rule.to, glyphs)}${context}`;
}
