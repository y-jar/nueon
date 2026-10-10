import { test } from "node:test";
import assert from "node:assert/strict";

import { JSDOM } from "jsdom";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { completionStatus, currentCompletions } from "@codemirror/autocomplete";

import { wordIndexField } from "./dictionary.ts";
import {
  fixesTablesField,
  noteHeadingsField,
  notePathsField,
  wikiCompletion,
} from "./wikiLinks.ts";

/**
 * Install a jsdom DOM onto `globalThis` before CodeMirror creates a view.
 * CodeMirror reads `document`/`navigator` lazily (module load captures only a
 * harmless browser-detection stub), but `Window` must be defined or it throws
 * on every update.
 */
function setupDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const set = (name: string, value: unknown) => {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  };
  set("window", w);
  set("document", w.document);
  set("navigator", w.navigator);
  set("Window", w.Window);
  set("MutationObserver", w.MutationObserver);
  set("requestAnimationFrame", w.requestAnimationFrame.bind(w));
  set("cancelAnimationFrame", w.cancelAnimationFrame.bind(w));
  set("getComputedStyle", w.getComputedStyle.bind(w));
  set("Range", w.Range);
  set("Selection", w.Selection);
  (w.document as unknown as { hasFocus: () => boolean }).hasFocus = () => true;
}

function type(view: EditorView, text: string): void {
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: "input.type",
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeView() {
  const state = EditorState.create({
    doc: "",
    extensions: [
      markdown(),
      wordIndexField.init(() => ({
        kyo: [{ id: "1", table: "lex", wordname: "kyo", senses: ["word"], tags: [] }],
      })),
      notePathsField.init(() => new Set(["alpha.md"])),
      noteHeadingsField.init(() => ({})),
      fixesTablesField.init(() => new Set()),
      wikiCompletion(() => ({})),
    ],
  });
  const view = new EditorView({
    state,
    parent: (document as Document).body,
  });
  view.contentDOM.focus();
  return view;
}

test("the dropdown survives CodeMirror's filter and mounts a tooltip", async () => {
  setupDom();
  const view = makeView();

  type(view, "[");
  type(view, "[");
  await wait(300);

  assert.equal(completionStatus(view.state), "active");
  let labels = currentCompletions(view.state).map((option) => option.label);
  assert.ok(labels.includes("kyo"), `labels: ${labels}`);
  assert.ok(labels.includes("alpha"), `labels: ${labels}`);
  assert.ok(
    view.dom.querySelector(".cm-tooltip-autocomplete"),
    "tooltip should mount for [[",
  );

  type(view, "k");
  type(view, "y");
  await wait(300);

  assert.equal(completionStatus(view.state), "active");
  labels = currentCompletions(view.state).map((option) => option.label);
  assert.deepEqual(labels, ["kyo"]);
  assert.ok(
    view.dom.querySelector(".cm-tooltip-autocomplete"),
    "tooltip should mount for [[ky",
  );

  view.destroy();
});
