import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type EditorState,
  type SelectionRange,
} from "@codemirror/state";
import type { Command, EditorView, KeyBinding } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { generateTable, serializeTable } from "./table.ts";

/** Which inline/block formats apply at the cursor (drives toolbar highlights). */
export interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  bullet: boolean;
  ordered: boolean;
  task: boolean;
  quote: boolean;
  code: boolean;
}

export const EMPTY_FORMAT: FormatState = {
  bold: false,
  italic: false,
  underline: false,
  bullet: false,
  ordered: false,
  task: false,
  quote: false,
  code: false,
};

type LineKind = "bullet" | "ordered" | "task" | "quote";

const TASK = /^(\s*)[-*+]\s+\[[ xX]\]\s+/;
const BULLET = /^(\s*)[-*+]\s+/;
const ORDERED = /^(\s*)\d+[.)]\s+/;
const QUOTE = /^(\s*)>\s?/;

/** The list/quote kind of a line and the length of its marker (after indent). */
function linePrefix(text: string): { kind: LineKind; indent: number; marker: number } | null {
  const tests: [LineKind, RegExp][] = [
    ["task", TASK],
    ["bullet", BULLET],
    ["ordered", ORDERED],
    ["quote", QUOTE],
  ];
  for (const [kind, pattern] of tests) {
    const match = pattern.exec(text);
    if (match) {
      return {
        kind,
        indent: match[1].length,
        marker: match[0].length - match[1].length,
      };
    }
  }
  return null;
}

function treeOf(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length, 2000) ?? syntaxTree(state);
}

function enclosing(state: EditorState, pos: number, names: string[]): SyntaxNode | null {
  let node: SyntaxNode | null = treeOf(state).resolveInner(pos, 0);
  while (node) {
    if (names.includes(node.name)) return node;
    node = node.parent;
  }
  return null;
}

/** Block contexts where headings and strikethrough must not apply. */
const CODE_OR_TABLE = ["FencedCode", "CodeBlock", "Table"];

/**
 * Whether a line sits inside code or a table. Probes just inside the line:
 * `resolveInner` at the exact boundary (`line.from`) is ambiguous and can
 * report the node before the fence.
 */
function lineBlocked(
  state: EditorState,
  line: { from: number; to: number },
): boolean {
  const pos = Math.min(line.from + 1, line.to);
  return enclosing(state, pos, CODE_OR_TABLE) !== null;
}

/** Whether `range` sits inside a `<u>…</u>` pair on one line. */
function insideUnderline(state: EditorState, range: SelectionRange): boolean {
  const line = state.doc.lineAt(range.from);
  const offset = range.from - line.from;
  const open = line.text.lastIndexOf("<u>", offset);
  if (open === -1) return false;
  const close = line.text.indexOf("</u>", open);
  return close !== -1 && open + 3 <= offset && range.to - line.from <= close;
}

/** Formats active at the main selection. */
export function formatAt(state: EditorState): FormatState {
  const range = state.selection.main;
  const text = state.doc.lineAt(range.head).text;
  const kind = linePrefix(text)?.kind;
  return {
    bold: enclosing(state, range.from, ["StrongEmphasis"]) !== null,
    italic: enclosing(state, range.from, ["Emphasis"]) !== null,
    underline: insideUnderline(state, range),
    bullet: kind === "bullet",
    ordered: kind === "ordered",
    task: kind === "task",
    quote: kind === "quote",
    code: enclosing(state, range.from, ["FencedCode", "InlineCode"]) !== null,
  };
}

/** Wrap, or unwrap, selections in Markdown emphasis marks. */
function toggleEmphasis(nodeName: "StrongEmphasis" | "Emphasis", mark: string): Command {
  return (view) => {
    const { state } = view;
    const transaction = state.changeByRange((range) => {
      const node = enclosing(state, range.from, [nodeName]);
      if (node && node.to >= range.to) {
        const marks = node.getChildren("EmphasisMark");
        if (marks.length >= 2) {
          const first = marks[0];
          const last = marks[marks.length - 1];
          const shift = first.to - first.from;
          const from = Math.max(first.from, range.from - shift);
          const to = Math.max(from, Math.min(last.from - shift, range.to - shift));
          return {
            changes: [
              { from: first.from, to: first.to },
              { from: last.from, to: last.to },
            ],
            range: EditorSelection.range(from, to),
          };
        }
      }
      if (range.empty) {
        return {
          changes: { from: range.from, insert: mark + mark },
          range: EditorSelection.cursor(range.from + mark.length),
        };
      }
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(range.from + mark.length, range.to + mark.length),
      };
    });
    view.dispatch(state.update(transaction, { scrollIntoView: true, userEvent: "input.format" }));
    return true;
  };
}

