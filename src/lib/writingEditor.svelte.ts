//! Vector-editor state: the open glyph, tools, selection, history and gestures.

import * as api from "./api";
import {
  addElement,
  alignElements,
  allNodeRefs,
  appendNode,
  applyMatrix,
  brushContour,
  closeContour,
  cycleNodeKind,
  distributeElements,
  emptyOutline,
  hitHandle,
  hitNode,
  isContour,
  knifeCut,
  mirrorElements,
  moveNodes,
  nearestSegment,
  newContour,
  removeElements,
  removeNodes,
  reorderElement,
  rotation,
  scaling,
  setHandle,
  setNodeKind,
  shapeContour,
  shear,
  snapPoint,
  splitSegment,
  selectedElements,
  type AlignMode,
  type NodeRef,
  type OrderMove,
  type Point,
  type ShapeKind,
} from "./writingCommands";
import {
  canRedo,
  canUndo,
  emptyHistory,
  pushHistory,
  redoStep,
  undoStep,
  type History,
} from "./history";
import { componentElement, type ToolId } from "./writing";

/** The live editor state, shared by the toolbox, canvas, menus and panels. */
export const editor = $state({
  openGlyphId: null as string | null,
  glyphMeta: null as api.GlyphMeta | null,
  outline: null as api.GlyphOutline | null,
  activeTool: "pen" as ToolId,
  zoom: 1,
  snap: false,
  grid: 10,
  showGuides: true,
  composeOpen: false,
  loading: false,
  status: "",
  error: "",
  selection: [] as NodeRef[],
  draft: null as { element: number } | null,
  preview: null as api.GlyphElement | null,
  shape: "rect" as ShapeKind,
  nibWidth: 40,
  nibAngle: 45,
  canUndo: false,
  canRedo: false,
});

let history: History<api.GlyphOutline> = emptyHistory();
let drag:
  | { kind: "move"; origin: Point; last: Point; moved: boolean }
  | { kind: "handle"; ref: NodeRef; which: "in" | "out" }
  | { kind: "pen"; ref: NodeRef }
  | { kind: "shape"; from: Point }
  | { kind: "brush"; points: Point[] }
  | null = null;

function syncHistoryFlags(): void {
  editor.canUndo = canUndo(history);
  editor.canRedo = canRedo(history);
}

function resetHistory(): void {
  history = emptyHistory();
  syncHistoryFlags();
}

function say(message: string): void {
  editor.status = message;
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
  editor.selection = [];
  editor.draft = null;
  editor.preview = null;
  drag = null;
  resetHistory();
  void loadOutline(id);
}

/** Leave the editor; edits are saved eagerly so nothing is lost. */
export function closeGlyph(): void {
  editor.openGlyphId = null;
  editor.glyphMeta = null;
  editor.outline = null;
  editor.status = "";
  editor.error = "";
  editor.selection = [];
  editor.draft = null;
  editor.preview = null;
  drag = null;
  resetHistory();
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
  editor.draft = null;
  editor.preview = null;
  drag = null;
}

export function setZoom(zoom: number): void {
  editor.zoom = Math.min(4, Math.max(0.25, zoom));
}

export function toggleSnap(): void {
  editor.snap = !editor.snap;
}

export function toggleGuides(): void {
  editor.showGuides = !editor.showGuides;
}

export function toggleCompose(): void {
  editor.composeOpen = !editor.composeOpen;
}

export function setShape(shape: ShapeKind): void {
  editor.shape = shape;
  editor.activeTool = "shapes";
}

export function setNib(width: number, angle: number): void {
  editor.nibWidth = Math.max(1, width);
  editor.nibAngle = angle;
}

/** Replace the outline as one undoable edit and persist it once. */
function commit(next: api.GlyphOutline, message?: string): void {
  if (!editor.outline) return;
  history = pushHistory(history, editor.outline);
  editor.outline = next;
  syncHistoryFlags();
  if (message) say(message);
  void saveOutline();
}

export function undo(): void {
  if (!editor.outline) return;
  const step = undoStep(history, editor.outline);
  if (!step) return;
  history = step.history;
  editor.outline = step.value;
  editor.selection = [];
  syncHistoryFlags();
  say("undo");
  void saveOutline();
}

export function redo(): void {
  if (!editor.outline) return;
  const step = redoStep(history, editor.outline);
  if (!step) return;
  history = step.history;
  editor.outline = step.value;
  editor.selection = [];
  syncHistoryFlags();
  say("redo");
  void saveOutline();
}

