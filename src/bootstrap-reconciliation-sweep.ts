/**
 * AI-1775 — Bootstrap reconciliation sweep.
 *
 * Stub — implementation by Igor. Tests in bootstrap-reconciliation-sweep.test.ts.
 */

import type { AlertBus } from "./alerts/alert-bus.js";

export interface ReconciliationSweepOptions {
  authToken: string;
  workflowRegistry?: Map<string, { id?: string; entry_state?: string; states: Array<{ id: string; owner_role?: string }> }>;
  graceWindowMs?: number;
  nowMs?: number;
  alertBus?: AlertBus;
  wakeFn?: (agentName: string, ticketIdentifier: string) => Promise<void>;
  fetchFn?: typeof fetch;
}

export interface ReconciliationSweepResult {
  scanned: number;
  healed: number;
  withinGrace: number;
  errors: string[];
}

export async function runBootstrapReconciliationSweep(
  _opts: ReconciliationSweepOptions,
): Promise<ReconciliationSweepResult> {
  return { scanned: 0, healed: 0, withinGrace: 0, errors: [] };
}

export function registerBootstrapReconciliationCron(
  _opts?: { intervalMs?: number },
): NodeJS.Timeout {
  return setInterval(() => {}, 60_000);
}
