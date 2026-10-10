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

/** A tab's identity: its kind, plus the ref for non-singleton tabs. */
export interface TabKey {
  kind: string;
  ref: string | null;
}

/** Tool tabs exist at most once per window. */
const SINGLETON_KINDS = new Set(["translation", "morphology", "phonology"]);

export function isSingletonTab(kind: string): boolean {
  return SINGLETON_KINDS.has(kind);
}

/**
 * Whether a tab satisfies a reveal request: tool tabs match by kind, every
 * other tab by kind and ref.
 */
export function tabMatches(tab: TabKey, key: TabKey): boolean {
  if (isSingletonTab(key.kind)) return tab.kind === key.kind;
  return tab.kind === key.kind && tab.ref === key.ref;
}

/** The first group holding a tab that matches `key`, or null. */
export function findTabGroup(
  groups: { id: string; tabs: TabKey[] }[],
  key: TabKey,
): string | null {
  for (const group of groups) {
    if (group.tabs.some((tab) => tabMatches(tab, key))) return group.id;
  }
  return null;
}

/**
 * Restored tabs whose identity was already seen: the first occurrence wins,
 * later repeats are reported so the caller can drop them.
 */
export function duplicateTabs(
  groups: { id: string; tabs: TabKey[] }[],
): { groupId: string; index: number }[] {
  const seen: TabKey[] = [];
  const dropped: { groupId: string; index: number }[] = [];
  for (const group of groups) {
    group.tabs.forEach((tab, index) => {
      if (seen.some((key) => tabMatches(tab, key))) {
        dropped.push({ groupId: group.id, index });
      } else {
        seen.push({ kind: tab.kind, ref: tab.ref });
      }
    });
  }
  return dropped;
}
