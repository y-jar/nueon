import { test } from "node:test";
import assert from "node:assert/strict";

import { MENU_ORDER, menuItems, neighbourGlyph, parseGuide, type MenuState } from "./writingMenus.ts";

const state: MenuState = {
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  hasComponent: false,
  hasElements: false,
  allHandles: false,
  snap: false,
  guides: true,
  back: true,
  fore: false,
  hasGlyph: true,
};

test("every menu except metrics has items with unique ids", () => {
  for (const menu of MENU_ORDER) {
    const items = menuItems(menu, state);
    if (menu === "metrics") {
      assert.equal(items.length, 0);
      continue;
    }
    assert.ok(items.length > 0, menu);
    const ids = items.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, `${menu} ids are unique`);
  }
});

test("undo and redo follow the history flags", () => {
  const edit = (s: MenuState) => menuItems("edit", s);
  assert.equal(edit(state).find((i) => i.id === "undo")!.disabled, true);
  assert.equal(edit({ ...state, canUndo: true }).find((i) => i.id === "undo")!.disabled, false);
  assert.equal(edit({ ...state, canRedo: true }).find((i) => i.id === "redo")!.disabled, false);
});

test("view toggles show their state and only ttf font export is enabled", () => {
  const view = menuItems("view", { ...state, snap: true });
  assert.ok(view.find((i) => i.id === "toggle-snap")!.label.startsWith("\u2713"));
  assert.ok(view.find((i) => i.id === "toggle-guides")!.label.startsWith("\u2713"));
  assert.ok(view.find((i) => i.id === "toggle-back")!.label.startsWith("\u2713"), "back shown");
  assert.ok(!view.find((i) => i.id === "toggle-fore")!.label.startsWith("\u2713"), "fore hidden");
  assert.ok(!view.find((i) => i.id === "toggle-snap")!.label.startsWith("Snap"));
  const exp = menuItems("export", state);
  assert.equal(exp.find((i) => i.id === "export-ttf")!.disabled, undefined, "ttf export is live");
  assert.equal(exp.find((i) => i.id === "export-otf")!.disabled, true, "otf stays disabled");
  assert.equal(exp.find((i) => i.id === "export-svg")!.disabled, false);
});

test("the tools menu lists every tool, matching the registry", async () => {
  const { TOOLS } = await import("./writing.ts");
  const ids = menuItems("tools", state).map((i) => i.id);
  for (const tool of TOOLS.map((t) => t.id)) {
    assert.ok(ids.includes(`tool-${tool}`), tool);
  }
});

test("neighbourGlyph wraps around both ways", () => {
  const ids = ["a", "b", "c"];
  assert.equal(neighbourGlyph(ids, "a", 1), "b");
  assert.equal(neighbourGlyph(ids, "c", 1), "a");
  assert.equal(neighbourGlyph(ids, "a", -1), "c");
  assert.equal(neighbourGlyph(ids, null, 1), "a");
  assert.equal(neighbourGlyph([], "a", 1), null);
});

test("parseGuide rejects blank and non-numeric input", () => {
  assert.equal(parseGuide("700"), 700);
  assert.equal(parseGuide("-200"), -200);
  assert.equal(parseGuide(""), null);
  assert.equal(parseGuide("abc"), null);
});

test("expand component is offered only when a component instance is selected", () => {
  const find = (s: MenuState) =>
    menuItems("tools", s).find((item) => item.id === "component-expand");
  assert.equal(find(state)?.disabled, true);
  assert.equal(find({ ...state, hasComponent: true })?.disabled, false);
});

test("the tools menu shortcuts equal the registry shortcuts", async () => {
  const { TOOL_SHORTCUTS } = await import("./writing.ts");
  const items = menuItems("tools", state);
  for (const [tool, key] of Object.entries(TOOL_SHORTCUTS)) {
    assert.equal(items.find((i) => i.id === `tool-${tool}`)?.shortcut, key, tool);
  }
});

test("duplicate needs a selected shape and the view menu offers fit, 100% and handles", () => {
  const find = (menu: Parameters<typeof menuItems>[0], id: string, s = state) =>
    menuItems(menu, s).find((i) => i.id === id);
  assert.equal(find("edit", "duplicate")?.disabled, true);
  assert.equal(find("edit", "duplicate", { ...state, hasElements: true })?.disabled, false);
  assert.ok(find("view", "zoom-fit") && find("view", "zoom-actual") && find("view", "toggle-handles"));
});

test("Edit offers Transform and the Tools menu offers the three node types", () => {
  const edit = menuItems("edit", state).map((i) => i.id);
  assert.ok(edit.includes("transform"));
  const tools = menuItems("tools", state);
  for (const id of ["node-corner", "node-smooth", "node-symmetric"]) {
    assert.equal(tools.find((i) => i.id === id)?.disabled, true, `${id} needs a selected node`);
    assert.equal(menuItems("tools", { ...state, hasSelection: true }).find((i) => i.id === id)?.disabled, false);
  }
});
