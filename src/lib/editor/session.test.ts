import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldApplySave } from "./session.ts";

test("a callback for the shown note is applied", () => {
  assert.equal(shouldApplySave("notes/a.md", "notes/a.md"), true);
});

test("a callback for another note is ignored", () => {
  assert.equal(shouldApplySave("notes/b.md", "notes/a.md"), false);
});

test("a callback after a rename is ignored for the old path", () => {
  assert.equal(shouldApplySave("notes/new.md", "notes/old.md"), false);
});

test("a callback after a rename is applied for the new path", () => {
  assert.equal(shouldApplySave("notes/new.md", "notes/new.md"), true);
});

test("no selected note ignores every callback", () => {
  assert.equal(shouldApplySave(null, "notes/a.md"), false);
});
