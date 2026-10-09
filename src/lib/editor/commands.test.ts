import { test } from "node:test";
import assert from "node:assert/strict";
import { history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { GFM } from "@lezer/markdown";

import {
  buildMarkdownKeymap,
  clearHeading,
  setHeading,
  toggleStrikethrough,
} from "./commands.ts";
import { resolveKeybinds } from "../keybindings.ts";

function state(doc: string, from = 0, to = from): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(from, to),
    extensions: [markdown({ extensions: [GFM] }), history()],
  });
}

function agent(initial: EditorState) {
  const host = {
    _state: initial,
    get state() {
      return host._state;
    },
    dispatch(spec: Transaction | object) {
      host._state =
        spec instanceof Transaction
          ? spec.state
          : host._state.update(spec as never).state;
    },
  };
  return host;
}

// -- headings ----------------------------------------------------------------

test("a heading level is set, replaced and toggled off", () => {
  const set = agent(state("text"));
  assert.equal(setHeading(2)(set), true);
  assert.equal(set.state.doc.toString(), "## text");

  const replace = agent(state("## text"));
  assert.equal(setHeading(3)(replace), true);
  assert.equal(replace.state.doc.toString(), "### text");

  const off = agent(state("## text"));
  assert.equal(setHeading(2)(off), true);
  assert.equal(off.state.doc.toString(), "text");
});

test("Mod-0 clears any heading", () => {
  const view = agent(state("###### deep"));
  assert.equal(clearHeading(view), true);
  assert.equal(view.state.doc.toString(), "deep");
});

test("a multi-line selection applies the heading to every line", () => {
  const view = agent(state("a\nb", 0, 3));
  assert.equal(setHeading(2)(view), true);
  assert.equal(view.state.doc.toString(), "## a\n## b");
});

test("headings do nothing inside a code block", () => {
  const doc = "```\ncode\n```\n";
  const view = agent(state(doc, 5));
  assert.equal(setHeading(2)(view), false);
  assert.equal(view.state.doc.toString(), doc);
});

test("headings do nothing inside a table", () => {
  const doc = "| a | b |\n| --- | --- |\n| c | d |\n";
  const view = agent(state(doc, 3));
  assert.equal(setHeading(2)(view), false);
  assert.equal(view.state.doc.toString(), doc);
});

test("a mixed selection skips code lines and edits the rest", () => {
  const doc = "a\n```\ncode\n```\nb\n";
  const view = agent(state(doc, 0, doc.length - 1));
  assert.equal(setHeading(2)(view), true);
  assert.equal(view.state.doc.toString(), "## a\n```\ncode\n```\n## b\n");
});

// -- strikethrough -----------------------------------------------------------

test("strikethrough wraps and unwraps a single-line selection", () => {
  const wrap = agent(state("word", 0, 4));
  assert.equal(toggleStrikethrough(wrap), true);
  assert.equal(wrap.state.doc.toString(), "~~word~~");

  const unwrap = agent(state("~~word~~", 2, 6));
  assert.equal(toggleStrikethrough(unwrap), true);
  assert.equal(unwrap.state.doc.toString(), "word");
});

test("strikethrough wraps every line of a multi-line selection", () => {
  const view = agent(state("a\nb", 0, 3));
  assert.equal(toggleStrikethrough(view), true);
  assert.equal(view.state.doc.toString(), "~~a~~\n~~b~~");
});

test("strikethrough does nothing inside a code block", () => {
  const doc = "```\ncode\n```\n";
  const view = agent(state(doc, 5));
  assert.equal(toggleStrikethrough(view), false);
  assert.equal(view.state.doc.toString(), doc);
});

// -- keymap ------------------------------------------------------------------

test("the markdown keymap binds the table, task and image keys", () => {
  const keys = buildMarkdownKeymap(resolveKeybinds({}), {
    onImage: () => {},
  }).map((b) => b.key);
  assert.ok(keys.includes("Mod-Shift-t"), "table key");
  assert.ok(keys.includes("Mod-Shift-l"), "task key");
  assert.ok(keys.includes("Mod-Shift-p"), "image key");
});

test("the image keybind opens the picker, or is a no-op without one", () => {
  const view = agent(state(""));
  const opened: string[] = [];
  const open = buildMarkdownKeymap(resolveKeybinds({}), {
    onImage: () => opened.push("yes"),
  });
  const binding = open.find((b) => b.key === "Mod-Shift-p");
  assert.equal(binding?.run?.(view as never), true);
  assert.deepEqual(opened, ["yes"]);

  const none = buildMarkdownKeymap(resolveKeybinds({})).find(
    (b) => b.key === "Mod-Shift-p",
  );
  assert.equal(none?.run?.(view as never), false);
});

// -- undo --------------------------------------------------------------------

test("one undo reverts a whole multi-line heading edit", () => {
  const view = agent(state("a\nb", 0, 3));
  const before = view.state.doc.toString();
  setHeading(2)(view);
  assert.notEqual(view.state.doc.toString(), before);
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), before);
});
