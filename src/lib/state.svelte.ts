import { emit, listen } from "@tauri-apps/api/event";
import { get } from "svelte/store";
import { t } from "./i18n";
import * as api from "./api";
import { windowLabel } from "./window";
import { isAssetPath, isNotePath, stripMd } from "./explorer";
import { shouldPruneGroup } from "./tabs";
import {
  canMoveInto,
  fromSplitLayout,
  nextActiveIndex,
  toSplitLayout,
  type SplitNode,
} from "./tiling";
export type { SplitNode } from "./tiling";
export { canMoveInto };
import { flushNotes, quiesceNotes, resolveNoteConflict } from "./editor/action";
import { beginRead, isFreshest } from "./editor/freshness";
import { dropPosition, movePosition } from "./editor/positions";

import {
  activeDoc,
  activeGroup,
  clearDoc,
  makeGroup,
  newId,
  setActiveGroup,
  ui,
  type Activity,
  type ColumnMenuPayload,
  type ConfirmRequest,
  type DocState,
  type Tab,
  type TabGroup,
  type TabKind,
  type ToastState,
  type View,
} from "./store.svelte";
export { activeDoc, activeGroup, setActiveGroup, ui };
export type {
  Activity,
  ColumnMenuPayload,
  ConfirmRequest,
  DocState,
  Tab,
  TabGroup,
  TabKind,
  ToastState,
  View,
};
export {
  collapseAll,
  closeContextMenu,
  consumeNew,
  consumeRename,
  dismissQuarantine,
  getContextEditor,
  openColumnMenu,
  openContextMenu,
  openEditorContextMenu,
  openTabContextMenu,
  requestNew,
  requestRename,
} from "./context.svelte";

function baseName(path: string): string {
  return stripMd(path.split("/").filter(Boolean).pop() ?? path);
}

// -- data loading --------------------------------------------------------

export async function refreshWorkspaces(): Promise<void> {
  ui.workspaces = await api.workspaceList();
  ui.root = await api.workspaceCurrent();
}

export async function refreshTree(): Promise<void> {
  ui.tree = ui.root ? await api.listWorkspace() : [];
}

/** Load the dictionary word index (for editor highlighting / name lookup). */
export async function loadWordIndex(): Promise<void> {
  if (!ui.root) {
    ui.wordIndex = {};
    ui.nameById = {};
    return;
  }
  try {
    const index = await api.wordIndex();
    ui.wordIndex = index;
    const names: Record<string, string> = {};
    for (const hits of Object.values(index)) {
      for (const hit of hits) {
        names[hit.id] = hit.wordname;
      }
    }
    ui.nameById = names;
  } catch {
    ui.wordIndex = {};
    ui.nameById = {};
  }
}

export async function refreshTables(): Promise<void> {
  ui.tables = ui.root ? await api.listTables() : [];
  ui.quarantine = ui.root ? await api.quarantineWarnings().catch(() => []) : [];
  if (!ui.root) {
    for (const group of ui.groups) {
      group.tabs = group.tabs.filter((tab) => tab.kind !== "table");
      if (group.doc.view === "dictionary") clearDoc(group.doc);
    }
    return;
  }

  const names = new Set(ui.tables.map((table) => table.name));
  for (const group of ui.groups) {
    const stale = group.tabs.filter(
      (tab) => tab.kind === "table" && tab.ref !== null && !names.has(tab.ref),
    );
    if (stale.length) {
      const activeStale = stale.find((tab) => tab.id === group.activeTabId);
      const removedIndex = activeStale ? group.tabs.indexOf(activeStale) : -1;
      group.tabs = group.tabs.filter((tab) => !stale.includes(tab));
      if (removedIndex !== -1) activateNeighbor(group, removedIndex);
    }
    if (group.doc.currentTable && !names.has(group.doc.currentTable)) {
      group.doc.currentTable = null;
      group.doc.table = null;
    } else if (group.doc.currentTable) {
      await syncGroupTable(group.id);
    }
  }
}

