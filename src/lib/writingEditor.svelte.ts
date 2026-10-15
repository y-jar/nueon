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
  staleDraft,
  shapeContour,
  shear,
  breakNode,
  deleteNodePreservingShape,
  joinSelected,
  nodesInBox,
  nudgeNodes,
  stepSelection,
  weldNodes,
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
import { untrack } from "svelte";
import { DEFAULT_TOOL, componentElement, type ToolId } from "./writing";
import { componentIds, expandComponent, flattenElements } from "./writingComponents";
import {
  IDENTITY,
  applyTransform,
  boxCentre,
  dialogMatrix,
  hitTransformHandle,
  isIdentity,
  rotateMatrix,
  scaleMatrix,
  selectionBox,
  skewMatrix,
  transformElements,
  type Box,
  type DialogValues,
  type Matrix,
  type TransformHandle,
} from "./writingTransform";
import { kindOfSelection, setKinds } from "./writingNodeType";
import {
  addExtrema,
  constrainHandle,
  dragSegment,
  hitTarget,
  pullHandles,
  setHandleBroken,
  toggleNode,
  type Target,
} from "./writingBezier";
import {
  clampZoom,
  fitView,
  panBy,
  sameSize,
  screenToGlyph,
  viewBoxOf,
  zoomAbout,
  zoomToRect,
  type ScreenSize,
  type Viewport,
} from "./writingViewport";
import {
  duplicateElements,
  elementsInBox,
  hitElement,
  nudgeElements,
  pruneSelection,
  selectAllElements,
  selectOnly,
  toggleElement,
  translateElements,
  type ElementSelection,
} from "./writingSelect";
import {
  constrainAngle,
  constrainAxis,
  isOpenEndpoint,
  snapPoint as snapTo,
  type SnapResult,
} from "./writingSnap";

/** The live editor state, shared by the toolbox, canvas, menus and panels. */
export const editor = $state({
  openGlyphId: null as string | null,
  glyphMeta: null as api.GlyphMeta | null,
  outline: null as api.GlyphOutline | null,
  activeTool: DEFAULT_TOOL as ToolId,
  /** The canvas view: the glyph point at the centre and screen pixels per font unit. */
  view: { cx: 500, cy: 300, scale: 0.5 } as Viewport,
  /** The canvas size in screen pixels, reported by the canvas. */
  canvasSize: { width: 800, height: 600 } as ScreenSize,
  /** False until the canvas has reported a real size once. */
  canvasMeasured: false,
  /** Zoom as screen pixels per font unit; kept for snapping and hit radii. */
  zoom: 0.5,
  /** Selected whole elements (Select tool); separate from the node selection. */
  elements: [] as ElementSelection,
  /** A temporary tool while a key is held (Space is a hand). */
  tempTool: null as ToolId | null,
  /** The zoom rectangle being dragged, in glyph space. */
  zoomBox: null as { a: Point; b: Point } | null,
  guideMetrics: { ascender: 800, descender: -200, advance: 600 },
  snap: false,
  grid: 10,
  showGuides: true,
  showAllHandles: false,
  /** What the pointer is over in the Direct tool, for hover highlight; written only when it changes. */
  hover: null as { kind: string; key: string } | null,
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
  /** The live snap result while dragging: drives the on-canvas indicator. */
  snapHit: null as SnapResult | null,
  /** The rubber-band rectangle in glyph space while dragging on empty canvas. */
  marquee: null as { a: Point; b: Point } | null,
  /** Outlines of every glyph the open glyph references, for drawing component instances. */
  library: {} as Record<string, api.GlyphOutline>,
  /** The font validation report; null when the dialog is closed. */
  report: null as { issues: api.FontIssue[]; exporting: boolean } | null,
  /** The transform handle under the pointer, for the cursor; written only when it changes. */
  hoverHandle: null as string | null,
  /** The transform box's pivot, or null for the box centre. Reset when the selection changes. */
  pivot: null as Point | null,
  /** The live transform while a handle is dragged; the outline is written on release. */
  liveMatrix: null as Matrix | null,
  /** The Transform dialog. */
  transformOpen: false,
  /** The selected component instance (element index), if any. */
  selectedComponent: null as number | null,
  /** Guide heights and advance, set by the canvas from the writing config. */
  guideHeights: [] as { y: number; label: string }[],
});

let history: History<api.GlyphOutline> = emptyHistory();
interface TransformDrag {
  kind: "transform";
  handle: TransformHandle;
  box: Box;
  pivot: Point;
  start: Point;
  base: api.GlyphOutline;
  indexes: number[];
}

let drag:
  | { kind: "move"; origin: Point; last: Point; moved: boolean; anchor: NodeRef; axis: boolean; start: Point }
  | { kind: "marquee"; from: Point; additive: boolean }
  | { kind: "handle"; ref: NodeRef; which: "in" | "out"; broken: boolean }
  | { kind: "segment"; element: number; segment: number; t: number; start: Point; base: api.GlyphOutline; moved: boolean }
  | { kind: "pull"; ref: NodeRef; moved: boolean }
  | { kind: "pen"; ref: NodeRef }
  | { kind: "shape"; from: Point }
  | { kind: "pan"; x: number; y: number }
  | { kind: "zoombox"; from: Point; screen: Point }
  | { kind: "elements-move"; origin: Point; last: Point; moved: boolean }
  | TransformDrag
  | { kind: "pivot"; box: Box }
  | { kind: "elements-marquee"; from: Point; additive: boolean }
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

