//! Pure [[...]] link parsing, ranking and resolution.
/**
 * Obsidian-style `[[...]]` note links. Kept free of Svelte/Tauri so the parse
 * and resolution rules can be unit-tested.
 */

import type { NoteNode, WordIndex } from "./api";

/** One `[[target]]`, `[[target|alias]]`, `[[target#heading]]` or an embed. */
export interface WikiLink {
  /** Absolute offsets of the whole `[[...]]` span. */
  from: number;
  to: number;
  target: string;
  alias: string | null;
  heading: string | null;
  embed: boolean;
}

/** Every file path under a note tree, for resolving `[[note]]` links. */
export function notePathSet(nodes: NoteNode[]): Set<string> {
  const paths = new Set<string>();
  const walk = (list: NoteNode[]) => {
    for (const node of list) {
      if (node.is_dir) walk(node.children);
      else paths.add(node.path);
    }
  };
  walk(nodes);
  return paths;
}

const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)(?:\|([^\[\]\n]+?))?\]\]/g;

/** Every wiki link in `text`, with its offsets. */
export function parseWikiLinks(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(text))) {
    const targetPart = match[2].trim();
    const hash = targetPart.indexOf("#");
    links.push({
      from: match.index,
      to: match.index + match[0].length,
      target: (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim(),
      heading: hash >= 0 ? targetPart.slice(hash + 1).trim() : null,
      alias: match[3] ? match[3].trim() : null,
      embed: match[1] === "!",
    });
  }
  return links;
}

/** A document selection range (from and to, inclusive of the endpoints). */
export interface LinkSelectionRange {
  from: number;
  to: number;
}

/**
 * Whether a link's raw text should be shown. A link is revealed whenever any
 * selection range touches it: a cursor inside it, a cursor sitting on either
 * end, or a selection that overlaps it.
 */
export function isLinkRevealed(
  from: number,
  to: number,
  ranges: readonly LinkSelectionRange[],
): boolean {
  return ranges.some((range) => range.from <= to && range.to >= from);
}

/**
 * If `offset` sits strictly inside a `[[...]]` link (after the opening `[[`
 * and before the closing `]]`, including the alias and heading parts, and the
 * `!` of an embed), return the absolute offset just after the closing `]]`.
 * Returns null at the very start of the link, after it, in plain text, or when
 * the link is inside a fenced code block.
 */
