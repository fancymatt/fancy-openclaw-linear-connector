/**
 * INF-282 — Reconciliation wake path with DispatchLeaseStore gate.
 *
 * During reconciliation sweeps (startup drain, pending bag replay, stale
 * session re-signal, anti-entropy passes), the connector must check the
 * DispatchLeaseStore before waking an agent for a ticket.
 *
 * See: deliverToAgent (src/delivery/deliver.ts) — already has lease checking.
 *      reconciliationWakeFn (this file) — NOW has lease checking (INF-282).
 */

import { deliverMessageToAgent, type DeliveryConfig } from "../delivery/index.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface ReconciliationWakeOptions {
  agentId: string;
  ticketId: string;
  leaseStore: {
    hasActiveLease(agentId: string, ticketId: string): boolean;
    acquireLease(agentId: string, ticketId: string, ttlMs: number): boolean;
    releaseLease(agentId: string, ticketId: string): void;
    getLease(agentId: string, ticketId: string): { agentId: string; ticketId: string; acquiredAt: number; ttlMs: number } | null;
    pruneExpired(): number;
  };
  leaseTtlMs: number;
  /** Optional delivery config forwarded to deliverMessageToAgent. */
  deliveryConfig?: DeliveryConfig;
  /**
   * Optional test-injectable delivery function.
   * Defaults to deliverMessageToAgent when omitted.
   */
  sendWake?: (agentId: string, ticketId: string, message: string, config: DeliveryConfig) => Promise<{ dispatched: boolean }>;
}

export interface ReconciliationWakeResult {
  /** True when the wake was suppressed due to an active lease. */
  suppressed: boolean;
  /** True when the wake message was actually dispatched. */
  dispatched: boolean;
  /** Optional human-readable reason for suppression or failure. */
  reason?: string;
}

// ── Implementation (lease-check wired) ────────────────────────────────────

/**
 * Default delivery function that wraps deliverMessageToAgent.
 */
async function defaultSendWake(
  agentId: string,
  ticketId: string,
  message: string,
  config: DeliveryConfig,
): Promise<{ dispatched: boolean }> {
  return await deliverMessageToAgent(agentId, ticketId, message, config);
}

/**
 * Deliver a reconciliation wake to an agent for a ticket.
 *
 * Checks the DispatchLeaseStore before delivering to prevent duplicate
 * wakes for tickets that are already being processed. The sequence is:
 *
 *   1. Prune expired leases (lazy cleanup).
 *   2. Check hasActiveLease — suppress if an active lease exists.
 *   3. Attempt to acquire a lease — suppress if racing a concurrent acquire.
 *   4. Deliver the wake message.
 */
export async function reconciliationWakeFn(
  options: ReconciliationWakeOptions,
): Promise<ReconciliationWakeResult> {
  const { agentId, ticketId, leaseStore, leaseTtlMs, deliveryConfig, sendWake } = options;

  const deliver = sendWake ?? defaultSendWake;

  // Step 1: Prune expired leases (lazy cleanup before checking).
  leaseStore.pruneExpired();

  // Step 2: Check if an active lease already exists for this (agent, ticket).
  // This prevents duplicate wakes when a webhook delivery or prior reconciliation
  // pass already dispatched this ticket.
  if (leaseStore.hasActiveLease(agentId, ticketId)) {
    return { suppressed: true, dispatched: false, reason: "Active lease exists" };
  }

  // Step 3: Attempt to acquire a lease for this reconciliation wake.
  // The acquire may fail if a concurrent reconciliation pass won the race.
  const acquired = leaseStore.acquireLease(agentId, ticketId, leaseTtlMs);
  if (!acquired) {
    return {
      suppressed: true,
      dispatched: false,
      reason: "Failed to acquire lease (racing concurrent acquire)",
    };
  }

  // Step 4: Deliver the wake message now that we hold a lease.
  try {
    const result = await deliver(
      agentId,
      ticketId,
      `Reconciliation wake for ticket ${ticketId.replace(/^linear-/, "")}`,
      deliveryConfig ?? { nodeBin: process.execPath },
    );
    return {
      suppressed: false,
      dispatched: result.dispatched,
    };
  } catch (err) {
    return {
      suppressed: false,
      dispatched: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
