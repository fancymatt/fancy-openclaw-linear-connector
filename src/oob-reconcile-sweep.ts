/**
 * AI-1838 — Out-of-band mutation reconciliation sweep.
 *
 * Periodic safety net that compares Linear-webhook-observed state/label/delegate
 * changes against proxy-forwarded mutations. A webhook-observed change with no
 * corresponding proxy op is an out-of-band mutation — someone holding a raw
 * OAuth token called api.linear.app directly, bypassing the connector gate.
 *
 * This is the Pillar-1 bypass detection control (companion to the existing
 * enforcement layers in proxy.ts). Even when egress can't be blocked (AC2,
 * separate fleet decision with Matt), this surfaces out-of-band writes after
 * the fact so a human/agent can investigate.
 *
 * Design:
 *   - Reads uncorrelated webhook mutations past a grace window (lets the
 *     proxy op land first).
 *   - For each, looks for any proxy record for the same ticket + change type
 *     within a match window. If found → correlate. If not → flag.
 *   - Flagged mutations are surfaced via the alert bus + operational events,
 *     then marked resolved (AI-2191) so later passes report only per-window new
 *     OOB mutations — not an ever-growing cumulative total.
 *   - Idempotent: re-runs are safe. Both correlated and already-flagged records
 *     are excluded by the query (both carry correlated=1).
 */

import { componentLogger, createLogger } from "./logger.js";
import type { MutationAuditStore, MutationAuditRecord, ChangeType } from "./store/mutation-audit-store.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";
import { getAlertBus } from "./alerts/alert-bus.js";
import { registerCron, markCronRun, formatIntervalMs } from "./cron/registry.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "oob-reconcile");

/** Default grace window before a webhook mutation is eligible for reconcile.
 *  The proxy op may arrive slightly after the webhook; this prevents premature
 *  false positives. */
const DEFAULT_GRACE_MS = 5 * 60 * 1000; // 5 min

/** How far back to scan webhook mutations. */
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h

/** Half-width of the proxy-op match window around each webhook event. */
const DEFAULT_MATCH_WINDOW_MS = 10 * 60 * 1000; // ±10 min

/** Default sweep cadence. */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 min

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReconcileOptions {
  /** Override grace window (ms). */
  graceMs?: number;
  /** Override lookback (ms). */
  lookbackMs?: number;
  /** Override match half-window (ms). */
  matchWindowMs?: number;
  /** Override `Date.now()` for tests. */
  nowMs?: number;
  /** Alert bus (defaults to global). */
  alertBus?: ReturnType<typeof getAlertBus>;
  /** Operational event store for surfacing flags. */
  operationalEventStore?: OperationalEventStore;
}

export interface ReconcileResult {
  /** Total uncorrelated webhook mutations examined. */
  examined: number;
  /** Successfully correlated to a proxy op. */
  correlated: number;
  /** Flagged as out-of-band (no matching proxy op). */
  flagged: number;
  /** Details of flagged mutations. */
  flaggedDetails: Array<{
    ticket: string;
    changeType: ChangeType;
    field: string | null;
    recordedAt: string;
    actorId: string | null;
  }>;
}

// ── Core reconcile ───────────────────────────────────────────────────────────

/**
 * Run a single reconcile pass over the mutation audit store.
 *
 * Pure I/O — reads uncorrelated webhook mutations, tries to match each against
 * proxy records, correlates matches, and flags the rest via the alert bus +
 * operational events.
 */