/** Forget a pen draft whose element is gone (undo, redo, delete, reload). */
function dropStaleDraft(): void {
  if (editor.outline && staleDraft(editor.outline, editor.draft)) {
    editor.draft = null;
    if (drag && drag.kind === "pen") drag = null;
  }
}

/** Open a glyph in the editor and load its outline from disk. */
export function openGlyph(id: string, meta: api.GlyphMeta): void {
  editor.openGlyphId = id;
  editor.glyphMeta = meta;
  editor.activeTool = DEFAULT_TOOL;
  editor.tempTool = null;
  setElements([]);
  editor.zoomBox = null;
  editor.snap = false;
  editor.status = "";
  editor.error = "";
  editor.selection = [];
  editor.selectedComponent = null;
  editor.library = {};
  editor.draft = null;
  editor.preview = null;
  drag = null;
  resetHistory();
  void loadOutline(id).then(fitGlyph);
}

/** Leave the editor; edits are saved eagerly so nothing is lost. */
export function closeGlyph(): void {
  editor.openGlyphId = null;
  editor.glyphMeta = null;
  editor.outline = null;
  editor.status = "";
  editor.error = "";
  editor.selection = [];
  editor.selectedComponent = null;
  editor.library = {};
  editor.draft = null;
  editor.preview = null;
  drag = null;
  resetHistory();
}

export async function loadOutline(id: string): Promise<void> {
  editor.loading = true;
  try {
    editor.outline = (await api.writingGlyphGet(id)) ?? emptyOutline();
    editor.draft = null;
    editor.error = "";
    await refreshLibrary();
  } catch (e) {
    editor.error = String(e);
  } finally {
    editor.loading = false;
  }
}

/** Load the outlines of every glyph the open glyph references, transitively. */
export async function refreshLibrary(): Promise<void> {
  const outline = editor.outline;
  if (!outline) return;
  const library: Record<string, api.GlyphOutline> = {};
  const lookup = (id: string) => library[id] ?? null;
  for (let round = 0; round < 16; round++) {
    const missing = componentIds(outline, lookup).filter((id) => !(id in library));
    if (missing.length === 0) break;
    await Promise.all(
      missing.map(async (id) => {
        try {
          library[id] = (await api.writingGlyphGet(id)) ?? emptyOutline();
        } catch {
          library[id] = emptyOutline();
        }
      }),
    );
  }
  if (editor.outline === outline) editor.library = library;
}

export function lookupGlyph(id: string): api.GlyphOutline | null {
  return editor.library[id] ?? null;
}

/** Component instances flattened to contours for drawing. */
export function componentContours(): { element: number; contours: api.GlyphContour[] }[] {
  return editor.outline ? flattenElements(editor.outline, lookupGlyph) : [];
}

/** The topmost component instance whose flattened bounds contain the point. */
function hitComponent(point: Point): number | null {
  const found = componentContours().filter(({ contours }) =>
    contours.some((c) => {
      const xs = c.nodes.map((n) => n.x);
      const ys = c.nodes.map((n) => n.y);
      return (
        xs.length > 0 &&
        point.x >= Math.min(...xs) &&
        point.x <= Math.max(...xs) &&
        point.y >= Math.min(...ys) &&
        point.y <= Math.max(...ys)
      );
    }),
  );
  return found.length > 0 ? found[found.length - 1].element : null;
}

/** Turn the selected component instance into ordinary editable contours. */
export function expandSelectedComponent(): void {
  if (!editor.outline || editor.selectedComponent === null) {
    say("select a component to expand");
    return;
  }
  const next = expandComponent(editor.outline, editor.selectedComponent, lookupGlyph);
  if (!next) {
    say("that element is not a component");
    return;
  }
  editor.selectedComponent = null;
  commit(next, "component expanded");
}

export function setTool(tool: ToolId): void {
  editor.activeTool = tool;
  editor.draft = null;
  editor.preview = null;
  editor.zoomBox = null;
  editor.marquee = null;
  editor.liveMatrix = null;
  drag = null;
}

/** The tool in effect: a held-key temporary tool wins over the chosen one. */
export function effectiveTool(): ToolId {
  return editor.tempTool ?? editor.activeTool;
}

/** Space (or H held) is a temporary hand; release returns to the chosen tool. */
export function holdTool(tool: ToolId | null): void {
  if (editor.tempTool === tool) return;
  editor.tempTool = tool;
  if (tool === null) drag = drag && drag.kind === "pan" ? null : drag;
}

function setView(view: Viewport): void {
  editor.view = view;
  editor.zoom = view.scale;
}

/** The SVG viewBox for the current view and canvas size. */
export function currentViewBox() {
  return viewBoxOf(editor.view, editor.canvasSize);
}

/**
 * Record the measured canvas size. Called from a ResizeObserver and from an
 * effect, so it must never be tracked: it reads the state it writes. It writes
 * only when the size really changed, so a repeated measure is free.
 */
