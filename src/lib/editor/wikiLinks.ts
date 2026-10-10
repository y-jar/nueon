import { StateEffect, StateField } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
  hoverTooltip,
} from "@codemirror/view";

import {
  isLinkRevealed,
  parseWikiLinks,
  rankCompletions,
  resolveNotePath,
  resolveWikiTarget,
  type WikiTarget,
} from "../wikilink.ts";
import { codeLines } from "./blocks.ts";
import { wordIndexField } from "./dictionary.ts";

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

/** Holds note → headings, updated via `setNoteHeadings`. */
export const setNoteHeadings = StateEffect.define<Record<string, string[]>>();

export const noteHeadingsField = StateField.define<Record<string, string[]>>({
  create: () => ({}),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(setNoteHeadings)) next = effect.value;
    }
    return next;
  },
});

/** Holds the Fixes table names, updated via `setFixesTables`. */
export const setFixesTables = StateEffect.define<Set<string>>();

export const fixesTablesField = StateField.define<Set<string>>({
  create: () => new Set(),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(setFixesTables)) next = effect.value;
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
  const headings = view.state.field(noteHeadingsField);
  for (const link of parseWikiLinks(line.text)) {
    if (offset >= link.from && offset <= link.to) {
      return {
        target: resolveWikiTarget(link.target, link.heading, index, notes, headings),
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
  if (target.kind === "note") {
    if (target.headingResolved === false) {
      return "cm-wikilink cm-wikilink-note cm-wikilink-heading-broken";
    }
    return "cm-wikilink cm-wikilink-note";
  }
  return "cm-wikilink cm-wikilink-unresolved";
}

/** Inline definition shown for a `![[word]]` embed. */
class EmbedWidget extends WidgetType {
  readonly wordname: string;
  readonly senses: string[];

  constructor(wordname: string, senses: string[]) {
    super();
    this.wordname = wordname;
    this.senses = senses;
  }

  eq(other: EmbedWidget): boolean {
    return other.wordname === this.wordname;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-wikilink-embed-widget";
    span.textContent = this.senses.length
      ? `${this.wordname} (${this.senses.join("; ")})`
      : this.wordname;
    return span;
  }
}

/** Collapsed `[[...]]` display: the alias (or target) plus a muted heading. */
class LinkWidget extends WidgetType {
  readonly text: string;
  readonly heading: string | null;
  readonly classes: string;
  readonly follow: () => void;

  constructor(
    text: string,
    heading: string | null,
    classes: string,
    follow: () => void,
  ) {
    super();
    this.text = text;
    this.heading = heading;
    this.classes = classes;
    this.follow = follow;
  }

  eq(other: LinkWidget): boolean {
    return (
      other.text === this.text &&
      other.heading === this.heading &&
      other.classes === this.classes
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `${this.classes} cm-wikilink-hidden`;
    span.textContent = this.text;
    if (this.heading) {
      const heading = document.createElement("span");
      heading.className = "cm-wikilink-heading";
      heading.textContent = `#${this.heading}`;
      span.appendChild(heading);
    }
    // A replace widget is atomic to CodeMirror's own click handling, so the
    // follow is bound directly to the element (Ctrl/Cmd+click only).
    span.addEventListener("mousedown", (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      event.stopPropagation();
      this.follow();
    });
    return span;
  }
}

function build(
  view: EditorView,
  getFollow: () => ((target: WikiTarget) => void) | undefined,
): DecorationSet {
  const index = view.state.field(wordIndexField);
  const notes = view.state.field(notePathsField);
  const headings = view.state.field(noteHeadingsField);
  const code = codeLines(view.state);
  const ranges: Range<Decoration>[] = [];
  const selection = view.state.selection.ranges;
  const follow = getFollow();
  for (const visible of view.visibleRanges) {
    const text = view.state.sliceDoc(visible.from, visible.to);
    for (const link of parseWikiLinks(text)) {
      const from = visible.from + link.from;
      const to = visible.from + link.to;
      if (code.has(view.state.doc.lineAt(from).number)) continue;
      const target = resolveWikiTarget(link.target, link.heading, index, notes, headings);
      const classes = classFor(target, link.embed);
      if (link.embed && target.kind === "word") {
        ranges.push(
          Decoration.replace({
            widget: new EmbedWidget(target.wordname, target.senses),
          }).range(from, to),
        );
      } else if (!link.embed) {
        if (isLinkRevealed(from, to, selection)) {
          ranges.push(Decoration.mark({ class: classes }).range(from, to));
        } else {
          ranges.push(
            Decoration.replace({
              widget: new LinkWidget(
                link.alias ?? link.target,
                link.heading,
                classes,
                () => follow?.(target),
              ),
            }).range(from, to),
          );
        }
      } else {
        ranges.push(Decoration.mark({ class: classes }).range(from, to));
      }
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
        this.decorations = build(view, getFollow);
      }

      update(update: ViewUpdate) {
        const changed =
          update.startState.field(wordIndexField) !==
            update.state.field(wordIndexField) ||
          update.startState.field(notePathsField) !==
            update.state.field(notePathsField) ||
          update.startState.field(noteHeadingsField) !==
            update.state.field(noteHeadingsField);
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          changed
        ) {
          this.decorations = build(update.view, getFollow);
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
          title.textContent = link.target.heading
            ? `${link.target.path}#${link.target.heading}`
            : link.target.path;
          dom.appendChild(title);
          if (link.target.headingResolved === false) {
            const broken = document.createElement("div");
            broken.className = "muted";
            broken.textContent = "heading not found";
            dom.appendChild(broken);
          }
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

/** Autocomplete dependencies the app supplies (async, via IPC). */
export interface WikiCompletionDeps {
  /** Read a note's headings (for the `#heading` mode). */
  getHeadings?: (path: string) => Promise<string[]>;
  /** Create an empty note in the current note's folder (the fallback row). */
  createNote?: (name: string) => Promise<void>;
}

interface LinkCandidate {
  name: string;
  applyName: string;
  type: "word" | "note";
  detail: string;
  fixes?: boolean;
}

/** Consume an auto-closed `]]` right after the match. */
function consumeTo(context: CompletionContext, match: { from: number; to: number }): number {
  const after = context.state.sliceDoc(match.to, match.to + 2);
  return after === "]]" ? match.to + 2 : match.to;
}

function optionsFor(
  context: CompletionContext,
  match: { from: number; to: number },
  options: Completion[],
): CompletionResult | null {
  if (options.length === 0) return null;
  return {
    from: match.from,
    to: consumeTo(context, match),
    options,
    // The source already ranks and filters, and `from` points at the `[[`, so
    // CodeMirror's default fuzzy filter would match "[[ky" against the labels
    // and hide every option. Disable it and re-run the source each keystroke.
    filter: false,
  };
}

/**
 * The completion source: words and notes while typing a target, that note's
 * headings after `#`, and nothing after `|` (the alias is free text). When
 * nothing matches, a "Create note" row offers to make an empty note.
 */
export function wikiCompletionSource(
  context: CompletionContext,
  deps: WikiCompletionDeps = {},
): CompletionResult | null | Promise<CompletionResult | null> {
  const match = context.matchBefore(/\[\[[^\[\]\n]*/);
  if (!match) return null;
  const inner = match.text.slice(2);
  if (inner.includes("|")) return null; // typing the alias

  const index = context.state.field(wordIndexField);
  const notes = context.state.field(notePathsField);
  const headings = context.state.field(noteHeadingsField);
  const fixesTables = context.state.field(fixesTablesField);

  const hash = inner.indexOf("#");
  if (hash >= 0) {
    // Heading mode: list the target note's headings.
    const target = inner.slice(0, hash).trim();
    const query = inner.slice(hash + 1).toLowerCase();
    const path = resolveNotePath(target, notes);
    if (!path) return null;
    const finish = (list: string[]): CompletionResult | null => {
      const options = rankCompletions(
        query,
        list.map((text) => ({ name: text })),
      )
        .slice(0, 20)
        .map((entry): Completion => ({
          label: entry.name,
          type: "heading",
          apply: `[[${target}#${entry.name}]]`,
        }));
      return optionsFor(context, match, options);
    };
    const cached = headings[path];
    if (cached) return finish(cached);
    if (!deps.getHeadings) return null;
    return deps.getHeadings(path).then(finish);
  }

  // Target mode: words and notes, mixed and ranked.
  const query = inner.toLowerCase();
  const typed = inner.trim();
  const words: LinkCandidate[] = [];
  for (const hits of Object.values(index)) {
    if (!hits.length) continue;
    words.push({
      name: hits[0].wordname,
      applyName: hits[0].wordname,
      type: "word",
      detail: hits[0].table,
      fixes: fixesTables.has(hits[0].table),
    });
  }
  const noteCandidates: LinkCandidate[] = [];
  for (const path of notes) {
    const base = (path.split("/").pop() ?? path).replace(/\.md$/, "");
    const folder = path.includes("/")
      ? path.split("/").slice(0, -1).join("/")
      : "";
    noteCandidates.push({ name: base, applyName: base, type: "note", detail: folder });
  }
  const all = [...words, ...noteCandidates];
  const groups = new Map<string, LinkCandidate[]>();
  for (const candidate of all) {
    const key = candidate.name.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  const disambiguated = all.map((candidate) => {
    const group = groups.get(candidate.name.toLowerCase())!;
    if (group.length > 1 && candidate.detail) {
      return { ...candidate, name: `${candidate.name} (${candidate.detail})` };
    }
    return candidate;
  });

  const ranked = rankCompletions(query, disambiguated).slice(0, 20);
  const options: Completion[] = ranked.map((candidate) => ({
    label: candidate.name,
    type: candidate.type,
    detail: candidate.detail,
    apply: `[[${candidate.applyName}]]`,
  }));

  if (options.length === 0 && typed && deps.createNote) {
    options.push({
      label: `Create note: ${typed}`,
      type: "note",
      apply: (view, _completion, from, to) => {
        void deps.createNote!(typed).catch(() => {});
        view.dispatch({
          changes: { from, to, insert: `[[${typed}]]` },
          selection: EditorSelection.cursor(from + typed.length + 4),
          userEvent: "input.complete",
        });
      },
    });
  }

  return optionsFor(context, match, options);
}

export function wikiCompletion(
  getDeps: () => WikiCompletionDeps,
) {
  return autocompletion({
    override: [(context) => wikiCompletionSource(context, getDeps())],
  });
}
