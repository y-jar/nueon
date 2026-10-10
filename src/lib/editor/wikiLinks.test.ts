import { test } from "node:test";
import assert from "node:assert/strict";

import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { CompletionContext } from "@codemirror/autocomplete";

import { wordIndexField } from "./dictionary.ts";
import {
  noteHeadingsField,
  notePathsField,
  wikiCompletionSource,
} from "./wikiLinks.ts";

function state(doc: string, pos: number) {
  const s = EditorState.create({
    doc,
    extensions: [
      markdown(),
      wordIndexField.init(() => ({
        velo: [{ id: "1", table: "lex", wordname: "velo", senses: ["to run"], tags: [] }],
        uene: [{ id: "2", table: "lex", wordname: "uene", senses: ["person"], tags: [] }],
      })),
      notePathsField.init(() => new Set(["alpha.md"])),
      noteHeadingsField.init(() => ({ "alpha.md": ["Intro", "Nouns"] })),
    ],
  });
  return { state: s, pos };
}

test("completion source offers words and notes mixed for [[", () => {
  const ctx = state("[[", 2);
  const result = wikiCompletionSource(new CompletionContext(ctx.state, ctx.pos, true));
  assert.ok(result, "source returned a result");
  const labels = result!.options.map((option) => option.label);
  assert.ok(labels.includes("velo"), `labels: ${labels}`);
  assert.ok(labels.includes("alpha"), `labels: ${labels}`);
});

test("a partial query matches by substring, not just prefix", () => {
  const ctx = state("[[ene", 5);
  const result = wikiCompletionSource(new CompletionContext(ctx.state, ctx.pos, true));
  const labels = result!.options.map((option) => option.label);
  assert.ok(labels.includes("uene"), `labels: ${labels}`);
});

test("after # the list switches to the note's headings", () => {
  const ctx = state("[[alpha#In", 10);
  const result = wikiCompletionSource(new CompletionContext(ctx.state, ctx.pos, true));
  assert.ok(result, "source returned a result");
  const labels = result!.options.map((option) => option.label);
  assert.deepEqual(labels, ["Intro"]);
});

test("after | there is no list (the alias is free text)", () => {
  const ctx = state("[[alpha|", 8);
  assert.equal(
    wikiCompletionSource(new CompletionContext(ctx.state, ctx.pos, true)),
    null,
  );
});

test("an unmatched name offers Create note", () => {
  const ctx = state("[[nope", 6);
  const result = wikiCompletionSource(new CompletionContext(ctx.state, ctx.pos, true), {
    createNote: async () => {},
  });
  assert.ok(result, "source returned a result");
  const labels = result!.options.map((option) => option.label);
  assert.ok(labels.includes("Create note: nope"), `labels: ${labels}`);
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
