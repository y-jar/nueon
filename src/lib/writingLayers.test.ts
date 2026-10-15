import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LAYERS,
  MIN_IMAGE_WIDTH,
  backImageRect,
  backRectCorners,
  editsBlocked,
  oppositeCorner,
  rectContains,
  scaleByCorner,
  toggleLayer,
} from "./writingLayers.ts";

test("toggleLayer flips only the named layer", () => {
  const next = toggleLayer(DEFAULT_LAYERS, "back");
  assert.deepEqual(next, { guide: true, back: false, fore: true });
  assert.deepEqual(DEFAULT_LAYERS, { guide: true, back: true, fore: true });
  assert.deepEqual(toggleLayer(toggleLayer(DEFAULT_LAYERS, "guide"), "guide"), DEFAULT_LAYERS);
});

test("editsBlocked only allows the view tools while fore is hidden", () => {
  const hidden = { ...DEFAULT_LAYERS, fore: false };
  assert.equal(editsBlocked(hidden, "pen"), true);
  assert.equal(editsBlocked(hidden, "select"), true);
  assert.equal(editsBlocked(hidden, "eraser"), true);
  assert.equal(editsBlocked(hidden, "hand"), false);
  assert.equal(editsBlocked(hidden, "zoom"), false);
  assert.equal(editsBlocked(DEFAULT_LAYERS, "pen"), false);
});

test("backImageRect centres the image and follows the aspect ratio", () => {
  const rect = backImageRect({ x: 500, y: 300, width: 1000 }, 2);
  assert.deepEqual(rect, { x: 0, y: 50, w: 1000, h: 500 });
  const tall = backImageRect({ x: 100, y: 100, width: 60 }, 0.5);
  assert.deepEqual(tall, { x: 70, y: 40, w: 60, h: 120 });
  assert.equal(backImageRect({ x: 0, y: 0, width: 0 }, 1), null, "zero width");
  assert.equal(backImageRect({ x: 0, y: 0, width: -10 }, 1), null, "negative width");
  assert.equal(backImageRect({ x: 0, y: 0, width: 100 }, 0), null, "zero aspect");
  assert.equal(backImageRect({ x: 0, y: 0, width: 100 }, Number.NaN), null, "NaN aspect");
});

test("backRectCorners is clockwise from top-left and rectContains matches it", () => {
  const rect = backImageRect({ x: 500, y: 300, width: 1000 }, 1)!;
  assert.deepEqual(backRectCorners(rect), {
    nw: { x: 0, y: 800 },
    ne: { x: 1000, y: 800 },
    se: { x: 1000, y: -200 },
    sw: { x: 0, y: -200 },
  });
  assert.equal(rectContains(rect, { x: 500, y: 300 }), true, "centre inside");
  assert.equal(rectContains(rect, { x: 0, y: -200 }), true, "corner on the edge");
  assert.equal(rectContains(rect, { x: 1000.1, y: 300 }), false);
  assert.equal(rectContains(rect, { x: 500, y: 800.1 }), false);
});

test("oppositeCorner pairs the diagonals", () => {
  assert.equal(oppositeCorner("nw"), "se");
  assert.equal(oppositeCorner("se"), "nw");
  assert.equal(oppositeCorner("ne"), "sw");
  assert.equal(oppositeCorner("sw"), "ne");
});

test("scaleByCorner anchors the opposite corner and keeps the aspect ratio", () => {
  const image = { x: 500, y: 300, width: 1000 };
  const grown = scaleByCorner(image, "se", { x: 2000, y: -1200 }, 1);
  assert.deepEqual(grown, { x: 1000, y: -200, width: 2000 });
  const rect = backImageRect(grown, 1)!;
  const corners = backRectCorners(rect);
  assert.deepEqual(corners.nw, { x: 0, y: 800 }, "the anchored nw corner stays put");

  const wide = scaleByCorner(image, "ne", { x: 1500, y: 300 }, 2);
  const wideRect = backImageRect(wide, 2)!;
  assert.equal(wideRect.h, wideRect.w / 2, "aspect kept while dragging on one axis");
  assert.deepEqual(backRectCorners(wideRect).sw, { x: 0, y: 50 }, "sw stays anchored");
});

test("scaleByCorner clamps at the minimum width", () => {
  const image = { x: 500, y: 300, width: 1000 };
  const shrunk = scaleByCorner(image, "se", { x: 1, y: 799 }, 1);
  assert.equal(shrunk.width, MIN_IMAGE_WIDTH);
  assert.deepEqual(backRectCorners(backImageRect(shrunk, 1)!).nw, { x: 0, y: 800 });
  assert.ok(shrunk.width >= MIN_IMAGE_WIDTH);
});
