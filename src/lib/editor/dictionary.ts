import type { Range } from "@codemirror/state";
import { StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  hoverTooltip,
} from "@codemirror/view";

import type { WordHit, WordIndex } from "../api";

export const setWordIndex = StateEffect.define<WordIndex>();

/** Holds the current word index; updated via `setWordIndex`. */
export const wordIndexField = StateField.define<WordIndex>({
  create: () => ({}),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(setWordIndex)) {
        next = effect.value;
      }
    }
    return next;
  },
});

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;

function build(view: EditorView): DecorationSet {
  const index = view.state.field(wordIndexField);
  const ranges: Range<Decoration>[] = [];
  if (Object.keys(index).length === 0) {
    return Decoration.set(ranges, true);
  }

  // Only scan the visible ranges so large notes stay smooth while typing.
  for (const visible of view.visibleRanges) {
    const text = view.state.sliceDoc(visible.from, visible.to);
    WORD_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WORD_RE.exec(text))) {
      const hits = index[match[0].toLowerCase()];
      if (hits && hits.length) {
        const from = visible.from + match.index;
        ranges.push(
          Decoration.mark({ class: "cm-dict" }).range(from, from + match[0].length),
        );
      }
    }
  }

  return Decoration.set(ranges, true);
}

/** Tint dictionary words in the visible viewport. */
export function dictionaryHighlight() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view);
      }

      update(update: ViewUpdate) {
        const indexChanged =
          update.startState.field(wordIndexField) !==
          update.state.field(wordIndexField);
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          indexChanged
        ) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (view) => view.decorations },
  );
}

function superscript(value: number): string {
  const digits = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];
  if (value === 0) return digits[0];
  let out = "";
  let n = value;
  while (n > 0) {
    out = digits[n % 10] + out;
    n = Math.floor(n / 10);
  }
  return out;
}

/** Hover card listing every entry matching the word under the cursor. */
export function dictionaryHover() {
  return hoverTooltip((view, pos) => {
    const index = view.state.field(wordIndexField);
    const word = view.state.wordAt(pos);
    if (!word) return null;
    const text = view.state.sliceDoc(word.from, word.to);
    const hits = index[text.toLowerCase()];
    if (!hits || hits.length === 0) return null;

    return {
      pos: word.from,
      end: word.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-dict-tooltip";
        hits.forEach((hit: WordHit, i: number) => {
          const row = document.createElement("div");
          row.className = "cm-dict-row";
          const title = document.createElement("strong");
          title.textContent =
            hits.length > 1 ? hit.wordname + superscript(i + 1) : hit.wordname;
          row.appendChild(title);
          if (hit.senses.length) {
            const senses = document.createElement("div");
            senses.textContent = hit.senses.join("; ");
            row.appendChild(senses);
          }
          const meta = document.createElement("div");
          meta.className = "muted";
          meta.textContent =
            hit.table + (hit.tags.length ? " · " + hit.tags.join(", ") : "");
          row.appendChild(meta);
          dom.appendChild(row);
        });
        return { dom };
      },
    };
  });
}
