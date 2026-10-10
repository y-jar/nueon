//! Note, folder and asset operations, and change/conflict handling.

import * as api from "./api";
import { isAssetPath, isNotePath, stripMd, uniqueNotePath } from "./explorer";
import { canMoveInto } from "./tiling";
import { ui, type DocState } from "./store.svelte";
import { flushNotes, quiesceNotes, resolveNoteConflict } from "./editor/action";
import { beginRead, isFreshest } from "./editor/freshness";
import { dropPosition, movePosition } from "./editor/positions";
import {
  activateNeighbor,
  openFile,
  openNote,
  openTable,
  pruneGroupIfEmpty,
} from "./tabs.svelte";
import { openInNewSplit } from "./layout.svelte";
import { refreshTables } from "./data.svelte";
import { baseName, confirmDialog, showToast, tr } from "./state.svelte";

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

export async function selectNote(
  path: string,
  opts?: { force?: boolean; groupId?: string },
): Promise<void> {
  // Markdown/text opens in the editor; anything else (and anything under
  // `notes/assets/`) opens in the viewer.
  await (isNotePath(path) && !isAssetPath(path)
    ? openNote(path, opts)
    : openFile(path, opts));
}

export async function selectTable(
  name: string,
  opts?: { force?: boolean },
): Promise<void> {
  await openTable(name, opts);
}

/** Open a note/file in a brand-new split pane, bypassing the reveal rule. */
export async function selectNoteInSplit(path: string): Promise<void> {
  const kind = isNotePath(path) && !isAssetPath(path) ? "note" : "file";
  await openInNewSplit(kind, path, baseName(path));
}

/** Open a table in a brand-new split pane, bypassing the reveal rule. */
export async function selectTableInSplit(name: string): Promise<void> {
  await openInNewSplit("table", name, name);
}

/** Serialize note creation so two rapid `+` clicks make one note, not two. */
let noteCreateInFlight = false;

export async function createNote(
  relPath?: string,
  groupId?: string,
): Promise<void> {
  if (noteCreateInFlight) return;
  noteCreateInFlight = true;
  try {
    // Compute the free name here, after any in-flight create has been dropped,
    // so a second click can never reuse the same path.
    const created = await api.createNote(relPath ?? uniqueNotePath(ui.tree));
    await selectNote(created, groupId ? { groupId } : undefined);
    ui.status = tr("status.created", { path: created });
  } finally {
    noteCreateInFlight = false;
  }
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

export function afterDelete(record: api.TrashRecord): void {
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
