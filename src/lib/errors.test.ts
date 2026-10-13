import { test } from "node:test";
import assert from "node:assert/strict";

import { isBenignError } from "./errors.ts";

test("the ResizeObserver loop notices are benign", () => {
  assert.equal(
    isBenignError("ResizeObserver loop completed with undelivered notifications."),
    true,
  );
  assert.equal(isBenignError("ResizeObserver loop limit exceeded"), true);
});

test("real errors are never filtered", () => {
  assert.equal(isBenignError("TypeError: x is undefined"), false);
  assert.equal(isBenignError("Error: ResizeObserver loop completed"), false);
  assert.equal(isBenignError(""), false);
});
