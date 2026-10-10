import { get } from "svelte/store";
import { t } from "./i18n";
import * as api from "./api";
import { stripMd } from "./explorer";
import { canMoveInto } from "./tiling";
export {
  createFolder,
  createNote,
  deletePath,
  loadNote,
  movePath,
  reloadOpenNotes,
  renamePath,
  requestDeleteNote,
  resolveConflict,
  restoreFromTrash,
  selectNote,
  selectTable,
} from "./notes.svelte";
export {
  createWorkspace,
  init,
  loadWordIndex,
  openWorkspace,
  refreshTables,
  refreshTree,
  refreshWorkspaces,
} from "./data.svelte";
import { deleteTable } from "./tabs.svelte";
import { afterDelete } from "./notes.svelte";
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

import {
  activeDoc,
  activeGroup,
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


/** Latest table-fetch ticket per group, so a slow older fetch cannot win. */

/**
 * Reload one group's table from disk. Responses that arrive out of order are
 * dropped, and a failed fetch is reported instead of aborting the caller.
 */





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
