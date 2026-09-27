import { describe, it, expect } from "vitest";
import { createSingleFlightCache } from "./single-flight-cache";

/*
  The booking page's defence against being flooded (security audit,
  2026-09-27). Every view used to read the calendar from Microsoft Graph, which
  allows four concurrent requests per mailbox: a handful of parallel page loads
  in a loop got the mailbox throttled, and then real customers saw no times and
  confirmations stalled. These pin what the cache must do so that however many
  requests arrive, the calendar is read at most once per window.
*/

const at = (ms: number) => new Date(Date.UTC(2031, 0, 1) + ms);

/** A loader that counts its calls and resolves only when told to. */
function controlledLoader<V>() {
  let calls = 0;
  const pending: { resolve: (v: V) => void; reject: (e: Error) => void }[] = [];
  const load = () => {
    calls += 1;
    return new Promise<V>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return {
    load,
    calls: () => calls,
    resolveAll: (value: V) => pending.splice(0).forEach((p) => p.resolve(value)),
    rejectAll: (error: Error) => pending.splice(0).forEach((p) => p.reject(error)),
  };
}

describe("createSingleFlightCache", () => {
  it("serves a flood of simultaneous requests with one load", async () => {
    const cache = createSingleFlightCache<string, number>({ ttlMs: 30_000 });
    const loader = controlledLoader<number>();

    const requests = Array.from({ length: 50 }, () => cache.get("k", at(0), loader.load));
    loader.resolveAll(42);

    expect(await Promise.all(requests)).toEqual(Array.from({ length: 50 }, () => 42));
    expect(loader.calls()).toBe(1);
  });

  it("does not load again inside the window", async () => {
    const cache = createSingleFlightCache<string, number>({ ttlMs: 30_000 });
    let calls = 0;
    const load = () => Promise.resolve(++calls);

    await cache.get("k", at(0), load);
    const later = await cache.get("k", at(29_999), load);

    expect(later).toBe(1);
    expect(calls).toBe(1);
  });

  it("loads afresh once the window has passed", async () => {
    const cache = createSingleFlightCache<string, number>({ ttlMs: 30_000 });
    let calls = 0;
    const load = () => Promise.resolve(++calls);

    await cache.get("k", at(0), load);
    const later = await cache.get("k", at(30_000), load);

    expect(later).toBe(2);
  });

  /*
    A failure must never be remembered: caching "the calendar could not be
    read" would show every visitor an outage for the whole window after
    Microsoft had already recovered.
  */
  it("does not remember a failure", async () => {
    const cache = createSingleFlightCache<string, number>({ ttlMs: 30_000 });
    const loader = controlledLoader<number>();

    const failing = cache.get("k", at(0), loader.load);
    loader.rejectAll(new Error("Graph said 429"));
    await expect(failing).rejects.toThrow(/429/);

    const retry = cache.get("k", at(1), loader.load);
    loader.resolveAll(7);
    expect(await retry).toBe(7);
    expect(loader.calls()).toBe(2);
  });

  it("gives every caller waiting on a failed load the same failure", async () => {
    const cache = createSingleFlightCache<string, number>({ ttlMs: 30_000 });
    const loader = controlledLoader<number>();

    const a = cache.get("k", at(0), loader.load);
    const b = cache.get("k", at(0), loader.load);
    loader.rejectAll(new Error("down"));

    await expect(a).rejects.toThrow(/down/);
    await expect(b).rejects.toThrow(/down/);
    expect(loader.calls()).toBe(1);
  });

  it("keeps each key separate", async () => {
    const cache = createSingleFlightCache<number, string>({ ttlMs: 30_000 });

    const sixty = await cache.get(60, at(0), () => Promise.resolve("sixty"));
    const ninety = await cache.get(90, at(0), () => Promise.resolve("ninety"));

    expect([sixty, ninety]).toEqual(["sixty", "ninety"]);
  });

  it("forgets the oldest key rather than growing without bound", async () => {
    const cache = createSingleFlightCache<number, number>({ ttlMs: 30_000, maxKeys: 2 });
    let calls = 0;
    const load = () => Promise.resolve(++calls);

    await cache.get(1, at(0), load);
    await cache.get(2, at(0), load);
    await cache.get(3, at(0), load);
    await cache.get(1, at(1), load);

    // Key 1 was evicted when key 3 arrived, so it loaded again.
    expect(calls).toBe(4);
  });
});
