import { test } from "node:test";
import assert from "node:assert/strict";

import { canRedo, canUndo, emptyHistory, pushHistory, redoStep, undoStep } from "./history.ts";

test("undo and redo walk a value through the stack", () => {
  let history = emptyHistory<number>();
  assert.equal(canUndo(history), false);
  history = pushHistory(history, 1);
  history = pushHistory(history, 2);
  const back = undoStep(history, 3);
  assert.ok(back);
  assert.equal(back.value, 2);
  assert.equal(canRedo(back.history), true);
  const again = undoStep(back.history, back.value);
  assert.equal(again!.value, 1);
  const forward = redoStep(again!.history, again!.value);
  assert.equal(forward!.value, 2);
});

test("a new edit clears the redo branch", () => {
  let history = pushHistory(emptyHistory<number>(), 1);
  const back = undoStep(history, 2)!;
  assert.equal(canRedo(back.history), true);
  history = pushHistory(back.history, 5);
  assert.equal(canRedo(history), false);
});

test("the stack is bounded and empty stacks return null", () => {
  let history = emptyHistory<number>();
  for (let i = 0; i < 150; i++) history = pushHistory(history, i);
  assert.equal(history.past.length, 100);
  assert.equal(undoStep(emptyHistory<number>(), 0), null);
  assert.equal(redoStep(emptyHistory<number>(), 0), null);
});
