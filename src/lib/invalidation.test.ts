//! Unit tests for the invalidation registry's pure core (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEBOUNCE_MS,
  OWN_WRITE_GRACE_MS,
  InvalidationCore,
  SCOPES,
  isScope,
  type ConsumerSpec,
  type Scope,
  type TimerApi,
} from "./invalidation.ts";

// -- a controllable clock, so debounce and suppression windows are exact ----

class FakeTimers implements TimerApi {
  time = 0;
  private seq = 0;
  private jobs = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): number {
    const handle = ++this.seq;
    this.jobs.set(handle, { at: this.time + ms, fn });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.jobs.delete(handle as number);
  }

  /** Move `ms` forward, firing every due job in time order. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let handle: number | null = null;
      let due = Infinity;
      for (const [h, job] of this.jobs) {
        if (job.at <= end && job.at < due) {
          handle = h;
          due = job.at;
        }
      }
      if (handle === null) break;
      const job = this.jobs.get(handle)!;
      this.jobs.delete(handle);
      this.time = job.at;
      job.fn();
    }
    this.time = end;
  }
}

function makeCore() {
  const timers = new FakeTimers();
  const core = new InvalidationCore(timers);
  const tracked = (id: string, scopes: Scope[], extra: Partial<ConsumerSpec> = {}) => {
    const reloads: number[] = [];
    core.register({
      id,
      scopes,
      reload: () => {
        reloads.push(timers.time);
      },
      ...extra,
    });
    return { id, reloads };
  };
  return { timers, core, tracked };
}

// -- scope fan-out -----------------------------------------------------------

test("notify reloads only the consumers of that scope", () => {
  const { timers, core, tracked } = makeCore();
  const a = tracked("a", ["dictionary"]);
  const b = tracked("b", ["config", "translation"]);
  core.notify("dictionary");
  timers.advance(DEBOUNCE_MS);
  assert.equal(a.reloads.length, 1, "the dictionary consumer reloaded");
  assert.equal(b.reloads.length, 0, "the other consumer did not");
  core.notify("translation");
  timers.advance(DEBOUNCE_MS);
  assert.equal(b.reloads.length, 1, "the translation consumer reloaded");
});

test("overlapping scopes coalesce to one reload per consumer", () => {
  const { timers, core, tracked } = makeCore();
  const a = tracked("a", ["dictionary"]);
  const c = tracked("c", ["config", "dictionary"]);
  core.notify("config");
  core.notify("dictionary");
  timers.advance(DEBOUNCE_MS);
  assert.equal(c.reloads.length, 1, "one reload across both scopes");
  assert.equal(a.reloads.length, 1, "the dictionary-only consumer reloaded");
});

test("notify bumps the per-scope revision once per event", () => {
  const { core } = makeCore();
  assert.equal(core.revision("dictionary"), 0);
  core.notify("dictionary");
  core.notify("dictionary");
  assert.equal(core.revision("dictionary"), 2);
  assert.equal(core.revision("config"), 0, "other scopes untouched");
});

// -- coalescing --------------------------------------------------------------

test("a burst of events coalesces into one reload per quiet window", () => {
  const { timers, core, tracked } = makeCore();
  const a = tracked("a", ["dictionary"]);
  for (let i = 0; i < 50; i++) core.notify("dictionary");
  timers.advance(DEBOUNCE_MS);
  assert.equal(a.reloads.length, 1, "50 events in one window = one reload");
  core.notify("dictionary");
  timers.advance(DEBOUNCE_MS / 2);
  core.notify("dictionary");
  timers.advance(DEBOUNCE_MS);
  assert.equal(a.reloads.length, 2, "a second burst after the window reloads again");
});

// -- own-write suppression ---------------------------------------------------

test("an own write's in-flight echo is skipped; others still reload", async () => {
  const { timers, core, tracked } = makeCore();
  const a = tracked("morphology", ["translation"]);
  const b = tracked("translation-panel", ["translation"]);
  await core.withOwnWrite("morphology", ["translation"], async () => {
    core.notify("translation");
    timers.advance(DEBOUNCE_MS);
    assert.equal(a.reloads.length, 0, "the writer skipped its own echo");
    assert.equal(b.reloads.length, 1, "the other consumer still reloaded");
  });
  core.notify("translation");
  timers.advance(DEBOUNCE_MS);
  assert.equal(
    a.reloads.length,
    1,
    "an external change right after the echo reloads",
  );
});

test("an own write's late echo is skipped; a change after it reloads", async () => {
  const { timers, core, tracked } = makeCore();
  const a = tracked("morphology", ["translation"]);
  await core.withOwnWrite("morphology", ["translation"], async () => {});
  core.notify("translation");
  timers.advance(DEBOUNCE_MS);
  assert.equal(a.reloads.length, 0, "the late echo is skipped");
  core.notify("translation");
  timers.advance(DEBOUNCE_MS);
  assert.equal(
    a.reloads.length,
    1,
    "a second event inside the grace window is an external change and reloads",
  );
  timers.advance(OWN_WRITE_GRACE_MS + 1);
  core.notify("translation");
  timers.advance(DEBOUNCE_MS);
  assert.equal(a.reloads.length, 2, "after the grace window events reload again");
});

// -- stale when hidden -------------------------------------------------------

test("hidden consumers go stale and reload when shown", () => {
  const { timers, core, tracked } = makeCore();
  let onScreen = false;
  const a = tracked("morphology", ["dictionary"], { visible: () => onScreen });
  core.notify("dictionary");
  timers.advance(DEBOUNCE_MS * 3);
  assert.equal(a.reloads.length, 0, "nothing reloads while hidden");
  assert.equal(core.staleOf("morphology"), true, "the consumer went stale");
  onScreen = true;
  core.shown("morphology");
  timers.advance(DEBOUNCE_MS);
  assert.equal(a.reloads.length, 1, "showing reloads the stale data");
  assert.equal(core.staleOf("morphology"), false, "the reload cleared the flag");
});

test("a pending reload is dropped when the consumer is hidden again", () => {
  const { timers, core, tracked } = makeCore();
  let onScreen = true;
  const a = tracked("morphology", ["dictionary"], { visible: () => onScreen });
  core.notify("dictionary");
  onScreen = false;
  core.notify("dictionary");
  timers.advance(DEBOUNCE_MS * 2);
  assert.equal(a.reloads.length, 0, "the pending reload was dropped");
  assert.equal(core.staleOf("morphology"), true, "and the data went stale");
});

// -- shown / needsLoad -------------------------------------------------------

test("shown schedules the first load but not a fresh consumer's reload", () => {
  const { timers, core, tracked } = makeCore();
  let needs = true;
  const a = tracked("m", ["dictionary"], { needsLoad: () => needs });
  core.shown("m");
  timers.advance(DEBOUNCE_MS);
  assert.equal(a.reloads.length, 1, "the first mount loads");
  needs = false;
  core.shown("m");
  timers.advance(DEBOUNCE_MS * 2);
  assert.equal(a.reloads.length, 1, "a fresh reload is not repeated");
});

// -- unregister / markFresh --------------------------------------------------

test("unregister drops the consumer and its pending reload", () => {
  const { timers, core, tracked } = makeCore();
  const a = tracked("a", ["dictionary"]);
  core.notify("dictionary");
  core.unregister("a");
  timers.advance(DEBOUNCE_MS * 2);
  assert.equal(a.reloads.length, 0, "no reload after unregistering");
  core.notify("dictionary");
  timers.advance(DEBOUNCE_MS * 2);
  assert.equal(a.reloads.length, 0, "later events reach nobody");
});

test("markFresh clears the stale flag after a manual refresh", () => {
  const { core, tracked } = makeCore();
  const a = tracked("a", ["dictionary"], { visible: () => false });
  core.notify("dictionary");
  assert.equal(core.staleOf("a"), true);
  core.markFresh("a");
  assert.equal(core.staleOf("a"), false);
  assert.equal(a.reloads.length, 0, "markFresh itself reloads nothing");
});

// -- scope typing ------------------------------------------------------------

test("isScope accepts exactly the seven backend scopes", () => {
  assert.equal(isScope("phonology"), false, "no phonology scope exists");
  assert.equal(isScope(undefined), false);
  assert.equal(isScope("config"), true);
  assert.equal(SCOPES.length, 7);
});
