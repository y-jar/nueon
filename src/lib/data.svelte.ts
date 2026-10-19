//! Workspace data loading: refresh, initial load and workspace switching.

import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { clearDoc, makeGroup, ui } from "./store.svelte";
import { registerInvalidation, notifyDataChanged } from "./invalidation.svelte";
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

/** Load the Fixes-table names (morphemes), for ranking the link dropdown. */
export async function loadFixesTables(): Promise<void> {
  if (!ui.root) {
    ui.fixesTables = new Set();
    return;
  }
  try {
    const roles = await api.tableRolesGet();
    ui.fixesTables = new Set(
      Object.entries(roles)
        .filter(([, config]) => config.role === "fixes")
        .map(([name]) => name),
    );
  } catch {
    ui.fixesTables = new Set();
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
  await loadFixesTables();
  await refreshTables();
  try {
    ui.suppressedConfirms = await api.suppressedConfirms();
    ui.showLineNumbers = await api.editorLineNumbers();
    ui.keybinds = await api.keybindsGet();
  } catch {
    // Best-effort; suppression just won't apply across reloads.
  }
  registerInvalidation({
    id: "workspaces",
    scopes: ["workspace"],
    reload: refreshWorkspaces,
  });
  registerInvalidation({
    id: "tree",
    scopes: ["workspace", "notes"],
    reload: refreshTree,
  });
  registerInvalidation({
    id: "wordIndex",
    scopes: ["workspace", "dictionary"],
    reload: loadWordIndex,
  });
  registerInvalidation({
    id: "fixesTables",
    scopes: ["workspace", "config"],
    reload: loadFixesTables,
  });
  registerInvalidation({
    id: "tables",
    scopes: ["workspace", "dictionary"],
    reload: refreshTables,
  });
  registerInvalidation({
    id: "openNotes",
    scopes: ["notes", "vcs"],
    reload: reloadOpenNotes,
  });
  await listen("data-changed", (event) => {
    const scope = (event.payload as { scope?: string }).scope;
    if (typeof scope === "string") notifyDataChanged(scope);
  });
}

export async function openWorkspaceDialog(): Promise<void> {
  ui.layoutReady = false;
  try {
    await api.workspaceOpenDialog();
  } catch (e) {
    if (String(e).includes("cancelled")) {
      ui.layoutReady = true;
      return;
    }
    ui.status = "";
    ui.layoutReady = true;
    await refreshWorkspaces();
    throw e;
  }
  await onWorkspaceOpened();
}

async function onWorkspaceOpened(): Promise<void> {
  ui.showWorkspacePicker = false;
  resetDocuments();
  await refreshWorkspaces();
  await refreshTree();
  await loadWordIndex();
  await loadFixesTables();
  await refreshTables();
  await restoreMainTiling();
  await reloadOpenNotes();
  ui.status = "";
  ui.layoutReady = true;
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
  await onWorkspaceOpened();
}

/** Create a workspace whose parent folder is chosen in a Rust-run dialog. */
export async function createWorkspaceDialog(name: string): Promise<void> {
  ui.status = tr("status.creating", { name });
  ui.layoutReady = false;
  try {
    await api.workspaceCreateDialog(name);
  } catch (e) {
    if (String(e).includes("cancelled")) {
      ui.layoutReady = true;
      return;
    }
    ui.status = "";
    ui.layoutReady = true;
    throw e;
  }
  await onWorkspaceOpened();
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
  await loadFixesTables();
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
