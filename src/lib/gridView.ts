/**
 * Pure helpers for a table's persisted grid view state.
 *
 * Kept free of Svelte and Tauri so the pruning rules — which decide whether a
 * column id or width is kept or dropped — can be unit-tested directly.
 */

/** Column ids and widths the caller wants to persist. */
export interface ViewInput {
  /** Stored order, possibly containing stale ids and `wordname`. */
  columnOrder: readonly string[];
  /** Stored widths, possibly containing stale ids. */
  columnSizing: Readonly<Record<string, number>>;
  /** Column ids that currently exist (excluding `wordname`). */
  knownIds: readonly string[];
  /**
   * Whether the table's columns are actually loaded. Before they are, we do
   * not know which ids are real, so nothing may be pruned.
   */
  columnsLoaded: boolean;
}

/** The normalized order and widths to persist. */
export interface ViewOutput {
  order: string[];
  widths: Record<string, number>;
}

/**
 * Normalize a view for persistence.
 *
 * - `wordname` is always first and never stored in another position.
 * - When the columns are loaded, ids that no longer exist are dropped and
 *   unknown columns are appended last.
 * - When the columns are **not** loaded yet, nothing is pruned: a save that
 *   fires early must not discard real ids or widths it cannot yet verify.
 */
export function normalizeView(input: ViewInput): ViewOutput {
  const { columnOrder, columnSizing, knownIds, columnsLoaded } = input;
  const ordered = columnOrder.filter((id) => id !== "wordname");

  if (!columnsLoaded) {
    // Columns unknown: keep everything, only pin `wordname` first.
    return {
      order: ["wordname", ...ordered],
      widths: roundWidths(columnSizing),
    };
  }

  const kept = ordered.filter((id) => knownIds.includes(id));
  const order = [
    "wordname",
    ...kept,
    ...knownIds.filter((id) => !kept.includes(id)),
  ];
  const widths = Object.fromEntries(
    Object.entries(columnSizing)
      .filter(([id]) => id === "wordname" || knownIds.includes(id))
      .map(([id, width]) => [id, Math.round(width)]),
  );
  return { order, widths };
}

function roundWidths(
  sizing: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(sizing).map(([id, width]) => [id, Math.round(width)]),
  );
}
