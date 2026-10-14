//! Pure viewport math for the glyph canvas: zoom about a point, pan, fit.

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 32;

/** The glyph point shown at the screen centre, and screen pixels per font unit. */
export interface Viewport {
  cx: number;
  cy: number;
  scale: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface Pt {
  x: number;
  y: number;
}

export interface ScreenRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GlyphBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** Glyph space is y-up; screen space is y-down with the origin at the top-left. */
export function glyphToScreen(view: Viewport, size: ScreenSize, p: Pt): Pt {
  return {
    x: size.width / 2 + (p.x - view.cx) * view.scale,
    y: size.height / 2 - (p.y - view.cy) * view.scale,
  };
}

export function screenToGlyph(view: Viewport, size: ScreenSize, p: Pt): Pt {
  return {
    x: view.cx + (p.x - size.width / 2) / view.scale,
    y: view.cy - (p.y - size.height / 2) / view.scale,
  };
}

/** Scale by `factor` while the glyph point under `cursor` stays under it. */
export function zoomAbout(view: Viewport, size: ScreenSize, cursor: Pt, factor: number): Viewport {
  const scale = clampZoom(view.scale * factor);
  const anchor = screenToGlyph(view, size, cursor);
  return {
    scale,
    cx: anchor.x - (cursor.x - size.width / 2) / scale,
    cy: anchor.y + (cursor.y - size.height / 2) / scale,
  };
}

/** Drag the content by `dx`, `dy` screen pixels. */
export function panBy(view: Viewport, dx: number, dy: number): Viewport {
  return { ...view, cx: view.cx - dx / view.scale, cy: view.cy + dy / view.scale };
}

const MIN_RECT = 4;

/** Zoom so a rectangle dragged on screen fills the view; a click-sized one is ignored. */
export function zoomToRect(view: Viewport, size: ScreenSize, rect: ScreenRect): Viewport {
  const w = Math.abs(rect.x2 - rect.x1);
  const h = Math.abs(rect.y2 - rect.y1);
  if (w < MIN_RECT && h < MIN_RECT) return view;
  const centre = screenToGlyph(view, size, {
    x: (rect.x1 + rect.x2) / 2,
    y: (rect.y1 + rect.y2) / 2,
  });
  const factor = Math.min(size.width / Math.max(w, 1e-6), size.height / Math.max(h, 1e-6));
  return { cx: centre.x, cy: centre.y, scale: clampZoom(view.scale * factor) };
}

/** Fit a font-unit box with a fractional margin on every side. */
export function fitBox(size: ScreenSize, box: GlyphBox, margin = 0.08): Viewport {
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const usable = 1 - 2 * margin;
  const scale =
    w <= 0 && h <= 0
      ? 1
      : clampZoom(
          Math.min(
            w > 0 ? (size.width * usable) / w : Infinity,
            h > 0 ? (size.height * usable) / h : Infinity,
          ),
        );
  return { cx: (box.minX + box.maxX) / 2, cy: (box.minY + box.maxY) / 2, scale };
}

export interface FitMetrics {
  ascender: number;
  descender: number;
  advance: number;
}

/** The default view of a glyph: descender to ascender, the advance with room either side. */
export function fitView(size: ScreenSize, m: FitMetrics): Viewport {
  const pad = Math.max(m.advance, 200) * 0.15;
  return fitBox(
    size,
    { minX: -pad, maxX: Math.max(m.advance, 200) + pad, minY: m.descender, maxY: m.ascender },
    0.06,
  );
}

/** The SVG viewBox (y flipped, as the canvas draws y negated) showing exactly the visible area. */
export function viewBoxOf(view: Viewport, size: ScreenSize) {
  const width = size.width / view.scale;
  const height = size.height / view.scale;
  return { x: view.cx - width / 2, y: -view.cy - height / 2, width, height };
}
