/**
 * Obsidian-style `[[...]]` note links. Kept free of Svelte/Tauri so the parse
 * and resolution rules can be unit-tested.
 */

import type { NoteNode, WordIndex } from "./api";

/** One `[[target]]`, `[[target|alias]]` or `![[target]]` link. */
export interface WikiLink {
  /** Absolute offsets of the whole `[[...]]` span. */
  from: number;
  to: number;
  target: string;
  alias: string | null;
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
    links.push({
      from: match.index,
      to: match.index + match[0].length,
      target: match[2].trim(),
      alias: match[3] ? match[3].trim() : null,
      embed: match[1] === "!",
    });
  }
  return links;
}

/** A resolved link target: a dictionary word, a note/file, or nothing. */
export type WikiTarget =
  | { kind: "word"; table: string; id: string; wordname: string; senses: string[] }
  | { kind: "note"; path: string }
  | { kind: "missing" };

/**
 * Resolve a link target: a dictionary word first (case-insensitive), then a
 * note by path or basename.
 */
export function resolveWikiTarget(
  target: string,
  index: WordIndex,
  notePaths: Set<string>,
): WikiTarget {
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
  if (notePaths.has(target)) return { kind: "note", path: target };
  if (notePaths.has(`${target}.md`)) return { kind: "note", path: `${target}.md` };
  for (const path of notePaths) {
    if (path.endsWith(`/${target}.md`)) return { kind: "note", path };
  }
  const base = target.split("/").pop() ?? target;
  for (const path of notePaths) {
    const name = (path.split("/").pop() ?? path).replace(/\.md$/, "");
    if (name === base) return { kind: "note", path };
  }
  return { kind: "missing" };
}
