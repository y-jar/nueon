/** Collapse `.` and `..` segments of a `/`-separated path. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length) out.pop();
    } else {
      out.push(part);
    }
  }
  return (absolute ? "/" : "") + out.join("/");
}

/**
 * Markdown link from a note to an imported asset. Notes live under `notes/`
 * and assets under `assets/`, both at the workspace root, so a note nested
 * `n` folders deep reaches `assets/` through `n + 1` parent hops.
 */
export function assetLink(notePath: string, assetName: string): string {
  const depth = notePath.split("/").filter(Boolean).length - 1;
  return `${"../".repeat(depth + 1)}assets/${assetName}`;
}

/** File name without its final extension, safe for Markdown link text. */
export function linkLabel(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, "").replace(/[[\]]/g, "");
}
