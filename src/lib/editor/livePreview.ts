import type { Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";

// Absolute `notes/` directory, used to resolve local image references.
let assetBase = "";
export function setAssetBase(base: string) {
  assetBase = base;
}

function resolveImage(src: string): string {
  if (/^(https?:|data:|asset:)/.test(src)) return src;
  const path = src.startsWith("/") ? src : `${assetBase}/${src}`;
  try {
    return convertFileSrc(path);
  } catch {
    return src;
  }
}

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-bullet";
    span.textContent = "•";
    return span;
  }
}
const BULLET = new BulletWidget();

/** A checkbox that writes `[x]`/`[ ]` back into the document. */
class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }

  eq(other: TaskWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-task";
    input.checked = this.checked;
    input.addEventListener("change", () => {
      const insert = input.checked ? "x" : " ";
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 1, insert },
      });
    });
    return input;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.url === this.url && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-image";
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    img.loading = "lazy";
    img.addEventListener("error", () => {
      wrap.classList.add("cm-image-error");
      wrap.textContent = this.alt || "(image)";
    });
    wrap.appendChild(img);
    return wrap;
  }
}

function splitRow(text: string): string[] {
  return text
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isDelimiter(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.includes("-") &&
    trimmed.includes("|") &&
    /^\|?[\s:|-]+\|?$/.test(trimmed)
  );
}

class TableWidget extends WidgetType {
  constructor(readonly block: string) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.block === this.block;
  }

  toDOM(): HTMLElement {
    const table = document.createElement("table");
    table.className = "cm-table";
    let headerDone = false;
    for (const rowText of this.block.split("\n")) {
      if (rowText.trim() === "" || isDelimiter(rowText)) continue;
      const tr = document.createElement("tr");
      const cells = splitRow(rowText);
      for (const cell of cells) {
        const el = document.createElement(headerDone ? "td" : "th");
        el.textContent = cell;
        tr.appendChild(el);
      }
      headerDone = true;
      table.appendChild(tr);
    }
    return table;
  }
}

class FootnoteWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }

  eq(other: FootnoteWidget): boolean {
    return other.label === this.label;
  }

  toDOM(): HTMLElement {
    const sup = document.createElement("sup");
    sup.className = "cm-footnote";
    sup.textContent = this.label;
    return sup;
  }
}

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

  if ((match = /^\[\^([^\]]+)\]:\s?/.exec(text))) {
    conceal(ranges, from, from + match[0].length);
    return;
  }

  if ((match = /^(>\s?)/.exec(text))) {
    conceal(ranges, from, from + match[1].length);
  }

  let bulletHandled = false;
  if ((match = /^(\s*)([-*+])\s\[( |x|X)\]\s/.exec(text))) {
    const start = from + match.index;
    const end = start + match[0].length;
    const statePos = from + match.index + match[1].length + match[2].length + 2;
    ranges.push(
      Decoration.replace({
        widget: new TaskWidget(match[3] !== " ", statePos),
      }).range(start, end),
    );
    bulletHandled = true;
  }

  if (!bulletHandled && (match = /^(\s*)([-*+])\s/.exec(text))) {
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
    conceal(ranges, start + 2 + match[1].length, start + match[0].length);
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

  const image = /!\[([^\]]*)\]\(([^)]+)\)/g;
  while ((match = image.exec(text))) {
    const start = from + match.index;
    ranges.push(
      Decoration.replace({
        widget: new ImageWidget(resolveImage(match[2]), match[1]),
      }).range(start, start + match[0].length),
    );
  }

  const link = /\[([^\]]+)\]\(([^)]+)\)/g;
  while ((match = link.exec(text))) {
    const start = from + match.index;
    conceal(ranges, start, start + 1);
    mark(ranges, start + 1, start + 1 + match[1].length, "cm-link");
    conceal(ranges, start + 1 + match[1].length, start + match[0].length);
  }

  const footnote = /\[\^([^\]]+)\]/g;
  while ((match = footnote.exec(text))) {
    const start = from + match.index;
    ranges.push(
      Decoration.replace({ widget: new FootnoteWidget(match[1]) }).range(
        start,
        start + match[0].length,
      ),
    );
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

      if (active.has(line.number)) {
        if (line.to >= visible.to) break;
        pos = line.to + 1;
        continue;
      }

      // GFM table block → single widget.
      const next =
        line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
      if (line.text.includes("|") && next && isDelimiter(next.text)) {
        let last = next.number;
        while (
          last < state.doc.lines &&
          state.doc.line(last + 1).text.includes("|") &&
          state.doc.line(last + 1).text.trim() !== ""
        ) {
          last += 1;
        }
        let blockActive = false;
        for (let n = line.number; n <= last; n += 1) {
          if (active.has(n)) {
            blockActive = true;
            break;
          }
        }
        if (!blockActive) {
          const blockFrom = line.from;
          const blockTo = state.doc.line(last).to;
          ranges.push(
            Decoration.replace({
              widget: new TableWidget(state.doc.sliceString(blockFrom, blockTo)),
            }).range(blockFrom, blockTo),
          );
          if (state.doc.line(last).to >= visible.to) break;
          pos = state.doc.line(last).to + 1;
          continue;
        }
      }

      decorateLine(line, ranges);
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
