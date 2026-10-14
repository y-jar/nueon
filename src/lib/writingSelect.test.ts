import { test } from "node:test";
import assert from "node:assert/strict";

import {
  duplicateElements,
  elementsInBox,
  hitElement,
  nudgeElements,
  pruneSelection,
  selectAllElements,
  toggleElement,
  selectOnly,
  translateElements,
  elementPathBounds,
} from "./writingSelect.ts";
import type { GlyphOutline } from "./api.ts";

const corner = (x: number, y: number) => ({ x, y, kind: "corner" as const });
const rect = (x: number, y: number, w: number, h: number) => ({
  kind: "contour" as const,
  closed: true,
  fill_rule: "nonzero" as const,
  nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)],
});
const comp = (glyph: string, dx: number, dy: number) => ({
  kind: "component" as const,
  glyph,
  dx,
  dy,
  scale_x: 1,
  scale_y: 1,
  rotation: 0,
});

const outline: GlyphOutline = {
  elements: [rect(0, 0, 100, 100), rect(200, 0, 100, 100), rect(50, 50, 100, 100)],
};

test("selectOnly replaces and toggleElement adds and removes", () => {
  assert.deepEqual(selectOnly(1), [1]);
  assert.deepEqual(toggleElement([0], 2), [0, 2]);
  assert.deepEqual(toggleElement([0, 2], 0), [2]);
  assert.deepEqual(toggleElement([2, 0], 1), [0, 1, 2], "kept sorted");
});

test("selectAllElements lists every element, contours and components", () => {
  assert.deepEqual(selectAllElements({ elements: [rect(0, 0, 1, 1), comp("a", 0, 0)] }), [0, 1]);
  assert.deepEqual(selectAllElements({ elements: [] }), []);
});

test("hitElement picks the topmost contour whose fill contains the point", () => {
  assert.equal(hitElement(outline, 5, { x: 75, y: 75 }), 2, "the later shape is on top");
  assert.equal(hitElement(outline, 5, { x: 10, y: 10 }), 0);
  assert.equal(hitElement(outline, 5, { x: 250, y: 50 }), 1);
});

test("hitElement misses empty space and accepts a stroke-width tolerance at the edge", () => {
  assert.equal(hitElement(outline, 5, { x: 180, y: 50 }), null);
  assert.equal(hitElement(outline, 5, { x: 103, y: 20 }), 0, "just outside the edge, within tolerance");
  assert.equal(hitElement(outline, 5, { x: 110, y: 20 }), null, "beyond tolerance");
});

test("hitElement treats a hollow ring as hit on the ring and a miss in the hole", () => {
  const ring: GlyphOutline = {
    elements: [rect(0, 0, 100, 100), { ...rect(25, 25, 50, 50), nodes: [corner(25, 25), corner(25, 75), corner(75, 75), corner(75, 25)] }],
  };
  assert.equal(hitElement(ring, 2, { x: 10, y: 10 }), 0);
  assert.equal(hitElement(ring, 2, { x: 50, y: 50 }), null, "the hole is not part of the shape");
});

test("hitElement finds a component by its resolved box", () => {
  const withComp: GlyphOutline = { elements: [comp("a", 0, 0)] };
  const lookup = (id: string): GlyphOutline | null =>
    id === "a" ? { elements: [rect(10, 10, 40, 40)] } : null;
  assert.equal(hitElement(withComp, 3, { x: 30, y: 30 }, lookup), 0);
  assert.equal(hitElement(withComp, 3, { x: 90, y: 90 }, lookup), null);
});

test("elementsInBox selects only elements fully inside, in any drag direction", () => {
  assert.deepEqual(elementsInBox(outline, { x: -10, y: -10 }, { x: 160, y: 160 }), [0, 2]);
  assert.deepEqual(elementsInBox(outline, { x: 160, y: 160 }, { x: -10, y: -10 }), [0, 2]);
  assert.deepEqual(elementsInBox(outline, { x: -10, y: -10 }, { x: 120, y: 120 }), [0]);
  assert.deepEqual(elementsInBox(outline, { x: 500, y: 500 }, { x: 600, y: 600 }), []);
});

test("elementPathBounds is the box of an element's nodes", () => {
  const b = elementPathBounds(outline, 1);
  assert.deepEqual(b, { minX: 200, minY: 0, maxX: 300, maxY: 100 });
  assert.equal(elementPathBounds(outline, 9), null);
});

test("translateElements moves whole elements and nothing else", () => {
  const moved = translateElements(outline, [1], 10, -5);
  const el = moved.elements[1];
  assert.ok(el.kind === "contour");
  assert.equal(el.nodes[0].x, 210);
  assert.equal(el.nodes[0].y, -5);
  assert.deepEqual(moved.elements[0], outline.elements[0]);
  assert.equal(outline.elements[1].kind === "contour" && outline.elements[1].nodes[0].x, 200, "input unchanged");
});

test("translateElements moves a component by its offset", () => {
  const moved = translateElements({ elements: [comp("a", 5, 5)] }, [0], 10, 20);
  const el = moved.elements[0];
  assert.ok(el.kind === "component");
  assert.equal(el.dx, 15);
  assert.equal(el.dy, 25);
});

test("nudgeElements steps 1 unit, or 10 with shift", () => {
  const one = nudgeElements(outline, [0], 1, 0, false);
  assert.equal(one.elements[0].kind === "contour" && one.elements[0].nodes[0].x, 1);
  const ten = nudgeElements(outline, [0], 0, -1, true);
  assert.equal(ten.elements[0].kind === "contour" && ten.elements[0].nodes[0].y, -10);
});

test("duplicateElements appends offset copies and returns the new indexes", () => {
  const { outline: out, selection } = duplicateElements(outline, [0, 2], 10);
  assert.equal(out.elements.length, 5);
  assert.deepEqual(selection, [3, 4]);
  const copy = out.elements[3];
  assert.ok(copy.kind === "contour");
  assert.equal(copy.nodes[0].x, 10);
  assert.equal(copy.nodes[0].y, 10);
  assert.deepEqual(out.elements[0], outline.elements[0], "the original is untouched");
});

test("duplicateElements with nothing selected does nothing", () => {
  const { outline: out, selection } = duplicateElements(outline, [], 10);
  assert.equal(out, outline);
  assert.deepEqual(selection, []);
});

test("pruneSelection drops indexes that no longer exist", () => {
  assert.deepEqual(pruneSelection([0, 2, 5], 3), [0, 2]);
  assert.deepEqual(pruneSelection([], 3), []);
});

test("hitElement treats an open contour as filled, as the canvas and the font do", () => {
  const open: GlyphOutline = {
    elements: [{ ...rect(0, 0, 100, 100), closed: false }],
  };
  assert.equal(hitElement(open, 2, { x: 50, y: 50 }), 0, "inside the implied closing edge");
  assert.equal(hitElement(open, 2, { x: 150, y: 50 }), null);
});
