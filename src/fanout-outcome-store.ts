/**
 * INF-28 — Barrier backstop: per-parent fanout outcome store.
 *
 * Records the result of a fan-out operation on a per-parent basis so the
 * barrier engine can evaluate against a recorded *outcome* (tagged by type)
 * rather than re-querying accumulated child history.
 *
 * An empty child set is ambiguous across six distinct situations — waived,
 * refused, pending-approval, dedup-no-op-with-live-children, mint-failed,
 * and eval-error. Three must satisfy or wait; three must alarm. By recording
 * a tagged outcome at barrier entry, the barrier engine can discriminate
 * correctly rather than collapsing all to "zero children → advance."
 *
 * Storage is persisted to a JSON file. The path resolves as: the explicit
 * FANOUT_OUTCOME_PATH override, else `<DATA_DIR>/fanout-outcomes.json`,
 * following the same `process.env.DATA_DIR ?? <cwd>/data` convention every
 * other connector store uses.
 *
 * Design: INF-28 AC2 (rewritten recorded-outcome axis).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "fanout-outcome-store");

/**
 * The types of fanout outcomes that can be recorded per parent.
 *
 * | Outcome | Meaning |
 * |---------|---------|
 * | `not-declared` | source state declares no fanout: block |
 * | `waived` | spawn_if evaluated false on a successful read |
 * | `awaiting` | spec-matched set, non-empty — wait on these children |
 * | `refused` | bad child_workflow / empty spec / cap violation |
 * | `pending-approval` | steward approval outstanding |
 * | `failed` | attempted N, minted 0; or read/eval error |
 */
export type FanoutOutcomeType =
  | "not-declared"
  | "waived"
  | "awaiting"
  | "refused"
  | "pending-approval"
  | "failed";

/**
 * A recorded fan-out outcome for a parent identifier.
 */
export interface FanoutOutcome {
  /** The outcome type — what happened when the fan-out was applied. */
  outcome: FanoutOutcomeType;
  /**
   * For `awaiting` outcomes: the identifiers of spec-matched children the
   * barrier should wait on. For all other outcomes, this is undefined.
   */
  childIdentifiers?: string[];
  /** ISO timestamp when the outcome was recorded (at barrier entry). */
  recordedAt: string;
}

/**
 * Resolve the on-disk path for persisted fanout outcomes.
 *
 * Precedence: the explicit FANOUT_OUTCOME_PATH override, else the shared data
 * directory (`DATA_DIR` env, else `<cwd>/data`) joined with "fanout-outcomes.json".
 */
export function fanoutOutcomeStorePath(): string {
  if (process.env.FANOUT_OUTCOME_PATH) return process.env.FANOUT_OUTCOME_PATH;
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dataDir, "fanout-outcomes.json");
}

/** In-memory store: parent identifier → FanoutOutcome. */
const _store = new Map<string, FanoutOutcome>();

/** Whether the initial load from disk has been attempted. */
let _loaded = false;

/** The path from which _store was last loaded — invalidated when the path changes. */
let _loadedFromPath: string | null = null;

/**
 * Load persisted fanout outcomes from disk. Idempotent — only loads once per path.
 * Re-loads automatically when FANOUT_OUTCOME_PATH changes (test isolation).
 * Fail-open: if the file doesn't exist or is corrupt, start with an empty store
 * and log a warning.
 */
