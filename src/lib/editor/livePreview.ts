import { type Range } from "@codemirror/state";
import {
  Decoration,
  type BlockInfo,
  type DecorationSet,
  EditorView,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  lineNumberWidgetMarker,
} from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import katex from "katex";
import { normalizePath } from "../assets";
import { codeLines, makeBlockField } from "./blocks";
import { isDelimiterRow, parseTable, rawCellOffset } from "./table";
import "katex/dist/katex.min.css";

// Absolute `notes/` directory and the open note's folder inside it, used to
// resolve relative image references (including `../assets/…`).
let assetBase = "";
let noteDir = "";
export function setAssetBase(base: string, notePath = "") {
  assetBase = base;
  noteDir = notePath.split("/").slice(0, -1).join("/");
}

function resolveImage(src: string): string {
  if (/^(https?:|data:|asset:)/.test(src)) return src;
  const path = src.startsWith("/")
    ? src
    : normalizePath(`${assetBase}/${noteDir}/${src}`);
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

class TableWidget extends WidgetType {
  constructor(
    readonly block: string,
    readonly pos: number,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.block === this.block && other.pos === this.pos;
  }

  toDOM(view: EditorView): HTMLElement {
    const table = document.createElement("table");
    table.className = "cm-table";
    // Wrapped so the vertical spacing is padding, which CodeMirror measures;
    // padding on a <table> itself is ignored by the engine.
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    wrap.appendChild(table);
    const model = parseTable(this.block);
    if (model) {
      const rows = [
        { header: true, cells: model.header },
        ...model.rows.map((cells) => ({ header: false, cells })),
      ];
      rows.forEach((row, index) => {
        const tr = document.createElement("tr");
        row.cells.forEach((text, col) => {
          const el = document.createElement(row.header ? "th" : "td");
          el.textContent = text;
          // Clicking a cell drops the cursor into its raw Markdown text.
          el.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const offset = rawCellOffset(this.block, index - 1, col);
            if (offset === null) return;
            view.dispatch({
              selection: { anchor: this.pos + offset },
              scrollIntoView: true,
            });
            view.focus();
          });
          tr.appendChild(el);
        });
        table.appendChild(tr);
      });
      return wrap;
    }
    // Not a valid table (ragged/mismatched): render as before, no bridge.
    let headerDone = false;
    for (const rowText of this.block.split("\n")) {
      if (rowText.trim() === "" || isDelimiterRow(rowText)) continue;
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
    return wrap;
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

/** Render TeX with KaTeX; invalid input falls back to raw text. */
class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    /** Block start; `-1` for a single-line (plugin) math span. */
    readonly pos = -1,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return (
      other.tex === this.tex &&
      other.display === this.display &&
      other.pos === this.pos
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-math-display" : "cm-math";
    enterBlockOnClick(el, view, this.pos);
    try {
      katex.render(this.tex, el, {
        displayMode: this.display,
        throwOnError: false,
      });
    } catch {
      el.textContent = this.tex;
    }
    return el;
  }
}

/**
 * A block widget swallows events by default, so clicking it never moves the
 * cursor. For a rendered block, put the cursor at its first line instead, which
 * makes the block active and switches it back to raw text for editing.
 */
function enterBlockOnClick(
  el: HTMLElement,
  view: EditorView,
  pos: number,
): void {
  if (pos < 0) return;
  el.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  });
}

/** Render an HTML block verbatim (user-authored notes). */
class HtmlWidget extends WidgetType {
  constructor(
    readonly html: string,
    /** Block start; `-1` for a single-line (plugin) HTML span. */
    readonly pos = -1,
  ) {
    super();
  }

