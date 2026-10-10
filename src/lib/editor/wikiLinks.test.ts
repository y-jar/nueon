import { test } from "node:test";
import assert from "node:assert/strict";

import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { CompletionContext } from "@codemirror/autocomplete";

import { wordIndexField } from "./dictionary.ts";
import { notePathsField, wikiCompletionSource } from "./wikiLinks.ts";

function state(doc: string, pos: number) {
  const s = EditorState.create({
    doc,
    extensions: [
      markdown(),
      wordIndexField.init(() => ({
        velo: [{ id: "1", table: "lex", wordname: "velo", senses: ["to run"], tags: [] }],
      })),
      notePathsField.init(() => new Set(["alpha.md"])),
    ],
  });
  return { state: s, pos };
}

test("completion source offers a word and a note for [[", () => {
  const ctx = state("[[", 2);
  const result = wikiCompletionSource(new CompletionContext(ctx.state, ctx.pos, true));
  assert.ok(result, "source returned a result");
  const labels = result!.options.map((option) => option.label);
  assert.ok(labels.includes("velo"), `labels: ${labels}`);
  assert.ok(labels.includes("alpha"), `labels: ${labels}`);
});

test("a partial query filters completions", () => {
  const ctx = state("[[vel", 5);
  const result = wikiCompletionSource(new CompletionContext(ctx.state, ctx.pos, true));
  const labels = result!.options.map((option) => option.label);
  assert.deepEqual(labels, ["velo"]);
});

test("completion replaces the [[...]] span including auto-closed brackets", () => {
  const ctx = state("[[]]", 2);
  const result = wikiCompletionSource(new CompletionContext(ctx.state, ctx.pos, true));
  assert.ok(result, "source returned a result");
  assert.equal(result!.from, 0);
  assert.equal(result!.to, 4);
});

test("no result outside a [[ prefix", () => {
  const ctx = state("hello", 5);
  assert.equal(
    wikiCompletionSource(new CompletionContext(ctx.state, ctx.pos, true)),
    null,
  );
});