export function linkExit(text: string, offset: number): number | null {
  const lines = text.split("\n");
  let start = 0;
  let fence: string | null = null;
  let targetLine: string | null = null;
  let targetStart = 0;
  for (const line of lines) {
    const end = start + line.length;
    if (offset >= start && offset <= end) {
      targetLine = line;
      targetStart = start;
      break;
    }
    const trimmed = line.trim();
    const opener = trimmed.match(/^(```|~~~)/);
    if (opener) {
      if (fence === null) fence = opener[1];
      else if (fence === opener[1]) fence = null;
    }
    start = end + 1;
  }
  if (targetLine === null || fence !== null) return null;
  const lineOffset = offset - targetStart;
  for (const link of parseWikiLinks(targetLine)) {
    if (lineOffset > link.from && lineOffset < link.to) {
      return targetStart + link.to;
    }
  }
  return null;
}

/** Strip inline formatting (bold, italic, code, links) from heading text. */
function stripInline(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** One ATX heading: its cleaned text and 1-indexed line number. */
export interface HeadingPosition {
  text: string;
  line: number;
}

/**
 * The ATX headings (`#` through `######`) in a Markdown note, in order.
 * Headings inside fenced code blocks are skipped, a trailing run of `#` is
 * dropped, and inline formatting is stripped.
 */
export function headingPositions(markdown: string): HeadingPosition[] {
  const positions: HeadingPosition[] = [];
  let fence: string | null = null;
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const opener = trimmed.match(/^(```|~~~)/);
    if (opener) {
      if (fence === null) fence = opener[1];
      else if (fence === opener[1]) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = line.match(/^(#{1,6})[ \t]+(.*)$/);
    if (!heading) continue;
    const text = heading[2].replace(/#+\s*$/, "").trim();
    if (text) positions.push({ text: stripInline(text), line: index + 1 });
  }
  return positions;
}

/** The heading texts of a Markdown note, in order. */
export function parseHeadings(markdown: string): string[] {
  return headingPositions(markdown).map((position) => position.text);
}

/** The 1-indexed line of the first heading matching `heading` (0 if none). */
export function headingLine(markdown: string, heading: string): number {
  const needle = heading.toLowerCase();
  const found = headingPositions(markdown).find(
    (position) => position.text.toLowerCase() === needle,
  );
  return found ? found.line : 0;
}

/** A resolved link target: a dictionary word, a note, or nothing. */
export type WikiTarget =
  | { kind: "word"; table: string; id: string; wordname: string; senses: string[] }
  | {
      kind: "note";
      path: string;
      heading: string | null;
      /** null when unknown (optimistic); otherwise whether the heading exists. */
      headingResolved: boolean | null;
    }
  | { kind: "missing" };

/** Resolve `target` against the note paths, returning the matching path. */
export function resolveNotePath(target: string, notePaths: Set<string>): string | null {
  if (notePaths.has(target)) return target;
  if (notePaths.has(`${target}.md`)) return `${target}.md`;
  for (const path of notePaths) {
    if (path.endsWith(`/${target}.md`)) return path;
  }
  const base = target.split("/").pop() ?? target;
  for (const path of notePaths) {
    const name = (path.split("/").pop() ?? path).replace(/\.md$/, "");
    if (name === base) return path;
  }
  return null;
}

/**
 * Score a candidate name against a query for the dropdown: prefix (0) beats a
 * word-boundary match (1), which beats a plain substring (2). `null` means no
 * match.
 */
export function matchScore(query: string, name: string): number | null {
  if (query === "") return 0;
  const needle = query.toLowerCase();
  const hay = name.toLowerCase();
  if (hay.startsWith(needle)) return 0;
  const index = hay.indexOf(needle);
  if (index > 0 && !/[a-z0-9]/.test(hay[index - 1])) return 1;
  if (index >= 0) return 2;
  return null;
}

/** Rank candidates: prefix, word-boundary, substring, then by name. */
export function rankCompletions<T extends { name: string; fixes?: boolean }>(
  query: string,
  candidates: T[],
): T[] {
  return candidates
    .map((candidate) => ({ candidate, score: matchScore(query, candidate.name) }))
    .filter(
      (entry): entry is { candidate: T; score: number } => entry.score !== null,
    )
    .sort(
      (a, b) =>
        a.score - b.score ||
        Number(!!a.candidate.fixes) - Number(!!b.candidate.fixes) ||
        a.candidate.name.localeCompare(b.candidate.name),
    )
    .map((entry) => entry.candidate);
}

/**
 * Resolve a link target. Words win unless a `#heading` is present (only notes
 * have headings), in which case a note wins over a same-named word. Headings
 * are matched case-insensitively against the note's cached headings; an
 * uncached note is optimistic (`headingResolved: null`).
 */
export function resolveWikiTarget(
  target: string,
  heading: string | null,
  index: WordIndex,
  notePaths: Set<string>,
  noteHeadings: Readonly<Record<string, string[]>> = {},
): WikiTarget {
  if (heading !== null) {
    const notePath = resolveNotePath(target, notePaths);
    if (notePath) {
      const headings = noteHeadings[notePath];
      const headingResolved = headings
        ? headings.some((entry) => entry.toLowerCase() === heading.toLowerCase())
        : null;
      return { kind: "note", path: notePath, heading, headingResolved };
    }
  }
  const hits = index[target.toLowerCase()];
  if (hits && hits.length > 0) {
    const hit = hits[0];
    return {
      kind: "word",
      table: hit.table,
      id: hit.id,
      wordname: hit.wordname,
      senses: hit.senses,
    };
  }
  const notePath = resolveNotePath(target, notePaths);
  if (notePath) {
    return { kind: "note", path: notePath, heading, headingResolved: null };
  }
  return { kind: "missing" };
}