  eq(other: HtmlWidget): boolean {
    return other.html === this.html && other.pos === this.pos;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-html-block";
    enterBlockOnClick(wrap, view, this.pos);
    wrap.innerHTML = this.html;
    return wrap;
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

  const underline = /<u>([^<\n]+)<\/u>/g;
  while ((match = underline.exec(text))) {
    const start = from + match.index;
    conceal(ranges, start, start + 3);
    mark(ranges, start + 3, start + 3 + match[1].length, "cm-underline");
    conceal(ranges, start + 3 + match[1].length, start + match[0].length);
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

  const inlineMath = /(^|[^$])\$([^$\n]+?)\$(?!\$)/g;
  while ((match = inlineMath.exec(text))) {
    const start = from + match.index + match[1].length;
    ranges.push(
      Decoration.replace({
        widget: new MathWidget(match[2], false),
      }).range(start, start + match[2].length + 2),
    );
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
  // Fenced and indented code stay plain: no inline marks, math, inline HTML,
  // display math or tables. One whole-document scan per build, not per line.
  const code = codeLines(state);
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

      if (code.has(line.number)) {
        if (line.to >= visible.to) break;
        pos = line.to + 1;
        continue;
      }

      // GFM table block → single widget.
      const next =
        line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
      if (line.text.includes("|") && next && isDelimiterRow(next.text)) {
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
          // The block widget itself comes from `tableBlocks` (a state field,
          // which may replace line breaks); here we only skip inline marks.
          if (state.doc.line(last).to >= visible.to) break;
          pos = state.doc.line(last).to + 1;
          continue;
        }
      }

      // Display math: single-line stays a plugin decoration (it replaces no
      // line break); multi-line is rendered by the block field.
      if (line.text.trimStart().startsWith("$$")) {
        let last = line.number;
        let raw = line.text;
        if (raw.indexOf("$$", raw.indexOf("$$") + 2) === -1) {
          while (last < state.doc.lines) {
            last += 1;
            const nextText = state.doc.line(last).text;
            raw += `\n${nextText}`;
            if (nextText.includes("$$")) break;
          }
        }
        const innerStart = raw.indexOf("$$") + 2;
        const innerEnd = raw.indexOf("$$", innerStart);
        if (innerEnd !== -1) {
          const blockTo = state.doc.line(last).to;
          if (last === line.number) {
            ranges.push(
              Decoration.replace({
                widget: new MathWidget(raw.slice(innerStart, innerEnd), true),
              }).range(line.from, blockTo),
            );
          }
          if (blockTo >= visible.to) break;
          pos = blockTo + 1;
          continue;
        }
      }

      // Raw HTML block: single-line is a plugin decoration, multi-line comes
      // from the block field.
      if (/^\s*<(?!https?:)[a-zA-Z!/]/.test(line.text)) {
        let last = line.number;
        while (
          last < state.doc.lines &&
          state.doc.line(last + 1).text.trim() !== ""
        ) {
          last += 1;
        }
        const blockTo = state.doc.line(last).to;
        if (last === line.number) {
          ranges.push(
            Decoration.replace({
              widget: new HtmlWidget(state.doc.sliceString(line.from, blockTo)),
            }).range(line.from, blockTo),
          );
        }
        if (blockTo >= visible.to) break;
        pos = blockTo + 1;
        continue;
      }

      decorateLine(line, ranges);
      if (line.to >= visible.to) break;
      pos = line.to + 1;
    }
  }

  return Decoration.set(ranges, true);
}

/**
 * Multi-line tables, display math and HTML rendered as block widgets. A
 * `ViewPlugin` may not replace line breaks, so these come from a state field;
 * the field sees the selection and leaves a block raw while the cursor is
 * inside it. The scanning lives in `blocks.ts`.
 */
const blockField = makeBlockField((kind, text, from) => {
  if (kind === "table") return new TableWidget(text, from);
  if (kind === "html") return new HtmlWidget(text, from);
  const start = text.indexOf("$$") + 2;
  return new MathWidget(text.slice(start, text.indexOf("$$", start)), true, from);
});

/** Block widgets for tables, multi-line math and multi-line HTML. */
export function blockBlocks() {
  return blockField;
}

/**
 * A block widget replaces whole lines, so CodeMirror's gutter has no text line
 * to number for them and the numbers after the block look offset. Show the
 * block's starting line number in the blank slot instead.
 */
class BlockLineMarker extends GutterMarker {
  constructor(readonly number: number) {
    super();
  }

  eq(other: BlockLineMarker): boolean {
    return other.number === this.number;
  }

  toDOM(): Text {
    return document.createTextNode(String(this.number));
  }
}

/** Line numbers for the rendered block widgets (tables, math, HTML). */
export function blockLineNumbers() {
  return lineNumberWidgetMarker.of(
    (view: EditorView, widget: WidgetType, block: BlockInfo) => {
      if (
        widget instanceof TableWidget ||
        widget instanceof MathWidget ||
        widget instanceof HtmlWidget
      ) {
        return new BlockLineMarker(view.state.doc.lineAt(block.from).number);
      }
      return null;
    },
  );
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
