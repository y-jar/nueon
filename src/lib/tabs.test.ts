import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldPruneGroup } from "./tabs.ts";

test("an emptied pane is pruned when other panes remain", () => {
  assert.equal(shouldPruneGroup(0, 2), true);
  assert.equal(shouldPruneGroup(0, 5), true);
});

test("the last pane is kept even when empty", () => {
  assert.equal(shouldPruneGroup(0, 1), false);
});

test("a pane with tabs is never pruned", () => {
  assert.equal(shouldPruneGroup(1, 2), false);
  assert.equal(shouldPruneGroup(3, 4), false);
});
