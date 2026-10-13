import { test } from "node:test";
import assert from "node:assert/strict";

import {
  groupGlyphs,
  soundCoverage,
  TOOLS,
  guideLines,
  outlineBounds,
  contourPathData,
  componentElement,
  compositeOutline,
  flipY,
  nextCodepoint,
  codepointConflicts,
  UNGROUPED,
} from "./writing.ts";
import type { GlyphMeta, GlyphOutline, WritingConfig } from "./api.ts";

function glyph(id: string, group: string, order: number): GlyphMeta {
  return {
    id,
    name: id,
    codepoint: 0xe000,
    phonemes: [],
    order,
    group,
  };
}

test("groupGlyphs buckets by group, defaulting empty to ungrouped", () => {
  const glyphs = [
    glyph("a", "consonants", 0),
    glyph("b", "", 0),
    glyph("c", "vowels", 1),
    glyph("d", "vowels", 0),
  ];
  const groups = groupGlyphs(glyphs);
  assert.deepEqual([...groups.keys()].sort(), ["consonants", UNGROUPED, "vowels"]);
  assert.deepEqual(
    groups.get("vowels")!.map((g) => g.id),
    ["d", "c"],
  );
  assert.deepEqual(
    groups.get(UNGROUPED)!.map((g) => g.id),
    ["b"],
  );
});

test("groupGlyphs sorts by order then name within a group", () => {
  const glyphs = [
    glyph("z", "g", 0),
    glyph("a", "g", 0),
    glyph("m", "g", 1),
  ];
  const groups = groupGlyphs(glyphs);
  assert.deepEqual(
    groups.get("g")!.map((g) => g.id),
    ["a", "z", "m"],
  );
});

test("soundCoverage counts phoneme ids with a glyph", () => {
  const glyphs = [
    { ...glyph("a", "g", 0), phonemes: ["p1"] },
    { ...glyph("b", "g", 1), phonemes: ["p2", "p3"] },
  ];
  const coverage = soundCoverage(glyphs, ["p1", "p2", "p3", "p4"]);
  assert.deepEqual(coverage, { total: 4, mapped: 3 });
});

test("soundCoverage is zero when no glyph maps a sound", () => {
  const coverage = soundCoverage([], ["p1", "p2"]);
  assert.deepEqual(coverage, { total: 2, mapped: 0 });
});

test("TOOLS lists the seven core tools with unique ids", () => {
  const ids = TOOLS.map((tool) => tool.id);
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(TOOLS.every((tool) => tool.label && tool.shortcut));
});

test("guideLines orders top to bottom with the right dashed flags", () => {
  const config = {
    x_height: 500,
    cap_height: 700,
    ascender: 800,
    descender: -200,
  } as WritingConfig;
  const lines = guideLines(config);
  assert.deepEqual(
    lines.map((line) => line.key),
    ["ascender", "cap_height", "x_height", "baseline", "descender"],
  );
  assert.equal(lines[0].y, 800);
  assert.equal(lines[2].y, 500);
  assert.equal(lines[3].y, 0);
  assert.equal(lines[4].y, -200);
  assert.equal(lines[2].dashed, true);
  assert.equal(lines[3].dashed, true);
  assert.equal(lines[1].dashed, false);
});

test("outlineBounds spans contours and ignores components", () => {
  const outline: GlyphOutline = {
    elements: [
      {
        kind: "contour",
        nodes: [
          { x: 0, y: 0, kind: "corner" },
          { x: 10, y: 20, kind: "corner" },
        ],
        closed: false,
        fill_rule: "nonzero",
      },
      {
        kind: "component",
        glyph: "g",
        dx: 0,
        dy: 0,
        scale_x: 1,
        scale_y: 1,
        rotation: 0,
      },
    ],
  };
  assert.deepEqual(outlineBounds(outline), {
    min_x: 0,
    min_y: 0,
    max_x: 10,
    max_y: 20,
  });
  assert.equal(outlineBounds({ elements: [] }), null);
});

test("contourPathData starts with a move and flips y", () => {
  const d = contourPathData(
    {
      nodes: [
        { x: 0, y: 0, kind: "corner" },
        { x: 10, y: 20, kind: "corner" },
      ],
      closed: true,
      fill_rule: "nonzero",
    },
    true,
  );
  assert.ok(d.startsWith("M 0 0"), d);
  assert.ok(d.includes("L 10 -20"), d);
  assert.ok(d.endsWith(" Z"), d);
});

test("flipY negates", () => {
  assert.equal(flipY(5), -5);
  assert.equal(flipY(-200), 200);
});

test("componentElement builds a unit component reference", () => {
  assert.deepEqual(componentElement("g-1"), {
    kind: "component",
    glyph: "g-1",
    dx: 0,
    dy: 0,
    scale_x: 1,
    scale_y: 1,
    rotation: 0,
  });
});

test("compositeOutline references two radicals side by side", () => {
  const outline = compositeOutline("left", "right");
  assert.equal(outline.elements.length, 2);
  assert.deepEqual(outline.elements[0], componentElement("left"));
  assert.deepEqual(outline.elements[1], componentElement("right", 500));
});

test("nextCodepoint reuses the lowest free slot, so deleting never collides", () => {
  const at = (cp: number) => ({ ...glyph(`g${cp}`, "g", 0), codepoint: cp });
  assert.equal(nextCodepoint([]), 0xe000);
  assert.equal(nextCodepoint([at(0xe000), at(0xe001)]), 0xe002);
  assert.equal(nextCodepoint([at(0xe001), at(0xe002)]), 0xe000);
  const full = Array.from({ length: 0xf8ff - 0xe000 + 1 }, (_, i) => at(0xe000 + i));
  assert.equal(nextCodepoint(full), null);
});

test("codepointConflicts lists glyphs that share a codepoint", () => {
  const at = (name: string, cp: number) => ({ ...glyph(name, "g", 0), codepoint: cp });
  const conflicts = codepointConflicts([at("a", 1), at("b", 1), at("c", 2)]);
  assert.deepEqual([...conflicts.entries()], [[1, ["a", "b"]]]);
  assert.equal(codepointConflicts([at("a", 1), at("c", 2)]).size, 0);
});