/** Latest table-fetch ticket per group, so a slow older fetch cannot win. */
const tableTickets = new Map<string, number>();

/**
 * Reload one group's table from disk. Responses that arrive out of order are
 * dropped, and a failed fetch is reported instead of aborting the caller.
 */
async function syncGroupTable(groupId: string): Promise<void> {
  const group = ui.groups.find((candidate) => candidate.id === groupId);
  const name = group?.doc.currentTable;
  if (!group || !name) return;
  const ticket = (tableTickets.get(groupId) ?? 0) + 1;
  tableTickets.set(groupId, ticket);
  try {
    const table = await api.getTable(name);
    if (tableTickets.get(groupId) === ticket && group.doc.currentTable === name) {
      group.doc.table = table;
    }
  } catch (error) {
    ui.status = tr("status.couldNotLoadTable", { name, error: String(error) });
  }
}

/** Reload the active group's table from disk. */
export async function refreshTable(): Promise<void> {
  await syncGroupTable(ui.activeGroupId);
}

export function selectEntry(id: string): void {
  const doc = activeDoc();
  doc.selectedEntry = doc.selectedEntry === id ? null : id;
}

// -- shell chrome --------------------------------------------------------

export function setActivity(activity: Activity): void {
  ui.activity = activity;
  ui.sidebarOpen = true;
  if (activity === "translation") openTranslation();
  if (activity === "morphology") openMorphology();
  if (activity === "phonology") openPhonology();
}

export function toggleSidebar(): void {
  ui.sidebarOpen = !ui.sidebarOpen;
}

export function toggleInspector(): void {
  ui.inspectorOpen = !ui.inspectorOpen;
}

export function setInspectorDock(side: "left" | "right"): void {
  ui.inspectorDock = side;
}

/** Open the import wizard. */
export function openImport(): void {
  ui.importOpen = true;
}

/** Close the import wizard. */
export function closeImport(): void {
  ui.importOpen = false;
}

export function openSettings(): void {
  ui.settingsOpen = true;
}

export function closeSettings(): void {
  ui.settingsOpen = false;
}

export function openSetupWizard(): void {
  ui.setupWizardOpen = true;
}

export function closeSetupWizard(): void {
  ui.setupWizardOpen = false;
}

// -- tabs ----------------------------------------------------------------

function activateNeighbor(group: TabGroup, removedIndex: number): void {
  const index = nextActiveIndex(group.tabs.length, removedIndex);
  const next = index === null ? null : group.tabs[index];
  group.activeTabId = next?.id ?? null;
  if (next) {
    void activateTab(group.id, next.id);
  } else {
    clearDoc(group.doc);
  }
}

export async function activateTab(
  groupId: string,
  id: string,
): Promise<void> {
  const group = ui.groups.find((candidate) => candidate.id === groupId);
  if (!group) return;
  const tab = group.tabs.find((candidate) => candidate.id === id);
  if (!tab) return;
  ui.activeGroupId = groupId;
  group.activeTabId = id;
  if (tab.kind === "note" && tab.ref) {
    group.doc.view = "notes";
    await loadNote(group.doc, tab.ref);
  } else if (tab.kind === "table" && tab.ref) {
    group.doc.view = "dictionary";
    if (group.doc.currentTable !== tab.ref) group.doc.table = null;
    group.doc.currentTable = tab.ref;
    group.doc.selectedEntry = null;
    await syncGroupTable(group.id);
  } else if (tab.kind === "morphology") {
    group.doc.view = "morphology";
  } else if (tab.kind === "phonology") {
    group.doc.view = "phonology";
  } else if (tab.kind === "file" && tab.ref) {
    group.doc.view = "file";
    group.doc.selected = tab.ref;
  } else {
    group.doc.view = "translation";
  }
}

export async function openNote(path: string): Promise<void> {
  const group = activeGroup();
  ui.activity = "notes";
  let tab = group.tabs.find((t) => t.kind === "note" && t.ref === path);
  if (!tab) {
    tab = { id: newId(), kind: "note", ref: path, title: baseName(path) };
    group.tabs = [...group.tabs, tab];
  }
  await activateTab(group.id, tab.id);
}

