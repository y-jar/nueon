import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clampPosition,
  dropPosition,
  movePosition,
  recallPosition,
  rememberPosition,
} from "./positions.ts";

test("a remembered position is recalled for the same path", () => {
  rememberPosition("a.md", { anchor: 12, head: 8, top: 30 });
  assert.deepEqual(recallPosition("a.md"), { anchor: 12, head: 8, top: 30 });
});

test("an unknown path recalls nothing", () => {
  assert.equal(recallPosition("never-seen.md"), undefined);
});

test("recalling does not consume the position", () => {
  rememberPosition("a.md", { anchor: 1, head: 1, top: 0 });
  recallPosition("a.md");
  assert.deepEqual(recallPosition("a.md"), { anchor: 1, head: 1, top: 0 });
});

test("a rename moves the position to the new path", () => {
  rememberPosition("old.md", { anchor: 5, head: 5, top: 5 });
  movePosition("old.md", "new.md");
  assert.deepEqual(recallPosition("new.md"), { anchor: 5, head: 5, top: 5 });
});

test("a folder rename moves every descendant", () => {
  rememberPosition("dir/a.md", { anchor: 1, head: 1, top: 0 });
  rememberPosition("dir/sub/b.md", { anchor: 2, head: 2, top: 0 });
  rememberPosition("other.md", { anchor: 3, head: 3, top: 0 });
  movePosition("dir", "renamed");
  assert.deepEqual(recallPosition("renamed/a.md"), {
    anchor: 1,
    head: 1,
    top: 0,
  });
  assert.deepEqual(recallPosition("renamed/sub/b.md"), {
    anchor: 2,
    head: 2,
    top: 0,
  });
  assert.deepEqual(recallPosition("other.md"), { anchor: 3, head: 3, top: 0 });
});

test("deleting drops the note and everything under it", () => {
  rememberPosition("gone.md", { anchor: 1, head: 1, top: 0 });
  rememberPosition("gone", { anchor: 4, head: 4, top: 0 });
  rememberPosition("gone/x.md", { anchor: 2, head: 2, top: 0 });
  rememberPosition("stays.md", { anchor: 3, head: 3, top: 0 });
  dropPosition("gone.md");
  assert.equal(recallPosition("gone.md"), undefined);
  assert.ok(recallPosition("gone/x.md"), "a note delete spares the folder");
  dropPosition("gone");
  assert.equal(recallPosition("gone"), undefined);
  assert.equal(recallPosition("gone/x.md"), undefined);
  assert.ok(recallPosition("stays.md"));
});

test("clamping keeps every offset inside the document", () => {
  assert.deepEqual(
    clampPosition({ anchor: 100, head: 50, top: 300 }, 40),
    { anchor: 40, head: 40, top: 40 },
  );
  assert.deepEqual(clampPosition({ anchor: 1, head: 2, top: 3 }, 40), {
    anchor: 1,
    head: 2,
    top: 3,
  });
});
