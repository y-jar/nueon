import type { NoteNode } from "./api";

/** Depth-first flatten of a notes tree. */
function flattenNotes(nodes: NoteNode[], out: NoteNode[] = []): NoteNode[] {
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

/** The notes subfolder that holds imported files, not notes. */
export const ASSETS_DIR = "assets";

/** Whether a tree path is inside the imported-assets folder. */
export function isAssetPath(path: string): boolean {
  return path === ASSETS_DIR || path.startsWith(`${ASSETS_DIR}/`);
}

/** Whether a tree path opens in the Markdown editor rather than the viewer. */
export function isNotePath(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(path);
}

/** A coarse file category for tree icons and the viewer. */
export type FileCategory =
  | "image"
  | "text"
  | "audio"
  | "video"
  | "archive"
  | "document"
  | "other";

const EXTENSIONS: Record<Exclude<FileCategory, "other">, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"],
  text: ["md", "markdown", "txt", "csv", "tsv", "json", "log", "yaml", "yml", "toml"],
  audio: ["mp3", "wav", "ogg", "flac", "m4a", "opus"],
  video: ["mp4", "webm", "mov", "mkv", "ogv"],
  archive: ["zip", "tar", "gz", "xz", "7z", "rar", "bz2"],
  document: ["pdf", "odt", "ods", "odp", "doc", "docx", "xls", "xlsx", "ppt", "pptx"],
};

/** Categorize a file name by its extension. */
export function fileCategory(name: string): FileCategory {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  for (const [category, list] of Object.entries(EXTENSIONS)) {
    if (list.includes(ext)) return category as FileCategory;
  }
  return "other";
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
