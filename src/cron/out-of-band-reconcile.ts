/**
 * AI-1838 AC2 — Out-of-band mutation reconciliation.
 *
 * Periodically scans `state-change-observed` audit events (from webhook payload
 * audit, AC1) and flags any state/label/delegate change that has no corresponding
 * proxy op (`proxy-forwarded` / `transition-applied`). A change with no proxy
 * record means it was made directly via the Linear UI or raw token API — bypassing
 * the connector proxy. This is the Pillar-1 bypass detection gate.
 *
 * Algorithm:
 *   1. Query `state-change-observed` events from the lookback window.
 *   2. For each, search for a `proxy-forwarded` or `transition-applied` event
 *      for the same ticket (subject_key) within a time tolerance of the change.
 *   3. If no matching proxy op is found, emit `out-of-band-detected` with the
 *      change details and the actor who made it.
 *
 * The reconcile is detection-only (per AC: "flag any state/label/delegate change
 * with no matching proxy op"). It does not revert changes — that's a separate
 * hardening decision. Findings are surfaced as operational events, which the
 * existing alert infrastructure picks up.
 */

import { createLogger, componentLogger } from "../logger.js";
import type { OperationalEventStore, OperationalEvent } from "../store/operational-event-store.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "oob-reconcile");

/** Maximum time (ms) between a proxy op and the resulting webhook state-change observation. */
const DEFAULT_RECONCILE_TOLERANCE_MS = 60_000; // 1 minute — Linear webhook delivery + processing delay
const DEFAULT_RECONCILE_LOOKBACK_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_RECONCILE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export interface OutOfBandReconcileOptions {
  operationalEventStore: OperationalEventStore;
  toleranceMs?: number;
  lookbackMs?: number;
}

export interface OutOfBandReconcileResult {
  scanned: number;
  matched: number;
  outOfBandDetected: number;
  errors: string[];
}

/**
 * Run a single reconcile pass. Queries recent `state-change-observed` events and
 * flags any that have no matching proxy op.
 */
export function runOutOfBandReconcilePass(opts: OutOfBandReconcileOptions): OutOfBandReconcileResult {
  const { operationalEventStore: store } = opts;
  const toleranceMs = opts.toleranceMs ?? DEFAULT_RECONCILE_TOLERANCE_MS;
  const lookbackMs = opts.lookbackMs ?? DEFAULT_RECONCILE_LOOKBACK_MS;

  const since = new Date(Date.now() - lookbackMs).toISOString();
  const errors: string[] = [];

  // Get all state-change-observed events in the lookback window.
  const stateChanges = store.query({ outcome: "state-change-observed", since, limit: 500 });

  // Get all proxy-forwarded and transition-applied events in the same window.
  // We fetch both and merge into a single timeline per ticket.
  const proxyForwards = store.query({ outcome: "proxy-forwarded", since, limit: 500 });
  const transitionsApplied = store.query({ outcome: "transition-applied", since, limit: 500 });

  // Build a per-ticket timeline of proxy-initiated ops.
  const proxyOpsByTicket = new Map<string, number[]>();
  for (const op of [...proxyForwards, ...transitionsApplied]) {
    const ticketKey = op.key;
    if (!ticketKey) continue;
    const timestamp = Date.parse(op.occurredAt);
    if (isNaN(timestamp)) continue;
    const arr = proxyOpsByTicket.get(ticketKey) ?? [];
    arr.push(timestamp);
    proxyOpsByTicket.set(ticketKey, arr);
  }

  let matched = 0;
  let outOfBandDetected = 0;

  for (const change of stateChanges) {
    const ticketKey = change.key;
    if (!ticketKey) continue;

    const changeTime = Date.parse(change.occurredAt);
    if (isNaN(changeTime)) continue;

    // Check if any proxy op for this ticket occurred within the tolerance window.
    const ops = proxyOpsByTicket.get(ticketKey) ?? [];
    const hasMatch = ops.some((opTime) => Math.abs(opTime - changeTime) <= toleranceMs);

    if (hasMatch) {
      matched++;
      continue;
    }

    // No matching proxy op — this is an out-of-band mutation.
    outOfBandDetected++;

    const detail = change.detail as Record<string, unknown> | null;
    const actor = (detail?.actor as Record<string, unknown> | undefined) ?? {};
    const changes = (detail?.changes as Record<string, unknown> | undefined) ?? {};

    log.warn(
      `[oob-reconcile] Out-of-band mutation detected: ticket=${ticketKey} ` +
      `actor=${actor.name ?? "unknown"} isAgent=${actor.isAgent ?? false} ` +
      `changes=${Object.keys(changes).join(",")}`,
    );

    // Emit the detection event so alerts can fire.
    store.append({
      outcome: "out-of-band-detected",
      key: ticketKey,
      sessionKey: ticketKey,
      agent: (actor.name as string | undefined) ?? null,
      errorSummary: `Out-of-band state change on ${ticketKey} by ${actor.name ?? "unknown"}: ${Object.keys(changes).join(", ")}`,
      detail: {
        ticket: ticketKey,
        actor: { name: actor.name ?? "unknown", id: actor.id ?? null, isAgent: actor.isAgent ?? false },
        changes,
        observedAt: change.occurredAt,
        toleranceMs,
      },
    });
  }

  const result: OutOfBandReconcileResult = {
    scanned: stateChanges.length,
    matched,
    outOfBandDetected,
    errors,
  };

  if (outOfBandDetected > 0 || stateChanges.length > 0) {
    log.info(
      `[oob-reconcile] Pass complete: scanned=${result.scanned} ` +
      `matched=${result.matched} out-of-band=${result.outOfBandDetected}`,
    );
  }

  return result;
}

/**
 * Register the periodic out-of-band reconcile cron.
 */
export function registerOutOfBandReconcileCron(opts: {
  operationalEventStore: OperationalEventStore;
  intervalMs?: number;
  toleranceMs?: number;
  lookbackMs?: number;
}): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? (
    process.env.OUT_OF_BAND_RECONCILE_INTERVAL
      ? parseInt(process.env.OUT_OF_BAND_RECONCILE_INTERVAL, 10)
      : DEFAULT_RECONCILE_INTERVAL_MS
  );

  const timer = setInterval(() => {
    try {
      const result = runOutOfBandReconcilePass({
        operationalEventStore: opts.operationalEventStore,
        toleranceMs: opts.toleranceMs,
        lookbackMs: opts.lookbackMs,
      });
      if (result.outOfBandDetected > 0) {
        log.warn(
          `[oob-reconcile] Scheduled pass detected ${result.outOfBandDetected} out-of-band mutation(s)`,
        );
      }
    } catch (err) {
      log.error(
        `[oob-reconcile] Scheduled pass failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, intervalMs);

  timer.unref();
  return timer;
}
