import type { Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-bullet";
    span.textContent = "•";
    return span;
  }
}
const BULLET = new BulletWidget();

/** Line numbers that intersect any selection range (revealed raw). */
function activeLines(state: EditorView["state"]): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const start = state.doc.lineAt(range.from).number;
    const end = state.doc.lineAt(range.to).number;
    for (let number = start; number <= end; number += 1) {
      lines.add(number);
    }
  }
  return lines;
}

function conceal(ranges: Range<Decoration>[], from: number, to: number) {
  if (to > from) {
    ranges.push(Decoration.replace({}).range(from, to));
  }
}

function mark(
  ranges: Range<Decoration>[],
  from: number,
  to: number,
  cls: string,
) {
  if (to > from) {
    ranges.push(Decoration.mark({ class: cls }).range(from, to));
  }
}

function decorateLine(
  line: { from: number; text: string },
  ranges: Range<Decoration>[],
) {
  const { from, text } = line;
  let match: RegExpExecArray | null;

  if ((match = /^(#{1,6})(\s+)/.exec(text))) {
    ranges.push(
      Decoration.line({ class: `cm-h${match[1].length}` }).range(from),
    );
    conceal(ranges, from, from + match[0].length);
  }

  if ((match = /^(>\s?)/.exec(text))) {
    conceal(ranges, from, from + match[1].length);
  }

  if ((match = /^(\s*)([-*+])\s/.exec(text))) {
    const markerFrom = from + match[1].length;
    ranges.push(
      Decoration.replace({ widget: BULLET }).range(
        markerFrom,
        markerFrom + match[2].length,
      ),
    );
  }

  const bold = /\*\*([^*\n]+)\*\*/g;
  while ((match = bold.exec(text))) {
    const start = from + match.index;
    conceal(ranges, start, start + 2);
    mark(ranges, start + 2, start + 2 + match[1].length, "cm-strong");
    conceal(
      ranges,
      start + 2 + match[1].length,
      start + match[0].length,
    );
  }

  const emphasis = /(^|[^*\w])\*([^*\n]+)\*(?!\*)/g;
  while ((match = emphasis.exec(text))) {
    const base = from + match.index + match[1].length;
    conceal(ranges, base, base + 1);
    mark(ranges, base + 1, base + 1 + match[2].length, "cm-em");
    conceal(ranges, base + 1 + match[2].length, base + 2 + match[2].length);
  }

  const code = /`([^`\n]+)`/g;
  while ((match = code.exec(text))) {
    const start = from + match.index;
    conceal(ranges, start, start + 1);
    mark(ranges, start + 1, start + 1 + match[1].length, "cm-code");
    conceal(ranges, start + 1 + match[1].length, start + match[0].length);
  }

  const link = /\[([^\]]+)\]\(([^)]+)\)/g;
  while ((match = link.exec(text))) {
    const start = from + match.index;
    conceal(ranges, start, start + 1);
    mark(ranges, start + 1, start + 1 + match[1].length, "cm-link");
    conceal(ranges, start + 1 + match[1].length, start + match[0].length);
  }
}

/** Build decorations only for the lines inside the current viewport. */
function build(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const ranges: Range<Decoration>[] = [];

  for (const visible of view.visibleRanges) {
    let pos = state.doc.lineAt(visible.from).from;
    while (pos <= visible.to) {
      const line = state.doc.lineAt(pos);
      if (!active.has(line.number)) {
        decorateLine(line, ranges);
      }
      if (line.to >= visible.to) break;
      pos = line.to + 1;
    }
  }

  return Decoration.set(ranges, true);
}

/**
 * Obsidian-style live preview: markdown markers are concealed on every line
 * except those intersecting the selection, which stay raw for editing.
 */
export function livePreview() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.focusChanged
        ) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (view) => view.decorations },
  );
}