/** Update one glyph metric and persist the outline immediately. */
export function setMetric(
  field: "advance" | "lsb" | "rsb",
  value: number | null,
): void {
  if (!editor.outline) return;
  commit({ ...editor.outline, [field]: value });
}

/** Append a component reference to the active outline and persist. */
export function insertComponent(glyphId: string): void {
  if (!editor.outline) return;
  commit(addElement(editor.outline, componentElement(glyphId)), "component inserted");
}

/** Run a pathfinder boolean on the active glyph, then reload its outline. */
export async function runPathfinder(operation: api.PathOperation): Promise<void> {
  if (!editor.openGlyphId) return;
  try {
    if (editor.outline) history = pushHistory(history, editor.outline);
    syncHistoryFlags();
    await api.writingPathOperation(editor.openGlyphId, operation);
    say(`pathfinder ${operation} applied`);
    await loadOutline(editor.openGlyphId);
    editor.selection = [];
  } catch (e) {
    say(`pathfinder ${operation}: ${String(e)}`);
  }
}

export async function saveOutline(): Promise<void> {
  if (!editor.openGlyphId || !editor.outline) return;
  try {
    await api.writingGlyphSet(editor.openGlyphId, editor.outline);
    editor.error = "";
  } catch (e) {
    editor.error = String(e);
  }
}

function targets(): number[] {
  return editor.outline ? selectedElements(editor.outline, editor.selection) : [];
}

export function selectAll(): void {
  if (!editor.outline) return;
  editor.selection = allNodeRefs(editor.outline);
  say(`${editor.selection.length} nodes selected`);
}

export function clearSelection(): void {
  editor.selection = [];
}

export function deleteSelection(): void {
  if (!editor.outline) return;
  if (editor.selection.length > 0) {
    commit(removeNodes(editor.outline, editor.selection), "nodes deleted");
  } else {
    commit(removeElements(editor.outline, targets()), "shapes deleted");
  }
  editor.selection = [];
}

export function cycleSelectedKind(): void {
  if (!editor.outline || editor.selection.length === 0) return;
  let outline = editor.outline;
  for (const ref of editor.selection) {
    const element = outline.elements[ref.element];
    if (!element || !isContour(element)) continue;
    const node = element.nodes[ref.node];
    if (node) outline = setNodeKind(outline, ref, cycleNodeKind(node.kind));
  }
  commit(outline, "node type changed");
}

export function mirror(axis: "h" | "v"): void {
  if (!editor.outline) return;
  commit(mirrorElements(editor.outline, targets(), axis), axis === "h" ? "flipped horizontally" : "flipped vertically");
}

export function scaleSelection(factor: number): void {
  if (!editor.outline) return;
  const box = boundsOf(targets());
  if (!box) return;
  commit(
    applyMatrix(editor.outline, targets(), scaling(factor, factor, box.cx, box.cy)),
    `scaled ${Math.round(factor * 100)}%`,
  );
}

export function rotateSelection(degrees: number): void {
  if (!editor.outline) return;
  const box = boundsOf(targets());
  if (!box) return;
  commit(
    applyMatrix(editor.outline, targets(), rotation(degrees, box.cx, box.cy)),
    `rotated ${degrees}\u00b0`,
  );
}

export function shearSelection(degrees: number): void {
  if (!editor.outline) return;
  const box = boundsOf(targets());
  if (!box) return;
  commit(
    applyMatrix(editor.outline, targets(), shear(degrees, 0, box.cx, box.cy)),
    `sheared ${degrees}\u00b0`,
  );
}

export function align(mode: AlignMode): void {
  if (!editor.outline) return;
  commit(alignElements(editor.outline, targets(), mode), `aligned ${mode}`);
}

export function distribute(axis: "h" | "v"): void {
  if (!editor.outline) return;
  const indexes = targets();
  if (indexes.length < 3) {
    say("select three or more shapes to distribute");
    return;
  }
  commit(distributeElements(editor.outline, indexes, axis), "distributed");
}

export function reorder(move: OrderMove): void {
  if (!editor.outline) return;
  const indexes = targets();
  if (indexes.length !== 1) {
    say("select one shape to change its order");
    return;
  }
  const result = reorderElement(editor.outline, indexes[0], move);
  commit(result.outline, `moved ${move}`);
  editor.selection = editor.selection.map((ref) => ({ ...ref, element: result.index }));
}

