import { listen } from "@tauri-apps/api/event";
import * as api from "./api";

/** Global reactive UI state (Svelte 5 runes). */
export const ui = $state({
  workspaces: [] as api.WorkspaceEntry[],
  root: null as string | null,
  tree: [] as api.NoteNode[],
  selected: null as string | null,
  content: "",
  dirty: false,
  status: "",
});

export async function refreshWorkspaces(): Promise<void> {
  ui.workspaces = await api.workspaceList();
  ui.root = await api.workspaceCurrent();
}

export async function refreshTree(): Promise<void> {
  ui.tree = ui.root ? await api.listWorkspace() : [];
}

/** Initial load + backend event subscription. */
export async function init(): Promise<void> {
  await refreshWorkspaces();
  await refreshTree();
  await listen("data-changed", async (event) => {
    const scope = (event.payload as { scope?: string }).scope;
    if (scope === "workspace") {
      await refreshWorkspaces();
      await refreshTree();
    } else if (scope === "notes") {
      await refreshTree();
    }
  });
}

export async function openWorkspace(path: string): Promise<void> {
  ui.status = `opening ${path}…`;
  await api.workspaceOpen(path);
  ui.selected = null;
  ui.content = "";
  ui.dirty = false;
  await refreshWorkspaces();
  await refreshTree();
  ui.status = "";
}

export async function createWorkspace(
  name: string,
  destination: string,
): Promise<void> {
  ui.status = `creating ${name}…`;
  await api.workspaceCreate(name, destination);
  await refreshWorkspaces();
  await refreshTree();
  ui.status = "";
}

export async function selectNote(path: string): Promise<void> {
  if (ui.dirty && ui.selected) {
    await saveCurrent();
  }
  ui.selected = path;
  ui.content = await api.readNote(path);
  ui.dirty = false;
}

export async function saveCurrent(): Promise<void> {
  if (!ui.selected) return;
  await api.saveNote(ui.selected, ui.content);
  ui.dirty = false;
  ui.status = `saved ${ui.selected}`;
}

export function markDirty(): void {
  ui.dirty = true;
}

export async function createNote(relPath: string): Promise<void> {
  await api.createNote(relPath);
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
  if (
    ui.selected === relPath ||
    ui.selected?.startsWith(`${relPath}/`)
  ) {
    ui.selected = null;
    ui.content = "";
  }
  ui.status = `deleted ${relPath}`;
}