/** Open a non-note file (image, PDF, …) in the viewer. */
export async function openFile(path: string): Promise<void> {
  const group = activeGroup();
  ui.activity = "notes";
  let tab = group.tabs.find((t) => t.kind === "file" && t.ref === path);
  if (!tab) {
    tab = { id: newId(), kind: "file", ref: path, title: baseName(path) };
    group.tabs = [...group.tabs, tab];
  }
  await activateTab(group.id, tab.id);
}

export async function openTable(name: string): Promise<void> {
  const group = activeGroup();
  ui.activity = "dictionary";
  let tab = group.tabs.find((t) => t.kind === "table" && t.ref === name);
  if (!tab) {
    tab = { id: newId(), kind: "table", ref: name, title: name };
    group.tabs = [...group.tabs, tab];
  }
  await activateTab(group.id, tab.id);
}

export async function openTranslation(): Promise<void> {
  const group = activeGroup();
  let tab = group.tabs.find((t) => t.kind === "translation");
  if (!tab) {
    tab = {
      id: newId(),
      kind: "translation",
      ref: null,
      title: "Translation",
    };
    group.tabs = [...group.tabs, tab];
  }
  await activateTab(group.id, tab.id);
}

export async function openMorphology(): Promise<void> {
  const group = activeGroup();
  let tab = group.tabs.find((t) => t.kind === "morphology");
  if (!tab) {
    tab = {
      id: newId(),
      kind: "morphology",
      ref: null,
      title: "Morphology",
    };
    group.tabs = [...group.tabs, tab];
  }
  await activateTab(group.id, tab.id);
}

export async function openPhonology(): Promise<void> {
  const group = activeGroup();
  let tab = group.tabs.find((t) => t.kind === "phonology");
  if (!tab) {
    tab = {
      id: newId(),
      kind: "phonology",
      ref: null,
      title: "Phonology",
    };
    group.tabs = [...group.tabs, tab];
  }
  await activateTab(group.id, tab.id);
}

export function closeTab(groupId: string, id: string): void {
  const group = ui.groups.find((candidate) => candidate.id === groupId);
  if (!group) return;
  const index = group.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;
  const wasActive = group.activeTabId === id;
  group.tabs = group.tabs.filter((tab) => tab.id !== id);
  // Closing a split pane's last tab removes the pane itself.
  if (pruneGroupIfEmpty(group)) return;
  if (wasActive) activateNeighbor(group, index);
}

/**
 * Close every tab in a pane. The pane is removed when other panes remain
 * (or left empty when it is the last one).
 */
export function closePane(groupId: string): void {
  const group = ui.groups.find((candidate) => candidate.id === groupId);
  if (!group) return;
  group.tabs = [];
  group.activeTabId = null;
  clearDoc(group.doc);
  pruneGroupIfEmpty(group);
}

/** Remove `group` when it is empty and not the only remaining pane. */
function pruneGroupIfEmpty(group: TabGroup): boolean {
  if (shouldPruneGroup(group.tabs.length, ui.groups.length)) {
    removeGroup(group.id);
    return true;
  }
  return false;
}

export function reorderTabs(groupId: string, items: Tab[]): void {
  const group = ui.groups.find((candidate) => candidate.id === groupId);
  if (group) group.tabs = [...items];
}

export function closeAllTabs(): void {
  for (const group of ui.groups) {
    group.tabs = [];
    group.activeTabId = null;
    clearDoc(group.doc);
  }
}

/** Rename a table, keeping every open tab in sync. */
export async function renameTable(from: string, to: string): Promise<void> {
  const ok = await api.renameTable(from, to);
  if (!ok) {
    ui.status = tr("status.couldNotRename", { name: from });
    return;
  }
  for (const group of ui.groups) {
    group.tabs = group.tabs.map((tab) =>
      tab.kind === "table" && tab.ref === from
        ? { ...tab, ref: to, title: to }
        : tab,
    );
    if (group.doc.currentTable === from) group.doc.currentTable = to;
  }
  await refreshTables();
  ui.status = tr("status.renamed", { from, to });
}

