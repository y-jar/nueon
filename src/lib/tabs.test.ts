import { test } from "node:test";
import assert from "node:assert/strict";

import {
  duplicateTabs,
  findTabGroup,
  isSingletonTab,
  shouldPruneGroup,
  tabMatches,
  type TabKey,
} from "./tabs.ts";

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

test("singleton tool tabs match by kind alone", () => {
  assert.equal(isSingletonTab("translation"), true);
  assert.equal(isSingletonTab("morphology"), true);
  assert.equal(isSingletonTab("phonology"), true);
  assert.equal(isSingletonTab("table"), false);
  assert.equal(
    tabMatches({ kind: "translation", ref: null }, { kind: "translation", ref: "x" }),
    true,
  );
});

test("non-singleton tabs match on kind and ref", () => {
  assert.equal(
    tabMatches({ kind: "table", ref: "lex" }, { kind: "table", ref: "lex" }),
    true,
  );
  assert.equal(
    tabMatches({ kind: "table", ref: "lex" }, { kind: "table", ref: "fixes" }),
    false,
  );
  assert.equal(
    tabMatches({ kind: "note", ref: "a.md" }, { kind: "table", ref: "a.md" }),
    false,
  );
});

test("findTabGroup returns the first group holding the revealed tab", () => {
  const groups = [
    { id: "g1", tabs: [{ kind: "note", ref: "a.md" }] },
    {
      id: "g2",
      tabs: [
        { kind: "table", ref: "lex" },
        { kind: "table", ref: "fixes" },
      ],
    },
  ];
  assert.equal(findTabGroup(groups, { kind: "table", ref: "fixes" }), "g2");
  assert.equal(findTabGroup(groups, { kind: "note", ref: "a.md" }), "g1");
  assert.equal(findTabGroup(groups, { kind: "table", ref: "gone" }), null);
});

test("duplicateTabs drops later repeats, keeping the first of each", () => {
  const groups = [
    {
      id: "g1",
      tabs: [
        { kind: "table", ref: "lex" },
        { kind: "translation", ref: null },
      ],
    },
    {
      id: "g2",
      tabs: [
        { kind: "table", ref: "lex" }, // duplicate of g1
        { kind: "table", ref: "fixes" },
        { kind: "translation", ref: null }, // duplicate singleton
      ],
    },
  ];
  assert.deepEqual(duplicateTabs(groups), [
    { groupId: "g2", index: 0 },
    { groupId: "g2", index: 2 },
  ]);
  // Distinct refs in the same group are all kept.
  const single: { id: string; tabs: TabKey[] }[] = [
    {
      id: "g1",
      tabs: [
        { kind: "table", ref: "lex" },
        { kind: "table", ref: "fixes" },
      ],
    },
  ];
  assert.deepEqual(duplicateTabs(single), []);
});