function boundsOf(indexes: number[]): { cx: number; cy: number } | null {
  if (!editor.outline) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const index of indexes) {
    const element = editor.outline.elements[index];
    if (!element || !isContour(element)) continue;
    for (const n of element.nodes) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

function place(point: Point): Point {
  return editor.snap ? snapPoint(point, editor.grid) : point;
}

const NODE_RADIUS = 8;

function selectNode(ref: NodeRef, additive: boolean): void {
  const exists = editor.selection.some((s) => s.element === ref.element && s.node === ref.node);
  if (additive) {
    editor.selection = exists
      ? editor.selection.filter((s) => !(s.element === ref.element && s.node === ref.node))
      : [...editor.selection, ref];
  } else if (!exists) {
    editor.selection = [ref];
  }
}

const TOOL_HINT: Record<ToolId, string> = {
  pen: "Pen: click to add points, drag for curves, click the first point to close",
  direct: "Direct Select: click or drag nodes and handles (Shift adds to the selection)",
  node: "Node Mod: click a node to change its type, click an edge to add a node",
  brush: "Brush: drag to paint a calligraphic stroke",
  shapes: "Shapes: drag to place the chosen shape",
  mirror: "Mirror/Flip: click to flip the selection (Shift for vertical)",
  eraser: "Eraser: click a node to delete it, click an edge to cut it",
};

export function toolHint(tool: ToolId): string {
  return TOOL_HINT[tool];
}

/** Pointer down in glyph space (y-up). */
export function pointerDown(raw: Point, shift: boolean): void {
  if (!editor.outline) return;
  const point = place(raw);
  const outline = editor.outline;
  const radius = NODE_RADIUS / editor.zoom;

  switch (editor.activeTool) {
    case "pen": {
      const draft = editor.draft;
      if (draft) {
        const element = outline.elements[draft.element];
        if (element && isContour(element) && element.nodes.length > 2) {
          const first = element.nodes[0];
          if (Math.hypot(first.x - point.x, first.y - point.y) <= radius) {
            commit(closeContour(outline, draft.element), "contour closed");
            editor.draft = null;
            return;
          }
        }
        const next = appendNode(outline, draft.element, { x: point.x, y: point.y, kind: "smooth" });
        const element2 = next.elements[draft.element];
        history = pushHistory(history, outline);
        editor.outline = next;
        syncHistoryFlags();
        drag = {
          kind: "pen",
          ref: { element: draft.element, node: isContour(element2) ? element2.nodes.length - 1 : 0 },
        };
      } else {
        const created = addElement(outline, newContour([point], false));
        const index = created.elements.length - 1;
        const el = created.elements[index];
        if (isContour(el)) el.nodes[0] = { ...el.nodes[0], kind: "smooth" };
        history = pushHistory(history, outline);
        editor.outline = created;
        syncHistoryFlags();
        editor.draft = { element: index };
        drag = { kind: "pen", ref: { element: index, node: 0 } };
      }
      return;
    }
    case "direct": {
      const handle = hitHandle(outline, raw, radius);
      if (handle) {
        history = pushHistory(history, outline);
        syncHistoryFlags();
        drag = { kind: "handle", ref: handle.ref, which: handle.which };
        return;
      }
      const hit = hitNode(outline, raw, radius);
      if (hit) {
        selectNode(hit, shift);
        history = pushHistory(history, outline);
        syncHistoryFlags();
        drag = { kind: "move", origin: raw, last: raw, moved: false };
      } else {
        if (!shift) editor.selection = [];
        say(TOOL_HINT.direct);
      }
      return;
    }
    case "node": {
      const hit = hitNode(outline, raw, radius);
      if (hit) {
        editor.selection = [hit];
        const element = outline.elements[hit.element];
        if (isContour(element)) {
          commit(
            setNodeKind(outline, hit, cycleNodeKind(element.nodes[hit.node].kind)),
            "node type changed",
          );
        }
        return;
      }
      const seg = nearestSegment(outline, raw, radius);
      if (seg) {
        commit(splitSegment(outline, seg.element, seg.segment, seg.t), "node added");
      } else {
        say(TOOL_HINT.node);
      }
      return;
    }
    case "eraser": {
      const hit = hitNode(outline, raw, radius);
      if (hit) {
        commit(removeNodes(outline, [hit]), "node deleted");
        editor.selection = [];
        return;
      }
      const seg = nearestSegment(outline, raw, radius);
      if (seg) {
        commit(knifeCut(outline, seg.element, seg.segment), "edge cut");
      } else {
        say(TOOL_HINT.eraser);
      }
      return;
    }
    case "mirror": {
      commit(mirrorElements(outline, targets(), shift ? "v" : "h"), shift ? "flipped vertically" : "flipped horizontally");
      return;
    }
    case "shapes": {
      drag = { kind: "shape", from: point };
      return;
    }
    case "brush": {
      drag = { kind: "brush", points: [raw] };
      return;
    }
  }
}

/** Pointer move in glyph space; only local state changes, never IPC. */
export function pointerMove(raw: Point): void {
  if (!editor.outline || !drag) return;
  const point = place(raw);
  if (drag.kind === "pen") {
    const element = editor.outline.elements[drag.ref.element];
    if (!element || !isContour(element)) return;
    const node = element.nodes[drag.ref.node];
    const out: [number, number] = [point.x - node.x, point.y - node.y];
    if (Math.hypot(out[0], out[1]) > 2) {
      editor.outline = setHandle(editor.outline, drag.ref, "out", out);
    }
  } else if (drag.kind === "move") {
    const dx = raw.x - drag.last.x;
    const dy = raw.y - drag.last.y;
    editor.outline = moveNodes(editor.outline, editor.selection, dx, dy);
    drag.last = raw;
    drag.moved = true;
  } else if (drag.kind === "handle") {
    const element = editor.outline.elements[drag.ref.element];
    if (!element || !isContour(element)) return;
    const node = element.nodes[drag.ref.node];
    editor.outline = setHandle(editor.outline, drag.ref, drag.which, [
      point.x - node.x,
      point.y - node.y,
    ]);
  } else if (drag.kind === "shape") {
    editor.preview = {
      ...shapeContour(editor.shape, drag.from, point),
    };
  } else if (drag.kind === "brush") {
    drag.points.push(raw);
    const stroke = brushContour(drag.points, editor.nibWidth, editor.nibAngle);
    editor.preview = stroke;
  }
}

/** Pointer up: finish the gesture, record one history step, save once. */
export function pointerUp(raw: Point): void {
  const finished = drag;
  drag = null;
  if (!finished || !editor.outline) return;
  const point = place(raw);

  if (finished.kind === "pen") {
    // History was recorded on pointer down; persist the finished node.
    void saveOutline();
    say(TOOL_HINT.pen);
  } else if (finished.kind === "move") {
    if (finished.moved) void saveOutline();
  } else if (finished.kind === "handle") {
    void saveOutline();
  } else if (finished.kind === "shape") {
    editor.preview = null;
    if (Math.hypot(point.x - finished.from.x, point.y - finished.from.y) < 2) return;
    commit(
      addElement(editor.outline, shapeContour(editor.shape, finished.from, point)),
      `${editor.shape} added`,
    );
  } else if (finished.kind === "brush") {
    editor.preview = null;
    const stroke = brushContour(finished.points, editor.nibWidth, editor.nibAngle);
    if (stroke) commit(addElement(editor.outline, stroke), "stroke added");
  }
}

/** Finish an open pen path (Enter / double-click) without closing it. */
export function finishPath(): void {
  if (editor.draft && editor.outline) {
    const element = editor.outline.elements[editor.draft.element];
    if (element && isContour(element) && element.nodes.length < 2) {
      editor.outline = removeElements(editor.outline, [editor.draft.element]);
    }
  }
  editor.draft = null;
  void saveOutline();
}

export function cancelGesture(): void {
  drag = null;
  editor.preview = null;
  finishPath();
}

export async function exportGlyphSvg(): Promise<string | null> {
  if (!editor.openGlyphId) return null;
  try {
    return await api.writingExportSvg(editor.openGlyphId);
  } catch (e) {
    editor.error = String(e);
    return null;
  }
}

export async function exportSpriteSvg(): Promise<string | null> {
  try {
    return await api.writingExportSprite();
  } catch (e) {
    editor.error = String(e);
    return null;
  }
}

export async function importSvg(svg: string): Promise<boolean> {
  if (!editor.openGlyphId) return false;
  try {
    const count = await api.writingImportSvg(editor.openGlyphId, svg);
    await loadOutline(editor.openGlyphId);
    resetHistory();
    editor.selection = [];
    say(`imported ${count} shape${count === 1 ? "" : "s"}`);
    return true;
  } catch (e) {
    editor.error = String(e);
    return false;
  }
}