/** Delete a table, closing any tab that referenced it. */
export async function deleteTable(name: string): Promise<api.TrashRecord | null> {
  const record = await api.deleteTable(name);
  if (!record) return null;
  for (const group of [...ui.groups]) {
    const removed = group.tabs.filter(
      (tab) => tab.kind === "table" && tab.ref === name,
    );
    const activeRemoved = removed.find((tab) => tab.id === group.activeTabId);
    const removedIndex = activeRemoved ? group.tabs.indexOf(activeRemoved) : -1;
    group.tabs = group.tabs.filter((tab) => !removed.includes(tab));
    if (group.doc.currentTable === name) {
      group.doc.currentTable = null;
      group.doc.table = null;
    }
    if (pruneGroupIfEmpty(group)) continue;
    if (removedIndex !== -1) activateNeighbor(group, removedIndex);
  }
  await refreshTables();
  ui.status = tr("status.deletedTable", { name });
  return record;
}

// -- split layout --------------------------------------------------------

/** Reload one group's table from disk (used by that pane's Grid). */
export async function reloadGroupTable(groupId: string): Promise<void> {
  await syncGroupTable(groupId);
}

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

async function loadNote(doc: DocState, path: string): Promise<void> {
  const snapshot = await api.readNote(path);
  doc.selected = path;
  doc.noteContent = snapshot.content;
  doc.noteHash = snapshot.hash;
  doc.dirty = false;
  doc.conflict = null;
}

/**
 * Follow files that changed on disk (another window, git, an external
 * editor). Clean editors update in place; an editor with unsaved edits is
 * flagged as conflicted by the editor itself.
 */
export async function reloadOpenNotes(): Promise<void> {
  for (const group of ui.groups) {
    const doc = group.doc;
    if (doc.view !== "notes" || !doc.selected) continue;
    const path = doc.selected;
    const generation = beginRead(path);
    try {
      const snapshot = await api.readNote(path);
      // A save (or a newer read) landed while this read was in flight: the
      // response is stale and must not move the note backwards.
      if (!isFreshest(path, generation)) continue;
      if (doc.selected !== path || snapshot.hash === doc.noteHash) continue;
      doc.noteContent = snapshot.content;
      doc.noteHash = snapshot.hash;
    } catch {
      // Vanished from disk: the editor reports it on its next save.
    }
  }
}

/** Resolve an open note's conflict in favour of the editor or the file. */
export async function resolveConflict(
  doc: DocState,
  choice: "keep-mine" | "use-disk" | "recreate",
): Promise<void> {
  const path = doc.selected;
  if (!path) return;
  try {
    if (choice === "recreate") {
      await api.createNote(path);
    }
    const snapshot = await api.readNote(path);
    // The doc may be showing another note by now (a tab switch landed while
    // the read was in flight); never apply this to the wrong note.
    if (doc.selected !== path) return;
    if (choice === "use-disk") {
      resolveNoteConflict(path, "reload", snapshot);
      doc.noteContent = snapshot.content;
    } else {
      // Keep the buffer; the next save is based on the file as it is now.
      resolveNoteConflict(path, "adopt", snapshot);
    }
    doc.noteHash = snapshot.hash;
    doc.conflict = null;
  } catch (error) {
    ui.status = tr("status.couldNotResolveConflict", { error: String(error) });
  }
}

// -- notes CRUD ----------------------------------------------------------

export async function selectNote(path: string): Promise<void> {
  // Markdown/text opens in the editor; anything else (and anything under
  // `notes/assets/`) opens in the viewer.
  await (isNotePath(path) && !isAssetPath(path)
    ? openNote(path)
    : openFile(path));
}

export async function selectTable(name: string): Promise<void> {
  await openTable(name);
}

