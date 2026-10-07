/**
 * Session decisions for the note editor.
 *
 * A save, reload or conflict is reported asynchronously: by the time it lands
 * the editor may be showing another note (a tab switch, or a rename that
 * changed the path). A callback must only touch the note it was made for, so
 * this gates every such write on the path the doc currently shows.
 */

/**
 * Whether a callback produced for `savedPath` still applies to the note the
 * doc currently shows (`selectedPath`). Renames are handled the same way: once
 * the path changes, callbacks for the old path are stale, and callbacks for
 * the new path are applied.
 */
export function shouldApplySave(
  selectedPath: string | null,
  savedPath: string,
): boolean {
  return selectedPath === savedPath;
}
