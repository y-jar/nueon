/**
 * Pure tab-group (split-pane) layout rules and serialization.
 *
 * Kept free of Svelte/Tauri so the ordering and round-trip rules can be unit
 * tested directly.
 */

import type { SplitLayout } from "./api";

/** A node in the recursive split layout. */
export type SplitNode =
  | { type: "leaf"; groupId: string }
  | {
      type: "split";
      direction: "row" | "column";
      children: SplitNode[];
      sizes?: number[];
    };

/**
 * The index to activate after removing the tab at `removedIndex` from a group
 * that now holds `count` tabs: the tab that shifted into that slot, else the
 * one before it, or `null` when the group is empty.
 */
export function nextActiveIndex(count: number, removedIndex: number): number | null {
  if (count <= 0) return null;
  return removedIndex < count ? removedIndex : count - 1;
}

/** Serialize a split tree for persistence. */
export function toSplitLayout(node: SplitNode): SplitLayout {
  if (node.type === "leaf") return { type: "leaf", group: node.groupId };
  return {
    type: "split",
    direction: node.direction,
    children: node.children.map(toSplitLayout),
    ...(node.sizes?.length ? { sizes: [...node.sizes] } : {}),
  };
}

/**
 * Rebuild a split tree from a snapshot, dropping leaves whose group id is not
 * in `ids` and collapsing single-child splits.
 */
export function fromSplitLayout(
  node: SplitLayout,
  ids: Map<string, string>,
): SplitNode | null {
  if (node.type === "leaf") {
    const groupId = ids.get(node.group);
    return groupId ? { type: "leaf", groupId } : null;
  }
  const children = node.children
    .map((child) => fromSplitLayout(child, ids))
    .filter((child): child is SplitNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const sizes =
    node.sizes && node.sizes.length === children.length ? node.sizes : undefined;
  return { type: "split", direction: node.direction, children, sizes };
}

/**
 * Whether the note/folder at `src` can be moved into `folder`: not into
 * itself, not into one of its own descendants, and not into its current parent.
 */
export function canMoveInto(src: string, folder: string): boolean {
  const parent = src.split("/").slice(0, -1).join("/");
  if (folder === parent) return false;
  return folder !== src && !folder.startsWith(`${src}/`);
}
