import { listen } from "@tauri-apps/api/event";
import * as api from "./api";

/** Left activity ribbon selection. */
export type Activity = "notes" | "dictionary" | "translation" | "git";

/** The kind of document a center tab represents. */
export type TabKind = "note" | "table" | "translation";

/** A center workspace tab. */
export interface Tab {
  id: string;
  kind: TabKind;
  /** Note path or table name; `null` for the translation tool. */
  ref: string | null;
  title: string;
}

/** Which panel the center pane is rendering (driven by the active tab). */
export type View = "notes" | "dictionary" | "translation";

/** Global reactive UI state (Svelte 5 runes). */
export const ui = $state({
  workspaces: [] as api.WorkspaceEntry[],
  root: null as string | null,

  // Shell chrome.
  activity: "notes" as Activity,
  sidebarOpen: true,
  view: "notes" as View,
  tabs: [] as Tab[],
  activeTabId: null as string | null,
  inspectorOpen: false,
  inspectorDock: "right" as "left" | "right",
  settingsOpen: false,

  // Active document state.
  tree: [] as api.NoteNode[],
  selected: null as string | null,
  noteContent: "",
  dirty: false,
  status: "",
  tables: [] as api.TableSummary[],
  currentTable: null as string | null,
  table: null as api.WordTable | null,
  selectedEntry: null as string | null,
  wordIndex: {} as api.WordIndex,
  nameById: {} as Record<string, string>,
  vcsRevision: 0,

  // Notes drag/context-menu plumbing.
  dragPath: null as string | null,
  contextMenu: null as {
    x: number;
    y: number;
    path: string;
    isDir: boolean;
    kind: "node" | "root";
  } | null,
  renameTarget: null as string | null,
  newRequest: null as { kind: "note" | "folder"; base: string } | null,
  collapseAllSignal: 0,
});

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function newTabId(): string {
  return crypto.randomUUID();
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
  if (!ui.root) {
    ui.currentTable = null;
    ui.table = null;
    ui.tabs = ui.tabs.filter((tab) => tab.kind !== "table");
    return;
  }

  // Drop tabs whose table no longer exists.
  const names = new Set(ui.tables.map((table) => table.name));
  const stale = ui.tabs.filter(
    (tab) => tab.kind === "table" && tab.ref !== null && !names.has(tab.ref),
  );
  if (stale.length) {
    ui.tabs = ui.tabs.filter((tab) => !stale.includes(tab));
    if (stale.some((tab) => tab.id === ui.activeTabId)) activateNeighbor();
  }

  if (ui.currentTable && !names.has(ui.currentTable)) {
    ui.currentTable = null;
    ui.table = null;
  } else if (ui.currentTable) {
    await refreshTable();
  }
}

export async function refreshTable(): Promise<void> {
  if (ui.currentTable) {
    ui.table = await api.getTable(ui.currentTable);
  }
}

export function selectEntry(id: string): void {
  ui.selectedEntry = ui.selectedEntry === id ? null : id;
}

// -- shell chrome --------------------------------------------------------

