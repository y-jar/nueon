//! Block detection: fenced code and table regions.
/**
 * Block scanning for live preview: which line ranges are GFM tables,
 * multi-line display math (`$$ … $$`) and multi-line HTML blocks, plus the
 * line ranges that are code (fenced or indented) and must stay plain.
 *
 * Pure over an `EditorState` so it can be unit-tested and reused. This module
 * holds no widgets and imports no CSS; `livePreview` supplies the widget
 * factory. A `ViewPlugin` may not replace line breaks, so the widgets are
 * produced by the state field built here.
 */
import {
  StateField,
  type EditorState,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  type DecorationSet,
  type WidgetType,
} from "@codemirror/view";

import { isDelimiterRow } from "./table.ts";

export type BlockKind = "table" | "math" | "html";

/** A block widget's document range. */
export interface BlockRange {
  kind: BlockKind;
  from: number;
  to: number;
}

/** A block range plus the line number it ends on (scan-internal). */
interface ScannedBlock extends BlockRange {
  last: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_MARKER = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const HTML_START = /^\s*<(?!https?:)[a-zA-Z!/]/;

function indentColumns(text: string): number {
  const indent = /^[ \t]*/.exec(text)?.[0] ?? "";
  return indent.replace(/\t/g, "    ").length;
}

/**
 * The 1-based numbers of lines inside a fenced (``` / ~~~) or indented code
 * block. An unclosed fence runs to the end of the document. Indented lines
 * that continue a list item are list content, not indented code.
 */
export function codeLines(state: EditorState): Set<number> {
  const { doc } = state;
  const lines = new Set<number>();
  let fence: { char: string; length: number } | null = null;
  let listIndent = -1;

  for (let number = 1; number <= doc.lines; number += 1) {
    const text = doc.line(number).text;
    const opener = FENCE.exec(text);

    if (fence) {
      lines.add(number);
      if (
        opener &&
        opener[1][0] === fence.char &&
        opener[1].length >= fence.length &&
        text.slice(opener[0].length).trim() === ""
      ) {
        fence = null;
      }
      continue;
    }

    if (opener) {
      fence = { char: opener[1][0], length: opener[1].length };
      lines.add(number);
      continue;
    }

    const marker = LIST_MARKER.exec(text);
    if (marker) {
      listIndent = marker[0].length;
      continue;
    }

    if (text.trim() === "") continue;

    const columns = indentColumns(text);
    if (columns >= 4 && !(listIndent >= 0 && columns >= listIndent)) {
      lines.add(number);
    } else if (columns < 4) {
      listIndent = -1;
    }
  }

  return lines;
}

/** The multi-line `$$ … $$` block starting at `number`, or null. */
function mathBlock(state: EditorState, number: number): ScannedBlock | null {
  const { doc } = state;
  let last = number;
  let raw = doc.line(number).text;
  if (raw.indexOf("$$", raw.indexOf("$$") + 2) === -1) {
    while (last < doc.lines) {
      last += 1;
      const next = doc.line(last).text;
      raw += `\n${next}`;
      if (next.includes("$$")) break;
    }
  }
  const innerStart = raw.indexOf("$$") + 2;
  const innerEnd = raw.indexOf("$$", innerStart);
  if (innerEnd === -1) return null;
  if (last === number) return null; // single-line stays in the plugin
  return {
    kind: "math",
    from: doc.line(number).from,
    to: doc.line(last).to,
    last,
  };
}

/**
 * Every multi-line block in the document, in order. Code lines are skipped,
 * so a table, math block or HTML block inside a fence or indented code stays
 * plain.
 */
export function scanBlocks(state: EditorState): BlockRange[] {
  const { doc } = state;
  const code = codeLines(state);
  const blocks: ScannedBlock[] = [];

  for (let number = 1; number <= doc.lines; number += 1) {
    if (code.has(number)) continue;
    const line = doc.line(number);
    const next = number < doc.lines ? doc.line(number + 1) : null;

    if (line.text.includes("|") && next && isDelimiterRow(next.text)) {
      let last = number + 1;
      while (
        last < doc.lines &&
        doc.line(last + 1).text.includes("|") &&
        doc.line(last + 1).text.trim() !== ""
      ) {
        last += 1;
      }
      blocks.push({ kind: "table", from: line.from, to: doc.line(last).to, last });
      number = last;
      continue;
    }

    if (line.text.trimStart().startsWith("$$")) {
      const math = mathBlock(state, number);
      if (math) {
        blocks.push(math);
        number = math.last;
        continue;
      }
    }

    if (HTML_START.test(line.text)) {
      let last = number;
      while (last < doc.lines && doc.line(last + 1).text.trim() !== "") last += 1;
      if (last > number) {
        blocks.push({ kind: "html", from: line.from, to: doc.line(last).to, last });
        number = last;
        continue;
      }
    }
  }

  return blocks.map(({ kind, from, to }) => ({ kind, from, to }));
}

/** Whether each block contains the current selection (so it stays raw). */
export function activeFlags(state: EditorState, ranges: BlockRange[]): boolean[] {
  const active = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number += 1) active.add(number);
  }
  return ranges.map((range) => {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number += 1) {
      if (active.has(number)) return true;
    }
    return false;
  });
}

function decorate(
  state: EditorState,
  ranges: BlockRange[],
  flags: boolean[],
  render: (kind: BlockKind, text: string, from: number) => WidgetType,
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  ranges.forEach((range, index) => {
    if (flags[index]) return;
    const text = state.doc.sliceString(range.from, range.to);
    decorations.push(
      Decoration.replace({
        widget: render(range.kind, text, range.from),
        block: true,
      }).range(range.from, range.to),
    );
  });
  return Decoration.set(decorations, true);
}

/** A field's value: the blocks, which are active, and the resulting widgets. */
export interface BlockState {
  ranges: BlockRange[];
  activeFlags: boolean[];
  decorations: DecorationSet;
}

/**
 * Build the block-widget state field. `render` turns a scanned block into a
 * widget (kept out of this module so the widgets' DOM/CSS imports stay in
 * `livePreview`).
 *
 * Selection-only transactions reuse the previous value unless a block gained
 * or lost the cursor, so moving inside a table does not rebuild decorations.
 */
export function makeBlockField(
  render: (kind: BlockKind, text: string, from: number) => WidgetType,
): StateField<BlockState> {
  const build = (state: EditorState): BlockState => {
    const ranges = scanBlocks(state);
    const flags = activeFlags(state, ranges);
    return { ranges, activeFlags: flags, decorations: decorate(state, ranges, flags, render) };
  };

  return StateField.define<BlockState>({
    create: build,
    update: (value, tr) => {
      if (tr.docChanged) return build(tr.state);
      const flags = activeFlags(tr.state, value.ranges);
      const changed = flags.some((flag, index) => flag !== value.activeFlags[index]);
      if (!changed) return value;
      return {
        ranges: value.ranges,
        activeFlags: flags,
        decorations: decorate(tr.state, value.ranges, flags, render),
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
}
