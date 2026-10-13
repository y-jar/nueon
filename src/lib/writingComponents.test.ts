import { test } from "node:test";
import assert from "node:assert/strict";

import {
  componentIds,
  expandComponent,
  flattenElements,
  transformContour,
} from "./writingComponents.ts";
import { componentElement } from "./writing.ts";
import type { GlyphContour, GlyphOutline } from "./api.ts";

function square(x: number, y: number, size: number): GlyphContour {
  return {
    closed: true,
    fill_rule: "nonzero",
    nodes: [
      { x, y, kind: "corner" },
      { x: x + size, y, kind: "corner" },
      { x: x + size, y: y + size, kind: "corner" },
      { x, y: y + size, kind: "corner" },
    ],
  };
}

function outlineOf(...contours: GlyphContour[]): GlyphOutline {
  return { elements: contours.map((c) => ({ kind: "contour" as const, ...c })) };
}

test("transformContour translates, scales then rotates like the backend", () => {
  const moved = transformContour(square(0, 0, 10), { ...componentElement("a", 100, 50) });
  assert.deepEqual(moved.nodes.map((n) => [n.x, n.y]), [[100, 50], [110, 50], [110, 60], [100, 60]]);

  const scaled = transformContour(square(0, 0, 10), { ...componentElement("a"), scale_x: 2, scale_y: 3 });
  assert.deepEqual(scaled.nodes[2], { x: 20, y: 30, kind: "corner", handle_in: undefined, handle_out: undefined });

  const turned = transformContour(square(0, 0, 10), { ...componentElement("a"), rotation: Math.PI / 2 });
  assert.ok(Math.abs(turned.nodes[1].x) < 1e-9 && Math.abs(turned.nodes[1].y - 10) < 1e-9);
});

test("transformContour transforms handles without translating them", () => {
  const contour: GlyphContour = {
    closed: false,
    fill_rule: "nonzero",
    nodes: [{ x: 0, y: 0, kind: "smooth", handle_out: [10, 0] }],
  };
  const out = transformContour(contour, { ...componentElement("a", 100, 100), scale_x: 2 });
  assert.deepEqual(out.nodes[0].handle_out, [20, 0]);
  assert.equal(out.nodes[0].x, 100);
});

test("flattenElements resolves nested components and skips plain contours", () => {
  const library: Record<string, GlyphOutline> = {
    inner: outlineOf(square(0, 0, 10)),
    outer: { elements: [componentElement("inner", 5, 0)] },
  };
  const target: GlyphOutline = {
    elements: [
      { kind: "contour", ...square(0, 0, 1) },
      componentElement("outer", 100, 0),
    ],
  };
  const flat = flattenElements(target, (id) => library[id] ?? null);
  assert.equal(flat.length, 1);
  assert.equal(flat[0].element, 1);
  assert.equal(flat[0].contours[0].nodes[0].x, 105);
});

test("flattenElements survives a cycle and a missing glyph", () => {
  const library: Record<string, GlyphOutline> = {
    a: { elements: [componentElement("b")] },
    b: { elements: [componentElement("a")] },
  };
  const target: GlyphOutline = { elements: [componentElement("a"), componentElement("gone")] };
  const flat = flattenElements(target, (id) => library[id] ?? null);
  assert.deepEqual(flat.map((f) => f.contours.length), [0, 0]);
});

test("componentIds lists every referenced glyph once, transitively", () => {
  const library: Record<string, GlyphOutline> = {
    a: { elements: [componentElement("b"), componentElement("b", 1)] },
    b: outlineOf(square(0, 0, 1)),
  };
  const target: GlyphOutline = { elements: [componentElement("a"), componentElement("b")] };
  assert.deepEqual(componentIds(target, (id) => library[id] ?? null).sort(), ["a", "b"]);
});

test("expandComponent swaps one instance for editable contours in place", () => {
  const library: Record<string, GlyphOutline> = {
    stem: outlineOf(square(0, 0, 10), square(20, 0, 10)),
  };
  const target: GlyphOutline = {
    elements: [
      { kind: "contour", ...square(0, 0, 1) },
      componentElement("stem", 100, 0),
      componentElement("stem", 0, 200),
    ],
    advance: 700,
  };
  const out = expandComponent(target, 1, (id) => library[id] ?? null);
  assert.ok(out);
  assert.deepEqual(out.elements.map((e) => e.kind), ["contour", "contour", "contour", "component"]);
  assert.equal(out.advance, 700);
  const second = out.elements[2];
  assert.equal(second.kind === "contour" && second.nodes[0].x, 120);
  assert.equal(expandComponent(target, 0, (id) => library[id] ?? null), null);
  assert.equal(expandComponent(target, 9, (id) => library[id] ?? null), null);
});