export const toggleBold = toggleEmphasis("StrongEmphasis", "**");
export const toggleItalic = toggleEmphasis("Emphasis", "*");

/** Markdown has no underline, so it uses inline `<u>` HTML. */
export const toggleUnderline: Command = (view) => {
  const { state } = view;
  const open = "<u>";
  const close = "</u>";
  const transaction = state.changeByRange((range) => {
    const before = state.doc.sliceString(Math.max(0, range.from - open.length), range.from);
    const after = state.doc.sliceString(range.to, range.to + close.length);
    if (before === open && after === close) {
      return {
        changes: [
          { from: range.from - open.length, to: range.from },
          { from: range.to, to: range.to + close.length },
        ],
        range: EditorSelection.range(range.from - open.length, range.to - open.length),
      };
    }
    const selected = state.doc.sliceString(range.from, range.to);
    if (
      selected.length >= open.length + close.length &&
      selected.startsWith(open) &&
      selected.endsWith(close)
    ) {
      return {
        changes: { from: range.from, to: range.to, insert: selected.slice(3, -4) },
        range: EditorSelection.range(range.from, range.to - open.length - close.length),
      };
    }
    if (range.empty) {
      return {
        changes: { from: range.from, insert: open + close },
        range: EditorSelection.cursor(range.from + open.length),
      };
    }
    return {
      changes: [
        { from: range.from, insert: open },
        { from: range.to, insert: close },
      ],
      range: EditorSelection.range(range.from + open.length, range.to + open.length),
    };
  });
  view.dispatch(state.update(transaction, { scrollIntoView: true, userEvent: "input.format" }));
  return true;
};