export async function reconcileOobMutations(
  store: MutationAuditStore,
  opts?: ReconcileOptions,
): Promise<ReconcileResult> {
  const now = opts?.nowMs ?? Date.now();
  const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;
  const lookbackMs = opts?.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const matchWindowMs = opts?.matchWindowMs ?? DEFAULT_MATCH_WINDOW_MS;

  const lookbackIso = new Date(now - lookbackMs).toISOString();
  const graceCutoffIso = new Date(now - graceMs).toISOString();

  const changeTypes: ChangeType[] = ["state", "delegate", "label"];

  const uncorrelated = store.uncorrelatedWebhookMutations(changeTypes, lookbackIso, graceCutoffIso);
  log.info(`reconcile: examining ${uncorrelated.length} uncorrelated webhook mutation(s)`);

  let correlated = 0;
  let flagged = 0;
  const flaggedDetails: ReconcileResult["flaggedDetails"] = [];

  for (const webhookRec of uncorrelated) {
    const matchSince = new Date(new Date(webhookRec.recordedAt).getTime() - matchWindowMs).toISOString();
    const matchUntil = new Date(new Date(webhookRec.recordedAt).getTime() + matchWindowMs).toISOString();

    const candidates = store.findProxyCandidates(
      webhookRec.ticket,
      webhookRec.changeType,
      matchSince,
      matchUntil,
      webhookRec.ticketUuid,
    );

    if (candidates.length > 0) {
      // Match the first uncorrelated proxy candidate.
      const proxyMatch = candidates.find((c) => !c.correlated) ?? candidates[0];
      store.correlate(webhookRec.id, proxyMatch.id, new Date(now).toISOString());
      correlated++;
      continue;
    }

    // No proxy op found → out-of-band mutation.
    flagged++;
    flaggedDetails.push({
      ticket: webhookRec.ticket,
      changeType: webhookRec.changeType,
      field: webhookRec.field,
      recordedAt: webhookRec.recordedAt,
      actorId: webhookRec.actorId,
    });

    // Surface via operational event + alert.
    opts?.operationalEventStore?.append({
      outcome: "no-activity-warn",
      type: "oob-reconcile",
      key: webhookRec.ticket,
      sessionKey: webhookRec.ticket,
      errorSummary: `Out-of-band ${webhookRec.changeType} mutation detected: ${webhookRec.field ?? "?"} on ${webhookRec.ticket} — no matching proxy op`,
      detail: {
        changeType: webhookRec.changeType,
        field: webhookRec.field,
        oldValue: webhookRec.oldValue,
        newValue: webhookRec.newValue,
        actorId: webhookRec.actorId,
        recordedAt: webhookRec.recordedAt,
      },
    });

    // AI-2191: mark the flagged record resolved so subsequent sweeps don't
    // re-examine and re-alert it. Without this, `uncorrelatedWebhookMutations`
    // (filters correlated=0) re-counts the full cumulative OOB set every pass,
    // making the hourly alert count climb monotonically instead of reporting
    // the per-window delta. The flag persists in SQLite → no re-alert on restart.
    store.markFlaggedResolved(webhookRec.id, new Date(now).toISOString());
  }

  // Emit a consolidated alert if any mutations were flagged.
  if (flagged > 0) {
    const alertBus = opts?.alertBus ?? getAlertBus();
    const summary = flaggedDetails
      .slice(0, 10)
      .map((d) => `${d.ticket} ${d.changeType}:${d.field ?? "?"}`)
      .join("; ");
    alertBus.notify({
      severity: "warning",
      source: "oob-reconcile",
      title: `Out-of-band mutations detected (${flagged} ticket${flagged === 1 ? "" : "s"})`,
      detail: summary,
      dedupKey: `oob-reconcile|${new Date(now).toISOString().slice(0, 13)}`,
    });
    log.warn(`reconcile: flagged ${flagged} out-of-band mutation(s): ${summary}`);
  } else {
    log.info(`reconcile: clean — ${correlated} correlated, 0 flagged`);
  }

  return { examined: uncorrelated.length, correlated, flagged, flaggedDetails };
}

// ── Cron registrar ───────────────────────────────────────────────────────────

/**
 * Register the out-of-band reconcile sweep as a periodic cron driver.
 * Call from index.ts bootstrap alongside the other periodic sweeps.
 */
export function registerOobReconcileCron(
  store: MutationAuditStore,
  operationalEventStore?: OperationalEventStore,
  intervalMs?: number,
): void {
  const interval = intervalMs ?? (parseInt(process.env.OOB_RECONCILE_INTERVAL_MS ?? "", 10) || DEFAULT_INTERVAL_MS);

  registerCron("oob-reconcile-sweep", formatIntervalMs(interval));

  setInterval(() => {
    reconcileOobMutations(store, { operationalEventStore }).then(() => {
      markCronRun("oob-reconcile-sweep");
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`reconcile sweep failed: ${msg}`);
    }).finally(() => {
      markCronRun("oob-reconcile-sweep");
    });
  }, interval);

  log.info(`oob-reconcile sweep registered: ${formatIntervalMs(interval)}`);
}