/** Initial load + backend event subscription. */
export async function init(): Promise<void> {
  await refreshWorkspaces();
  await refreshTree();
  await loadWordIndex();
  await refreshTables();
  try {
    ui.suppressedConfirms = await api.suppressedConfirms();
    ui.showLineNumbers = await api.editorLineNumbers();
    ui.keybinds = await api.keybindsGet();
  } catch {
    // Best-effort; suppression just won't apply across reloads.
  }
  await listen("data-changed", async (event) => {
    const scope = (event.payload as { scope?: string }).scope;
    if (scope === "workspace") {
      await refreshWorkspaces();
      await refreshTree();
      await loadWordIndex();
      await refreshTables();
    } else if (scope === "notes") {
      await refreshTree();
      await reloadOpenNotes();
    } else if (scope === "dictionary") {
      await loadWordIndex();
      await refreshTables();
    } else if (scope === "vcs") {
      ui.vcsRevision += 1;
      await reloadOpenNotes();
    }
  });
}

export async function openWorkspace(path: string): Promise<void> {
  ui.status = tr("status.opening", { path });
  ui.layoutReady = false;
  try {
    await api.workspaceOpen(path);
  } catch (error) {
    // The backend prunes vanished folders from the registry; resync.
    ui.status = "";
    ui.layoutReady = true;
    await refreshWorkspaces();
    throw error;
  }
  ui.showWorkspacePicker = false;
  resetDocuments();
  await refreshWorkspaces();
  await refreshTree();
  await loadWordIndex();
  await refreshTables();
  await restoreMainTiling();
  ui.status = "";
}

export async function createWorkspace(
  name: string,
  destination: string,
): Promise<void> {
  ui.status = tr("status.creating", { name });
  ui.layoutReady = false;
  await api.workspaceCreate(name, destination);
  ui.showWorkspacePicker = false;
  resetDocuments();
  await refreshWorkspaces();
  await refreshTree();
  await loadWordIndex();
  await refreshTables();
  ui.layoutReady = true;
  ui.status = "";
}

function resetDocuments(): void {
  const group = makeGroup();
  ui.groups = [group];
  ui.activeGroupId = group.id;
  ui.splitRoot = { type: "leaf", groupId: group.id };
  ui.activity = "notes";
}

export async function createNote(relPath: string): Promise<void> {
  // The backend appends `.md` to a bare name and returns the real path.
  const created = await api.createNote(relPath);
  await selectNote(created);
  ui.status = tr("status.created", { path: created });
}

export async function createFolder(relPath: string): Promise<void> {
  await api.createFolder(relPath);
  ui.status = tr("status.createdFolder", { path: relPath });
}

/** Whether `src` may be moved into `folder` ("" is the notes root). */
/** Move a note/folder into `folder`, reporting failures in the status bar. */
export async function movePath(src: string, folder: string): Promise<void> {
  if (!canMoveInto(src, folder)) return;
  const name = src.split("/").pop() ?? src;
  const target = folder ? `${folder}/${name}` : name;
  try {
    await renamePath(src, target);
  } catch (error) {
    ui.status = tr("status.couldNotMove", { name, error: String(error) });
  }
}

