/**
 * Per-note editor positions, kept across the editor's remounts (tab switches,
 * renames) so the cursor and the top visible line survive them. Positions are
 * stored as document offsets — never scroll fractions, because live-preview
 * widgets change line heights — and clamped on restore in case the note
 * shrank. Keyed by note path; renames move entries, deletes drop them.
 */
import { EditorView } from "@codemirror/view";

export interface NotePosition {
  /** Main selection anchor (document offset). */
  anchor: number;
  /** Main selection head (document offset). */
  head: number;
  /** Offset of the first visible line. */
  top: number;
}

const positions = new Map<string, NotePosition>();

/** Remember a position for `path` (overwrites any previous one). */
export function rememberPosition(path: string, position: NotePosition): void {
  positions.set(path, position);
}

/** The last position remembered for `path`, if any. */
export function recallPosition(path: string): NotePosition | undefined {
  return positions.get(path);
}

/** Move every entry at or under `from` to the renamed path `to`. */
export function movePosition(from: string, to: string): void {
  const prefix = `${from}/`;
  for (const [path, position] of [...positions]) {
    if (path === from) {
      positions.delete(path);
      positions.set(to, position);
    } else if (path.startsWith(prefix)) {
      positions.delete(path);
      positions.set(`${to}/${path.slice(prefix.length)}`, position);
    }
  }
}

/** Drop every entry at or under `path` (the note or folder was deleted). */
export function dropPosition(path: string): void {
  const prefix = `${path}/`;
  for (const key of [...positions.keys()]) {
    if (key === path || key.startsWith(prefix)) positions.delete(key);
  }
}

/** Keep every offset inside a document of `docLength` code units. */
export function clampPosition(
  position: NotePosition,
  docLength: number,
): NotePosition {
  const clamp = (offset: number) => Math.max(0, Math.min(offset, docLength));
  return {
    anchor: clamp(position.anchor),
    head: clamp(position.head),
    top: clamp(position.top),
  };
}

/** Snapshot the view's selection and first visible line for `path`. */
export function savePosition(path: string, view: EditorView): void {
  const { anchor, head } = view.state.selection.main;
  // The line index can throw while a measure is in flight; keep the last
  // known top line rather than losing the whole snapshot.
  let top = recallPosition(path)?.top ?? 0;
  try {
    top = view.lineBlockAtHeight(
      view.scrollDOM.scrollTop + view.documentTop,
    ).from;
  } catch { /* measured later */ }
  rememberPosition(path, { anchor, head, top });
}

/**
 * The remembered position for `path` as initial editor construction options,
 * so a remounting editor starts already placed. The scroll is applied to the
 * scroller DOM directly after mount — dispatching a scroll effect during the
 * first measure corrupts the editor's line index (observed as later
 * `lineBlockAtHeight` crashes).
 */
export function initialPosition(
  path: string,
  docLength: number,
): { anchor: number; head: number; top: number } | null {
  const saved = recallPosition(path);
  if (!saved) return null;
  return clampPosition(saved, docLength);
}

/**
 * Scroll `top` (a document offset) to the top of the viewport via the
 * scroller's own scroll position, once the initial layout has settled.
 */
export function restoreScroll(view: EditorView, top: number): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // A destroyed view tolerates the writes below; skip the work anyway.
      if (!view.dom.isConnected) return;
      const clamped = Math.min(top, view.state.doc.length);
      view.scrollDOM.scrollTop = view.lineBlockAt(clamped).top;
    });
  });
}
