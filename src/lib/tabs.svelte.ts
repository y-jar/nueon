//! Opening, activating and closing tabs, and their table operations.

import * as api from "./api";
import { shouldPruneGroup } from "./tabs";
import { nextActiveIndex } from "./tiling";
import {
  activeDoc,
  activeGroup,
  clearDoc,
  newId,
  ui,
  type Tab,
  type TabGroup,
} from "./store.svelte";
import { removeGroup } from "./layout.svelte";
import { baseName, loadNote, refreshTables, tr } from "./state.svelte";

/** Per-group table-load generation, so a stale load cannot clobber a newer one. */
const tableTickets = new Map<string, number>();

export async function syncGroupTable(groupId: string): Promise<void> {
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


// -- tabs ----------------------------------------------------------------

export function activateNeighbor(group: TabGroup, removedIndex: number): void {
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
export function pruneGroupIfEmpty(group: TabGroup): boolean {
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
