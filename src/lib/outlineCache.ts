//! A small lazy cache of glyph outlines for the grid, with bounded concurrency and invalidation.
import type { GlyphOutline } from "./api";

export type OutlineLoader = (id: string) => Promise<GlyphOutline | null>;

export interface OutlineCache {
  /** The cached outline, null when the glyph has none on disk, undefined when not loaded yet. */
  get(id: string): GlyphOutline | null | undefined;
  has(id: string): boolean;
  /** Ask for these glyphs to be loaded; ids already cached or in flight are ignored. */
  request(ids: string[]): void;
  /** Store an outline directly (the glyph being edited). */
  set(id: string, outline: GlyphOutline | null): void;
  /** Drop everything and discard loads that started before this call. */
  invalidate(): void;
  version(): number;
  onChange(listener: () => void): () => void;
  /** Resolves when nothing is queued or loading. */
  idle(): Promise<void>;
}

export function createOutlineCache(load: OutlineLoader, concurrency: number): OutlineCache {
  const data = new Map<string, GlyphOutline | null>();
  const queued: string[] = [];
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;
  let epoch = 0;
  let running = 0;
  let waiting: (() => void)[] = [];
  let notifyScheduled = false;

  const limit = Math.max(1, concurrency);

  function notify() {
    if (notifyScheduled) return;
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      version += 1;
      for (const l of listeners) l();
    });
  }

  function settle() {
    if (running === 0 && queued.length === 0) {
      const w = waiting;
      waiting = [];
      for (const r of w) r();
    }
  }

  function pump() {
    while (running < limit && queued.length > 0) {
      const id = queued.shift()!;
      running += 1;
      const mine = epoch;
      load(id)
        .then((outline) => {
          if (mine === epoch) {
            data.set(id, outline);
            notify();
          }
        })
        .catch(() => {})
        .finally(() => {
          inFlight.delete(id);
          running -= 1;
          pump();
          settle();
        });
    }
  }

  return {
    get: (id) => data.get(id),
    has: (id) => data.has(id),
    request(ids) {
      for (const id of ids) {
        if (data.has(id) || inFlight.has(id)) continue;
        inFlight.add(id);
        queued.push(id);
      }
      pump();
    },
    set(id, outline) {
      data.set(id, outline);
      notify();
    },
    invalidate() {
      epoch += 1;
      data.clear();
      queued.length = 0;
      inFlight.clear();
      version += 1;
      notify();
    },
    version: () => version,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    idle() {
      if (running === 0 && queued.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
  };
}
