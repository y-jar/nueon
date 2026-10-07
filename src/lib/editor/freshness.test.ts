import { test } from "node:test";
import assert from "node:assert/strict";

import { beginRead, invalidateReads, isFreshest } from "./freshness.ts";

test("the newest read is the freshest", () => {
  const first = beginRead("a.md");
  const second = beginRead("a.md");
  assert.notEqual(first, second);
  assert.equal(isFreshest("a.md", second), true);
  assert.equal(isFreshest("a.md", first), false);
});

test("a local save invalidates a read started before it", () => {
  // The read starts (request in flight)...
  const pending = beginRead("a.md");
  // ...an autosave lands while the request is on the wire...
  invalidateReads("a.md");
  // ...and the stale response is dropped when it resolves.
  assert.equal(isFreshest("a.md", pending), false);
});

test("a read started after the save is unaffected", () => {
  invalidateReads("a.md");
  const after = beginRead("a.md");
  assert.equal(isFreshest("a.md", after), true);
});

test("generations are independent per path", () => {
  const a = beginRead("a.md");
  beginRead("b.md");
  assert.equal(isFreshest("a.md", a), true);
});
