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
 * Markdown link from a note to an imported asset. Assets live in
 * `notes/assets/`, so a note nested `n` folders deep reaches `assets/`
 * through exactly `n` parent hops.
 */
export function assetLink(notePath: string, assetName: string): string {
  const depth = notePath.split("/").filter(Boolean).length - 1;
  return `${"../".repeat(depth)}assets/${assetName}`;
}

/** File name without its final extension, safe for Markdown link text. */
export function linkLabel(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, "").replace(/[[\]]/g, "");
}
