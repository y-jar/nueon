//! Back-layer and layer-visibility maths for the vector editor, pure so it can
//! be tested and mutation-checked without the DOM or Tauri IPC.

/** Which layers the canvas shows: guide rails, the back layer, the fore layer. */
export interface LayerState {
  guide: boolean;
  back: boolean;
  fore: boolean;
}

export type LayerId = keyof LayerState;

export const DEFAULT_LAYERS: LayerState = { guide: true, back: true, fore: true };

/** Flip one layer's visibility, leaving the others alone. */
export function toggleLayer(layers: LayerState, which: LayerId): LayerState {
  return { ...layers, [which]: !layers[which] };
}

/**
 * Whether the tool may edit the glyph while the fore layer is hidden. The
 * view tools (Hand, Zoom) still pan and zoom; everything else would edit
 * invisible outlines, so it waits until Fore shows again.
 */
export function editsBlocked(layers: LayerState, tool: string): boolean {
  return !layers.fore && tool !== "hand" && tool !== "zoom";
}

/** Smallest image width in font units a corner drag can leave behind. */
export const MIN_IMAGE_WIDTH = 8;

/** A back image's on-canvas rectangle in font units, y up. */
export interface BackRect {
  /** Left edge. */
  x: number;
  /** Bottom edge. */
  y: number;
  w: number;
  h: number;
}

/**
 * The rectangle a placed back image covers: centred on `(image.x, image.y)`,
 * `image.width` wide, and as tall as the file's aspect ratio makes it. A
 * non-positive width or aspect ratio has no rectangle.
 */
export function backImageRect(
  image: { x: number; y: number; width: number },
  aspect: number,
): BackRect | null {
  if (!(image.width > 0) || !(aspect > 0)) return null;
  const h = image.width / aspect;
  return { x: image.x - image.width / 2, y: image.y - h / 2, w: image.width, h };
}

/** The four corners of a back-image rectangle, clockwise from top-left. */
export function backRectCorners(rect: BackRect): { nw: Point; ne: Point; se: Point; sw: Point } {
  return {
    nw: { x: rect.x, y: rect.y + rect.h },
    ne: { x: rect.x + rect.w, y: rect.y + rect.h },
    se: { x: rect.x + rect.w, y: rect.y },
    sw: { x: rect.x, y: rect.y },
  };
}

interface Point {
  x: number;
  y: number;
}

/** Whether a point lies inside (or on the edge of) a rectangle. */
export function rectContains(rect: BackRect, p: Point): boolean {
  return (
    p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h
  );
}

export type CornerId = "nw" | "ne" | "se" | "sw";

/** The corner opposite `corner`, the one a corner drag anchors in place. */
export function oppositeCorner(corner: CornerId): CornerId {
  return corner === "nw" ? "se" : corner === "ne" ? "sw" : corner === "se" ? "nw" : "ne";
}

/**
 * Scale a back image by dragging one corner: the opposite corner stays
 * anchored, the far corner follows the ray from it through the pointer, and
 * the aspect ratio is kept exactly, because the new width comes from the
 * diagonal's length. A drag that would shrink below [`MIN_IMAGE_WIDTH`]
 * clamps there instead.
 */
export function scaleByCorner(
  image: { x: number; y: number; width: number },
  corner: CornerId,
  p: Point,
  aspect: number,
): { x: number; y: number; width: number } {
  const rect = backImageRect(image, aspect);
  if (!rect) return image;
  const corners = backRectCorners(rect);
  const anchor = corners[oppositeCorner(corner)];
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  const diagonal = Math.hypot(dx, dy);
  const width = Math.max(MIN_IMAGE_WIDTH, diagonal / Math.sqrt(1 + 1 / (aspect * aspect)));
  const h = width / aspect;
  const sx = dx >= 0 ? 1 : -1;
  const sy = dy >= 0 ? 1 : -1;
  return { x: anchor.x + (sx * width) / 2, y: anchor.y + (sy * h) / 2, width };
}
