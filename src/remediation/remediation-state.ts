/**
 * INF-320 — Remediation state store.
 *
 * In-memory store for remediation action records. Every invocation of
 * executeRemediation() is recorded here — the action kind, failure_class,
 * outcome, timestamp, and attempt count. History is filterable by ticketId
 * and returned in chronological order (oldest first).
 *
 * The /health liveness surface (getRemediationHealth()) exposes the total
 * action count and the most recent records, proving the store is wired at
 * the production entry point without needing a real failure_class event.
 */

import { createLogger, componentLogger } from "../logger.js";
import type {
  RemediationHealth,
  RemediationRecord,
  RemediationResult,
} from "./remediation-types.js";

const log = componentLogger(createLogger(), "remediation-state");

// ── In-memory store ────────────────────────────────────────────────────────

const _records: RemediationRecord[] = [];

const MAX_HEALTH_RECENTS = 50;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Persist a remediation result as a record in the store.
 */
export function recordRemediation(result: RemediationResult): void {
  const record: RemediationRecord = {
    actionKind: result.action.kind,
    actionClass: result.actionClass,
    failureClass: result.failureClass,
    outcome: result.outcome,
    timestamp: result.recordedAt,
    attemptCount: result.attemptCount,
    ticketId: result.context.ticketId,
  };
  _records.push(record);
  log.debug(`remediation-state: recorded ${result.action.kind} / ${result.outcome} for ${result.context.ticketId}`);
}

/**
 * Returns remediation history, optionally filtered by ticketId.
 * Entries are returned in chronological order (oldest first).
 */
export function getRemediationHistory(ticketId?: string): RemediationRecord[] {
  const records = ticketId
    ? _records.filter((r) => r.ticketId === ticketId)
    : [..._records];
  return records.sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
}

/**
 * Returns liveness snapshot for the /health endpoint.
 * Proves the store is wired at the production entry point (AI-1808 guard).
 */
export function getRemediationHealth(): RemediationHealth {
  return {
    armed: true,
    totalActions: _records.length,
    recentActions: _records.slice(-MAX_HEALTH_RECENTS),
  };
}

/**
 * Reset all state (test isolation only).
 * Clears the in-memory record store.
 */
export function resetRemediationStateForTest(): void {
  _records.length = 0;
}
