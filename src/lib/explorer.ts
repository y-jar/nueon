import type { NoteNode } from "./api";

/** Depth-first flatten of a notes tree. */
export function flattenNotes(nodes: NoteNode[], out: NoteNode[] = []): NoteNode[] {
  for (const node of nodes) {
    out.push(node);
    if (node.children.length) flattenNotes(node.children, out);
  }
  return out;
}

/** Drop a trailing `.md` for display; other extensions stay visible. */
export function stripMd(name: string): string {
  return name.replace(/\.md$/i, "");
}

/** A note path ("untitled", "untitled 2", …) not present in the tree. */
export function uniqueNotePath(nodes: NoteNode[], base = "untitled"): string {
  const paths = new Set(
    flattenNotes(nodes).map((node) => stripMd(node.path)),
  );
  let name = base;
  let n = 2;
  while (paths.has(name)) {
    name = `${base} ${n}`;
    n += 1;
  }
  return name;
}

/**
 * Keep nodes whose name matches `needle`, plus their ancestors. A directory is
 * kept when any descendant matches. Pure derivation over `ui.tree`.
 */
export function filterTree(nodes: NoteNode[], needle: string): NoteNode[] {
  const query = needle.trim().toLowerCase();
  if (!query) return nodes;
  const walk = (list: NoteNode[]): NoteNode[] =>
    list
      .map((node) => {
        const children = walk(node.children);
        const label = node.is_dir ? node.name : stripMd(node.name);
        if (label.toLowerCase().includes(query) || children.length) {
          return { ...node, children };
        }
        return null;
      })
      .filter((node): node is NoteNode => node !== null);
  return walk(nodes);
}
