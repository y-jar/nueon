import { EditorView } from "@codemirror/view";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as api from "./api";
import { assetLink, linkLabel } from "./assets";
import { insertTextAt } from "./editor/commands";
import { tr, ui } from "./state.svelte";

/**
 * OS file drops never reach DOM `drop` events in a Tauri webview; they arrive
 * as native events carrying filesystem paths and a physical pixel position.
 * This routes them by the element under the pointer:
 *
 * - editor: import to `assets/` and insert an image/link reference;
 * - explorer: text/Markdown files become notes, other files go to `assets/`.
 */

type Position = { x: number; y: number };

type Target =
  | { kind: "editor"; el: HTMLElement; view: EditorView; notePath: string }
  | { kind: "folder"; el: HTMLElement; folder: string };

/** Physical webview pixels → the element under that point. */
function cssPoint(position: Position): Position {
  const ratio = window.devicePixelRatio || 1;
  return { x: position.x / ratio, y: position.y / ratio };
}

function targetAt(position: Position): Target | null {
  const point = cssPoint(position);
  const el = document.elementFromPoint(point.x, point.y) as HTMLElement | null;
  if (!el) return null;

  const cm = el.closest<HTMLElement>(".cm-editor");
  const host = el.closest<HTMLElement>(".cm-host");
  if (cm && host?.dataset.note) {
    const view = EditorView.findFromDOM(cm);
    if (view) return { kind: "editor", el: host, view, notePath: host.dataset.note };
  }

  const row = el.closest<HTMLElement>(".tree-row");
  if (row?.dataset.path !== undefined) {
    const path = row.dataset.path;
    const folder =
      row.dataset.dir === "true" ? path : path.split("/").slice(0, -1).join("/");
    return { kind: "folder", el: row, folder };
  }
  const tree = el.closest<HTMLElement>(".tree");
  if (tree) return { kind: "folder", el: tree, folder: "" };
  return null;
}

async function dropOnEditor(
  target: Extract<Target, { kind: "editor" }>,
  paths: string[],
  position: Position,
): Promise<void> {
  const lines: string[] = [];
  for (const path of paths) {
    try {
      const asset = await api.importAsset(path);
      const link = assetLink(target.notePath, asset.name);
      lines.push(
        asset.kind === "image"
          ? `![${linkLabel(asset.original_name)}](${link})`
          : `[${asset.original_name.replace(/[[\]]/g, "")}](${link})`,
      );
    } catch (error) {
      ui.status = tr("status.couldNotImport", { path, error: String(error) });
    }
  }
  if (lines.length === 0) return;
  const point = cssPoint(position);
  const pos =
    target.view.posAtCoords({ x: point.x, y: point.y }) ??
    target.view.state.selection.main.head;
  insertTextAt(target.view, lines.join("\n"), pos);
  target.view.focus();
  ui.status = tr("status.importedFiles", { count: lines.length });
}

async function dropOnFolder(folder: string, paths: string[]): Promise<void> {
  let notes = 0;
  let assets = 0;
  for (const path of paths) {
    try {
      const result = await api.importDrop(folder, path);
      if (result.type === "note") notes += 1;
      else assets += 1;
    } catch (error) {
      ui.status = tr("status.couldNotImport", { path, error: String(error) });
    }
  }
  const parts: string[] = [];
  if (notes) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  if (assets) parts.push(`${assets} file${assets === 1 ? "" : "s"} to assets`);
  if (parts.length) ui.status = tr("status.imported", { names: parts.join(", ") });
}

/** Listen for OS file drops on this window's webview. */
export async function installFileDrop(): Promise<() => void> {
  let hint: HTMLElement | null = null;
  const setHint = (el: HTMLElement | null) => {
    if (hint === el) return;
    hint?.classList.remove("file-drop");
    hint = el;
    hint?.classList.add("file-drop");
  };

  const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "leave") {
      setHint(null);
      return;
    }
    const target = targetAt(payload.position);
    if (payload.type !== "drop") {
      setHint(target?.el ?? null);
      return;
    }
    setHint(null);
    if (!target) {
      ui.status = tr("status.dropHint");
      return;
    }
    if (target.kind === "editor") {
      void dropOnEditor(target, payload.paths, payload.position);
    } else {
      void dropOnFolder(target.folder, payload.paths);
    }
  });

  return () => {
    unlisten();
    setHint(null);
  };
}