/** Line numbers touched by the selection (a trailing empty line is excluded). */
function selectedLines(state: EditorState): number[] {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    if (!range.empty && last > first && state.doc.line(last).from === range.to) last -= 1;
    for (let n = first; n <= last; n += 1) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Toggle a bullet / numbered / task / quote marker on the selected lines. */
function toggleLines(kind: LineKind): Command {
  return (view) => {
    const { state } = view;
    const lines = selectedLines(state).map((n) => state.doc.line(n));
    const filled = lines.filter((line) => line.text.trim() !== "");
    const targets = filled.length > 0 ? filled : lines;
    const remove = targets.every((line) => linePrefix(line.text)?.kind === kind);

    let counter = 1;
    const changes = targets.map((line) => {
      const existing = linePrefix(line.text);
      const indent = existing ? existing.indent : (/^\s*/.exec(line.text)?.[0].length ?? 0);
      const start = line.from + indent;
      const end = existing ? start + existing.marker : start;
      let insert = "";
      if (!remove) {
        insert =
          kind === "bullet"
            ? "- "
            : kind === "task"
              ? "- [ ] "
              : kind === "quote"
                ? "> "
                : `${counter}. `;
        counter += 1;
      }
      return { from: start, to: end, insert };
    });
    view.dispatch({ changes, scrollIntoView: true, userEvent: "input.format" });
    return true;
  };
}

export const toggleBulletList = toggleLines("bullet");
export const toggleNumberedList = toggleLines("ordered");
export const toggleTaskList = toggleLines("task");
export const toggleBlockquote = toggleLines("quote");

/**
 * Set the selected lines to an ATX heading: `level` 1–6 sets that level, the
 * same level again removes it, and level 0 clears any heading. Lines inside
 * code blocks or a table are left alone; an all-ineligible selection is a
 * no-op. One dispatch, so it is a single undo step.
 */
export function setHeading(level: number): Command {
  return (view) => {
    const { state } = view;
    const changes: { from: number; to?: number; insert?: string }[] = [];
    for (const number of selectedLines(state)) {
      const line = state.doc.line(number);
      if (line.text.trim() === "") continue;
      if (lineBlocked(state, line)) continue;
      const indent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
      const start = line.from + indent;
      const match = /^(#{1,6})[ \t]+/.exec(line.text.slice(indent));
      if (match) {
        if (level === 0 || match[1].length === level) {
          changes.push({ from: start, to: start + match[0].length, insert: "" });
        } else {
          changes.push({
            from: start,
            to: start + match[1].length,
            insert: "#".repeat(level),
          });
        }
      } else if (level > 0) {
        changes.push({ from: start, insert: `${"#".repeat(level)} ` });
      }
    }
    if (!changes.length) return false;
    view.dispatch({ changes, scrollIntoView: true, userEvent: "input.format" });
    return true;
  };
}

export const clearHeading = setHeading(0);

/**
 * Toggle `~~strikethrough~~`. A partial single-line selection wraps just the
 * selected text; an empty cursor or a multi-line selection wraps each selected
 * line (skipping blank, code and table lines). No-op inside code or a table.
 */
export const toggleStrikethrough: Command = (view) => {
  const { state } = view;
  const main = state.selection.main;
  if (lineBlocked(state, state.doc.lineAt(main.from))) return false;
  const first = state.doc.lineAt(main.from).number;
  const last = state.doc.lineAt(main.to).number;

  if (!main.empty && first === last) {
    const before = state.doc.sliceString(Math.max(0, main.from - 2), main.from);
    const after = state.doc.sliceString(main.to, main.to + 2);
    if (before === "~~" && after === "~~") {
      view.dispatch({
        changes: [
          { from: main.from - 2, to: main.from },
          { from: main.to, to: main.to + 2 },
        ],
        userEvent: "input.format",
      });
    } else {
      view.dispatch({
        changes: [
          { from: main.from, insert: "~~" },
          { from: main.to, insert: "~~" },
        ],
        userEvent: "input.format",
      });
    }
    return true;
  }

  const changes: { from: number; to?: number; insert?: string }[] = [];
  for (let number = first; number <= last; number += 1) {
    const line = state.doc.line(number);
    if (line.text.trim() === "") continue;
    if (lineBlocked(state, line)) continue;
    const start = line.from + (line.text.length - line.text.trimStart().length);
    const end = line.from + line.text.trimEnd().length;
    if (line.text.slice(start - line.from, end - line.from).startsWith("~~")) {
      changes.push({ from: start, to: start + 2, insert: "" });
      changes.push({ from: end - 2, to: end, insert: "" });
    } else {
      changes.push({ from: start, insert: "~~" });
      changes.push({ from: end, insert: "~~" });
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes, scrollIntoView: true, userEvent: "input.format" });
  return true;
};

/**
 * Insert a block (table, rule, …) on its own lines after the current line,
 * optionally selecting `select` (offsets within `block`).
 */
function insertBlock(
  view: EditorView,
  block: string,
  select?: { from: number; to: number },
): void {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const blank = line.text.trim() === "";
  const from = blank ? line.from : line.to;
  const to = line.to;
  const prefix = blank ? "" : "\n\n";
  const text = prefix + block;
  const base = from + prefix.length;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: select
      ? EditorSelection.range(base + select.from, base + select.to)
      : EditorSelection.cursor(from + text.length),
    scrollIntoView: true,
    userEvent: "input.format",
  });
}

/** Wrap the selection in a fenced code block, or remove the fence it is in. */
export const toggleCodeBlock: Command = (view) => {
  const { state } = view;
  const main = state.selection.main;
  const fence = enclosing(state, main.from, ["FencedCode"]);
  if (fence) {
    const first = state.doc.lineAt(fence.from);
    const last = state.doc.lineAt(fence.to);
    const changes = [{ from: first.from, to: Math.min(first.to + 1, state.doc.length) }];
    if (last.number !== first.number && /^\s*(```|~~~)/.test(last.text)) {
      changes.push({ from: Math.max(last.from - 1, first.to + 1), to: last.to });
    }
    view.dispatch({ changes, userEvent: "input.format" });
    return true;
  }
  if (main.empty) {
    insertBlock(view, "```\n\n```", { from: 4, to: 4 });
  } else {
    const selected = state.doc.sliceString(main.from, main.to);
    view.dispatch({
      changes: { from: main.from, to: main.to, insert: `\`\`\`\n${selected}\n\`\`\`` },
      userEvent: "input.format",
    });
  }
  return true;
};

