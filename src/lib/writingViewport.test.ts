import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  fitBox,
  fitView,
  panBy,
  screenToGlyph,
  glyphToScreen,
  viewBoxOf,
  zoomAbout,
  zoomToRect,
  type Viewport,
} from "./writingViewport.ts";

const size = { width: 800, height: 600 };
const view: Viewport = { cx: 500, cy: 300, scale: 1 };

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

test("the viewport centre maps to the middle of the screen, y up becomes y down", () => {
  const mid = glyphToScreen(view, size, { x: 500, y: 300 });
  near(mid.x, 400);
  near(mid.y, 300);
  const above = glyphToScreen(view, size, { x: 500, y: 400 });
  near(above.y, 200);
  const right = glyphToScreen(view, size, { x: 600, y: 300 });
  near(right.x, 500);
});

test("screenToGlyph inverts glyphToScreen at any scale", () => {
  for (const scale of [0.1, 0.5, 1, 4, 32]) {
    const v = { cx: 120, cy: -40, scale };
    const p = { x: 333, y: 217 };
    const back = screenToGlyph(v, size, glyphToScreen(v, size, p));
    near(back.x, p.x, 1e-6);
    near(back.y, p.y, 1e-6);
  }
});

test("scale is screen pixels per font unit", () => {
  const a = glyphToScreen({ ...view, scale: 2 }, size, { x: 600, y: 300 });
  near(a.x, 400 + 200);
});

test("zoomAbout keeps the glyph point under the cursor fixed", () => {
  const cursor = { x: 650, y: 120 };
  const before = screenToGlyph(view, size, cursor);
  const next = zoomAbout(view, size, cursor, 2);
  assert.equal(next.scale, 2);
  const after = screenToGlyph(next, size, cursor);
  near(after.x, before.x, 1e-6);
  near(after.y, before.y, 1e-6);
});

test("zoomAbout at the screen centre does not move the viewport", () => {
  const next = zoomAbout(view, size, { x: 400, y: 300 }, 3);
  near(next.cx, view.cx);
  near(next.cy, view.cy);
});

test("zoomAbout clamps to 0.1..32 and still keeps the cursor point fixed", () => {
  const cursor = { x: 100, y: 500 };
  const big = zoomAbout(view, size, cursor, 1000);
  assert.equal(big.scale, MAX_ZOOM);
  const small = zoomAbout(view, size, cursor, 0.00001);
  assert.equal(small.scale, MIN_ZOOM);
  const before = screenToGlyph(view, size, cursor);
  const after = screenToGlyph(big, size, cursor);
  near(after.x, before.x, 1e-6);
  near(after.y, before.y, 1e-6);
});

test("the zoom range is 0.1 to 32", () => {
  assert.equal(MIN_ZOOM, 0.1);
  assert.equal(MAX_ZOOM, 32);
  assert.equal(clampZoom(0), 0.1);
  assert.equal(clampZoom(99), 32);
  assert.equal(clampZoom(2), 2);
  assert.equal(clampZoom(Number.NaN), 1);
});

test("panBy moves the glyph by the drag in screen pixels", () => {
  const start = { x: 400, y: 300 };
  const g = screenToGlyph(view, size, start);
  const next = panBy(view, 50, -20);
  const moved = glyphToScreen(next, size, g);
  near(moved.x, 450, 1e-6);
  near(moved.y, 280, 1e-6);
});

test("panBy is independent of zoom in screen terms", () => {
  const v = { ...view, scale: 4 };
  const g = screenToGlyph(v, size, { x: 400, y: 300 });
  const moved = glyphToScreen(panBy(v, 30, 10), size, g);
  near(moved.x, 430, 1e-6);
  near(moved.y, 310, 1e-6);
});

test("zoomToRect fits a dragged screen rectangle to the view", () => {
  const rect = { x1: 200, y1: 150, x2: 300, y2: 225 };
  const next = zoomToRect(view, size, rect);
  near(next.scale, 8, 1e-9);
  const centreGlyph = screenToGlyph(view, size, { x: 250, y: 187.5 });
  near(next.cx, centreGlyph.x, 1e-6);
  near(next.cy, centreGlyph.y, 1e-6);
});

test("zoomToRect uses the tighter axis so the whole rectangle stays visible", () => {
  const tall = { x1: 390, y1: 100, x2: 410, y2: 500 };
  const next = zoomToRect(view, size, tall);
  near(next.scale, 600 / 400, 1e-9);
});

test("zoomToRect ignores a click-sized rectangle", () => {
  assert.deepEqual(zoomToRect(view, size, { x1: 10, y1: 10, x2: 12, y2: 11 }), view);
});

test("zoomToRect is clamped at the maximum", () => {
  const next = zoomToRect(view, size, { x1: 100, y1: 100, x2: 104, y2: 104 });
  assert.equal(next.scale, MAX_ZOOM);
});

test("fitBox fits a font-unit box with a margin and centres it", () => {
  const v = fitBox(size, { minX: 0, minY: 0, maxX: 400, maxY: 800 }, 0.1);
  near(v.cx, 200);
  near(v.cy, 400);
  near(v.scale, (600 * 0.8) / 800, 1e-9);
});

test("fitBox on a degenerate box falls back to a sane scale", () => {
  const v = fitBox(size, { minX: 5, minY: 5, maxX: 5, maxY: 5 }, 0.1);
  assert.ok(Number.isFinite(v.scale) && v.scale >= MIN_ZOOM && v.scale <= MAX_ZOOM);
  near(v.cx, 5);
});

test("fitView shows the descender to the ascender and the advance with room", () => {
  const v = fitView(size, { ascender: 800, descender: -200, advance: 600 });
  const top = glyphToScreen(v, size, { x: 300, y: 800 });
  const bottom = glyphToScreen(v, size, { x: 300, y: -200 });
  assert.ok(top.y >= 0 && bottom.y <= size.height, `${top.y} ${bottom.y}`);
  const left = glyphToScreen(v, size, { x: 0, y: 0 });
  const right = glyphToScreen(v, size, { x: 600, y: 0 });
  assert.ok(left.x >= 0 && right.x <= size.width);
});

test("viewBoxOf describes exactly the visible glyph area, y flipped for SVG", () => {
  const box = viewBoxOf(view, size);
  near(box.width, 800);
  near(box.height, 600);
  near(box.x, 100);
  near(box.y, -600);
  const zoomed = viewBoxOf({ ...view, scale: 2 }, size);
  near(zoomed.width, 400);
  near(zoomed.x, 300);
});

import { measuredSize, sameSize } from "./writingViewport.ts";

test("measuredSize rounds to whole pixels and removes the border, never below 1", () => {
  assert.deepEqual(measuredSize({ width: 445.4, height: 1140.6 }, 2), { width: 443, height: 1139 });
  assert.deepEqual(measuredSize({ width: 1, height: 0 }, 2), { width: 1, height: 1 });
  assert.deepEqual(measuredSize({ width: 800, height: 600 }, 0), { width: 800, height: 600 });
});

test("sameSize ignores changes under one pixel", () => {
  assert.equal(sameSize({ width: 800, height: 600 }, { width: 800, height: 600 }), true);
  assert.equal(sameSize({ width: 800, height: 600 }, { width: 800.4, height: 599.7 }), true);
  assert.equal(sameSize({ width: 800, height: 600 }, { width: 801, height: 600 }), false);
  assert.equal(sameSize({ width: 800, height: 600 }, { width: 800, height: 602 }), false);
});
