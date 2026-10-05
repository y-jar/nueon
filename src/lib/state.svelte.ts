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

/** Which panel a group's center pane is rendering. */
export type View = "notes" | "dictionary" | "translation";

/** The loaded document for one tab group. */
export interface DocState {
  view: View;
  selected: string | null;
  noteContent: string;
  dirty: boolean;
  currentTable: string | null;
  table: api.WordTable | null;
  selectedEntry: string | null;
}

/** A pane of tabs. Split view composes several of these. */
export interface TabGroup {
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
  doc: DocState;
}

/** A node in the recursive split layout. */
export type SplitNode =
  | { type: "leaf"; groupId: string }
  | {
      type: "split";
      direction: "row" | "column";
      children: SplitNode[];
      sizes?: number[];
    };

function newId(): string {
  return crypto.randomUUID();
}

function emptyDoc(): DocState {
  return {
    view: "notes",
    selected: null,
    noteContent: "",
    dirty: false,
    currentTable: null,
    table: null,
    selectedEntry: null,
  };
}

function makeGroup(): TabGroup {
  return { id: newId(), tabs: [], activeTabId: null, doc: emptyDoc() };
}

const firstGroup = makeGroup();

/** Global reactive UI state (Svelte 5 runes). */
export const ui = $state({
  workspaces: [] as api.WorkspaceEntry[],
  root: null as string | null,

  // Shell chrome.
  activity: "notes" as Activity,
  sidebarOpen: true,
  inspectorOpen: false,
  inspectorDock: "right" as "left" | "right",
  settingsOpen: false,
  /** Show the workspace picker/onboarding over an open workspace. */
  showWorkspacePicker: false,

  // Tiling layout.
  groups: [firstGroup] as TabGroup[],
  activeGroupId: firstGroup.id as string,
  splitRoot: { type: "leaf", groupId: firstGroup.id } as SplitNode,

  // Workspace data shared across groups.
  tree: [] as api.NoteNode[],
  status: "",
  tables: [] as api.TableSummary[],
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
  /** Tab currently being dragged (native DnD), if any. */
  dragTab: null as { tabId: string; fromGroupId: string } | null,
});

// -- group helpers -------------------------------------------------------

export function activeGroup(): TabGroup {
  return (
    ui.groups.find((group) => group.id === ui.activeGroupId) ?? ui.groups[0]
  );
}

export function activeDoc(): DocState {
  return activeGroup().doc;
}

export function setActiveGroup(groupId: string): void {
  if (ui.groups.some((group) => group.id === groupId)) {
    ui.activeGroupId = groupId;
  }
}

function clearDoc(doc: DocState): void {
  doc.view = "notes";
  doc.selected = null;
  doc.noteContent = "";
  doc.dirty = false;
  doc.currentTable = null;
  doc.table = null;
  doc.selectedEntry = null;
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
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
    ui.status = `could not load table ${name}: ${String(error)}`;
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

function activateNeighbor(group: TabGroup, removedIndex: number): void {
  const next = group.tabs[removedIndex] ?? group.tabs[removedIndex - 1] ?? null;
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

export function closeTab(groupId: string, id: string): void {
  const group = ui.groups.find((candidate) => candidate.id === groupId);
  if (!group) return;
  const index = group.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;
  const wasActive = group.activeTabId === id;
  group.tabs = group.tabs.filter((tab) => tab.id !== id);
  if (wasActive) activateNeighbor(group, index);
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
    ui.status = `could not rename ${from}`;
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
  ui.status = `renamed ${from} to ${to}`;
}

/** Delete a table, closing any tab that referenced it. */
export async function deleteTable(name: string): Promise<void> {
  const ok = await api.deleteTable(name);
  if (!ok) return;
  for (const group of ui.groups) {
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
    if (removedIndex !== -1) activateNeighbor(group, removedIndex);
  }
  await refreshTables();
  ui.status = `deleted table ${name}`;
}

// -- split layout --------------------------------------------------------

/** Reload one group's table from disk (used by that pane's Grid). */
export async function reloadGroupTable(groupId: string): Promise<void> {
  await syncGroupTable(groupId);
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
  return { ...node, children };
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

/** Drag a tab to `edge` of `targetGroupId`, creating a new pane. */
export async function splitGroup(
  fromGroupId: string,
  tabId: string,
  targetGroupId: string,
  edge: "left" | "right" | "top" | "bottom",
): Promise<void> {
  const source = ui.groups.find((group) => group.id === fromGroupId);
  if (!source) return;
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

  const horizontal = edge === "left" || edge === "right";
  const before = edge === "left" || edge === "top";
  ui.splitRoot = replaceLeaf(ui.splitRoot, targetGroupId, (leaf) => ({
    type: "split",
    direction: horizontal ? "row" : "column",
    children: before
      ? [{ type: "leaf", groupId: group.id }, leaf]
      : [leaf, { type: "leaf", groupId: group.id }],
  }));
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
  const source = ui.groups.find((group) => group.id === fromGroupId);
  const target = ui.groups.find((group) => group.id === toGroupId);
  if (!source || !target) return;
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

// -- active document loaders --------------------------------------------

async function loadNote(doc: DocState, path: string): Promise<void> {
  const content = await api.readNote(path);
  doc.selected = path;
  doc.noteContent = content;
  doc.dirty = false;
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
  try {
    await api.workspaceOpen(path);
  } catch (error) {
    // The backend prunes vanished folders from the registry; resync.
    ui.status = "";
    await refreshWorkspaces();
    throw error;
  }
  ui.showWorkspacePicker = false;
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
  ui.showWorkspacePicker = false;
  resetDocuments();
  await refreshWorkspaces();
  await refreshTree();
  await loadWordIndex();
  await refreshTables();
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
  const prefix = `${oldPath}/`;
  for (const group of ui.groups) {
    if (group.doc.selected === oldPath) group.doc.selected = newPath;
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
  }
  ui.status = `renamed to ${newPath}`;
}

export async function deletePath(relPath: string): Promise<void> {
  await api.deleteNote(relPath);
  const prefix = `${relPath}/`;
  for (const group of ui.groups) {
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
  ui.status = `deleted ${relPath}`;
}