async function ensureLoaded(): Promise<void> {
  const currentPath = fanoutOutcomeStorePath();
  if (_loaded && _loadedFromPath === currentPath) return;
  _store.clear();
  _loaded = true;
  _loadedFromPath = currentPath;
  try {
    const raw = await fs.readFile(fanoutOutcomeStorePath(), "utf8");
    const data = JSON.parse(raw) as Record<string, FanoutOutcome>;
    for (const [key, record] of Object.entries(data)) {
      _store.set(key, record);
    }
    log.info(`fanout-outcome-store: loaded ${_store.size} record(s) from ${fanoutOutcomeStorePath()}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      log.info(`fanout-outcome-store: no persisted records file at ${fanoutOutcomeStorePath()} — starting fresh`);
    } else {
      log.warn(`fanout-outcome-store: failed to load persisted records from ${fanoutOutcomeStorePath()}: ${msg}`);
    }
  }
}

/**
 * Persist the current store to disk. Throws on failure — callers must handle
 * the error because an unwritable record means the barrier cannot trust its
 * evaluation (INF-28 AC2: write must not be fail-open).
 */
async function persist(): Promise<void> {
  const data: Record<string, FanoutOutcome> = {};
  for (const [key, record] of _store) {
    data[key] = record;
  }
  const target = fanoutOutcomeStorePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Record a fanout outcome for a parent identifier.
 * Overwrites any existing record (new cycle replaces old).
 * Persists to disk after recording.
 * Throws on write failure so callers can suppress barrier auto-advance.
 */
export async function recordFanoutOutcome(
  parentIdentifier: string,
  outcome: FanoutOutcome,
): Promise<void> {
  await ensureLoaded();
  _store.set(parentIdentifier, outcome);
  log.info(
    `fanout-outcome-store: recorded outcome '${outcome.outcome}' for parent ${parentIdentifier}` +
    (outcome.childIdentifiers?.length
      ? ` (${outcome.childIdentifiers.length} child(ren): ${outcome.childIdentifiers.join(", ")})`
      : ""),
  );
  await persist();
}

/**
 * Retrieve the fanout outcome for a parent identifier.
 * Returns null if no outcome has been recorded (parent predates the feature,
 * or no fan-out has run since deploy).
 */
export async function getFanoutOutcome(parentIdentifier: string): Promise<FanoutOutcome | null> {
  await ensureLoaded();
  return _store.get(parentIdentifier) ?? null;
}

/**
 * Check whether a parent has a recorded fanout outcome.
 */
export async function hasFanoutOutcome(parentIdentifier: string): Promise<boolean> {
  await ensureLoaded();
  return _store.has(parentIdentifier);
}

/**
 * Remove the fanout outcome for a parent identifier (cleanup).
 * Returns true if a record was removed, false if none existed.
 */
export async function removeFanoutOutcome(parentIdentifier: string): Promise<boolean> {
  await ensureLoaded();
  const had = _store.delete(parentIdentifier);
  if (had) {
    log.info(`fanout-outcome-store: removed outcome for parent ${parentIdentifier}`);
    await persist();
  }
  return had;
}

/** Clear all fanout outcomes. Used in tests. */
export function clearFanoutOutcomeStore(): void {
  _store.clear();
  _loaded = false;
  _loadedFromPath = null;
}

// ── Startup liveness state (INF-28 AC4) ───────────────────────────────────────────────

/** Whether the startup liveness check has been completed. */
let _livenessCompleted = false;

/** Whether the startup liveness check passed (only meaningful when _livenessCompleted). */
let _livenessOk = false;

/** ISO timestamp of the last liveness check (startup). */
let _livenessCheckedAt: string | null = null;

/**
 * Reset liveness state (for tests).
 */
export function resetFanoutOutcomeStoreLiveness(): void {
  _livenessCompleted = false;
  _livenessOk = false;
  _livenessCheckedAt = null;
}

/**
 * Return the recorded liveness state — never calls the store; for /health surfacing.
 */
export function getFanoutOutcomeStoreLiveness(): {
  healthy: boolean | null;
  checkedAt: string | null;
} {
  return {
    healthy: _livenessCompleted ? _livenessOk : null,
    checkedAt: _livenessCheckedAt,
  };
}

/**
 * Startup liveness check: verify the store is readable and writable.
 * An unreadable/unwritable DATA_DIR is a fatal, alarming condition — it would
 * make every record `absent` → warn → advance → LIF-2 fleet-wide, silently.
 * (INF-28 AC4.)
 *
 * Call once at startup. Does not fail the process; logs fatally and returns
 * false so the caller can decide the escalation policy.
 */
export async function checkFanoutOutcomeStoreLiveness(): Promise<boolean> {
  try {
    await ensureLoaded();
    // Verify writability by persisting (no new records, just the current state)
    await persist();
    _livenessCompleted = true;
    _livenessOk = true;
    _livenessCheckedAt = new Date().toISOString();
    log.info("fanout-outcome-store: liveness check passed");
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    _livenessCompleted = true;
    _livenessOk = false;
    _livenessCheckedAt = new Date().toISOString();
    log.error(
      `fanout-outcome-store: LIVENESS CHECK FAILED — DATA_DIR may be unwritable. ` +
      `Every fanout outcome will be absent → current-behavior → potential vacuous advance. ` +
      `Error: ${msg}`,
    );
    return false;
  }
}
