/**
 * Phase 6.5 / H-6: Label-projection store.
 *
 * Records the authoritative connector-side workflow state for each governed
 * ticket. This is the "store" in the H-6 label read-only projection design:
 *
 *   - The proxy is the sole writer; it records state on every successful
 *     state transition (applyStateTransition in workflow-gate.ts).
 *   - checkWorkflowRules reads from this store (not from Linear labels) when
 *     an entry exists — labels are a read-only projection, not the source.
 *   - The drift reconciler (reconcileLabelDrift) detects when a Linear label
 *     diverges from the store and re-projects the correct label, emitting an
 *     alert. The label never wins; the store always wins.
 *
 * Storage: JSON file (PROJECTION_STORE_PATH env or /tmp/label-projection-store.json).
 * Pattern mirrors implementer-store.ts.
 */

import fs from "node:fs/promises";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "label-projection-store");

const DEFAULT_PROJECTION_STORE_PATH = "/tmp/label-projection-store.json";

function projectionStorePath(): string {
  return process.env.PROJECTION_STORE_PATH ?? DEFAULT_PROJECTION_STORE_PATH;
}

export interface LabelProjectionRecord {
  workflowId: string;
  stateName: string;
  projectedAt: string;
}

const _store = new Map<string, LabelProjectionRecord>();
let _loaded = false;

async function ensureLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await fs.readFile(projectionStorePath(), "utf8");
    const data = JSON.parse(raw) as Record<string, LabelProjectionRecord>;
    for (const [key, record] of Object.entries(data)) {
      _store.set(key, record);
    }
    log.info(`label-projection-store: loaded ${_store.size} record(s) from ${projectionStorePath()}`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      log.info(`label-projection-store: no persisted records at ${projectionStorePath()} — starting fresh`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`label-projection-store: failed to load from ${projectionStorePath()}: ${msg}`);
    }
  }
}

async function persist(): Promise<void> {
  // Skip disk I/O in test mode to prevent async writes from outliving the Jest environment.
  if (process.env.JEST_WORKER_ID) return;
  try {
    const data: Record<string, LabelProjectionRecord> = {};
    for (const [key, record] of _store) {
      data[key] = record;
    }
    await fs.writeFile(projectionStorePath(), JSON.stringify(data, null, 2), "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`label-projection-store: failed to persist to ${projectionStorePath()}: ${msg}`);
  }
}

/** Record (or update) the authoritative workflow state for a ticket. */
export async function recordProjection(
  issueId: string,
  workflowId: string,
  stateName: string,
): Promise<void> {
  await ensureLoaded();
  _store.set(issueId, { workflowId, stateName, projectedAt: new Date().toISOString() });
  log.info(`label-projection-store: recorded ${issueId} → ${workflowId}:${stateName}`);
  await persist();
}

/** Get the authoritative projection for a ticket, or null if not tracked. */
export async function getProjection(issueId: string): Promise<LabelProjectionRecord | null> {
  await ensureLoaded();
  return _store.get(issueId) ?? null;
}

/** Return a snapshot of all tracked projections (triggers load on first call). */
export async function getAllProjections(): Promise<ReadonlyMap<string, LabelProjectionRecord>> {
  await ensureLoaded();
  return _store;
}

/** Remove the projection when a ticket leaves the workflow (escape, __ad_hoc__). */
export async function removeProjection(issueId: string): Promise<void> {
  await ensureLoaded();
  if (_store.has(issueId)) {
    _store.delete(issueId);
    log.info(`label-projection-store: removed record for ${issueId}`);
    await persist();
  }
}

/**
 * Clear all records. Sets _loaded=true so subsequent calls don't re-read
 * stale disk state (used in tests for isolation).
 */
export function clearProjectionStore(): void {
  _store.clear();
  _loaded = true;
}
