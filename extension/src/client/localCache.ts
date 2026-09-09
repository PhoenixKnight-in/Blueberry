/**
 * The extension's in-memory result cache.
 *
 * This is the *second* cache in the system and it exists for a different
 * reason than the backend's Redis. Redis stops repeated checks from re-hitting
 * PyPI and GitHub; this one stops a keystroke from re-hitting the backend at
 * all. A developer editing a file with twenty imports produces a check request
 * per import per debounce window, and almost every one of those has the same
 * answer as it did two seconds ago.
 *
 * Two behaviours matter beyond plain TTL storage:
 *
 * - **In-flight de-duplication.** Ten candidates for `requests` in one pass
 *   must produce one request, not ten. Callers share the pending promise.
 * - **A short TTL for failures.** A backend that was down when the editor
 *   opened should be retried in seconds, not minutes, or the developer has to
 *   restart the editor to recover from a transient outage.
 */

import type { CheckOutcome } from '../types';

interface CacheEntry {
  readonly outcome: CheckOutcome;
  readonly expiresAt: number;
}

/** How long a successful verdict is reused, in milliseconds. */
export const SUCCESS_TTL_MS = 5 * 60 * 1000;

/**
 * How long a failure is reused. Deliberately short: caching "could not
 * verify" for as long as a real answer would leave the extension silent long
 * after the backend came back.
 */
export const FAILURE_TTL_MS = 15 * 1000;

/** Upper bound on retained entries, evicted oldest-first. */
export const MAX_ENTRIES = 500;

export class LocalCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CheckOutcome>>();

  constructor(
    private readonly successTtlMs: number = SUCCESS_TTL_MS,
    private readonly failureTtlMs: number = FAILURE_TTL_MS,
    private readonly maxEntries: number = MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  /** PyPI treats names case-insensitively, and so must the cache key. */
  private static key(packageName: string): string {
    return packageName.trim().toLowerCase();
  }

  /** Return a cached outcome, or `undefined` if absent or expired. */
  get(packageName: string): CheckOutcome | undefined {
    const key = LocalCache.key(packageName);
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.outcome;
  }

  /** Store an outcome, with a TTL chosen by whether the check succeeded. */
  set(packageName: string, outcome: CheckOutcome): void {
    const key = LocalCache.key(packageName);
    const ttl = outcome.kind === 'ok' ? this.successTtlMs : this.failureTtlMs;

    // Re-insert rather than update, so the Map's insertion order stays a
    // usable approximation of least-recently-written for eviction.
    this.entries.delete(key);
    this.entries.set(key, { outcome, expiresAt: this.now() + ttl });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Return a cached outcome, or run `factory` — sharing one call between
   * every concurrent caller asking for the same package.
   */
  async resolve(
    packageName: string,
    factory: () => Promise<CheckOutcome>,
  ): Promise<CheckOutcome> {
    const cached = this.get(packageName);
    if (cached) {
      return cached;
    }

    const key = LocalCache.key(packageName);
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const request = factory()
      .then((outcome) => {
        this.set(packageName, outcome);
        return outcome;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);
    return request;
  }

  /** Drop everything. Bound to the `Clear Local Result Cache` command. */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  /** Number of live (unexpired) entries — used by the tests and the status bar. */
  get size(): number {
    const now = this.now();
    let live = 0;
    for (const entry of this.entries.values()) {
      if (entry.expiresAt > now) {
        live += 1;
      }
    }
    return live;
  }
}
