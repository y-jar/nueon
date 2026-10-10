//! Tiling layout: tab drag between panes/windows, split/merge and persistence.

import { emit, listen } from "@tauri-apps/api/event";

import * as api from "./api";
import { windowLabel } from "./window";
import { makeGroup, newId, ui, type Tab, type TabGroup, type TabKind } from "./store.svelte";
import { fromSplitLayout, toSplitLayout, type SplitNode } from "./tiling";
import { duplicateTabs } from "./tabs";
import { activateTab, closeTab, tr } from "./state.svelte";
import { activateNeighbor } from "./tabs.svelte";

let dragTimer: ReturnType<typeof setTimeout> | null = null;

/** Sentinel `fromGroupId` for a tab dragged in from another window. */
export const FOREIGN_GROUP = "__foreign__";
const foreignTabs = new Map<string, api.TabLayout>();

/** Broadcast payload announcing a tab drag to every window. */
interface TabDragEvent {
  phase: "start" | "end";
  sourceLabel: string;
  tab?: api.TabLayout;
}

/** The drag started in *this* window, until it ends or is dropped locally. */
let sourceDrag: { tabId: string; groupId: string } | null = null;
/** A drag from another window that has not entered this one yet. */
let pendingForeign: api.TabLayout | null = null;
/** A drop landed somewhere in this window (handled or not). */
let dropSeenInWindow = false;
/** The pointer last left this window's viewport during the drag. */
let leftWindow = false;

function tabLayoutOf(tab: Tab): api.TabLayout {
  return {
    kind: tab.kind,
    ...(tab.ref !== null ? { ref: tab.ref } : {}),
    title: tab.title,
  };
}

function announceDrag(event: TabDragEvent): void {
  void emit("tab-drag", event).catch(() => {});
}

/**
 * Start a tab drag. Publishing the drag (which mounts the drop overlays) is
 * deferred past `dragstart`: changing the DOM under the cursor inside that
 * event makes WebKit cancel the drag before it begins.
 */
export function beginTabDrag(tabId: string, fromGroupId: string): void {
  if (dragTimer) clearTimeout(dragTimer);
  dragTimer = setTimeout(() => {
    dragTimer = null;
    ui.dragTab = { tabId, fromGroupId };
  }, 0);

  const group = ui.groups.find((candidate) => candidate.id === fromGroupId);
  const tab = group?.tabs.find((candidate) => candidate.id === tabId);
  sourceDrag = { tabId, groupId: fromGroupId };
  dropSeenInWindow = false;
  leftWindow = false;
  if (tab) {
    announceDrag({
      phase: "start",
      sourceLabel: windowLabel,
      tab: tabLayoutOf(tab),
    });
  }
}

/** End (or cancel) the current tab drag after a local drop. */
export function endTabDrag(): void {
  if (dragTimer) {
    clearTimeout(dragTimer);
    dragTimer = null;
  }
  ui.dragTab = null;
  if (sourceDrag) {
    sourceDrag = null;
    announceDrag({ phase: "end", sourceLabel: windowLabel });
  }
}

/** Remove a tab from a group, dropping the group if it empties. */
function removeSourceTab(groupId: string, tabId: string): void {
  const group = ui.groups.find((candidate) => candidate.id === groupId);
  if (!group) return;
  closeTab(groupId, tabId);
  if (group.tabs.length === 0 && ui.groups.length > 1) removeGroup(groupId);
}

/** Send a tab to a brand-new window and close it here. */
export async function moveTabToNewWindow(
  groupId: string,
  tabId: string,
): Promise<void> {
  const group = ui.groups.find((candidate) => candidate.id === groupId);
  const tab = group?.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return;
  try {
    await api.windowSpawn(tabLayoutOf(tab));
    removeSourceTab(groupId, tabId);
  } catch (error) {
    ui.status = tr("status.couldNotOpenWindow", { error: String(error) });
  }
}

/**
 * Finish a drag on the source tab's `dragend`.
 *
 * - dropped somewhere in this window: the local handlers already acted;
 * - accepted by another window (`move`): remove the tab here;
 * - not accepted after the pointer left the window: tear it off;
 * - otherwise it was cancelled and nothing changes.
 */
export async function finishTabDrag(effect: string): Promise<void> {
  if (dragTimer) {
    clearTimeout(dragTimer);
    dragTimer = null;
  }
  ui.dragTab = null;
  const drag = sourceDrag;
  sourceDrag = null;
  if (!drag) return;
  announceDrag({ phase: "end", sourceLabel: windowLabel });
  if (dropSeenInWindow) return;
  if (effect === "move") {
    removeSourceTab(drag.groupId, drag.tabId);
  } else if (leftWindow) {
    await moveTabToNewWindow(drag.groupId, drag.tabId);
  }
}

