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
  guideHeight,
  DEFAULT_GUIDES,
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

test("unset guide heights fall back to FontForge's 800/200 defaults", () => {
  const unset = { x_height: 0, cap_height: 0, ascender: 0, descender: 0 } as WritingConfig;
  const lines = guideLines(unset);
  assert.deepEqual(
    lines.map((l) => l.y),
    [800, 700, 500, 0, -200],
  );
  assert.equal(new Set(lines.map((l) => l.y)).size, 5, "rails no longer stack on the baseline");
  assert.equal(guideHeight({ ...unset, x_height: 480 } as WritingConfig, "x_height"), 480);
  assert.equal(DEFAULT_GUIDES.ascender, 800);
});

import {
  TOOL_GROUPS,
  TOOL_SHORTCUTS,
  toolByKey,
  RESERVED_KEYS,
  DEFAULT_TOOL,
} from "./writing.ts";

test("TOOLS now lists select, direct, hand, zoom and the drawing tools", () => {
  const ids = TOOLS.map((t) => t.id);
  assert.deepEqual(ids, [
    "select", "direct", "hand", "zoom", "pen", "node", "brush", "shapes", "mirror", "eraser",
  ]);
  assert.equal(new Set(ids).size, ids.length);
});

test("the default tool is select", () => {
  assert.equal(DEFAULT_TOOL, "select");
});

test("the tool shortcuts are the ones asked for", () => {
  assert.deepEqual(TOOL_SHORTCUTS, {
    select: "V", direct: "A", hand: "H", zoom: "Z", pen: "P",
    node: "N", brush: "B", shapes: "S", mirror: "M", eraser: "E",
  });
});

test("tool shortcuts are unique single letters", () => {
  const keys = Object.values(TOOL_SHORTCUTS);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((k) => /^[A-Z]$/.test(k)));
});

test("no tool shortcut collides with a key the editor already binds", () => {
  for (const key of Object.values(TOOL_SHORTCUTS)) {
    assert.ok(!RESERVED_KEYS.includes(key.toLowerCase()), `${key} is reserved`);
  }
});

test("tools are grouped select / view / draw / edit with every tool exactly once", () => {
  assert.deepEqual(TOOL_GROUPS.map((g) => g.id), ["select", "view", "draw", "edit"]);
  const flat = TOOL_GROUPS.flatMap((g) => g.tools);
  assert.equal(flat.length, TOOLS.length);
  assert.deepEqual([...flat].sort(), TOOLS.map((t) => t.id).sort());
});

test("toolByKey finds a tool from a key, ignoring case, and nothing for other keys", () => {
  assert.equal(toolByKey("v"), "select");
  assert.equal(toolByKey("H"), "hand");
  assert.equal(toolByKey("z"), "zoom");
  assert.equal(toolByKey("q"), undefined);
  assert.equal(toolByKey("Enter"), undefined);
});

test("every tool has an icon name, a label and a tooltip with the shortcut", () => {
  for (const tool of TOOLS) {
    assert.ok(tool.label && tool.icon, tool.id);
    assert.ok(tool.tooltip.includes(tool.shortcut), tool.id);
  }
});
