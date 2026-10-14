import { test } from "node:test";
import assert from "node:assert/strict";

import { formChoices, hasForms, setForm, FORM_KEYS } from "./writingForms.ts";
import type { GlyphMeta } from "./api.ts";

const glyph = (id: string, name: string, forms?: GlyphMeta["forms"]): GlyphMeta => ({
  id,
  name,
  codepoint: 0xe000,
  phonemes: [],
  order: 0,
  group: "",
  forms,
});

test("setForm sets one position and leaves the others", () => {
  const g = glyph("a", "a", { initial: "x" });
  const next = setForm(g, "medial", "y");
  assert.deepEqual(next.forms, { initial: "x", medial: "y" });
  assert.deepEqual(g.forms, { initial: "x" }, "the input is not changed");
});

test("setForm with an empty value clears that position, and the last one clears forms", () => {
  const g = glyph("a", "a", { initial: "x", final_form: "z" });
  assert.deepEqual(setForm(g, "initial", "").forms, { final_form: "z" });
  assert.equal(setForm(setForm(g, "initial", ""), "final_form", null).forms, undefined);
});

test("hasForms is true only when some position is set", () => {
  assert.equal(hasForms(glyph("a", "a")), false);
  assert.equal(hasForms(glyph("a", "a", {})), false);
  assert.equal(hasForms(glyph("a", "a", { medial: "m" })), true);
});

test("formChoices lists the other glyphs by name and never the glyph itself", () => {
  const all = [glyph("a", "alpha"), glyph("b", "beta"), glyph("c", "gamma")];
  assert.deepEqual(formChoices(all, "a"), [
    { id: "b", name: "beta" },
    { id: "c", name: "gamma" },
  ]);
  assert.deepEqual(formChoices(all, "missing").length, 3);
});

test("FORM_KEYS covers initial, medial and final in reading order", () => {
  assert.deepEqual(FORM_KEYS, ["initial", "medial", "final_form"]);
});