export const insertTable: Command = (view) => {
  const block = serializeTable(generateTable(3, 1));
  // Cursor lands in the first header cell.
  insertBlock(view, block, { from: 2, to: 2 });
  return true;
};

export const insertHorizontalRule: Command = (view) => {
  insertBlock(view, "---\n");
  return true;
};

/** Insert `[text](url)`, using the selection as the link text. */
export const insertLink: Command = (view) => {
  const { state } = view;
  const main = state.selection.main;
  const text = main.empty ? "text" : state.doc.sliceString(main.from, main.to);
  const urlFrom = main.from + text.length + 3;
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: `[${text}](url)` },
    selection: EditorSelection.range(urlFrom, urlFrom + 3),
    scrollIntoView: true,
    userEvent: "input.format",
  });
  return true;
};

/** Insert an image reference at the selection (or at `pos`). */
export function insertImageMarkdown(
  view: EditorView,
  alt: string,
  src: string,
  pos?: number,
): void {
  const main = view.state.selection.main;
  const from = pos ?? main.from;
  const to = pos ?? main.to;
  const markdown = `![${alt}](${src})`;
  view.dispatch({
    changes: { from, to, insert: markdown },
    selection: EditorSelection.cursor(from + markdown.length),
    scrollIntoView: true,
    userEvent: "input.drop",
  });
}

/** Insert plain text (a link reference, …) at `pos` or the selection. */
export function insertTextAt(view: EditorView, text: string, pos?: number): void {
  const main = view.state.selection.main;
  const from = pos ?? main.from;
  const to = pos ?? main.to;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + text.length),
    scrollIntoView: true,
    userEvent: "input.drop",
  });
}

/** Non-command handlers the Markdown keymap needs. */
export interface MarkdownKeymapHandlers {
  /** Open the image picker (the toolbar's insert-image action). */
  onImage?: () => void;
}

/**
 * Standard Markdown keybinds; must take precedence over the default keymap.
 * The image keybind needs the picker the component owns, so it is supplied
 * through `handlers`.
 */
export function buildMarkdownKeymap(
  handlers: MarkdownKeymapHandlers = {},
): readonly KeyBinding[] {
  return [
    { key: "Mod-b", run: toggleBold, preventDefault: true },
    { key: "Mod-i", run: toggleItalic, preventDefault: true },
    { key: "Mod-u", run: toggleUnderline, preventDefault: true },
    { key: "Mod-k", run: insertLink, preventDefault: true },
    { key: "Mod-Shift-8", run: toggleBulletList, preventDefault: true },
    { key: "Mod-Shift-7", run: toggleNumberedList, preventDefault: true },
    { key: "Mod-Shift-9", run: toggleBlockquote, preventDefault: true },
    // Mod-Shift-l toggles a task list item; Mod-Shift-t inserts a table.
    { key: "Mod-Shift-l", run: toggleTaskList, preventDefault: true },
    { key: "Mod-Shift-t", run: insertTable, preventDefault: true },
    { key: "Mod-Shift-c", run: toggleCodeBlock, preventDefault: true },
    { key: "Mod-1", run: setHeading(1), preventDefault: true },
    { key: "Mod-2", run: setHeading(2), preventDefault: true },
    { key: "Mod-3", run: setHeading(3), preventDefault: true },
    { key: "Mod-4", run: setHeading(4), preventDefault: true },
    { key: "Mod-5", run: setHeading(5), preventDefault: true },
    { key: "Mod-6", run: setHeading(6), preventDefault: true },
    { key: "Mod-0", run: clearHeading, preventDefault: true },
    { key: "Mod-Shift-x", run: toggleStrikethrough, preventDefault: true },
    {
      key: "Mod-Shift-p",
      run: () => {
        if (!handlers.onImage) return false;
        handlers.onImage();
        return true;
      },
    },
  ];
}
