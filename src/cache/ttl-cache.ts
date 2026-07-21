/**
 * INF-193 — TTL-based in-memory cache with drift detection and flush support.
 *
 * Provides an in-memory cache whose entries expire after a configurable TTL.
 * Designed for workflow-critical data (labels, states, workflow defs) where
 * stale resolution causes silent misrouting. Also exports liveness helpers
 * for bootstrap-wiring proof and a manual flush endpoint marker.
 *
 * AC1 — entries expire after configurable TTL (default ≤ 5 min)
 * AC2 — drift detection compares stale vs. fresh resolve; logs mismatch
 * AC3 — flushAll() clears the entire cache
 */

import { registerCron, markCronRun, formatIntervalMs } from "../cron/registry.js";

// ── Module-level liveness state ───────────────────────────────────────────────
// These are set by the TtlCache constructor and the bootstrap-wiring helpers so
// that getCacheLiveness() reflects the production cache without needing a
// reference passed through every createApp caller.

let _activeDefaultTtlMs = 300_000;
let _flushRouteMounted = false;
let _ttlSchedulerActive = false;
/** Module-level pointer to the last-created TtlCache, so getCacheLiveness() can
 *  report live entry count without every caller threading the instance through. */
let _activeCache: TtlCache<unknown> | null = null;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TtlCacheOptions {
  /** Default TTL in milliseconds for entries that don't specify their own.
   *  Must be ≤ 300_000 (5 minutes) for workflow-critical data per AC1. */
  defaultTtlMs?: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export interface DriftResult<V> {
  /** Whether the stale value differs from the fresh resolve. */
  drifted: boolean;
  /** The cache key that was checked. */
  key: string;
  /** The value that was in the cache (stale). */
  staleValue?: V;
  /** The value obtained from the fresh resolve. */
  freshValue?: V;
}

export interface CacheLiveness {
  /** The active default TTL (ms). ≤ 300_000 per AC1. */
  defaultTtlMs: number;
  /** Number of entries currently in the cache. */
  entries: number;
  /** Whether the flush route has been mounted at bootstrap. */
  flushRouteMounted: boolean;
  /** Whether the TTL invalidation scheduler timer is armed. */
  ttlSchedulerActive: boolean;
}

// ── TtlCache class ────────────────────────────────────────────────────────────

export class TtlCache<V = unknown> {
  private store = new Map<string, CacheEntry<V>>();
  private defaultTtlMs: number;

  constructor(options?: TtlCacheOptions) {
    this.defaultTtlMs = Math.min(
      options?.defaultTtlMs ?? 300_000,
      300_000, // AC1 bound: ≤ 5 minutes for workflow-critical data
    );
    _activeDefaultTtlMs = this.defaultTtlMs;
    _activeCache = this;
  }

  /**
   * Store a value with an optional per-entry TTL. When `ttlMs` is omitted,
   * the cache-wide default is used.
   */
  set(key: string, value: V, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });
  }

  /**
   * Retrieve a value. Returns `undefined` if the key is absent or expired.
   * Expired entries are lazily evicted (detected on read).
   */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Check whether a key exists and has not expired.
   */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Remove a single entry immediately.
   */
  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * Remove all entries from the cache.
   */
  flushAll(): void {
    this.store.clear();
  }

  /**
   * Detect drift by comparing the cached (stale) value against a fresh
   * resolve function. When the two differ, logs a warning and returns
   * `drifted: true`. The fresh value is NOT written to the cache — drift
   * detection is read-only observation.
   *
   * When the key is not in the cache, returns `drifted: false` (no stale
   * value to compare against).
   *
   * Supports both synchronous and async freshResolve callbacks.
   */
  async detectDrift(
    key: string,
    freshResolve: () => V | Promise<V>,
  ): Promise<DriftResult<V>> {
    const staleEntry = this.store.get(key);
    if (!staleEntry || Date.now() >= staleEntry.expiresAt) {
      // No stale value to compare; not a drift scenario.
      return { drifted: false, key };
    }

    const freshValue = await freshResolve();
    if (freshValue !== staleEntry.value) {
      console.warn(
        `[INF-193] cache-drift detected for key="${key}"`,
        {
          key,
          staleValue: staleEntry.value,
          freshValue,
          drifted: true,
        },
      );
      return {
        drifted: true,
        key,
        staleValue: staleEntry.value,
        freshValue,
      };
    }

    return { drifted: false, key };
  }

  /**
   * Number of entries currently in the cache (including expired ones not
   * yet lazily evicted). Use `purgeExpired()` to clean them proactively,
   * or check `get()` which evicts on read.
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Remove all expired entries from the store. Called periodically by the
   * TTL invalidation cron to prevent memory accumulation of stale keys
   * that are never read.
   */
  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(key);
        purged++;
      }
    }
    return purged;
  }
}

// ── Liveness helper ───────────────────────────────────────────────────────────

/**
 * Return live liveness state for the active cache. Called by /health to
 * prove the TTL scheduler and flush route are wired at bootstrap.
 */
export function getCacheLiveness(): CacheLiveness {
  return {
    defaultTtlMs: _activeDefaultTtlMs,
    entries: _activeCache?.size ?? 0,
    flushRouteMounted: _flushRouteMounted,
    ttlSchedulerActive: _ttlSchedulerActive,
  };
}

/**
 * Full liveness including live entry count. Called by the /health handler
 * with the actual cache instance reference so it reports current size.
 */
export function buildFullCacheLiveness(cache: TtlCache<unknown>): CacheLiveness {
  return {
    defaultTtlMs: _activeDefaultTtlMs,
    entries: cache.size,
    flushRouteMounted: _flushRouteMounted,
    ttlSchedulerActive: _ttlSchedulerActive,
  };
}

// ── Bootstrap wiring helpers ──────────────────────────────────────────────────

/**
 * Mark the cache-flush route as mounted. Called at bootstrap from the
 * createApp() code path that mounts the POST /admin/api/cache/flush route.
 */
export function markCacheFlushRouteMounted(): void {
  _flushRouteMounted = true;
}

/**
 * Register and start the periodic TTL invalidation cron. Calls
 * `registerCron` to make the timer visible in /health.crons, then starts
 * the interval. Each tick purges expired entries from the cache and stamps
 * lastRunAt via markCronRun.
 *
 * The cache instance is passed explicitly so the /health handler and flush
 * route can reference the same object without a module-level singleton.
 */
export function registerTtlInvalidationCron(
  cache: TtlCache<unknown>,
  intervalMs: number = 60_000,
): ReturnType<typeof setInterval> {
  _ttlSchedulerActive = true;
  registerCron("ttl-cache-invalidation", `every ${formatIntervalMs(intervalMs)}`);

  const timer = setInterval(() => {
    cache.purgeExpired();
    markCronRun("ttl-cache-invalidation");
  }, intervalMs);
  timer.unref();

  return timer;
}

/**
 * Reset liveness state for testing. Not exported in production.
 * Called from test setup to clear state between tests.
 */
export function resetCacheLivenessForTest(): void {
  _activeDefaultTtlMs = 300_000;
  _flushRouteMounted = false;
  _ttlSchedulerActive = false;
  _activeCache = null;
}
