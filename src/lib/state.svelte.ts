import { listen } from "@tauri-apps/api/event";
import { get } from "svelte/store";
import { t } from "./i18n";
import * as api from "./api";
import { isAssetPath, isNotePath, stripMd } from "./explorer";
import { canMoveInto } from "./tiling";
import { restoreMainTiling } from "./layout.svelte";
import {
  activateNeighbor,
  deleteTable,
  openFile,
  openNote,
  openTable,
  pruneGroupIfEmpty,
  syncGroupTable,
} from "./tabs.svelte";
export {
  activateTab,
  closeAllTabs,
  closePane,
  closeTab,
  deleteTable,
  openFile,
  openMorphology,
  openNote,
  openPhonology,
  openTable,
  openTranslation,
  refreshTable,
  reloadGroupTable,
  renameTable,
  reorderTabs,
} from "./tabs.svelte";
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

export function baseName(path: string): string {
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

/**
 * Reload one group's table from disk. Responses that arrive out of order are
 * dropped, and a failed fetch is reported instead of aborting the caller.
 */


export async function loadNote(doc: DocState, path: string): Promise<void> {
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
