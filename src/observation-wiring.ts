/**
 * AI-2036 — Bootstrap registry + counters for the observation write path.
 *
 * Why this module exists
 * ----------------------
 * `observations` sat at 0 rows from the day P4-1 shipped (AI-1378) until
 * AI-2036. Nothing was broken loudly — the write was gated behind preconditions
 * that were never met, and the skip produced no row, no counter, and (for the
 * decisive precondition) no log line. The failure was invisible.
 *
 * Two things prevent a repeat:
 *
 *  1. **Registration is structural.** The proxy cannot obtain an ObservationStore
 *     except through `getRegisteredObservationStore()`, and that returns
 *     `undefined` until `registerObservationWriter()` runs at the production
 *     entry point. If a future refactor drops the bootstrap call, the write path
 *     goes dark *and says so* — `/health.observations.registered` flips to false
 *     and every transition emits a counted `store-unwired` skip. This is the
 *     AI-1773/AI-1775 dead-code-in-prod guard (AI-1808 addendum).
 *
 *  2. **Every outcome is counted.** Appended, degraded, and each distinct skip
 *     reason increment an in-process counter projected at `/health.observations`
 *     and mirrored to operational_events. A silent skip is no longer possible.
 *
 * Counters are in-process and reset on restart, matching DispatchIdempotencyStore.
 * The durable count of rows comes from the store itself (`rows`).
 */

import type { ObservationStore } from "./store/observation-store.js";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "observation-wiring");

/**
 * Why a feedback-required transition produced no observation row.
 * Each value is a counted, logged, telemetry-visible outcome (AC1.3).
 */
export const OBSERVATION_SKIP_REASONS = [
  /** No ObservationStore reached the transition handler — bootstrap wiring gap. */
  "store-unwired",
  /** The implementer body could not be resolved from header, delegate, or store. */
  "from-body-unresolved",
  /** The SQLite insert threw. Fail-open: the transition still applies. */
  "write-failed",
] as const;

export type ObservationSkipReason = (typeof OBSERVATION_SKIP_REASONS)[number];

export interface ObservationCounters {
  /** Rows successfully appended since process start. */
  appended: number;
  /** Subset of `appended` written with the `unspecified` degraded reason code. */
  degraded: number;
  /** Feedback-required transitions that produced no row. */
  skipped: number;
  /** `skipped`, broken down by cause. Always has every key present. */
  skipsByReason: Record<ObservationSkipReason, number>;
}

export interface ObservationLiveness extends ObservationCounters {
  /** True only once `registerObservationWriter()` has run. Never a literal. */
  registered: boolean;
  /** Backing SQLite file, or null when unregistered. */
  dbPath: string | null;
  /** Durable row count read from the store, or null when unregistered. */
  rows: number | null;
}

function emptySkipCounts(): Record<ObservationSkipReason, number> {
  return Object.fromEntries(
    OBSERVATION_SKIP_REASONS.map((r) => [r, 0]),
  ) as Record<ObservationSkipReason, number>;
}

let _store: ObservationStore | undefined;
let _counters: ObservationCounters = {
  appended: 0,
  degraded: 0,
  skipped: 0,
  skipsByReason: emptySkipCounts(),
};

/**
 * Register the observation write path at server bootstrap (AC1.5).
 *
 * Returns the store so callers wire it by *using the return value* — the
 * registration cannot be dropped without also dropping the store.
 */
export function registerObservationWriter(store: ObservationStore): ObservationStore {
  _store = store;
  // AC1.6: liveness is observable from the startup log alone, before any
  // feedback-required transition has occurred.
  log.info(
    `observation write path registered at bootstrap: db=${store.dbPath} rows=${store.count()}`,
  );
  return store;
}

/**
 * The registered store, or `undefined` if bootstrap never registered one.
 *
 * Callers that need to write observations MUST source the store from here so
 * that "wired at bootstrap" and "usable by the write path" are the same fact.
 */
export function getRegisteredObservationStore(): ObservationStore | undefined {
  return _store;
}

/** Record a successful append. `degraded` marks an `unspecified` reason code. */
export function countObservationAppended(degraded: boolean): void {
  _counters.appended += 1;
  if (degraded) _counters.degraded += 1;
}

/** Record a skipped observation write. */
export function countObservationSkip(reason: ObservationSkipReason): void {
  _counters.skipped += 1;
  _counters.skipsByReason[reason] += 1;
}

/**
 * Liveness snapshot for `/health.observations` (AC1.6).
 *
 * `registered` reflects a real bootstrap call, and `rows` is read from SQLite —
 * neither is a hardcoded literal, so a dead write path is visible here without
 * waiting for a feedback-required transition to occur.
 */
export function getObservationLiveness(): ObservationLiveness {
  let rows: number | null = null;
  if (_store) {
    try {
      rows = _store.count();
    } catch {
      rows = null;
    }
  }
  return {
    registered: _store !== undefined,
    dbPath: _store?.dbPath ?? null,
    rows,
    ..._counters,
    skipsByReason: { ..._counters.skipsByReason },
  };
}

/** Test isolation only — drops the registration and zeroes the counters. */
export function resetObservationWiring(): void {
  _store = undefined;
  _counters = { appended: 0, degraded: 0, skipped: 0, skipsByReason: emptySkipCounts() };
}
