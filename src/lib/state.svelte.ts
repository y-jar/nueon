import { listen } from "@tauri-apps/api/event";
import { get } from "svelte/store";
import { t } from "./i18n";
import * as api from "./api";
import { isAssetPath, isNotePath, stripMd } from "./explorer";
import { shouldPruneGroup } from "./tabs";
import { canMoveInto, nextActiveIndex } from "./tiling";
import { removeGroup, restoreMainTiling } from "./layout.svelte";
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
export {
  closeImport,
  closeSettings,
  closeSetupWizard,
  openImport,
  openSettings,
  openSetupWizard,
  setActivity,
  setInspectorDock,
  toggleInspector,
  toggleSidebar,
} from "./shell.svelte";
export {
  beginTabDrag,
  endTabDrag,
  finishTabDrag,
  FOREIGN_GROUP,
  installDragBridge,
  moveTab,
  moveTabToNewWindow,
  removeGroup,
  restoreMainTiling,
  restoreSecondaryTiling,
  restoreTiling,
  serializeTiling,
  splitGroup,
} from "./layout.svelte";

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
