import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMarkdownKeymap } from "./editor/commands.ts";
import { tableKeymap } from "./editor/tableEditing.ts";
import { KEYBIND_GROUPS, formatKeys } from "./keybindings.ts";

function group(titleKey: string) {
  const found = KEYBIND_GROUPS.find((entry) => entry.titleKey === titleKey);
  assert.ok(found, `missing group ${titleKey}`);
  return found;
}

test("formats CodeMirror key notation for display", () => {
  assert.equal(formatKeys("Mod-Shift-l"), "Ctrl+Shift+L");
  assert.equal(formatKeys("Mod-b"), "Ctrl+B");
  assert.equal(formatKeys("Shift-Tab"), "Shift+Tab");
  assert.equal(formatKeys("Enter"), "Enter");
});

test("the markdown group lists exactly the markdown keymap", () => {
  const real = buildMarkdownKeymap({ onImage() {} })
    .map((binding) => binding.key)
    .sort();
  const listed = group("keybinds.groupMarkdown")
    .bindings.map((binding) => binding.keys)
    .sort();
  assert.deepEqual(listed, real);
});

test("the tables group lists exactly the table keymap", () => {
  const real = tableKeymap.map((binding) => binding.key).sort();
  const listed = group("keybinds.groupTables")
    .bindings.map((binding) => binding.keys)
    .sort();
  assert.deepEqual(listed, real);
});