export function setCanvasSize(size: ScreenSize): void {
  untrack(() => {
    if (size.width <= 0 || size.height <= 0) return;
    const current = editor.canvasSize;
    if (sameSize(current, size)) return;
    const first = !editor.canvasMeasured;
    editor.canvasSize = size;
    editor.canvasMeasured = true;
    if (first && editor.outline) fitGlyph();
  });
}

/** Guide metrics for fitting; assigned only when a value differs. */
export function setGuideMetrics(m: { ascender: number; descender: number; advance: number }): void {
  untrack(() => {
    const c = editor.guideMetrics;
    if (c.ascender === m.ascender && c.descender === m.descender && c.advance === m.advance) return;
    editor.guideMetrics = m;
  });
}

/** Show the whole glyph: descender to ascender and the advance with room. */
export function fitGlyph(): void {
  const m = editor.guideMetrics;
  const advance = editor.outline?.advance ?? m.advance;
  setView(fitView(editor.canvasSize, { ascender: m.ascender, descender: m.descender, advance }));
}

/** Zoom to an exact scale about the canvas centre. */
export function setZoom(zoom: number): void {
  const factor = clampZoom(zoom) / editor.view.scale;
  const c = { x: editor.canvasSize.width / 2, y: editor.canvasSize.height / 2 };
  setView(zoomAbout(editor.view, editor.canvasSize, c, factor));
}

/** 100% means one font unit per screen pixel. */
export function zoomActual(): void {
  setZoom(1);
}

export function zoomStep(factor: number, cursor?: Point): void {
  const c = cursor ?? { x: editor.canvasSize.width / 2, y: editor.canvasSize.height / 2 };
  setView(zoomAbout(editor.view, editor.canvasSize, c, factor));
}

export function panScreen(dx: number, dy: number): void {
  setView(panBy(editor.view, dx, dy));
}

/** A pointer position in screen pixels over the canvas, for gestures that start there. */
export function screenPoint(x: number, y: number): Point {
  return { x, y };
}

export function glyphAtScreen(x: number, y: number): Point {
  return screenToGlyph(editor.view, editor.canvasSize, { x, y });
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
  dropStaleDraft();
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
  setElements(pruneSelection(editor.elements, step.value.elements.length));
  editor.selectedComponent = null;
  editor.draft = null;
  drag = null;
  syncHistoryFlags();
  say("undo");
  void saveOutline();
  void refreshLibrary();
}

export function redo(): void {
  if (!editor.outline) return;
  const step = redoStep(history, editor.outline);
  if (!step) return;
  history = step.history;
  editor.outline = step.value;
  editor.selection = [];
  setElements(pruneSelection(editor.elements, step.value.elements.length));
  editor.selectedComponent = null;
  editor.draft = null;
  drag = null;
  syncHistoryFlags();
  say("redo");
  void saveOutline();
  void refreshLibrary();
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
  editor.selectedComponent = editor.outline.elements.length - 1;
  void refreshLibrary();
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
  if (effectiveTool() === "select") {
    editor.selection = [];
    setElements(selectAllElements(editor.outline));
    say(`${editor.elements.length} shape(s) selected`);
    return;
  }
  setElements([]);
  editor.selection = allNodeRefs(editor.outline);
  say(`${editor.selection.length} nodes selected`);
}

/** Ctrl+D: copy the selected shapes, offset, and select the copies. */
export function duplicateSelection(): void {
  if (!editor.outline || editor.elements.length === 0) {
    say("select a shape to duplicate");
    return;
  }
  const result = duplicateElements(editor.outline, editor.elements, 20);
  commit(result.outline, "duplicated");
  setElements(result.selection);
}

export function clearSelection(): void {
  editor.selection = [];
}

