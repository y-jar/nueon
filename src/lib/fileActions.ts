/**
 * Small OS-level file actions shared by the note tree's context menu and the
 * editor's overflow menu, so there is one implementation of each.
 */

import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

/** Reveal an absolute path in the system file manager. */
export function revealInFileExplorer(absPath: string): void {
  if (absPath) revealItemInDir(absPath).catch(() => {});
}

/** Open an absolute path with the OS default application. */
export function openInDefaultApp(absPath: string): void {
  if (absPath) openPath(absPath).catch(() => {});
}

/** Copy text to the clipboard, ignoring an unavailable clipboard. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can be denied; nothing useful to do.
  }
}