function activateForeignDrag(tab: api.TabLayout): void {
  const id = newId();
  foreignTabs.set(id, tab);
  ui.dragTab = { tabId: id, fromGroupId: FOREIGN_GROUP };
}

function clearForeignDrag(): void {
  const drag = ui.dragTab;
  if (drag?.fromGroupId === FOREIGN_GROUP) {
    foreignTabs.delete(drag.tabId);
    ui.dragTab = null;
  }
}

/** Create a tab in this window from a foreign tab payload. */
function adoptForeignTab(payload: api.TabLayout): Tab {
  return {
    id: newId(),
    kind: payload.kind,
    ref: payload.ref ?? null,
    title: payload.title,
  };
}

/**
 * Wire window-level drag handling: foreign tab announcements, a catch-all
 * drop target (so a drop inside the window always counts as "here"), and
 * detection of the pointer leaving the window.
 */
export async function installDragBridge(): Promise<() => void> {
  const unlisten = await listen<TabDragEvent>("tab-drag", (event) => {
    const payload = event.payload;
    if (payload.sourceLabel === windowLabel) return;
    if (payload.phase === "start" && payload.tab) {
      pendingForeign = payload.tab;
    } else {
      pendingForeign = null;
      clearForeignDrag();
    }
  });

  const onDragEnter = () => {
    if (pendingForeign && !ui.dragTab) activateForeignDrag(pendingForeign);
  };
  const onDragOver = (event: DragEvent) => {
    leftWindow = false;
    if (!ui.dragTab) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  };
  const onDragLeave = (event: DragEvent) => {
    if (event.relatedTarget !== null) return;
    leftWindow = true;
    clearForeignDrag();
  };
  const onDrop = () => {
    dropSeenInWindow = true;
  };
  document.addEventListener("dragenter", onDragEnter, true);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDrop, true);

  return () => {
    unlisten();
    document.removeEventListener("dragenter", onDragEnter, true);
    document.removeEventListener("dragover", onDragOver);
    document.removeEventListener("dragleave", onDragLeave);
    document.removeEventListener("drop", onDrop, true);
  };
}

/** Remove a group and collapse the split tree around it. */
export function removeGroup(groupId: string): void {
  if (ui.groups.length <= 1) return;
  ui.groups = ui.groups.filter((group) => group.id !== groupId);
  ui.splitRoot = collapseTree(removeLeaf(ui.splitRoot, groupId));
  if (ui.activeGroupId === groupId) ui.activeGroupId = ui.groups[0].id;
}

function replaceLeaf(
  node: SplitNode,
  groupId: string,
  make: (leaf: Extract<SplitNode, { type: "leaf" }>) => SplitNode,
): SplitNode {
  if (node.type === "leaf") {
    return node.groupId === groupId ? make(node) : node;
  }
  return { ...node, children: node.children.map((child) => replaceLeaf(child, groupId, make)) };
}

function removeLeaf(node: SplitNode, groupId: string): SplitNode | null {
  if (node.type === "leaf") {
    return node.groupId === groupId ? null : node;
  }
  const children = node.children
    .map((child) => removeLeaf(child, groupId))
    .filter((child): child is SplitNode => child !== null);
  if (children.length === 0) return null;
  // Stored divider sizes no longer match once a pane is gone.
  const sizes = children.length === node.children.length ? node.sizes : undefined;
  return { ...node, children, sizes };
}

function collapseTree(node: SplitNode | null): SplitNode {
  if (!node) {
    return { type: "leaf", groupId: ui.groups[0].id };
  }
  if (node.type === "leaf") return node;
  const children = node.children.map(collapseTree);
  if (children.length === 1) return children[0];
  return { ...node, children };
}

/** Put `groupId` beside `targetGroupId` on the given edge of its pane. */
function placeGroup(
  targetGroupId: string,
  groupId: string,
  edge: "left" | "right" | "top" | "bottom",
): void {
  const horizontal = edge === "left" || edge === "right";
  const before = edge === "left" || edge === "top";
  ui.splitRoot = replaceLeaf(ui.splitRoot, targetGroupId, (leaf) => ({
    type: "split",
    direction: horizontal ? "row" : "column",
    children: before
      ? [{ type: "leaf", groupId }, leaf]
      : [leaf, { type: "leaf", groupId }],
  }));
}

/**
 * Open a tab in a brand-new pane to the right of the active one, leaving any
 * existing tab of the same identity in place. Used by the deliberate
 * "Open in new split" actions.
 */
