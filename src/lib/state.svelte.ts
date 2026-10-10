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
export {
  clearSuppressedConfirms,
  confirmDialog,
  dismissToast,
  noteFilePath,
  requestDeleteTable,
  resetKeybinds,
  setEditorLineNumbers,
  setKeybind,
  showToast,
  suppressConfirm,
  tr,
} from "./feedback.svelte";

export function baseName(path: string): string {
  return stripMd(path.split("/").filter(Boolean).pop() ?? path);
}

// -- confirmation, undo toast, trash ------------------------------------

