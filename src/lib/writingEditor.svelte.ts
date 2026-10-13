//! Vector-editor state: the open glyph, tools, and view options.

import * as api from "./api";
import type { ToolId } from "./writing";

/** The live editor state, shared by the toolbox, canvas and metrics panel. */
export const editor = $state({
  openGlyphId: null as string | null,
  glyphMeta: null as api.GlyphMeta | null,
  outline: null as api.GlyphOutline | null,
  activeTool: "pen" as ToolId,
  zoom: 1,
  snap: false,
  loading: false,
  status: "",
  error: "",
});

function emptyOutline(): api.GlyphOutline {
  return { elements: [], advance: null, lsb: null, rsb: null };
}

/** Open a glyph in the editor and load its outline from disk. */
export function openGlyph(id: string, meta: api.GlyphMeta): void {
  editor.openGlyphId = id;
  editor.glyphMeta = meta;
  editor.activeTool = "pen";
  editor.zoom = 1;
  editor.snap = false;
  editor.status = "";
  editor.error = "";
  void loadOutline(id);
}

/** Leave the editor, discarding unsaved view state (metrics save eagerly). */
export function closeGlyph(): void {
  editor.openGlyphId = null;
  editor.glyphMeta = null;
  editor.outline = null;
  editor.status = "";
  editor.error = "";
}

export async function loadOutline(id: string): Promise<void> {
  editor.loading = true;
  try {
    editor.outline = (await api.writingGlyphGet(id)) ?? emptyOutline();
    editor.error = "";
  } catch (e) {
    editor.error = String(e);
  } finally {
    editor.loading = false;
  }
}

export function setTool(tool: ToolId): void {
  editor.activeTool = tool;
}

export function setZoom(zoom: number): void {
  editor.zoom = zoom;
}

export function toggleSnap(): void {
  editor.snap = !editor.snap;
}

/** Update one glyph metric and persist the outline immediately. */
export function setMetric(
  field: "advance" | "lsb" | "rsb",
  value: number | null,
): void {
  if (!editor.outline) return;
  editor.outline = { ...editor.outline, [field]: value };
  void saveOutline();
}

export async function saveOutline(): Promise<void> {
  if (!editor.openGlyphId || !editor.outline) return;
  try {
    await api.writingGlyphSet(editor.openGlyphId, editor.outline);
    editor.error = "";
    editor.status = "saved";
  } catch (e) {
    editor.error = String(e);
  }
}

const TOOL_STATUS: Record<ToolId, string> = {
  pen: "Pen: click to add a point (drawing lands in a later stage)",
  direct: "Direct Select: click a node to select it",
  node: "Node Mod: click a node to adjust its handles",
  brush: "Brush: drag to draw a calligraphic stroke",
  shapes: "Shapes: pick a shape to place",
  mirror: "Mirror/Flip: reflect the selection",
  eraser: "Eraser: click a node to delete it",
};

/** Stub canvas pointer handler: report the tool, mutate nothing. */
export function handleCanvasPointer(tool: ToolId): void {
  editor.status = TOOL_STATUS[tool];
}
