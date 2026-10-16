import { test } from "node:test";
import assert from "node:assert/strict";

import { MAJOR_MIN_PX, RULER_PX, rulerTicks } from "./writingRulers.ts";

test("a zoomed-in ruler labels every fifth unit", () => {
  // 10 px per unit: a major needs >= 48 px = >= 4.8 units, so the ladder picks 5.
  const ticks = rulerTicks(0, 100, 10);
  const majors = ticks.filter((t) => t.label !== null);
  assert.deepEqual(
    majors.map((t) => t.label),
    ["0", "5", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55", "60", "65", "70", "75", "80", "85", "90", "95", "100"],
  );
  assert.ok(ticks.some((t) => t.label === null), "minors fill between majors");
  assert.equal(RULER_PX, 18, "the strip the ticks are drawn into");
});

test("a zoomed-out ruler walks the 1/2/5 ladder", () => {
  // 0.25 px per unit: a major needs >= 48 px = >= 192 units, so the step is 200.
  const ticks = rulerTicks(-400, 1400, 0.25);
  const majors = ticks.filter((t) => t.label !== null);
  assert.deepEqual(
    majors.map((t) => t.label),
    ["-400", "-200", "0", "200", "400", "600", "800", "1000", "1200", "1400"],
  );
  assert.ok(ticks.some((t) => t.label === null), "minors fill between majors");
});

test("a mid zoom picks the finest ladder step that clears the floor", () => {
  // 2.4 px per unit: majors at >= 20 units -> step 20, minors at 4 units.
  const mid = rulerTicks(0, 100, 2.4);
  assert.deepEqual(
    mid.filter((t) => t.label !== null).map((t) => t.label),
    ["0", "20", "40", "60", "80", "100"],
  );
  assert.ok(mid.some((t) => t.label === null), "minors fill between majors");
  // 1.4 px per unit: >= 34.3 units -> step 50.
  const coarse = rulerTicks(0, 200, 1.4);
  assert.deepEqual(
    coarse.filter((t) => t.label !== null).map((t) => t.label),
    ["0", "50", "100", "150", "200"],
  );
});

test("ticks follow the ruler's range, negative and fractional included", () => {
  const ticks = rulerTicks(-250, 250, 2);
  assert.deepEqual(
    ticks.filter((t) => t.label !== null).map((t) => t.label),
    ["-250", "-200", "-150", "-100", "-50", "0", "50", "100", "150", "200", "250"],
  );
  const fine = rulerTicks(0.4, 1.6, 400);
  assert.deepEqual(
    fine.filter((t) => t.label !== null).map((t) => t.label),
    ["0.4", "0.6", "0.8", "1.0", "1.2", "1.4", "1.6"],
  );
  assert.deepEqual(fine.filter((t) => t.label !== null).map((t) => t.at), [0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6]);
});

test("ticks never fall outside the ruler's range", () => {
  // A range that starts and ends mid-minor: nothing below 0.41 or above 1.59.
  const fine = rulerTicks(0.41, 1.59, 400);
  assert.ok(fine.length > 0, "some ticks");
  assert.ok(fine[0].at >= 0.41 - 1e-9, `the first tick is inside: ${fine[0].at}`);
  const last = fine[fine.length - 1];
  assert.ok(last.at <= 1.59 + 1e-9, `the last tick is inside: ${last.at}`);
  for (let i = 1; i < fine.length; i++) {
    assert.ok(fine[i].at > fine[i - 1].at, "ticks are ordered and never repeat");
  }
  // An integral range keeps its end ticks.
  const ends = rulerTicks(0, 100, 10);
  assert.equal(ends[ends.length - 1].at, 100, "the last tick is the ruler's end");
  assert.equal(ends[0].at, 0, "the first tick is the ruler's start");
});

test("a degenerate ruler has no ticks", () => {
  assert.deepEqual(rulerTicks(0, 0, 10), []);
  assert.deepEqual(rulerTicks(100, 0, 10), []);
  assert.deepEqual(rulerTicks(0, 100, 0), []);
  assert.deepEqual(rulerTicks(0, 100, Number.NaN), []);
});

test("majors always clear the pixel floor for any zoom", () => {
  for (const pxPerUnit of [0.05, 0.25, 1, 2.4, 10, 100]) {
    const ticks = rulerTicks(-1000, 1000, pxPerUnit);
    const majors = ticks.filter((t) => t.label !== null);
    assert.ok(majors.length >= 2, `some majors at ${pxPerUnit} px/unit`);
    for (let i = 1; i < majors.length; i++) {
      assert.ok(
        (majors[i].at - majors[i - 1].at) * pxPerUnit >= MAJOR_MIN_PX - 1e-6,
        `majors clear ${MAJOR_MIN_PX} px at ${pxPerUnit} px/unit`,
      );
    }
  }
});
