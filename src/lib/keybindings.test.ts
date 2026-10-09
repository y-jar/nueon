import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMarkdownKeymap } from "./editor/commands.ts";
import { buildTableKeymap } from "./editor/tableEditing.ts";
import {
  MARKDOWN_KEYBINDS,
  TABLE_KEYBINDS,
  conflictingId,
  defaultKeybinds,
  formatKeys,
  isReserved,
  resolveKeybinds,
} from "./keybindings.ts";

test("formats CodeMirror key notation for display", () => {
  assert.equal(formatKeys("Mod-Shift-l"), "Ctrl+Shift+L");
  assert.equal(formatKeys("Mod-b"), "Ctrl+B");
  assert.equal(formatKeys("Shift-Tab"), "Shift+Tab");
  assert.equal(formatKeys("Enter"), "Enter");
});

test("resolved defaults reproduce the markdown and table keymaps", () => {
  const resolved = resolveKeybinds({});
  assert.deepEqual(resolved, defaultKeybinds());

  const markdown = buildMarkdownKeymap(resolved, { onImage() {} })
    .map((binding) => binding.key)
    .sort();
  assert.deepEqual(
    markdown,
    MARKDOWN_KEYBINDS.map((def) => def.defaultKey).sort(),
  );

  const tables = buildTableKeymap(resolved)
    .map((binding) => binding.key)
    .sort();
  assert.deepEqual(
    tables,
    TABLE_KEYBINDS.map((def) => def.defaultKey).sort(),
  );
});

test("overrides replace and empty values unbind", () => {
  const resolved = resolveKeybinds({ bold: "Mod-Alt-b", italic: "" });
  assert.equal(resolved["bold"], "Mod-Alt-b");
  assert.equal(resolved["italic"], null);

  const markdown = buildMarkdownKeymap(resolved, { onImage() {} });
  assert.ok(markdown.some((binding) => binding.key === "Mod-Alt-b"));
  assert.ok(!markdown.some((binding) => binding.key === "Mod-b"));
  assert.ok(!markdown.some((binding) => binding.key === "Mod-i")); // unbound
});

test("reserved combos and conflicts are detected", () => {
  assert.ok(isReserved("Mod-c"));
  assert.ok(!isReserved("Mod-b"));
  const resolved = resolveKeybinds({});
  assert.equal(conflictingId("bold", "Mod-i", resolved), "italic");
  assert.equal(conflictingId("bold", "Mod-Alt-b", resolved), undefined);
});
