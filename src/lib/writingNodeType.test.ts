import { test } from "node:test";
import assert from "node:assert/strict";

import { commonKind, kindOfSelection, setKinds } from "./writingNodeType.ts";
import type { GlyphOutline } from "./api.ts";

const corner = (x: number, y: number, extra = {}) => ({ x, y, kind: "corner" as const, ...extra });
const tri: GlyphOutline = {
  elements: [
    { kind: "contour", closed: true, fill_rule: "nonzero", nodes: [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)] },
  ],
};

const node = (o: GlyphOutline, i: number) => {
  const el = o.elements[0];
  assert.ok(el.kind === "contour");
  return el.nodes[i];
};
const len = (h: [number, number]) => Math.hypot(h[0], h[1]);
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("smooth on a handle-less corner grows collinear handles along the neighbours' line", () => {
  const out = setKinds(tri, [{ element: 0, node: 1 }], "smooth");
  const n = node(out, 1);
  assert.equal(n.kind, "smooth");
  assert.ok(n.handle_in && n.handle_out);
  const [ix, iy] = n.handle_in!;
  const [ox, oy] = n.handle_out!;
  near(ix * oy - iy * ox, 0, 1e-6);
  assert.ok(ix * ox + iy * oy < 0, "the two handles point opposite ways");
  assert.ok(len(n.handle_in!) > 0 && len(n.handle_out!) > 0);
});

test("the grown handles follow the direction from the previous to the next node", () => {
  const out = setKinds(tri, [{ element: 0, node: 1 }], "smooth");
  const n = node(out, 1);
  const dir = [100 - 0, 100 - 0];
  const dl = Math.hypot(dir[0], dir[1]);
  near(n.handle_out![0] / len(n.handle_out!), dir[0] / dl, 1e-9);
  near(n.handle_out![1] / len(n.handle_out!), dir[1] / dl, 1e-9);
  near(n.handle_in![0] / len(n.handle_in!), -dir[0] / dl, 1e-9);
});

test("handle length is a third of the nearer neighbour, so it never crosses it", () => {
  const out = setKinds(tri, [{ element: 0, node: 1 }], "smooth");
  near(len(node(out, 1).handle_out!), 100 / 3, 1e-6);
  near(len(node(out, 1).handle_in!), 100 / 3, 1e-6);
});

test("symmetric gives two handles of equal length", () => {
  const out = setKinds(tri, [{ element: 0, node: 2 }], "symmetric");
  const n = node(out, 2);
  assert.equal(n.kind, "symmetric");
  near(len(n.handle_in!), len(n.handle_out!), 1e-9);
});

test("existing handles are kept: smooth keeps lengths and realigns, symmetric equalises", () => {
  const o: GlyphOutline = {
    elements: [
      {
        kind: "contour", closed: true, fill_rule: "nonzero",
        nodes: [corner(0, 0), corner(100, 0, { handle_in: [-30, 5], handle_out: [10, 40] }), corner(100, 100)],
      },
    ],
  };
  const smooth = node(setKinds(o, [{ element: 0, node: 1 }], "smooth"), 1);
  near(len(smooth.handle_in!), len([-30, 5]), 1e-9);
  near(len(smooth.handle_out!), len([10, 40]), 1e-9);
  near(smooth.handle_in![0] * smooth.handle_out![1] - smooth.handle_in![1] * smooth.handle_out![0], 0, 1e-6);
  const sym = node(setKinds(o, [{ element: 0, node: 1 }], "symmetric"), 1);
  near(len(sym.handle_in!), len(sym.handle_out!), 1e-9);
});

test("corner keeps the handles it has and does not grow new ones", () => {
  const smooth = setKinds(tri, [{ element: 0, node: 1 }], "smooth");
  const back = node(setKinds(smooth, [{ element: 0, node: 1 }], "corner"), 1);
  assert.equal(back.kind, "corner");
  assert.deepEqual(back.handle_out, node(smooth, 1).handle_out);
  const none = node(setKinds(tri, [{ element: 0, node: 0 }], "corner"), 0);
  assert.equal(none.handle_in ?? null, null);
  assert.equal(none.handle_out ?? null, null);
});

test("an open contour's end node gets one handle, toward its only neighbour's line", () => {
  const open: GlyphOutline = {
    elements: [{ kind: "contour", closed: false, fill_rule: "nonzero", nodes: [corner(0, 0), corner(90, 0), corner(90, 90)] }],
  };
  const end = node(setKinds(open, [{ element: 0, node: 0 }], "smooth"), 0);
  assert.equal(end.kind, "smooth");
  assert.ok(end.handle_out, "an open end grows a handle toward the next node");
  assert.equal(end.handle_in ?? null, null, "there is nothing behind it");
  near(end.handle_out![1], 0, 1e-9);
  assert.ok(end.handle_out![0] > 0);
});

test("a contour with a single node cannot grow handles and just changes kind", () => {
  const one: GlyphOutline = { elements: [{ kind: "contour", closed: false, fill_rule: "nonzero", nodes: [corner(5, 5)] }] };
  const out = setKinds(one, [{ element: 0, node: 0 }], "smooth");
  assert.equal(node(out, 0).kind, "smooth");
  assert.equal(node(out, 0).handle_out ?? null, null);
});

test("setKinds changes every listed node, ignores stale refs, and leaves the input alone", () => {
  const out = setKinds(tri, [{ element: 0, node: 0 }, { element: 0, node: 2 }, { element: 9, node: 0 }, { element: 0, node: 99 }], "symmetric");
  assert.equal(node(out, 0).kind, "symmetric");
  assert.equal(node(out, 2).kind, "symmetric");
  assert.equal(node(out, 1).kind, "corner");
  assert.equal(node(tri, 0).kind, "corner");
});

test("kindOfSelection reports the shared kind or null when mixed or empty", () => {
  const mixed = setKinds(tri, [{ element: 0, node: 0 }], "smooth");
  assert.equal(kindOfSelection(mixed, [{ element: 0, node: 1 }, { element: 0, node: 2 }]), "corner");
  assert.equal(kindOfSelection(mixed, [{ element: 0, node: 0 }, { element: 0, node: 1 }]), null);
  assert.equal(kindOfSelection(mixed, []), null);
  assert.equal(kindOfSelection(mixed, [{ element: 7, node: 0 }]), null);
});

test("commonKind of a list", () => {
  assert.equal(commonKind(["smooth", "smooth"]), "smooth");
  assert.equal(commonKind(["smooth", "corner"]), null);
  assert.equal(commonKind([]), null);
});

test("with unequal neighbours the handle is a third of the nearer one", () => {
  const o: GlyphOutline = {
    elements: [{ kind: "contour", closed: false, fill_rule: "nonzero", nodes: [corner(0, 0), corner(30, 0), corner(300, 0)] }],
  };
  const n = node(setKinds(o, [{ element: 0, node: 1 }], "smooth"), 1);
  near(len(n.handle_out!), 30 / 3, 1e-9);
  near(len(n.handle_in!), 30 / 3, 1e-9);
});
