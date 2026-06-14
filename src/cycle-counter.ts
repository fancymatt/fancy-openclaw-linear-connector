/**
 * Phase 6.5 / H-8 — Sprint oscillation cycle counter (§14b).
 *
 * For Archetype-C (sprint) workflows, the `validating → spawning` rework loop
 * carries a cycle counter that increments each time validation kicks work back
 * for another spawn round. It does not block the loop (genuine multi-round
 * sprints exist) — it is a metric; a high count flags a sprint that keeps
 * failing its own integrated AC.
 *
 * Storage is persisted to a JSON file (CYCLE_COUNTER_PATH env or
 * /tmp/cycle-counter.json by default). On startup, existing records are
 * loaded from disk. The store is keyed by ticket identifier (e.g. "AI-1483").
 *
 * Design: design.md §14b.
 */

import fs from "node:fs/promises";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "cycle-counter");

/** Default path for persisted cycle counter records. Override via CYCLE_COUNTER_PATH env. */
const DEFAULT_CYCLE_COUNTER_PATH = "/tmp/cycle-counter.json";

function cycleCounterPath(): string {
  return process.env.CYCLE_COUNTER_PATH ?? DEFAULT_CYCLE_COUNTER_PATH;
}

/** A cycle counter record for a single sprint ticket. */
export interface CycleCounterRecord {
  /** Current oscillation cycle count. */
  cycles: number;
  /** ISO timestamp of the first cycle (initial spawn). */
  firstCycleAt: string;
  /** ISO timestamp of the most recent cycle increment. */
  lastCycleAt: string;
  /** The workflow ID (should be "sprint"). */
  workflowId: string;
}

/** In-memory store: ticket identifier → CycleCounterRecord. */
const _store = new Map<string, CycleCounterRecord>();

/** In-flight load promise to prevent race conditions during startup. */
let _loadingPromise: Promise<void> | null = null;

/**
 * Load persisted cycle counter records from disk. Idempotent — only loads once.
 * Fail-open: if the file doesn't exist or is corrupt, start with empty store.
 */
async function ensureLoaded(): Promise<void> {
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = _doLoad();
  return _loadingPromise;
}

/** Internal async load implementation. */
async function _doLoad(): Promise<void> {
  try {
    const raw = await fs.readFile(cycleCounterPath(), "utf8");
    const data = JSON.parse(raw) as Record<string, CycleCounterRecord>;
    for (const [key, record] of Object.entries(data)) {
      _store.set(key, record);
    }
    log.info(`cycle-counter: loaded ${_store.size} record(s) from ${cycleCounterPath()}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      log.info(`cycle-counter: no persisted records file at ${cycleCounterPath()} — starting fresh`);
    } else {
      log.warn(`cycle-counter: failed to load persisted records from ${cycleCounterPath()}: ${msg}`);
    }
  }
}

/**
 * Persist the current store to disk. Fail-open: logs errors but never throws.
 */
async function persist(): Promise<void> {
  try {
    const data: Record<string, CycleCounterRecord> = {};
    for (const [key, record] of _store) {
      data[key] = record;
    }
    await fs.writeFile(cycleCounterPath(), JSON.stringify(data, null, 2), "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`cycle-counter: failed to persist records to ${cycleCounterPath()}: ${msg}`);
  }
}

/**
 * §14b: Increment the oscillation cycle counter for a sprint ticket.
 *
 * Called when the sprint workflow transitions from `validating` back to
 * `spawning` (a rework cycle). The first spawn sets the counter to 1;
 * each subsequent re-spawn increments it.
 *
 * Returns the new cycle count.
 */
export async function incrementCycle(
  ticketId: string,
  workflowId: string,
): Promise<number> {
  await ensureLoaded();
  const now = new Date().toISOString();
  const existing = _store.get(ticketId);

  if (existing) {
    existing.cycles++;
    existing.lastCycleAt = now;
    log.info(
      `cycle-counter: ${ticketId} cycle ${existing.cycles} (workflow: ${workflowId})`,
    );
    await persist();
    return existing.cycles;
  }

  const record: CycleCounterRecord = {
    cycles: 1,
    firstCycleAt: now,
    lastCycleAt: now,
    workflowId,
  };
  _store.set(ticketId, record);
  log.info(`cycle-counter: ${ticketId} first cycle (workflow: ${workflowId})`);
  await persist();
  return 1;
}

/**
 * Get the current cycle count for a sprint ticket.
 * Returns 0 if no record exists (ticket has not entered the spawning loop).
 */
export async function getCycleCount(ticketId: string): Promise<number> {
  await ensureLoaded();
  return _store.get(ticketId)?.cycles ?? 0;
}

/**
 * Get the full cycle counter record for a sprint ticket.
 * Returns null if no record exists.
 */
export async function getCycleRecord(ticketId: string): Promise<CycleCounterRecord | null> {
  await ensureLoaded();
  return _store.get(ticketId) ?? null;
}

/**
 * Remove the cycle counter record for a ticket (cleanup on terminal state / escape).
 * Returns true if a record was removed, false if none existed.
 * Persists to disk after removal.
 */
export async function removeCycleRecord(ticketId: string): Promise<boolean> {
  await ensureLoaded();
  const had = _store.delete(ticketId);
  if (had) {
    log.info(`cycle-counter: removed record for ${ticketId}`);
    await persist();
  }
  return had;
}

/**
 * Clear all records (for testing).
 */
export function clearCycleCounterStore(): void {
  _store.clear();
  _loadingPromise = null;
}
