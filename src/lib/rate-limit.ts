/**
 * A fixed-window rate limiter.
 *
 * A public form endpoint with no limit is an open invitation: somebody can sit
 * on it and fill the customers table, or use it to probe which email addresses
 * already exist. This is the cheap defence that stops the obvious version of
 * both.
 *
 * KNOWN LIMIT, stated rather than hidden: the counts live in this process's
 * memory. With more than one instance running, each keeps its own count and
 * the effective limit multiplies; a restart forgets everything. That is
 * acceptable for a single managed Node instance and NOT acceptable once the
 * app is scaled horizontally - at which point this needs to move behind
 * Postgres or a shared store. It is deliberately a small, replaceable piece
 * with an interface that does not care where the counting happens.
 *
 * It is also not a substitute for bot protection. It slows a single source
 * down; it does nothing about a distributed one.
 */

export interface RateLimitResult {
  readonly allowed: boolean;
  /** How long until the window resets. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  /** Requests permitted per window, per key. */
  readonly limit: number;
  readonly windowMs: number;
  /** Guard against unbounded memory: the most keys tracked at once. */
  readonly maxKeys?: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  check(key: string, now: Date): RateLimitResult;
  /** Test and diagnostic helper. */
  size(): number;
}

const DEFAULT_MAX_KEYS = 10_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs, maxKeys = DEFAULT_MAX_KEYS } = options;
  const windows = new Map<string, Window>();

  function prune(nowMs: number): void {
    for (const [key, window] of windows) {
      if (window.resetAt <= nowMs) windows.delete(key);
    }
  }

  return {
    check(key: string, now: Date): RateLimitResult {
      const nowMs = now.getTime();
      const existing = windows.get(key);

      if (!existing || existing.resetAt <= nowMs) {
        /*
          Pruning on write rather than on a timer: there is no background task
          to leak, and the work is proportional to what is actually being
          tracked. Without it, a stream of one-off keys grows the map forever,
          which turns the defence into the vulnerability.
        */
        if (windows.size >= maxKeys) prune(nowMs);
        windows.set(key, { count: 1, resetAt: nowMs + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (existing.count < limit) {
        existing.count += 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }

      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000)),
      };
    },

    size(): number {
      return windows.size;
    },
  };
}
