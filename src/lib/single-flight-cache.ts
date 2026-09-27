/**
 * Remember a slow answer for a short while, and never ask for it twice at once.
 *
 * Built for the booking page (security audit, 2026-09-27). Every view used to
 * read the calendar from Microsoft Graph, which allows four concurrent
 * requests per mailbox, so a handful of parallel page loads in a loop got the
 * mailbox throttled and real customers saw no times. With this, however many
 * requests arrive, the answer is loaded at most once per window: callers who
 * arrive while it is loading share that one load, and callers inside the
 * window share its result.
 *
 * A failure is never remembered. Caching "could not be read" would show every
 * visitor an outage for the whole window after the service had recovered.
 *
 * In memory, per process, like the rate limiter: with several instances each
 * keeps its own copy, which only multiplies the loads by the instance count.
 */

export interface SingleFlightCacheOptions {
  /** How long a loaded answer is served before it is loaded again. */
  readonly ttlMs: number;
  /** Guard against unbounded memory: the most keys kept at once. */
  readonly maxKeys?: number;
}

export interface SingleFlightCache<K, V> {
  get(key: K, now: Date, load: () => Promise<V>): Promise<V>;
}

interface Entry<V> {
  readonly value: Promise<V>;
  /** Set once the load succeeds; until then the entry is in flight. */
  expiresAt?: number;
}

const DEFAULT_MAX_KEYS = 50;

export function createSingleFlightCache<K, V>(
  options: SingleFlightCacheOptions,
): SingleFlightCache<K, V> {
  const { ttlMs, maxKeys = DEFAULT_MAX_KEYS } = options;
  const entries = new Map<K, Entry<V>>();

  return {
    get(key, now, load) {
      const nowMs = now.getTime();
      const existing = entries.get(key);
      if (existing && (existing.expiresAt === undefined || existing.expiresAt > nowMs)) {
        return existing.value;
      }

      // A Map keeps insertion order, so the first key is the oldest.
      if (!existing && entries.size >= maxKeys) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }

      const entry: Entry<V> = {
        value: load().then(
          (value) => {
            entry.expiresAt = nowMs + ttlMs;
            return value;
          },
          (error: unknown) => {
            if (entries.get(key) === entry) entries.delete(key);
            throw error;
          },
        ),
      };
      entries.set(key, entry);
      return entry.value;
    },
  };
}
