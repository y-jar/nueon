import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canMoveInto,
  fromSplitLayout,
  nextActiveIndex,
  toSplitLayout,
  type SplitNode,
} from "./tiling.ts";

test("nextActiveIndex picks the tab that took the slot, else the previous one", () => {
  assert.equal(nextActiveIndex(3, 0), 0);
  assert.equal(nextActiveIndex(3, 1), 1);
  assert.equal(nextActiveIndex(3, 2), 2);
  // Closing the last tab activates the new last one.
  assert.equal(nextActiveIndex(3, 3), 2);
  // Empty group has nothing to activate.
  assert.equal(nextActiveIndex(0, 0), null);
});

test("a split tree round-trips through serialization", () => {
  const tree: SplitNode = {
    type: "split",
    direction: "row",
    sizes: [2, 1],
    children: [
      { type: "leaf", groupId: "g1" },
      {
        type: "split",
        direction: "column",
        sizes: [1, 2],
        children: [
          { type: "leaf", groupId: "g2" },
          { type: "leaf", groupId: "g3" },
        ],
      },
    ],
  };
  const ids = new Map([
    ["g1", "g1"],
    ["g2", "g2"],
    ["g3", "g3"],
  ]);
  assert.deepEqual(fromSplitLayout(toSplitLayout(tree), ids), tree);
});

test("fromSplitLayout drops unknown leaves and collapses single-child splits", () => {
  const layout = toSplitLayout({
    type: "split",
    direction: "row",
    children: [
      { type: "leaf", groupId: "g1" },
      { type: "leaf", groupId: "gone" },
    ],
  });
  const ids = new Map([["g1", "g1"]]);
  // Only g1 survives, so the split collapses to a single leaf.
  assert.deepEqual(fromSplitLayout(layout, ids), { type: "leaf", groupId: "g1" });

  const missing = new Map<string, string>();
  assert.equal(fromSplitLayout(layout, missing), null);
});

test("canMoveInto rejects self, descendants and the current parent", () => {
  assert.equal(canMoveInto("a/b", "a"), false); // already there
  assert.equal(canMoveInto("a/b", "a/b"), false); // into itself
  assert.equal(canMoveInto("a/b", "a/b/c"), false); // into a descendant
  assert.equal(canMoveInto("a/b", "x"), true);
  assert.equal(canMoveInto("a/b", ""), true);
  assert.equal(canMoveInto("top", ""), false); // top's parent is the root
});
