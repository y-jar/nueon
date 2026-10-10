//! Value-suggestion filtering for tag_list/text cells.
/**
 * Pure value-suggestion matching for column autocomplete. Kept free of Svelte
 * and DOM so the ranking rules can be unit-tested directly.
 */

/**
 * Values to offer for a typed `draft`, case-insensitively. An empty draft
 * offers everything (alphabetical); otherwise prefix matches rank before
 * substring matches. Deduplicated and capped at `limit`.
 */
export function filterSuggestions(
  values: readonly string[],
  draft: string,
  limit = 8,
): string[] {
  const sorted = [...new Set(values)].sort((a, b) => a.localeCompare(b));
  const needle = draft.trim().toLowerCase();
  if (!needle) return sorted.slice(0, limit);

  const prefix: string[] = [];
  const contains: string[] = [];
  for (const value of sorted) {
    const lower = value.toLowerCase();
    if (lower.startsWith(needle)) prefix.push(value);
    else if (lower.includes(needle)) contains.push(value);
  }
  return [...prefix, ...contains].slice(0, limit);
}