export function setActivity(activity: Activity): void {
  ui.activity = activity;
  ui.sidebarOpen = true;
  if (activity === "translation") openTranslation();
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

export function openSettings(): void {
  ui.settingsOpen = true;
}

export function closeSettings(): void {
  ui.settingsOpen = false;
}

// -- tabs ----------------------------------------------------------------

function activateNeighbor(): void {
  const index = ui.tabs.findIndex((tab) => tab.id === ui.activeTabId);
  if (index === -1) {
    ui.activeTabId = ui.tabs[0]?.id ?? null;
  } else {
    const next = ui.tabs[index + 1] ?? ui.tabs[index - 1] ?? null;
    ui.activeTabId = next?.id ?? null;
  }
  if (ui.activeTabId) {
    void activateTab(ui.activeTabId);
  }
}

export async function activateTab(id: string): Promise<void> {
  const tab = ui.tabs.find((candidate) => candidate.id === id);
  if (!tab) return;
  ui.activeTabId = id;
  if (tab.kind === "note" && tab.ref) {
    ui.view = "notes";
    await loadNote(tab.ref);
  } else if (tab.kind === "table" && tab.ref) {
    ui.view = "dictionary";
    await loadTable(tab.ref);
  } else {
    ui.view = "translation";
  }
}

export async function openNote(path: string): Promise<void> {
  ui.activity = "notes";
  let tab = ui.tabs.find((t) => t.kind === "note" && t.ref === path);
  if (!tab) {
    tab = { id: newTabId(), kind: "note", ref: path, title: baseName(path) };
    ui.tabs = [...ui.tabs, tab];
  }
  await activateTab(tab.id);
}

export async function openTable(name: string): Promise<void> {
  ui.activity = "dictionary";
  let tab = ui.tabs.find((t) => t.kind === "table" && t.ref === name);
  if (!tab) {
    tab = { id: newTabId(), kind: "table", ref: name, title: name };
    ui.tabs = [...ui.tabs, tab];
  }
  await activateTab(tab.id);
}

export async function openTranslation(): Promise<void> {
  let tab = ui.tabs.find((t) => t.kind === "translation");
  if (!tab) {
    tab = {
      id: newTabId(),
      kind: "translation",
      ref: null,
      title: "Translation",
    };
    ui.tabs = [...ui.tabs, tab];
  }
  await activateTab(tab.id);
}

export function closeTab(id: string): void {
  const wasActive = ui.activeTabId === id;
  ui.tabs = ui.tabs.filter((tab) => tab.id !== id);
  if (wasActive) activateNeighbor();
}

export function reorderTabs(items: Tab[]): void {
  ui.tabs = [...items];
}

export function closeAllTabs(): void {
  ui.tabs = [];
  ui.activeTabId = null;
}

// -- active document loaders --------------------------------------------

async function loadNote(path: string): Promise<void> {
  const content = await api.readNote(path);
  ui.selected = path;
  ui.noteContent = content;
  ui.dirty = false;
}

async function loadTable(name: string): Promise<void> {
  ui.currentTable = name;
  ui.table = await api.getTable(name);
  ui.selectedEntry = null;
}

// -- notes CRUD ----------------------------------------------------------

export async function selectNote(path: string): Promise<void> {
  await openNote(path);
}

export async function selectTable(name: string): Promise<void> {
  await openTable(name);
}

export function openContextMenu(
  x: number,
  y: number,
  path: string,
  isDir: boolean,
  kind: "node" | "root" = "node",
): void {
  ui.contextMenu = { x, y, path, isDir, kind };
}

export function closeContextMenu(): void {
  ui.contextMenu = null;
}

export function collapseAll(): void {
  ui.collapseAllSignal += 1;
}

export function requestRename(path: string): void {
  ui.renameTarget = path;
  ui.contextMenu = null;
}

export function consumeRename(): void {
  ui.renameTarget = null;
}

export function requestNew(kind: "note" | "folder", base: string): void {
  ui.newRequest = { kind, base };
  ui.contextMenu = null;
}

export function consumeNew(): void {
  ui.newRequest = null;
}

/** Initial load + backend event subscription. */
export async function init(): Promise<void> {
  await refreshWorkspaces();
  await refreshTree();
  await loadWordIndex();
  await refreshTables();
  await listen("data-changed", async (event) => {
    const scope = (event.payload as { scope?: string }).scope;
    if (scope === "workspace") {
      await refreshWorkspaces();
      await refreshTree();
      await loadWordIndex();
      await refreshTables();
    } else if (scope === "notes") {
      await refreshTree();
    } else if (scope === "dictionary") {
      await loadWordIndex();
      await refreshTables();
    } else if (scope === "vcs") {
      ui.vcsRevision += 1;
    }
  });
}

export async function openWorkspace(path: string): Promise<void> {
  ui.status = `opening ${path}…`;
  await api.workspaceOpen(path);
  resetDocuments();
  await refreshWorkspaces();
  await refreshTree();
  await loadWordIndex();
  await refreshTables();
  ui.status = "";
}

export async function createWorkspace(
  name: string,
  destination: string,
): Promise<void> {
  ui.status = `creating ${name}…`;
  await api.workspaceCreate(name, destination);
  resetDocuments();
  await refreshWorkspaces();
  await refreshTree();
  await loadWordIndex();
  await refreshTables();
  ui.status = "";
}

function resetDocuments(): void {
  ui.selected = null;
  ui.noteContent = "";
  ui.dirty = false;
  ui.currentTable = null;
  ui.table = null;
  ui.selectedEntry = null;
  ui.tabs = [];
  ui.activeTabId = null;
  ui.activity = "notes";
}

export async function createNote(relPath: string): Promise<void> {
  await api.createNote(relPath);
  await selectNote(relPath);
  ui.status = `created ${relPath}`;
}

export async function createFolder(relPath: string): Promise<void> {
  await api.createFolder(relPath);
  ui.status = `created ${relPath}/`;
}

export async function renamePath(
  oldPath: string,
  newPath: string,
): Promise<void> {
  await api.moveOrRenameNote(oldPath, newPath);
  if (ui.selected === oldPath) {
    ui.selected = newPath;
  }
  const prefix = `${oldPath}/`;
  ui.tabs = ui.tabs.map((tab) => {
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
  ui.status = `renamed to ${newPath}`;
}

export async function deletePath(relPath: string): Promise<void> {
  await api.deleteNote(relPath);
  const prefix = `${relPath}/`;
  const removed = ui.tabs.filter(
    (tab) =>
      tab.kind === "note" &&
      tab.ref !== null &&
      (tab.ref === relPath || tab.ref.startsWith(prefix)),
  );
  if (removed.length) {
    ui.tabs = ui.tabs.filter((tab) => !removed.includes(tab));
    if (removed.some((tab) => tab.id === ui.activeTabId)) activateNeighbor();
  }
  if (ui.selected === relPath || ui.selected?.startsWith(prefix)) {
    ui.selected = null;
    ui.noteContent = "";
  }
  ui.status = `deleted ${relPath}`;
}
