import { test } from "node:test";
import assert from "node:assert/strict";

import { canExport, groupIssues, summarise } from "./fontReport.ts";
import type { FontIssue } from "./api.ts";

const issue = (glyph: string, severity: FontIssue["severity"], code: string): FontIssue => ({
  glyph,
  name: glyph,
  severity,
  code,
  message: `${glyph} ${code}`,
});

test("summarise counts each severity", () => {
  const counts = summarise([
    issue("a", "error", "x"),
    issue("a", "warning", "y"),
    issue("b", "warning", "y"),
    issue("b", "info", "z"),
  ]);
  assert.deepEqual(counts, { error: 1, warning: 2, info: 1 });
  assert.deepEqual(summarise([]), { error: 0, warning: 0, info: 0 });
});

test("only errors block the export", () => {
  assert.equal(canExport([]), true);
  assert.equal(canExport([issue("a", "warning", "y"), issue("a", "info", "z")]), true);
  assert.equal(canExport([issue("a", "error", "x")]), false);
});

test("groupIssues groups by glyph, worst first, then by name", () => {
  const groups = groupIssues([
    issue("b", "info", "z"),
    issue("c", "error", "x"),
    issue("a", "warning", "y"),
    issue("c", "info", "w"),
  ]);
  assert.deepEqual(groups.map((g) => g.glyph), ["c", "a", "b"]);
  assert.deepEqual(groups[0].issues.map((i) => i.severity), ["error", "info"]);
  assert.equal(groups[0].worst, "error");
});