export async function openInNewSplit(
  kind: TabKind,
  ref: string | null,
  title: string,
): Promise<void> {
  const target = ui.activeGroupId;
  const group = makeGroup();
  const tab: Tab = { id: newId(), kind, ref, title };
  group.tabs = [tab];
  group.activeTabId = tab.id;
  ui.groups = [...ui.groups, group];
  await activateTab(group.id, tab.id);
  placeGroup(target, group.id, "right");
  ui.activeGroupId = group.id;
}

/** Duplicate the given open tab into a new split pane. */
export async function duplicateTabToNewSplit(
  groupId: string,
  tabId: string,
): Promise<void> {
  const group = ui.groups.find((candidate) => candidate.id === groupId);
  const tab = group?.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return;
  await openInNewSplit(tab.kind, tab.ref, tab.title);
}

/** Drag a tab to `edge` of `targetGroupId`, creating a new pane. */
export async function splitGroup(
  fromGroupId: string,
  tabId: string,
  targetGroupId: string,
  edge: "left" | "right" | "top" | "bottom",
): Promise<void> {
  if (fromGroupId === FOREIGN_GROUP) {
    const payload = foreignTabs.get(tabId);
    foreignTabs.delete(tabId);
    if (!payload) return;
    const tab = adoptForeignTab(payload);
    const group = makeGroup();
    group.tabs = [tab];
    group.activeTabId = tab.id;
    ui.groups = [...ui.groups, group];
    await activateTab(group.id, tab.id);
    placeGroup(targetGroupId, group.id, edge);
    ui.activeGroupId = group.id;
    return;
  }
  const source = ui.groups.find((group) => group.id === fromGroupId);
  if (!source) return;
  // Splitting a group's only tab against itself would delete the target.
  if (fromGroupId === targetGroupId && source.tabs.length <= 1) return;
  const index = source.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return;
  const tab = source.tabs[index];
  const wasActive = source.activeTabId === tabId;
  source.tabs = source.tabs.filter((candidate) => candidate.id !== tabId);

  const group = makeGroup();
  group.tabs = [tab];
  group.activeTabId = tab.id;
  ui.groups = [...ui.groups, group];
  await activateTab(group.id, tab.id);

  placeGroup(targetGroupId, group.id, edge);
  ui.activeGroupId = group.id;

  if (source.tabs.length === 0) {
    removeGroup(source.id);
  } else if (wasActive) {
    activateNeighbor(source, Math.min(index, source.tabs.length - 1));
  }
}

/** Move or reorder a tab between/within groups. */
export async function moveTab(
  tabId: string,
  fromGroupId: string,
  toGroupId: string,
  beforeTabId: string | null = null,
): Promise<void> {
  const target = ui.groups.find((group) => group.id === toGroupId);
  if (!target) return;

  if (fromGroupId === FOREIGN_GROUP) {
    const payload = foreignTabs.get(tabId);
    foreignTabs.delete(tabId);
    if (!payload) return;
    const existing = target.tabs.find(
      (tab) => tab.kind === payload.kind && tab.ref === (payload.ref ?? null),
    );
    const tab = existing ?? adoptForeignTab(payload);
    if (!existing) {
      const at = beforeTabId
        ? target.tabs.findIndex((candidate) => candidate.id === beforeTabId)
        : -1;
      const pos = at === -1 ? target.tabs.length : at;
      target.tabs = [...target.tabs.slice(0, pos), tab, ...target.tabs.slice(pos)];
    }
    await activateTab(target.id, tab.id);
    return;
  }

  const source = ui.groups.find((group) => group.id === fromGroupId);
  if (!source) return;
  const index = source.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return;
  const tab = source.tabs[index];
  const wasActive = source.activeTabId === tabId;
  source.tabs = source.tabs.filter((candidate) => candidate.id !== tabId);

  const insertAt = beforeTabId
    ? target.tabs.findIndex((candidate) => candidate.id === beforeTabId)
    : -1;
  const at = insertAt === -1 ? target.tabs.length : insertAt;
  target.tabs = [...target.tabs.slice(0, at), tab, ...target.tabs.slice(at)];

  if (fromGroupId !== toGroupId) {
    await activateTab(target.id, tab.id);
    if (source.tabs.length === 0) {
      removeGroup(source.id);
    } else if (wasActive) {
      activateNeighbor(source, Math.min(index, source.tabs.length - 1));
    }
  }
}

// -- layout persistence --------------------------------------------------

/** Snapshot this window's tab groups and split tree for persistence. */
export function serializeTiling(): api.TilingLayout {
  return {
    groups: ui.groups.map((group) => ({
      id: group.id,
      tabs: group.tabs.map((tab) => ({
        kind: tab.kind,
        ...(tab.ref !== null ? { ref: tab.ref } : {}),
        title: tab.title,
      })),
      active: Math.max(
        0,
        group.tabs.findIndex((tab) => tab.id === group.activeTabId),
      ),
    })),
    root: toSplitLayout(ui.splitRoot),
    active_group: ui.activeGroupId,
  };
}

