//! Context menus, inline rename/new requests and section collapsing.

import type { EditorView } from "@codemirror/view";

import { ui, type ColumnMenuPayload } from "./store.svelte";

/** The editor the open editor context menu acts on. */
let contextEditor: EditorView | null = null;

export function openEditorContextMenu(x: number, y: number, view: EditorView): void {
  contextEditor = view;
  ui.contextMenu = { x, y, path: "", isDir: false, kind: "editor" };
}

export function getContextEditor(): EditorView | null {
  return contextEditor;
}

/** Open the right-click menu for a grid column header. */
export function openColumnMenu(
  x: number,
  y: number,
  column: ColumnMenuPayload,
): void {
  ui.contextMenu = { x, y, path: "", isDir: false, kind: "column", column };
}

export function openTabContextMenu(
  x: number,
  y: number,
  groupId: string,
  tabId: string,
): void {
  ui.contextMenu = {
    x,
    y,
    path: "",
    isDir: false,
    kind: "tab",
    tab: { groupId, tabId },
  };
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
  // Drop the editor the menu acted on so it cannot be kept alive or reused.
  contextEditor = null;
}

export function collapseAll(): void {
  ui.collapseAllSignal += 1;
}

/** Hide a quarantine warning for this session; the file itself is untouched. */
export function dismissQuarantine(fileName: string): void {
  ui.quarantineDismissed = [...ui.quarantineDismissed, fileName];
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
