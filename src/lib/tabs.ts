/**
 * Pure rules for the tab-group (split-pane) layout.
 *
 * Kept free of Svelte/Tauri so the "should this pane disappear?" decision can
 * be unit-tested directly.
 */

/**
 * Whether a group that now holds `tabCount` tabs should be removed from the
 * layout, collapsing its split tile.
 *
 * A pane is only pruned once it is empty **and** it is not the last pane: the
 * final pane is always kept, showing the empty state, so the app never ends up
 * with no place to open a tab.
 */
export function shouldPruneGroup(tabCount: number, groupCount: number): boolean {
  return tabCount === 0 && groupCount > 1;
}