export function deleteSelection(): void {
  deleteNodes(false);
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

/** Guide rails and the advance line, in the snap engine's terms. */
export function setGuideHeights(guides: { y: number; label: string }[]): void {
  untrack(() => {
    const c = editor.guideHeights;
    if (c.length === guides.length && c.every((g, i) => g.y === guides[i].y && g.label === guides[i].label)) {
      return;
    }
    editor.guideHeights = guides;
  });
}

function snapAt(
  raw: Point,
  exclude: NodeRef[],
  dragging: NodeRef | null,
  disabled: boolean,
): SnapResult {
  if (disabled || !editor.outline) {
    return { point: raw, hits: [], locked: false, weld: null };
  }
  return snapTo(
    {
      outline: editor.outline,
      guides: editor.guideHeights,
      advance: editor.outline.advance ?? null,
      grid: editor.grid,
      gridOn: editor.snap,
      zoom: editor.zoom,
      exclude,
      dragging,
    },
    raw,
  );
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
  select: "Select: click a shape, Shift-click to add, drag to move, drag empty space to box-select",
  hand: "Hand: drag to pan (Space also pans, as does middle-drag)",
  zoom: "Zoom: click to zoom in, Alt-click to zoom out, drag a box to fit it",
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

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  /** The pointer in canvas screen pixels; view tools work in these. */
  screen?: Point;
  /** Which button went down: 0 primary, 1 middle. */
  button?: number;
}

const ZOOM_CLICK = 1.5;

/** The transform box of the current element selection, or null. */
export function currentTransformBox(): Box | null {
  if (!editor.outline || editor.elements.length === 0) return null;
  return selectionBox(editor.outline, editor.elements, lookupGlyph);
}

export function currentPivot(): Point | null {
  const box = currentTransformBox();
  if (!box) return null;
  return editor.pivot ?? boxCentre(box);
}

/** The outline as it will look if the live transform is released now. */
export function previewOutline(): api.GlyphOutline | null {
  if (!editor.outline) return null;
  if (!editor.liveMatrix || !drag || drag.kind !== "transform") return editor.outline;
  return transformElements(drag.base, drag.indexes, editor.liveMatrix).outline;
}

export function setElements(next: number[]): void {
  editor.elements = next;
  editor.pivot = null;
}



/** The snapped placement for a new point (pen, shapes): nodes, rails, lines, grid. */
function placement(raw: Point, mods: Modifiers, exclude: NodeRef[] = []): Point {
  const hit = snapAt(raw, exclude, null, mods.shift);
  editor.snapHit = hit.hits.length > 0 ? hit : null;
  return hit.point;
}

/** Pointer down in glyph space (y-up). */
export function pointerDown(raw: Point, mods: Modifiers): void {
  if (!editor.outline) return;
  const outline = editor.outline;
  const radius = NODE_RADIUS / editor.zoom;
  editor.snapHit = null;

  if (mods.button === 1 || effectiveTool() === "hand") {
    if (mods.screen) drag = { kind: "pan", x: mods.screen.x, y: mods.screen.y };
    return;
  }

  switch (effectiveTool()) {
    case "select": {
      const lookup = lookupGlyph;
      const box = currentTransformBox();
      if (box && editor.elements.length > 0) {
        const pivot = currentPivot() ?? boxCentre(box);
        const handle = hitTransformHandle(box, pivot, raw, 1 / editor.zoom);
        if (handle) {
          if (handle.kind === "pivot") {
            drag = { kind: "pivot", box };
          } else {
            drag = {
              kind: "transform",
              handle,
              box,
              pivot,
              start: raw,
              base: outline,
              indexes: [...editor.elements],
            };
            editor.liveMatrix = IDENTITY;
          }
          return;
        }
      }
      const hit = hitElement(outline, radius, raw, lookup);
      if (hit !== null) {
        editor.selection = [];
        const nextSel = mods.shift
          ? toggleElement(editor.elements, hit)
          : editor.elements.includes(hit)
            ? editor.elements
            : selectOnly(hit);
        if (nextSel.join() !== editor.elements.join()) setElements(nextSel);
        if (editor.elements.includes(hit)) {
          history = pushHistory(history, outline);
          syncHistoryFlags();
          drag = { kind: "elements-move", origin: raw, last: raw, moved: false };
        }
      } else {
        if (!mods.shift) setElements([]);
        drag = { kind: "elements-marquee", from: raw, additive: mods.shift };
        editor.marquee = { a: raw, b: raw };
      }
      return;
    }
    case "hand":
      return;
    case "zoom": {
      if (mods.screen) {
        drag = { kind: "zoombox", from: raw, screen: mods.screen };
        editor.zoomBox = { a: raw, b: raw };
      }
      return;
    }
    case "pen": {
      const point = placement(raw, mods);
      if (staleDraft(outline, editor.draft)) editor.draft = null;
      const draft = editor.draft;
      if (draft) {
        const element = outline.elements[draft.element];
        if (element && isContour(element) && element.nodes.length > 2) {
          const first = element.nodes[0];
          if (Math.hypot(first.x - raw.x, first.y - raw.y) <= radius) {
            commit(closeContour(outline, draft.element), "contour closed");
            editor.draft = null;
            return;
          }
        }
        const from = element && isContour(element) ? element.nodes[element.nodes.length - 1] : null;
        const target = mods.ctrl && from ? constrainAngle(from, point) : point;
        const next = appendNode(outline, draft.element, { x: target.x, y: target.y, kind: "smooth" });
        const element2 = next.elements[draft.element];
        if (!isContour(element2)) {
          editor.draft = null;
          return;
        }
        history = pushHistory(history, outline);
        editor.outline = next;
        syncHistoryFlags();
        drag = {
          kind: "pen",
          ref: { element: draft.element, node: element2.nodes.length - 1 },
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
      const target = hitTarget(outline, editor.selection, raw, editor.zoom, editor.showAllHandles);
      editor.selectedComponent = null;
      if (target?.kind === "handle") {
        history = pushHistory(history, outline);
        syncHistoryFlags();
        drag = { kind: "handle", ref: target.ref, which: target.which, broken: mods.alt };
        return;
      }
      if (target?.kind === "node") {
        const hit = target.ref;
        selectNode(hit, mods.shift);
        history = pushHistory(history, outline);
        syncHistoryFlags();
        if (mods.alt && !mods.shift) {
          drag = { kind: "pull", ref: hit, moved: false };
          return;
        }
        const startNode = nodeAt(hit);
        drag = {
          kind: "move",
          origin: raw,
          last: raw,
          moved: false,
          anchor: hit,
          axis: mods.ctrl,
          start: startNode ? { x: startNode.x, y: startNode.y } : raw,
        };
        return;
      }
      if (target?.kind === "segment") {
        if (mods.shift) {
          const element = outline.elements[target.element];
          if (isContour(element)) {
            editor.selection = [
              { element: target.element, node: target.segment },
              { element: target.element, node: (target.segment + 1) % element.nodes.length },
            ];
          }
          return;
        }
        history = pushHistory(history, outline);
        syncHistoryFlags();
        drag = {
          kind: "segment",
          element: target.element,
          segment: target.segment,
          t: target.t,
          start: raw,
          base: outline,
          moved: false,
        };
        return;
      }
      const component = hitComponent(raw);
      if (component !== null) {
        editor.selection = [];
        editor.selectedComponent = component;
        say("component selected");
        return;
      }
      if (!mods.shift) editor.selection = [];
      drag = { kind: "marquee", from: raw, additive: mods.shift };
      editor.marquee = { a: raw, b: raw };
      return;
    }
    case "node": {
      const hit = hitNode(outline, raw, radius);
      if (hit) {
        editor.selection = [hit];
        const element = outline.elements[hit.element];
        if (isContour(element)) {
          if (mods.alt) {
            commit(deleteNodePreservingShape(outline, hit), "node deleted");
            editor.selection = [];
          } else {
            commit(
              setNodeKind(outline, hit, cycleNodeKind(element.nodes[hit.node].kind)),
              "node type changed",
            );
          }
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
        commit(
          mods.ctrl ? removeNodes(outline, [hit]) : deleteNodePreservingShape(outline, hit),
          "node deleted",
        );
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
      commit(
        mirrorElements(outline, targets(), mods.shift ? "v" : "h"),
        mods.shift ? "flipped vertically" : "flipped horizontally",
      );
      return;
    }
    case "shapes": {
      drag = { kind: "shape", from: placement(raw, mods) };
      return;
    }
    case "brush": {
      drag = { kind: "brush", points: [raw] };
      return;
    }
  }
}

/** The matrix for the handle being dragged. Snapping moves the pointer; Shift and Alt change the maths. */
function liveTransform(d: TransformDrag, raw: Point, mods: Modifiers): Matrix {
  const snapped = snapAt(raw, [], null, mods.shift);
  editor.snapHit = snapped.hits.length > 0 ? snapped : null;
  const pointer = snapped.point;
  const h = d.handle;
  if (h.kind === "scale") {
    return scaleMatrix(d.box, h.which, pointer, {
      keepRatio: mods.shift,
      fromPivot: mods.alt,
      pivot: d.pivot,
    });
  }
  if (h.kind === "rotate") return rotateMatrix(d.pivot, d.start, raw, mods.shift);
  if (h.kind === "skew") return skewMatrix(d.box, h.which, pointer, d.pivot);
  return IDENTITY;
}

/** Pointer move in glyph space; only local state changes, never IPC. */
export function pointerMove(raw: Point, mods: Modifiers): void {
  if (!editor.outline) return;
  if (drag && drag.kind === "pan") {
    if (mods.screen) {
      panScreen(mods.screen.x - drag.x, mods.screen.y - drag.y);
      drag = { kind: "pan", x: mods.screen.x, y: mods.screen.y };
    }
    return;
  }
  if (drag && drag.kind === "pivot") {
    const p = snapAt(raw, [], null, mods.shift).point;
    editor.pivot = { x: p.x, y: p.y };
    return;
  }
  if (drag && drag.kind === "transform") {
    editor.liveMatrix = liveTransform(drag, raw, mods);
    return;
  }
  if (drag && drag.kind === "elements-move") {
    const dx = raw.x - drag.last.x;
    const dy = raw.y - drag.last.y;
    editor.outline = translateElements(editor.outline, editor.elements, dx, dy);
    drag = { ...drag, last: raw, moved: true };
    return;
  }
  if (drag && drag.kind === "elements-marquee") {
    editor.marquee = { a: drag.from, b: raw };
    return;
  }
  if (drag && drag.kind === "zoombox") {
    editor.zoomBox = { a: drag.from, b: raw };
    return;
  }
  if (!drag && effectiveTool() === "select") {
    const box = currentTransformBox();
    let label: string | null = null;
    if (box) {
      const h = hitTransformHandle(box, currentPivot() ?? boxCentre(box), raw, 1 / editor.zoom);
      label = h ? `${h.kind}-${h.which}` : null;
    }
    if (editor.hoverHandle !== label) editor.hoverHandle = label;
  } else if (editor.hoverHandle !== null) {
    editor.hoverHandle = null;
  }
  if (!drag && effectiveTool() === "direct") {
    const t = hitTarget(editor.outline, editor.selection, raw, editor.zoom, editor.showAllHandles);
    const next = hoverOf(t);
    const cur = editor.hover;
    if ((cur?.key ?? null) !== (next?.key ?? null)) editor.hover = next;
  } else if (editor.hover !== null) {
    editor.hover = null;
  }
  if (!drag) {
    // Hover feedback: show what a click would snap to, without changing anything.
    if (editor.activeTool === "pen" || editor.activeTool === "shapes") {
      const hit = snapAt(raw, [], null, mods.shift);
      editor.snapHit = hit.hits.length > 0 ? hit : null;
    } else if (editor.snapHit) {
      editor.snapHit = null;
    }
    return;
  }
  if (drag.kind === "pen") {
    const element = editor.outline.elements[drag.ref.element];
    if (!element || !isContour(element)) return;
    const node = element.nodes[drag.ref.node];
    const point = snapAt(raw, [drag.ref], null, mods.shift).point;
    let out: [number, number] = [point.x - node.x, point.y - node.y];
    if (mods.ctrl) {
      const c = constrainAngle({ x: 0, y: 0 }, { x: out[0], y: out[1] }, 15);
      out = [c.x, c.y];
    }
    if (Math.hypot(out[0], out[1]) > 2) {
      editor.outline = setHandle(editor.outline, drag.ref, "out", out);
    }
  } else if (drag.kind === "move") {
    const refs = editor.selection;
    const anchorNode = nodeAt(drag.anchor);
    if (!anchorNode) return;
    const wanted = { x: anchorNode.x + (raw.x - drag.last.x), y: anchorNode.y + (raw.y - drag.last.y) };
    const hit = snapAt(wanted, refs, drag.anchor, mods.shift);
    editor.snapHit = hit.hits.length > 0 ? hit : null;
    let target = hit.point;
    if (mods.ctrl || drag.axis) target = constrainAxis(drag.start, target);
    const dx = target.x - anchorNode.x;
    const dy = target.y - anchorNode.y;
    editor.outline = moveNodes(editor.outline, refs, dx, dy);
    drag.last = raw;
    drag.moved = true;
  } else if (drag.kind === "segment") {
    const delta = { x: raw.x - drag.start.x, y: raw.y - drag.start.y };
    editor.outline = dragSegment(drag.base, drag.element, drag.segment, drag.t, delta);
    drag.moved = true;
  } else if (drag.kind === "pull") {
    const next = pullHandles(editor.outline, drag.ref, raw);
    if (next !== editor.outline) {
      editor.outline = next;
      drag.moved = true;
    }
  } else if (drag.kind === "handle") {
    const element = editor.outline.elements[drag.ref.element];
    if (!element || !isContour(element)) return;
    const node = element.nodes[drag.ref.node];
    if (!node) return;
    const pointer = mods.shift ? raw : snapAt(raw, [drag.ref], null, false).point;
    let offset: [number, number] = constrainHandle([pointer.x - node.x, pointer.y - node.y], {
      shift: mods.shift,
      ctrl: mods.ctrl,
    });
    if (drag.broken || mods.alt) {
      editor.outline = setHandleBroken(editor.outline, drag.ref, drag.which, offset);
    } else {
      editor.outline = setHandle(editor.outline, drag.ref, drag.which, offset);
    }
  } else if (drag.kind === "shape") {
    let point = snapAt(raw, [], null, mods.shift).point;
    if (mods.ctrl) {
      const side = Math.max(Math.abs(point.x - drag.from.x), Math.abs(point.y - drag.from.y));
      point = {
        x: drag.from.x + Math.sign(point.x - drag.from.x || 1) * side,
        y: drag.from.y + Math.sign(point.y - drag.from.y || 1) * side,
      };
    }
    editor.preview = { ...shapeContour(editor.shape, drag.from, point) };
  } else if (drag.kind === "brush") {
    drag.points.push(raw);
    editor.preview = brushContour(drag.points, editor.nibWidth, editor.nibAngle);
  } else if (drag.kind === "marquee") {
    editor.marquee = { a: drag.from, b: raw };
  }
}

function hoverOf(t: Target | null): { kind: string; key: string } | null {
  if (!t) return null;
  if (t.kind === "node") return { kind: "node", key: `n:${t.ref.element}:${t.ref.node}` };
  if (t.kind === "handle") return { kind: "handle", key: `h:${t.ref.element}:${t.ref.node}:${t.which}` };
  return { kind: "segment", key: `s:${t.element}:${t.segment}` };
}

function nodeAt(ref: NodeRef) {
  const element = editor.outline?.elements[ref.element];
  return element && isContour(element) ? element.nodes[ref.node] : null;
}

/** Pointer up: finish the gesture, record one history step, save once. */
export function pointerUp(raw: Point, mods: Modifiers): void {
  const finished = drag;
  drag = null;
  const hit = editor.snapHit;
  editor.snapHit = null;
  if (!finished || !editor.outline) return;

  if (finished.kind === "pan") return;
  if (finished.kind === "pivot") return;
  if (finished.kind === "transform") {
    const m = editor.liveMatrix;
    editor.liveMatrix = null;
    if (!m || isIdentity(m)) return;
    const result = applyTransform(finished.base, finished.indexes, m, false);
    commit(result.outline, finished.handle.kind === "scale" ? "scaled" : finished.handle.kind === "rotate" ? "rotated" : "skewed");
    setElements(result.selection);
    if (result.skipped > 0) say(`${result.skipped} component(s) cannot be skewed, flipped or stretched and were left alone`);
    return;
  }
  if (finished.kind === "elements-move") {
    if (finished.moved) void saveOutline();
    return;
  }
  if (finished.kind === "elements-marquee") {
    const box = editor.marquee;
    editor.marquee = null;
    if (box && Math.hypot(box.a.x - box.b.x, box.a.y - box.b.y) > 3 / editor.zoom) {
      const inside = elementsInBox(editor.outline, box.a, box.b, lookupGlyph);
      setElements(
        finished.additive
          ? [...new Set([...editor.elements, ...inside])].sort((a, b) => a - b)
          : inside,
      );
      say(`${editor.elements.length} shape(s) selected`);
    }
    return;
  }
  if (finished.kind === "zoombox") {
    editor.zoomBox = null;
    const end = mods.screen;
    if (!end) return;
    const moved = Math.hypot(end.x - finished.screen.x, end.y - finished.screen.y);
    if (moved < 4) {
      zoomStep(mods.alt ? 1 / ZOOM_CLICK : ZOOM_CLICK, end);
    } else {
      setView(
        zoomToRect(editor.view, editor.canvasSize, {
          x1: finished.screen.x,
          y1: finished.screen.y,
          x2: end.x,
          y2: end.y,
        }),
      );
    }
    return;
  }

  if (finished.kind === "pen") {
    void saveOutline();
    say(TOOL_HINT.pen);
  } else if (finished.kind === "move") {
    if (!finished.moved) return;
    // Weld on drop: an open endpoint released on another open endpoint joins them.
    if (hit?.weld && editor.selection.length === 1 && isOpenEndpoint(editor.outline, finished.anchor)) {
      const welded = weldNodes(editor.outline, finished.anchor, hit.weld, hit.point);
      if (welded) {
        editor.outline = welded;
        editor.selection = [];
        say("endpoints welded");
        void saveOutline();
        return;
      }
    }
    void saveOutline();
  } else if (finished.kind === "handle") {
    void saveOutline();
  } else if (finished.kind === "segment") {
    if (finished.moved) void saveOutline();
  } else if (finished.kind === "pull") {
    if (finished.moved) void saveOutline();
  } else if (finished.kind === "shape") {
    editor.preview = null;
    let point = snapAt(raw, [], null, mods.shift).point;
    if (mods.ctrl) {
      const side = Math.max(Math.abs(point.x - finished.from.x), Math.abs(point.y - finished.from.y));
      point = {
        x: finished.from.x + Math.sign(point.x - finished.from.x || 1) * side,
        y: finished.from.y + Math.sign(point.y - finished.from.y || 1) * side,
      };
    }
    if (Math.hypot(point.x - finished.from.x, point.y - finished.from.y) < 2) return;
    commit(
      addElement(editor.outline, shapeContour(editor.shape, finished.from, point)),
      `${editor.shape} added`,
    );
  } else if (finished.kind === "brush") {
    editor.preview = null;
    const stroke = brushContour(finished.points, editor.nibWidth, editor.nibAngle);
    if (stroke) commit(addElement(editor.outline, stroke), "stroke added");
  } else if (finished.kind === "marquee") {
    const box = editor.marquee;
    editor.marquee = null;
    if (box && Math.hypot(box.a.x - box.b.x, box.a.y - box.b.y) > 3 / editor.zoom) {
      const inside = nodesInBox(editor.outline, box.a, box.b);
      editor.selection = finished.additive
        ? [
            ...editor.selection,
            ...inside.filter(
              (r) => !editor.selection.some((s) => s.element === r.element && s.node === r.node),
            ),
          ]
        : inside;
      say(`${editor.selection.length} nodes selected`);
    }
  }
}

/** Join the two selected endpoints (Shift+J). */
export function joinNodes(): void {
  if (!editor.outline) return;
  const joined = joinSelected(editor.outline, editor.selection);
  if (!joined) {
    say("select exactly two open endpoints to join");
    return;
  }
  commit(joined, "endpoints joined");
  editor.selection = [];
}

/** Break the selected node in two (Shift+B). */
export function breakSelected(): void {
  if (!editor.outline || editor.selection.length !== 1) {
    say("select one node to break");
    return;
  }
  const broken = breakNode(editor.outline, editor.selection[0]);
  if (!broken) {
    say("that node cannot be broken");
    return;
  }
  commit(broken, "node broken");
  editor.selection = [];
}

/** Arrow-key nudge: 1 unit, 10 with Shift (FontForge's default step). */
export function nudge(dx: number, dy: number, shift: boolean): void {
  if (editor.outline && editor.elements.length > 0 && editor.selection.length === 0) {
    commit(nudgeElements(editor.outline, editor.elements, dx, dy, shift));
    return;
  }
  if (!editor.outline || editor.selection.length === 0) return;
  const step = shift ? 10 : 1;
  commit(nudgeNodes(editor.outline, editor.selection, dx * step, dy * step));
}

export function selectNext(step: 1 | -1): void {
  if (!editor.outline) return;
  const current = editor.selection.length > 0 ? editor.selection[editor.selection.length - 1] : null;
  const next = stepSelection(editor.outline, current, step);
  editor.selection = next ? [next] : [];
}

/** Delete selected nodes keeping the curve's shape; `plain` removes without refitting. */
export function deleteNodes(plain: boolean): void {
  if (!editor.outline) return;
  if (editor.elements.length > 0 && editor.selection.length === 0) {
    commit(removeElements(editor.outline, editor.elements), "shapes deleted");
    setElements([]);
    return;
  }
  if (editor.selectedComponent !== null) {
    commit(removeElements(editor.outline, [editor.selectedComponent]), "component removed");
    editor.selectedComponent = null;
    return;
  }
  if (editor.selection.length === 0) {
    commit(removeElements(editor.outline, targets()), "shapes deleted");
    return;
  }
  let outline = editor.outline;
  const ordered = editor.selection
    .slice()
    .sort((a, b) => b.element - a.element || b.node - a.node);
  for (const ref of ordered) {
    outline = plain ? removeNodes(outline, [ref]) : deleteNodePreservingShape(outline, ref);
  }
  commit(outline, "nodes deleted");
  editor.selection = [];
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
  editor.liveMatrix = null;
  editor.snapHit = null;
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

/** Compile the writing system to a font at `path`; reports what was written. */
/** Validate the writing system and open the report; `exporting` offers the export button. */
export async function checkFont(exporting: boolean): Promise<void> {
  try {
    editor.report = { issues: await api.writingValidateFont(), exporting };
  } catch (e) {
    editor.error = String(e);
  }
}

export function closeReport(): void {
  editor.report = null;
}

export async function exportFont(path: string): Promise<boolean> {
  try {
    const result = await api.writingExportFont(path);
    say(
      `font exported: ${result.glyphs} glyphs, ${result.lookups} layout lookups, ${result.bytes} bytes`,
    );
    return true;
  } catch (e) {
    editor.error = String(e);
    return false;
  }
}


/** Open the Transform dialog on the current selection (or the whole glyph when none). */
export function openTransformDialog(): void {
  if (!editor.outline) return;
  editor.transformOpen = true;
}

export function closeTransformDialog(): void {
  editor.transformOpen = false;
}

/** The shapes a numeric transform acts on: the selection, else every shape. */
function transformTargets(): number[] {
  if (!editor.outline) return [];
  if (editor.elements.length > 0) return editor.elements;
  return editor.outline.elements.map((_, i) => i);
}

/** The pivot the dialog uses: the pivot handle when set, else the centre of what it acts on. */
export function dialogPivot(): Point {
  if (editor.outline && editor.elements.length > 0 && editor.pivot) return editor.pivot;
  const box = editor.outline ? selectionBox(editor.outline, transformTargets(), lookupGlyph) : null;
  return box ? boxCentre(box) : { x: 0, y: 0 };
}

/** Apply the dialog's numbers as one undoable step; `copy` transforms appended copies instead. */
export function applyDialog(values: DialogValues, copy: boolean): void {
  if (!editor.outline) return;
  const targets = transformTargets();
  if (targets.length === 0) {
    say("nothing to transform");
    return;
  }
  const m = dialogMatrix(values, dialogPivot());
  if (isIdentity(m) && !copy) {
    say("nothing to change");
    return;
  }
  const result = applyTransform(editor.outline, targets, m, copy);
  commit(result.outline, copy ? "transformed copy" : "transformed");
  if (editor.elements.length > 0 || copy) setElements(result.selection);
  if (result.skipped > 0) say(`${result.skipped} component(s) cannot be skewed, flipped or stretched and were left alone`);
}

/** Set the type of the selected nodes as one undoable step. */
export function setSelectedKind(kind: api.NodeKind): void {
  if (!editor.outline || editor.selection.length === 0) {
    say("select a node first");
    return;
  }
  commit(setKinds(editor.outline, editor.selection, kind), `node type: ${kind}`);
}

/** The shared type of the selected nodes, or null when mixed or none selected. */
export function selectedKind(): api.NodeKind | null {
  if (!editor.outline) return null;
  return kindOfSelection(editor.outline, editor.selection);
}


/** Double-click a node in the Direct tool: corner <-> smooth. */
export function toggleNodeAt(raw: Point): void {
  if (!editor.outline) return;
  const t = hitTarget(editor.outline, editor.selection, raw, editor.zoom, editor.showAllHandles);
  if (t?.kind !== "node") return;
  commit(toggleNode(editor.outline, t.ref), "node type toggled");
  editor.selection = [t.ref];
}

/** Add a node at each horizontal and vertical extremum of the selected curves. */
export function addExtremaToSelection(): void {
  if (!editor.outline) return;
  const elements =
    editor.selection.length > 0
      ? [...new Set(editor.selection.map((r) => r.element))]
      : editor.elements.length > 0
        ? editor.elements
        : editor.outline.elements.map((_, i) => i);
  const before = editor.outline.elements.reduce((n, el) => n + (el.kind === "contour" ? el.nodes.length : 0), 0);
  const next = addExtrema(editor.outline, elements);
  const after = next.elements.reduce((n, el) => n + (el.kind === "contour" ? el.nodes.length : 0), 0);
  if (after === before) {
    say("no extrema to add");
    return;
  }
  commit(next, `added ${after - before} extrema node(s)`);
  editor.selection = [];
}
