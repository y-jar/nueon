//! Read generations guarding stale file reads.
/**
 * Freshness generations for note reads. A disk read that started before a
 * local save must never be applied over the save's result: applying is gated
 * on the read still being the newest thing that happened to the path.
 */

const generations = new Map<string, number>();

/** Start a read of `path`; the returned generation identifies it. */
export function beginRead(path: string): number {
  const next = (generations.get(path) ?? 0) + 1;
  generations.set(path, next);
  return next;
}

/** A local save landed: every read of `path` already in flight is stale. */
export function invalidateReads(path: string): void {
  generations.set(path, (generations.get(path) ?? 0) + 1);
}

/** Whether `generation` is still the newest thing that happened to `path`. */
export function isFreshest(path: string, generation: number): boolean {
  return generations.get(path) === generation;
}