function notePaths(nodes: api.NoteNode[], into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.is_dir) notePaths(node.children, into);
    else into.add(node.path);
  }
  return into;
}

/**
 * Rebuild this window's layout from a saved snapshot. References to notes or
 * tables that no longer exist are dropped, along with panes left empty.
 */
export async function restoreTiling(layout: api.TilingLayout): Promise<void> {
  const tables = new Set(ui.tables.map((table) => table.name));
  const notes = notePaths(ui.tree);
  const exists = (tab: api.TabLayout): boolean =>
    tab.kind === "translation" ||
    tab.kind === "morphology" ||
    tab.kind === "phonology" ||
    (tab.ref != null &&
      (tab.kind === "table" ? tables.has(tab.ref) : notes.has(tab.ref)));

  const ids = new Map<string, string>();
  const groups: TabGroup[] = [];
  const activeIds = new Map<string, string | null>();
  for (const saved of layout.groups) {
    const group = makeGroup();
    ids.set(saved.id, group.id);
    const kept = saved.tabs.filter(exists);
    group.tabs = kept.map((tab) => ({
      id: newId(),
      kind: tab.kind,
      ref: tab.ref ?? null,
      title: tab.title,
    }));
    const wanted = saved.tabs[saved.active ?? 0];
    const active =
      group.tabs.find(
        (tab) => wanted && tab.kind === wanted.kind && tab.ref === (wanted.ref ?? null),
      ) ?? group.tabs[0];
    activeIds.set(group.id, active?.id ?? null);
    groups.push(group);
  }
  if (groups.length === 0) return;

  // Collapse tabs the reveal rule would have prevented: the first occurrence
  // of an identity wins, later repeats are dropped (and logged so a surprise
  // is traceable, with nothing shown to the user).
  const drops = new Map<string, Set<number>>();
  for (const { groupId, index } of duplicateTabs(
    groups.map((group) => ({
      id: group.id,
      tabs: group.tabs.map((tab) => ({ kind: tab.kind, ref: tab.ref })),
    })),
  )) {
    const indices = drops.get(groupId) ?? new Set<number>();
    indices.add(index);
    drops.set(groupId, indices);
  }
  for (const [groupId, indices] of drops) {
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) continue;
    for (const index of indices) {
      const tab = group.tabs[index];
      if (tab) {
        console.debug(
          "nueon: dropped duplicate restored tab",
          tab.kind,
          tab.ref ?? "",
        );
      }
    }
    group.tabs = group.tabs.filter((_, index) => !indices.has(index));
  }
  // A dropped active tab falls back to the group's first remaining tab.
  for (const group of groups) {
    const activeId = activeIds.get(group.id);
    if (!activeId || !group.tabs.some((tab) => tab.id === activeId)) {
      activeIds.set(group.id, group.tabs[0]?.id ?? null);
    }
  }

  let root = fromSplitLayout(layout.root, ids);
  for (const group of groups) {
    if (group.tabs.length === 0 && root) root = removeLeaf(root, group.id);
  }
  const live = groups.filter((group) => group.tabs.length > 0);
  if (live.length === 0 || !root) return;

  ui.groups = live;
  ui.splitRoot = collapseTree(root);
  ui.activeGroupId = live[0].id;
  for (const group of live) {
    const tabId = activeIds.get(group.id);
    if (tabId) await activateTab(group.id, tabId);
  }
  const savedActive = layout.active_group ? ids.get(layout.active_group) : undefined;
  ui.activeGroupId =
    savedActive && live.some((group) => group.id === savedActive)
      ? savedActive
      : live[0].id;
}

/** Restore this secondary window's saved tiling and enable persistence. */
export async function restoreSecondaryTiling(label: string): Promise<void> {
  try {
    const state = await api.layoutStateGet();
    const saved = state.windows?.find((window) => window.label === label);
    if (saved) await restoreTiling(saved.tiling);
  } catch (error) {
    ui.status = tr("status.couldNotRestoreWindowLayout", { error: String(error) });
  } finally {
    ui.layoutReady = true;
  }
}

/**
 * Restore the saved main-window layout (if any), respawn the secondary
 * windows saved with it, and enable persistence.
 */
export async function restoreMainTiling(): Promise<void> {
  try {
    const state = await api.layoutStateGet();
    if (state.main) await restoreTiling(state.main);
    await api.windowsRestore();
  } catch (error) {
    ui.status = tr("status.couldNotRestoreLayout", { error: String(error) });
  } finally {
    ui.layoutReady = true;
  }
}

// -- active document loaders --------------------------------------------
