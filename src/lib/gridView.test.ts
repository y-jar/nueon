import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeView } from "./gridView.ts";

test("a save fired before columns load does not prune real ids or widths", () => {
  const out = normalizeView({
    // A seeded view: "morph" is a real column, "ghost" a stale one.
    columnOrder: ["wordname", "morph", "ghost"],
    columnSizing: { morph: 200, ghost: 99 },
    // The table's columns have not loaded yet, so nothing is known.
    knownIds: [],
    columnsLoaded: false,
  });
  assert.ok(out.order.includes("morph"), `real id kept, got ${out.order}`);
  assert.equal(out.widths["morph"], 200, "real width kept");
});

test("once loaded, stale ids are pruned and new columns appended last", () => {
  const out = normalizeView({
    columnOrder: ["wordname", "morph", "ghost"],
    columnSizing: { morph: 200, ghost: 99 },
    knownIds: ["morph", "def"],
    columnsLoaded: true,
  });
  assert.deepEqual(out.order, ["wordname", "morph", "def"]);
  assert.deepEqual(out.widths, { morph: 200 });
});

test("wordname is always first and never stored elsewhere", () => {
  const out = normalizeView({
    columnOrder: ["morph", "wordname", "def"],
    columnSizing: {},
    knownIds: ["morph", "def"],
    columnsLoaded: true,
  });
  assert.equal(out.order[0], "wordname");
  assert.equal(out.order.filter((id) => id === "wordname").length, 1);
});
