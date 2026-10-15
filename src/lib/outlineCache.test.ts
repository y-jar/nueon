import { test } from "node:test";
import assert from "node:assert/strict";

import { createOutlineCache } from "./outlineCache.ts";
import type { GlyphOutline } from "./api.ts";

const o = (n: number): GlyphOutline => ({ elements: [], advance: n });

function fakeLoader() {
  const calls: string[] = [];
  const data: Record<string, GlyphOutline | null> = { a: o(1), b: o(2), c: null };
  let fail: string | null = null;
  const load = async (id: string) => {
    calls.push(id);
    await Promise.resolve();
    if (fail === id) throw new Error("boom");
    return data[id] ?? null;
  };
  return { calls, data, load, failOn: (id: string | null) => (fail = id) };
}

test("a requested outline is loaded once and then served from the cache", async () => {
  const f = fakeLoader();
  const cache = createOutlineCache(f.load, 4);
  cache.request(["a"]);
  await cache.idle();
  assert.deepEqual(cache.get("a"), o(1));
  cache.request(["a", "a"]);
  await cache.idle();
  assert.deepEqual(f.calls, ["a"]);
});

test("asking again while a load is in flight does not start a second load", async () => {
  const f = fakeLoader();
  const cache = createOutlineCache(f.load, 4);
  cache.request(["a"]);
  cache.request(["a"]);
  await cache.idle();
  assert.deepEqual(f.calls, ["a"]);
});

test("a missing glyph is cached as null so it is not asked for again", async () => {
  const f = fakeLoader();
  const cache = createOutlineCache(f.load, 4);
  cache.request(["c"]);
  await cache.idle();
  assert.equal(cache.get("c"), null);
  assert.equal(cache.has("c"), true);
  cache.request(["c"]);
  await cache.idle();
  assert.deepEqual(f.calls, ["c"]);
});

test("at most the given number of loads run at once", async () => {
  let running = 0;
  let peak = 0;
  const load = async (id: string) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return o(id.length);
  };
  const cache = createOutlineCache(load, 3);
  cache.request(["1", "22", "333", "4444", "55555", "666666", "7777777"]);
  await cache.idle();
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.equal(cache.get("7777777")?.advance, 7);
});

test("a failed load is not cached, so a later request retries it", async () => {
  const f = fakeLoader();
  f.failOn("a");
  const cache = createOutlineCache(f.load, 4);
  cache.request(["a"]);
  await cache.idle();
  assert.equal(cache.has("a"), false);
  f.failOn(null);
  cache.request(["a"]);
  await cache.idle();
  assert.deepEqual(cache.get("a"), o(1));
  assert.deepEqual(f.calls, ["a", "a"]);
});

test("invalidate drops the cache and bumps the version so views redraw", async () => {
  const f = fakeLoader();
  const cache = createOutlineCache(f.load, 4);
  cache.request(["a"]);
  await cache.idle();
  const v = cache.version();
  cache.invalidate();
  assert.equal(cache.has("a"), false);
  assert.ok(cache.version() > v);
  cache.request(["a"]);
  await cache.idle();
  assert.deepEqual(f.calls, ["a", "a"]);
});

test("an invalidation during a load does not let the stale result back in", async () => {
  let release: (() => void) | null = null;
  let value = 1;
  const load = (id: string) =>
    new Promise<GlyphOutline | null>((resolve) => {
      const v = value;
      release = () => resolve(o(v));
      void id;
    });
  const cache = createOutlineCache(load, 2);
  cache.request(["a"]);
  value = 2;
  cache.invalidate();
  release!();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cache.has("a"), false, "the pre-invalidate result was discarded");
});

test("set stores an outline directly, for the glyph being edited", () => {
  const cache = createOutlineCache(async () => null, 2);
  cache.set("a", o(9));
  assert.deepEqual(cache.get("a"), o(9));
  assert.equal(cache.has("a"), true);
});

test("onChange fires when outlines arrive, batched, and not for repeat requests", async () => {
  const f = fakeLoader();
  const cache = createOutlineCache(f.load, 4);
  let changes = 0;
  cache.onChange(() => (changes += 1));
  cache.request(["a", "b"]);
  await cache.idle();
  assert.ok(changes >= 1 && changes <= 2, `changes ${changes}`);
  const before = changes;
  cache.request(["a", "b"]);
  await cache.idle();
  assert.equal(changes, before);
});

test("after an invalidate, a glyph that was still loading can be requested again and its fresh value is used", async () => {
  const resolvers: ((v: GlyphOutline | null) => void)[] = [];
  const load = () => new Promise<GlyphOutline | null>((resolve) => resolvers.push(resolve));
  const cache = createOutlineCache(load, 2);
  cache.request(["a"]);
  assert.equal(resolvers.length, 1);
  cache.invalidate();
  cache.request(["a"]);
  assert.equal(resolvers.length, 2, "the glyph is asked for again after the invalidate");
  resolvers[1](o(7));
  resolvers[0](o(1));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(cache.get("a"), o(7), "the old load's stale value is ignored");
});

test("listeners are told once for a burst of arrivals, and can be removed", async () => {
  const f = fakeLoader();
  const cache = createOutlineCache(f.load, 8);
  let n = 0;
  const off = cache.onChange(() => (n += 1));
  cache.set("x", o(1));
  cache.set("y", o(2));
  cache.set("z", o(3));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(n, 1, "three sets in one tick notify once");
  off();
  cache.set("w", o(4));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(n, 1, "a removed listener hears nothing");
});
