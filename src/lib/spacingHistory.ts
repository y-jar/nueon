//! An undo log for spacing edits made from the glyph grid, where one change can touch many glyphs.
import type { GlyphOutline } from "./api";

export type Outlines = Record<string, GlyphOutline>;

interface Entry {
  label: string;
  before: Outlines;
  after: Outlines;
}

export interface SpacingLog {
  /** Record a change: the outlines of every glyph it touched, before and after. */
  record(label: string, before: Outlines, after: Outlines): void;
  undo(): { label: string; outlines: Outlines } | null;
  redo(): { label: string; outlines: Outlines } | null;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
}

export function createSpacingLog(limit = 100): SpacingLog {
  let past: Entry[] = [];
  let future: Entry[] = [];

  return {
    record(label, before, after) {
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      past.push({ label, before, after });
      if (past.length > limit) past = past.slice(past.length - limit);
      future = [];
    },
    undo() {
      const entry = past.pop();
      if (!entry) return null;
      future.push(entry);
      return { label: entry.label, outlines: entry.before };
    },
    redo() {
      const entry = future.pop();
      if (!entry) return null;
      past.push(entry);
      return { label: entry.label, outlines: entry.after };
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    clear() {
      past = [];
      future = [];
    },
  };
}
