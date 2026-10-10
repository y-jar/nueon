//! Workspace data loading: refresh, initial load and workspace switching.

import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { clearDoc, makeGroup, ui } from "./store.svelte";
import { activateNeighbor, syncGroupTable } from "./tabs.svelte";
import { restoreMainTiling } from "./layout.svelte";
import { reloadOpenNotes } from "./notes.svelte";
import { tr } from "./state.svelte";

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
