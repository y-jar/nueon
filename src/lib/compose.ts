/**
 * Pure rules for linking a composed word back to its roots.
 *
 * Kept free of Svelte/Tauri so the parent-selection rules can be unit-tested.
 */

import type { LexiconWord } from "./api";

/** A root of a composed form: enough to list it and to link it as a parent. */
export interface Root {
  table: string;
  id: string;
  label: string;
}

/** Resolve the strip's word pieces to distinct roots, in strip order. */
export function rootsOf(
  pieces: { kind: "word" | "morpheme"; id: string }[],
  lexicon: Pick<LexiconWord, "id" | "table" | "wordname">[],
): Root[] {
  const byId = new Map(lexicon.map((word) => [word.id, word]));
  const seen = new Set<string>();
  const roots: Root[] = [];
  for (const piece of pieces) {
    if (piece.kind !== "word" || seen.has(piece.id)) continue;
    const word = byId.get(piece.id);
    if (!word) continue;
    seen.add(piece.id);
    roots.push({ table: word.table, id: word.id, label: word.wordname });
  }
  return roots;
}

/**
 * The table holding the most roots, so the fewest end up unlinked. Ties break
 * toward the table of the earliest root.
 */
export function defaultTableFor(roots: Root[]): string {
  if (roots.length === 0) return "";
  const counts = new Map<string, number>();
  for (const root of roots) {
    counts.set(root.table, (counts.get(root.table) ?? 0) + 1);
  }
  let best = roots[0].table;
  let bestCount = 0;
  for (const [table, count] of counts) {
    if (count > bestCount) {
      best = table;
      bestCount = count;
    }
  }
  return best;
}

/** Each root with whether it can be linked to a word saved in `table`. */
export function partitionParents(
  roots: Root[],
  table: string,
): { root: Root; linked: boolean }[] {
  return roots.map((root) => ({ root, linked: root.table === table }));
}
