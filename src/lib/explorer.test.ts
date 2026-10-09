import { test } from "node:test";
import assert from "node:assert/strict";

import { fileCategory, isAssetPath, isNotePath } from "./explorer.ts";

test("markdown, text and extensionless files open in the editor", () => {
  assert.ok(isNotePath("note.md"));
  assert.ok(isNotePath("lore/note.markdown"));
  assert.ok(isNotePath("old.txt"));
  assert.ok(isNotePath("legacy"));
  assert.ok(isNotePath("v1.2 notes"));
});

test("other files and dotfiles open in the viewer", () => {
  assert.ok(!isNotePath("photo.png"));
  assert.ok(!isNotePath(".DS_Store"));
  assert.ok(!isNotePath("docs/report.pdf"));
});

test("paths under assets/ are files, even when markdown", () => {
  assert.ok(isAssetPath("assets/old.md"));
  assert.ok(isAssetPath("assets/pic.png"));
  assert.ok(!isAssetPath("lore/old.md"));
});

test("files are categorized by extension", () => {
  assert.equal(fileCategory("a.PNG"), "image");
  assert.equal(fileCategory("a.csv"), "text");
  assert.equal(fileCategory("a.mp3"), "audio");
  assert.equal(fileCategory("a.mp4"), "video");
  assert.equal(fileCategory("a.zip"), "archive");
  assert.equal(fileCategory("a.pdf"), "document");
  assert.equal(fileCategory("noext"), "other");
});
