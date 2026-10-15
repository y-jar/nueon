import { test } from "node:test";
import assert from "node:assert/strict";

import { createSpacingLog } from "./spacingHistory.ts";
import type { GlyphOutline } from "./api.ts";

const o = (adv: number): GlyphOutline => ({ elements: [], advance: adv });

test("a change is recorded with the before and after of every glyph it touched", () => {
  const log = createSpacingLog();
  log.record("drag", { a: o(100) }, { a: o(120) });
  assert.equal(log.canUndo(), true);
  assert.equal(log.canRedo(), false);
});

test("undo returns the earlier outlines and redo the later ones, one change at a time", () => {
  const log = createSpacingLog();
  log.record("one", { a: o(1) }, { a: o(2) });
  log.record("two", { a: o(2), b: o(5) }, { a: o(3), b: o(6) });
  const u1 = log.undo()!;
  assert.deepEqual(u1.outlines, { a: o(2), b: o(5) });
  assert.equal(u1.label, "two");
  const u2 = log.undo()!;
  assert.deepEqual(u2.outlines, { a: o(1) });
  assert.equal(log.undo(), null);
  const r1 = log.redo()!;
  assert.deepEqual(r1.outlines, { a: o(2) });
  const r2 = log.redo()!;
  assert.deepEqual(r2.outlines, { a: o(3), b: o(6) });
  assert.equal(log.redo(), null);
});

test("a new change clears what could be redone", () => {
  const log = createSpacingLog();
  log.record("one", { a: o(1) }, { a: o(2) });
  log.undo();
  assert.equal(log.canRedo(), true);
  log.record("two", { a: o(1) }, { a: o(9) });
  assert.equal(log.canRedo(), false);
});

test("a change that did nothing is not recorded", () => {
  const log = createSpacingLog();
  log.record("noop", { a: o(1) }, { a: o(1) });
  assert.equal(log.canUndo(), false);
});

test("the log is bounded, dropping the oldest changes", () => {
  const log = createSpacingLog(3);
  for (let i = 0; i < 6; i++) log.record(`c${i}`, { a: o(i) }, { a: o(i + 1) });
  let count = 0;
  while (log.undo()) count += 1;
  assert.equal(count, 3);
});

test("clear forgets everything", () => {
  const log = createSpacingLog();
  log.record("one", { a: o(1) }, { a: o(2) });
  log.clear();
  assert.equal(log.canUndo(), false);
  assert.equal(log.canRedo(), false);
});

test("clear drops the redo side as well as the undo side", () => {
  const log = createSpacingLog();
  log.record("one", { a: o(1) }, { a: o(2) });
  log.undo();
  assert.equal(log.canRedo(), true);
  log.clear();
  assert.equal(log.canRedo(), false);
  assert.equal(log.redo(), null);
});
