import { listen } from "@tauri-apps/api/event";
import * as api from "./api";

export type View = "notes" | "dictionary" | "translation";

/** Global reactive UI state (Svelte 5 runes). */
export const ui = $state({
  workspaces: [] as api.WorkspaceEntry[],
  root: null as string | null,
  view: "notes" as View,
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
  gitPanelOpen: false,
  vcsRevision: 0,
  dragPath: null as string | null,
  contextMenu: null as {
    x: number;
    y: number;
    path: string;
    isDir: boolean;
  } | null,
  renameTarget: null as string | null,
  newRequest: null as { kind: "note" | "folder"; base: string } | null,
});

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
    return;
  }
  if (
    ui.currentTable &&
    !ui.tables.some((table) => table.name === ui.currentTable)
  ) {
    ui.currentTable = null;
  }
  if (!ui.currentTable && ui.tables.length) {
    await selectTable(ui.tables[0].name);
  } else if (ui.currentTable) {
    await refreshTable();
  }
}

export async function selectTable(name: string): Promise<void> {
  ui.currentTable = name;
  ui.table = await api.getTable(name);
  ui.selectedEntry = null;
  ui.view = "dictionary";
}

export async function refreshTable(): Promise<void> {
  if (ui.currentTable) {
    ui.table = await api.getTable(ui.currentTable);
  }
}

export function selectEntry(id: string): void {
  ui.selectedEntry = ui.selectedEntry === id ? null : id;
}

export function setView(view: View): void {
  ui.view = view;
}

export function toggleGitPanel(): void {
  ui.gitPanelOpen = !ui.gitPanelOpen;
}

export function openContextMenu(
  x: number,
  y: number,
  path: string,
  isDir: boolean,
): void {
  ui.contextMenu = { x, y, path, isDir };
}

export function closeContextMenu(): void {
  ui.contextMenu = null;
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
  ui.selected = null;
  ui.noteContent = "";
  ui.dirty = false;
  ui.currentTable = null;
  ui.table = null;
  ui.selectedEntry = null;
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
  ui.selected = null;
  ui.noteContent = "";
  ui.dirty = false;
  ui.currentTable = null;
  ui.table = null;
  ui.selectedEntry = null;
  await refreshWorkspaces();
  await refreshTree();
  await loadWordIndex();
  await refreshTables();
  ui.status = "";
}

export async function selectNote(path: string): Promise<void> {
  const content = await api.readNote(path);
  ui.selected = path;
  ui.noteContent = content;
  ui.dirty = false;
  ui.view = "notes";
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
  ui.status = `renamed to ${newPath}`;
}

export async function deletePath(relPath: string): Promise<void> {
  await api.deleteNote(relPath);
  if (ui.selected === relPath || ui.selected?.startsWith(`${relPath}/`)) {
    ui.selected = null;
    ui.noteContent = "";
  }
  ui.status = `deleted ${relPath}`;
}
