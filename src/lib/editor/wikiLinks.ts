import { StateEffect, StateField } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  hoverTooltip,
} from "@codemirror/view";

import { parseWikiLinks, resolveWikiTarget, type WikiTarget } from "../wikilink";
import { codeLines } from "./blocks";
import { wordIndexField } from "./dictionary";

/** Holds the note path set, updated via `setNotePaths`. */
export const setNotePaths = StateEffect.define<Set<string>>();

export const notePathsField = StateField.define<Set<string>>({
  create: () => new Set(),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(setNotePaths)) next = effect.value;
    }
    return next;
  },
});

/** The `[[target]]` link whose span contains `pos`, resolved, or null. */
function linkAt(view: EditorView, pos: number): {
  target: WikiTarget;
  from: number;
  to: number;
} | null {
  const line = view.state.doc.lineAt(pos);
  const offset = pos - line.from;
  const index = view.state.field(wordIndexField);
  const notes = view.state.field(notePathsField);
  for (const link of parseWikiLinks(line.text)) {
    if (offset >= link.from && offset <= link.to) {
      return {
        target: resolveWikiTarget(link.target, index, notes),
        from: line.from + link.from,
        to: line.from + link.to,
      };
    }
  }
  return null;
}

function classFor(target: WikiTarget, embed: boolean): string {
  if (embed) return "cm-wikilink cm-wikilink-embed";
  if (target.kind === "word") return "cm-wikilink cm-wikilink-word";
  if (target.kind === "note") return "cm-wikilink cm-wikilink-note";
  return "cm-wikilink cm-wikilink-unresolved";
}

function build(view: EditorView): DecorationSet {
  const index = view.state.field(wordIndexField);
  const notes = view.state.field(notePathsField);
  const code = codeLines(view.state);
  const ranges: Range<Decoration>[] = [];
  for (const visible of view.visibleRanges) {
    const text = view.state.sliceDoc(visible.from, visible.to);
    for (const link of parseWikiLinks(text)) {
      const from = visible.from + link.from;
      const to = visible.from + link.to;
      if (code.has(view.state.doc.lineAt(from).number)) continue;
      const target = resolveWikiTarget(link.target, index, notes);
      ranges.push(
        Decoration.mark({ class: classFor(target, link.embed) }).range(from, to),
      );
    }
  }
  return Decoration.set(ranges, true);
}

/**
 * Decorate `[[...]]` links in the visible viewport and follow them on
 * Ctrl/Cmd+click via `getFollow`.
 */
export function wikiLinks(
  getFollow: () => ((target: WikiTarget) => void) | undefined,
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view);
      }

      update(update: ViewUpdate) {
        const changed =
          update.startState.field(wordIndexField) !==
            update.state.field(wordIndexField) ||
          update.startState.field(notePathsField) !==
            update.state.field(notePathsField);
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          changed
        ) {
          this.decorations = build(update.view);
        }
      }
    },
    {
      decorations: (view) => view.decorations,
      eventHandlers: {
        mousedown(event, view) {
          if (!(event.ctrlKey || event.metaKey)) return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) return false;
          const link = linkAt(view, pos);
          if (!link) return false;
          event.preventDefault();
          getFollow()?.(link.target);
          return true;
        },
      },
    },
  );
}

/** Hover card for the `[[...]]` link under the cursor. */
export function wikiLinkHover() {
  return hoverTooltip((view, pos) => {
    const link = linkAt(view, pos);
    if (!link) return null;
    return {
      pos: link.from,
      end: link.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-wikilink-tooltip";
        if (link.target.kind === "word") {
          const title = document.createElement("strong");
          title.textContent = link.target.wordname;
          dom.appendChild(title);
          if (link.target.senses.length) {
            const senses = document.createElement("div");
            senses.textContent = link.target.senses.join("; ");
            dom.appendChild(senses);
          }
          const meta = document.createElement("div");
          meta.className = "muted";
          meta.textContent = link.target.table;
          dom.appendChild(meta);
        } else if (link.target.kind === "note") {
          const title = document.createElement("strong");
          title.textContent = link.target.path;
          dom.appendChild(title);
        } else {
          const title = document.createElement("div");
          title.className = "muted";
          title.textContent = "not found";
          dom.appendChild(title);
        }
        return { dom };
      },
    };
  });
}
