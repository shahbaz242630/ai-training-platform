import { describe, it, expect } from "vitest";
import { createRateLimiter } from "./rate-limit";

const NOW = new Date("2026-09-01T10:00:00.000Z");
const at = (secondsLater: number) => new Date(NOW.getTime() + secondsLater * 1000);

describe("createRateLimiter", () => {
  it("allows up to the limit and refuses the next one", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      expect(limiter.check("1.2.3.4", NOW).allowed).toBe(true);
    }
    expect(limiter.check("1.2.3.4", NOW).allowed).toBe(false);
  });

  it("counts each key separately, so one person cannot block everybody else", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check("1.2.3.4", NOW).allowed).toBe(true);
    expect(limiter.check("1.2.3.4", NOW).allowed).toBe(false);
    expect(limiter.check("5.6.7.8", NOW).allowed).toBe(true);
  });

  it("says how long to wait, and only when refusing", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check("k", NOW).retryAfterSeconds).toBe(0);

    const refused = limiter.check("k", at(10));
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(50);
  });

  it("never advises waiting zero seconds while still refusing", () => {
    // A "retry after 0" tells a caller to retry immediately into another refusal.
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check("k", NOW);
    expect(limiter.check("k", at(59.9)).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("lets somebody back in once the window has passed", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check("k", NOW).allowed).toBe(true);
    expect(limiter.check("k", at(30)).allowed).toBe(false);
    expect(limiter.check("k", at(60)).allowed).toBe(true);
  });

  it("starts a fresh window rather than carrying the old count over", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    limiter.check("k", NOW);
    limiter.check("k", NOW);
    expect(limiter.check("k", at(61)).allowed).toBe(true);
    expect(limiter.check("k", at(61)).allowed).toBe(true);
    expect(limiter.check("k", at(61)).allowed).toBe(false);
  });

  /*
    Without pruning, a stream of one-off keys grows the map forever - which
    turns the defence into the memory exhaustion it was meant to prevent.
  */
  it("does not grow forever when every request comes from a different key", () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 1_000, maxKeys: 50 });
    for (let i = 0; i < 500; i++) {
      limiter.check(`key-${i}`, at(i));
    }
    expect(limiter.size()).toBeLessThanOrEqual(50);
  });

  it("keeps counting correctly for a live key after pruning", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
    expect(limiter.check("live", NOW).allowed).toBe(true);
    // Push past maxKeys with keys that expire immediately, forcing a prune.
    for (let i = 0; i < 10; i++) limiter.check(`short-${i}`, NOW);
    // The live key is still inside its window and must still be refused.
    expect(limiter.check("live", at(1)).allowed).toBe(false);
  });
});