export async function renamePath(
  oldPath: string,
  requestedPath: string,
): Promise<void> {
  // Save edits, then freeze the open editors so none can write to the old
  // path once it is gone. A failed rename lifts the freeze again.
  await flushNotes(oldPath);
  const resume = await quiesceNotes(oldPath);
  let newPath: string;
  try {
    // A file renamed to a bare name keeps its extension; use the real result.
    newPath = await api.moveOrRenameNote(oldPath, requestedPath);
  } catch (error) {
    resume();
    throw error;
  }
  // Editor positions follow the rename so the remount restores them.
  movePosition(oldPath, newPath);
  const prefix = `${oldPath}/`;
  for (const group of ui.groups) {
    if (group.doc.selected === oldPath) group.doc.selected = newPath;
    else if (group.doc.selected?.startsWith(prefix)) {
      group.doc.selected = `${newPath}/${group.doc.selected.slice(prefix.length)}`;
    }
    group.tabs = group.tabs.map((tab) => {
      if (tab.kind !== "note" || !tab.ref) return tab;
      if (tab.ref === oldPath) {
        return { ...tab, ref: newPath, title: baseName(newPath) };
      }
      if (tab.ref.startsWith(prefix)) {
        const ref = `${newPath}/${tab.ref.slice(prefix.length)}`;
        return { ...tab, ref, title: baseName(ref) };
      }
      return tab;
    });
    // Reload from disk: the remounted editor must start from what was just
    // saved, not from the text loaded before the edits.
    const doc = group.doc;
    if (doc.view === "notes" && doc.selected) {
      try {
        await loadNote(doc, doc.selected);
      } catch (error) {
        ui.status = tr("status.couldNotReopen", {
          path: doc.selected,
          error: String(error),
        });
      }
    }
  }
  ui.status = tr("status.renamedTo", { path: newPath });
}

export async function deletePath(relPath: string): Promise<api.TrashRecord> {
  // Freeze the open editors first, and wait for saves in flight, so nothing
  // can write the note back after it is deleted.
  const resume = await quiesceNotes(relPath);
  let record: api.TrashRecord;
  try {
    record = await api.deleteNote(relPath);
  } catch (error) {
    resume();
    throw error;
  }
  dropPosition(relPath);
  const prefix = `${relPath}/`;
  for (const group of [...ui.groups]) {
    const removed = group.tabs.filter(
      (tab) =>
        tab.kind === "note" &&
        tab.ref !== null &&
        (tab.ref === relPath || tab.ref.startsWith(prefix)),
    );
    if (removed.length) {
      const activeRemoved = removed.find((tab) => tab.id === group.activeTabId);
      const removedIndex = activeRemoved
        ? group.tabs.indexOf(activeRemoved)
        : -1;
      group.tabs = group.tabs.filter((tab) => !removed.includes(tab));
      if (pruneGroupIfEmpty(group)) continue;
      if (removedIndex !== -1) activateNeighbor(group, removedIndex);
    }
    if (
      group.doc.selected === relPath ||
      group.doc.selected?.startsWith(prefix)
    ) {
      group.doc.selected = null;
      group.doc.noteContent = "";
    }
  }
  ui.status = tr("status.deleted", { path: relPath });
  return record;
}

// -- confirmation, undo toast, trash ------------------------------------

export function tr(key: string, values?: Record<string, string | number>): string {
  return get(t)(key, values ? { values } : undefined);
}

/** Ask a yes/no question in a modal dialog. */
export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  /** Lets the dialog offer "don't ask again" for this kind. */
  kind?: string;
  /** Requires the user to type this exact text before confirming. */
  requireText?: string;
}): Promise<boolean> {
  // A silenced kind answers "yes" without showing anything.
  if (options.kind && ui.suppressedConfirms.includes(options.kind)) {
    return Promise.resolve(true);
  }
  // Only one question at a time: a new one answers the old one "no".
  ui.confirm?.resolve(false);
  return new Promise((resolve) => {
    ui.confirm = {
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel,
      cancelLabel: tr("grid.cancel"),
      danger: options.danger ?? false,
      kind: options.kind,
      requireText: options.requireText,
      resolve: (confirmed) => {
        ui.confirm = null;
        resolve(confirmed);
      },
    };
  });
}

/** Persist a "don't ask again" choice for a confirm kind. */
export async function suppressConfirm(kind: string): Promise<void> {
  if (!ui.suppressedConfirms.includes(kind)) {
    ui.suppressedConfirms = [...ui.suppressedConfirms, kind];
  }
  try {
    await api.suppressConfirm(kind);
  } catch {
    // Best-effort: the in-memory list still suppresses this session.
  }
}

/** Clear every silenced confirm kind. */
export async function clearSuppressedConfirms(): Promise<void> {
  ui.suppressedConfirms = [];
  try {
    await api.clearSuppressedConfirms();
  } catch {
    // Best-effort.
  }
}

