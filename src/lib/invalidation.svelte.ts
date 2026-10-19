//! Wiring for the data-changed invalidation registry (see ./invalidation.ts).
/**
 * The live registry over the pure core: `notifyDataChanged` routes one
 * backend `data-changed` event (bumping `ui.revision` per scope for
 * effect-based consumers), and stores/panels register the scopes that
 * invalidate the data they hold.
 */

import {
  InvalidationCore,
  SCOPES,
  isScope,
  type ConsumerSpec,
  type Scope,
} from "./invalidation";
import { ui } from "./store.svelte";

const timers = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const core = new InvalidationCore(timers);

/** Declare a consumer: which scopes invalidate the data it holds. */
export function registerInvalidation(spec: ConsumerSpec): void {
  core.register(spec);
}

/** Drop a consumer (and its pending reload) — component-owned caches. */
export function unregisterInvalidation(id: string): void {
  core.unregister(id);
}

/** The consumer came on screen: load or refresh its data if needed. */
export function consumerShown(id: string): void {
  core.shown(id);
}

/** A manual refresh made the consumer's data fresh. */
export function consumerFresh(id: string): void {
  core.markFresh(id);
}

export function consumerStale(id: string): boolean {
  return core.staleOf(id);
}

/**
 * Wrap a mutating write: the event it causes is skipped for this consumer
 * alone (it already holds what it wrote); every other consumer still
 * reloads.
 */
export function withOwnWrite<T>(
  id: string,
  scopes: Scope[],
  write: () => Promise<T>,
): Promise<T> {
  return core.withOwnWrite(id, scopes, write);
}

/** Route one backend `data-changed` event through the registry. */
export function notifyDataChanged(scope: string): void {
  if (!isScope(scope)) return;
  core.notify(scope);
  for (const name of SCOPES) {
    const next = core.revision(name);
    if (ui.revision[name] !== next) ui.revision[name] = next;
  }
}
