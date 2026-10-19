//! Pure core of the data-changed invalidation registry.
/**
 * Consumers (stores, panels) declare the `data-changed` scopes that
 * invalidate the backend data they hold; `notify` reloads the visible ones
 * and marks the hidden ones stale. Reloads are debounced so a burst of
 * events coalesces, and an event caused by a consumer's own write is
 * skipped for that consumer alone. Pure (injectable timers), so the rules
 * are unit-testable; `invalidation.svelte.ts` wires it to the stores.
 */

export type Scope =
  | "workspace"
  | "notes"
  | "dictionary"
  | "config"
  | "translation"
  | "writing"
  | "vcs";

export const SCOPES: readonly Scope[] = [
  "workspace",
  "notes",
  "dictionary",
  "config",
  "translation",
  "writing",
  "vcs",
];

export function isScope(value: unknown): value is Scope {
  return (
    typeof value === "string" && (SCOPES as readonly string[]).includes(value)
  );
}

export interface ConsumerSpec {
  /** Unique id ("morphology", "wordIndex", ...). */
  id: string;
  /** The scopes that invalidate this consumer's data. */
  scopes: Scope[];
  /** Refetch the data. */
  reload: () => void | Promise<void>;
  /** On screen right now? Hidden consumers only go stale. Default: always. */
  visible?: () => boolean;
  /** Data not loaded yet? `shown` schedules the first load too. */
  needsLoad?: () => boolean;
}

export type TimerHandle = unknown;

export interface TimerApi {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Debounce window that coalesces a burst of events into one reload. */
export const DEBOUNCE_MS = 150;
/** How long after an own write settles its echo events are skipped. */
export const OWN_WRITE_GRACE_MS = 750;

interface Entry {
  spec: ConsumerSpec;
  stale: boolean;
  timer: TimerHandle | null;
  /** Scope → deadline; events before it were caused by the own write. */
  suppressUntil: Partial<Record<Scope, number>>;
  /** Scope → count of own writes in flight. */
  writing: Partial<Record<Scope, number>>;
}

export class InvalidationCore {
  private entries = new Map<string, Entry>();
  private revisions: Record<Scope, number> = {
    workspace: 0,
    notes: 0,
    dictionary: 0,
    config: 0,
    translation: 0,
    writing: 0,
    vcs: 0,
  };
  private timers: TimerApi;

  constructor(timers: TimerApi) {
    this.timers = timers;
  }

  register(spec: ConsumerSpec): void {
    if (this.entries.has(spec.id)) return;
    this.entries.set(spec.id, {
      spec,
      stale: false,
      timer: null,
      suppressUntil: {},
      writing: {},
    });
  }

  unregister(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.timer !== null) this.timers.clearTimeout(entry.timer);
    this.entries.delete(id);
  }

  /** How many events this scope has seen; drives the revision counters. */
  revision(scope: Scope): number {
    return this.revisions[scope];
  }

  notify(scope: Scope): void {
    this.revisions[scope] += 1;
    const now = this.timers.now();
    for (const entry of this.entries.values()) {
      if (!entry.spec.scopes.includes(scope)) continue;
      if (this.ownWriteActive(entry, scope, now)) continue;
      if (!this.visible(entry)) {
        if (entry.timer !== null) {
          this.timers.clearTimeout(entry.timer);
          entry.timer = null;
        }
        entry.stale = true;
        continue;
      }
      if (entry.timer === null) {
        entry.timer = this.timers.setTimeout(
          () => this.fire(entry),
          DEBOUNCE_MS,
        );
      }
    }
  }

  /** The consumer came on screen: load or refresh now if needed. */
  shown(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (!entry.stale && !entry.spec.needsLoad?.()) return;
    if (entry.timer !== null) return;
    entry.timer = this.timers.setTimeout(() => this.fire(entry), DEBOUNCE_MS);
  }

  /** A manual refresh made the data fresh. */
  markFresh(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.stale = false;
  }

  staleOf(id: string): boolean {
    return this.entries.get(id)?.stale ?? false;
  }

  /**
   * Wrap a mutating write: the event it causes is skipped for this consumer
   * alone (it already holds what it wrote); every other consumer still
   * reloads.
   */
  async withOwnWrite<T>(
    id: string,
    scopes: Scope[],
    write: () => Promise<T>,
  ): Promise<T> {
    const entry = this.entries.get(id);
    if (!entry) return write();
    for (const scope of scopes) {
      entry.writing[scope] = (entry.writing[scope] ?? 0) + 1;
    }
    try {
      return await write();
    } finally {
      for (const scope of scopes) {
        entry.writing[scope] = Math.max(0, (entry.writing[scope] ?? 0) - 1);
        entry.suppressUntil[scope] = this.timers.now() + OWN_WRITE_GRACE_MS;
      }
    }
  }

  private ownWriteActive(entry: Entry, scope: Scope, now: number): boolean {
    if ((entry.writing[scope] ?? 0) > 0) return true;
    const until = entry.suppressUntil[scope];
    return until !== undefined && now < until;
  }

  private visible(entry: Entry): boolean {
    return entry.spec.visible ? entry.spec.visible() : true;
  }

  private fire(entry: Entry): void {
    entry.timer = null;
    const done = () => {
      entry.stale = false;
    };
    try {
      const result = entry.spec.reload();
      if (
        result !== null &&
        typeof result === "object" &&
        typeof (result as Promise<void>).then === "function"
      ) {
        void (result as Promise<void>).then(done, done);
      } else {
        done();
      }
    } catch {
      done();
    }
  }
}