/** Show or hide the editor's line-number gutter and persist the choice. */
export async function setEditorLineNumbers(show: boolean): Promise<void> {
  ui.showLineNumbers = show;
  try {
    await api.setEditorLineNumbers(show);
  } catch {
    // Best-effort.
  }
}

/** The absolute path of a workspace-relative note. */
export function noteFilePath(path: string): string {
  return ui.root ? `${ui.root}/notes/${path}` : "";
}

/** Set (or clear when `null`) a keybind override and persist it. */
export async function setKeybind(id: string, key: string | null): Promise<void> {
  const next = { ...ui.keybinds };
  if (key === null) delete next[id];
  else next[id] = key;
  ui.keybinds = next;
  try {
    await api.setKeybind(id, key);
  } catch {
    // Best-effort; the in-memory override still applies this session.
  }
}

/** Clear every keybind override, restoring the defaults. */
export async function resetKeybinds(): Promise<void> {
  ui.keybinds = {};
  try {
    await api.resetKeybinds();
  } catch {
    // Best-effort.
  }
}

let toastCounter = 0;

/** Show a transient message (auto-dismissed after `ms`). */
export function showToast(
  message: string,
  action?: { label: string; run: () => void },
  ms = 10_000,
): void {
  toastCounter += 1;
  const id = toastCounter;
  ui.toast = {
    id,
    message,
    actionLabel: action?.label,
    onAction: action?.run,
  };
  setTimeout(() => {
    if (ui.toast?.id === id) ui.toast = null;
  }, ms);
}

export function dismissToast(): void {
  ui.toast = null;
}

/** Restore a trashed item and report where it landed. */
export async function restoreFromTrash(id: string): Promise<void> {
  try {
    const restored = await api.trashRestore(id);
    ui.status = tr("trash.restored", { name: restored.name });
    showToast(tr("trash.restored", { name: restored.name }));
    if (restored.kind === "table") await refreshTables();
  } catch (error) {
    ui.status = tr("trash.restoreFailed", { error: String(error) });
  }
}

function afterDelete(record: api.TrashRecord): void {
  showToast(tr("trash.deleted", { name: record.name }), {
    label: tr("trash.undo"),
    run: () => void restoreFromTrash(record.id),
  });
}

/** Confirm, then move a note or folder to the trash (with an Undo toast). */
export async function requestDeleteNote(
  path: string,
  isDir: boolean,
): Promise<void> {
  const name = stripMd(path.split("/").pop() ?? path);
  let message = tr("trash.confirmNote", { name });
  if (isDir) {
    let count = 0;
    try {
      count = await api.noteCount(path);
    } catch {
      // The delete itself will report a missing folder.
    }
    message = tr("trash.confirmFolder", { name, count });
  }
  const confirmed = await confirmDialog({
    title: tr(isDir ? "trash.confirmFolderTitle" : "trash.confirmNoteTitle"),
    message,
    confirmLabel: tr("contextMenu.delete"),
    danger: true,
    kind: "delete-note",
  });
  if (!confirmed) return;
  try {
    afterDelete(await deletePath(path));
  } catch (error) {
    ui.status = tr("status.couldNotDelete", { name, error: String(error) });
  }
}

/** Confirm, then move a table to the trash (with an Undo toast). */
export async function requestDeleteTable(name: string): Promise<void> {
  const words = ui.tables.find((table) => table.name === name)?.word_count ?? 0;
  const confirmed = await confirmDialog({
    title: tr("trash.confirmTableTitle"),
    message: tr("trash.confirmTable", { name, count: words }),
    confirmLabel: tr("tables.delete"),
    danger: true,
    kind: "delete-table",
  });
  if (!confirmed) return;
  try {
    const record = await deleteTable(name);
    if (record) afterDelete(record);
  } catch (error) {
    ui.status = tr("status.couldNotDelete", { name, error: String(error) });
  }
}
