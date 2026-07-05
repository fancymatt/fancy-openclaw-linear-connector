/**
 * AI-1775 — Bootstrap reconciliation sweep.
 *
 * A periodic safety net that finds governed-intent tickets (wf:* label) that
 * never enrolled (no state:* label) past a configurable grace window and heals
 * them using the same bootstrap core as the webhook path
 * (`applyBootstrapToIssue` in workflow-bootstrap.ts).
 *
 * Problem solved: if Linear drops the Issue-update webhook, a wf:* label sits
 * on a ticket with no state:* label, no delegate, and no alert — the ticket is
 * permanently dark. The sweep detects and recovers this.
 *
 * Design notes:
 *   - Query: batch Linear search for wf:* labeled tickets, filter client-side
 *     for no state:* label and past grace window.
 *   - Heal: re-fetch issue context (idempotency) then call `applyBootstrapToIssue`
 *     — the exact same core the webhook bootstrap uses.
 *   - Alert: each heal emits a warning via the alert bus (`bootstrap-reconciled`).
 *   - Race-safe: the idempotency re-fetch inside the heal path prevents
 *     double-bootstrap when a late webhook lands between query and heal.
 *   - Error-tolerant: a Linear API error alerts and does not kill the loop.
 */

import { componentLogger, createLogger } from "./logger.js";
import {
  fetchIssueContext,
  applyBootstrapToIssue,
  type WorkflowDef,
} from "./workflow-bootstrap.js";
import type { AlertBus } from "./alerts/alert-bus.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "bootstrap-reconciliation");

const LINEAR_API_URL = "https://api.linear.app/graphql";

/** Default grace window: a ticket younger than this is given time for the
 *  Issue-update webhook to arrive naturally. */
const DEFAULT_GRACE_WINDOW_MS = 2 * 60 * 1000; // 2 min

/** Default sweep cadence (if registered via the cron helper). */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 min

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReconciliationSweepOptions {
  authToken: string;
  /** Optional workflow registry override. If absent, the core loads from file. */
  workflowRegistry?: Map<string, WorkflowDef>;
  /** Grace window in ms. Tickets younger than this are skipped. Default 2 min. */
  graceWindowMs?: number;
  /** Override for `Date.now()` — used in tests for deterministic timing. */
  nowMs?: number;
  /** Alert bus for heal/failure notifications. */
  alertBus?: AlertBus;
  /** Called to wake the first-owner delegate after a successful heal. */
  wakeFn?: (agentName: string, ticketIdentifier: string) => Promise<void>;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export interface ReconciliationSweepResult {
  /** Total unenrolled tickets returned by the query. */
  scanned: number;
  /** Tickets successfully healed (bootstrap applied). */
  healed: number;
  /** Tickets within the grace window (skipped, not healed). */
  withinGrace: number;
  /** Non-fatal errors encountered during the sweep. */
  errors: string[];
}

// ── Sweep query ──────────────────────────────────────────────────────────────

/**
 * Query Linear for tickets that have a `wf:*` label but may not have enrolled.
 *
 * The query is intentionally broad (all wf:* labeled issues) — the sweep
 * filters client-side for the absence of `state:*` labels and the grace window.
 * Linear's API does not support a "label NOT present" filter, so we fetch and
 * filter.
 */
async function queryUnenrolledTickets(
  authToken: string,
  fetchFn: typeof fetch,
): Promise<
  Array<{
    id: string;
    identifier: string;
    updatedAt: string;
    labels: Array<{ id: string; name: string }>;
    delegateId: string | null;
    teamId: string;
  }>
> {
  const query = `
    query BootstrapReconciliation {
      issues(filter: { labels: { some: { name: { startsWith: "wf:" } } } }) {
        nodes {
          id
          identifier
          updatedAt
          labels { nodes { id name } }
          delegate { id }
          team { id }
          title
        }
      }
    }
  `;

  const res = await fetchFn(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authToken },
    body: JSON.stringify({ query }),
  });

  type Resp = {
    data?: {
      issues?: {
        nodes: Array<{
          id: string;
          identifier: string;
          updatedAt: string;
          labels: { nodes: Array<{ id: string; name: string }> };
          delegate: { id: string } | null;
          team: { id: string };
        }>;
      };
    };
  };
  const data = (await res.json()) as Resp;
  const nodes = data.data?.issues?.nodes ?? [];

  return nodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    updatedAt: n.updatedAt,
    labels: n.labels.nodes,
    delegateId: n.delegate?.id ?? null,
    teamId: n.team.id,
  }));
}

// ── Main sweep ───────────────────────────────────────────────────────────────

/**
 * Run a single reconciliation sweep: query → filter → heal → alert.
 *
 * Never throws — all errors are captured in the `errors` array of the result
 * and surfaced via the alert bus.
 */
export async function runBootstrapReconciliationSweep(
  opts: ReconciliationSweepOptions,
): Promise<ReconciliationSweepResult> {
  const authToken = opts.authToken;
  const graceWindowMs = opts.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const alertBus = opts.alertBus;
  const wakeFn = opts.wakeFn;

  const result: ReconciliationSweepResult = {
    scanned: 0,
    healed: 0,
    withinGrace: 0,
    errors: [],
  };

  // ── Query ──────────────────────────────────────────────────────────────
  let candidates: Awaited<ReturnType<typeof queryUnenrolledTickets>>;
  try {
    candidates = await queryUnenrolledTickets(authToken, fetchFn);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`query failed: ${msg}`);
    log.error(`bootstrap-reconciliation: query failed: ${msg}`);
    alertBus?.notify({
      severity: "warning",
      source: "bootstrap-reconciled",
      title: `Bootstrap reconciliation sweep query failed: ${msg}`,
    });
    return result;
  }

  result.scanned = candidates.length;

  // ── Filter + heal ──────────────────────────────────────────────────────
  for (const ticket of candidates) {
    // Filter: must have a wf:* label but NO state:* label
    const hasStateLabel = ticket.labels.some((l) => l.name.startsWith("state:"));
    if (hasStateLabel) continue; // already enrolled — skip

    // Filter: grace window — give the webhook time to arrive
    const updatedAtMs = new Date(ticket.updatedAt).getTime();
    const ageMs = nowMs - updatedAtMs;
    if (ageMs < graceWindowMs) {
      result.withinGrace++;
      continue;
    }

    // Heal: re-fetch fresh issue context (idempotency guard for the race where
    // a webhook landed between query and heal) then apply bootstrap via the
    // shared core.
    try {
      const issue = await fetchIssueContext(ticket.id, authToken);
      if (!issue) {
        result.errors.push(`could not re-fetch issue context for ${ticket.identifier}`);
        continue;
      }

      // Double-check idempotency on fresh data — if state:* appeared between
      // query and re-fetch, the ticket was enrolled by the webhook. Skip.
      if (issue.labels.some((l) => l.name.startsWith("state:"))) continue;

      const bootstrapResult = await applyBootstrapToIssue(
        issue,
        authToken,
        opts.workflowRegistry,
      );

      if (bootstrapResult?.action === "bootstrapped") {
        result.healed++;
        log.info(
          `bootstrap-reconciliation: healed ${ticket.identifier} → ${bootstrapResult.workflowId}:${bootstrapResult.entryState}`,
        );

        // Dispatch wake to the first-owner delegate
        if (wakeFn) {
          try {
            await wakeFn(
              bootstrapResult.delegateAgentName ?? "",
              bootstrapResult.ticketIdentifier ?? ticket.identifier,
            );
          } catch (wakeErr) {
            const wakeMsg = wakeErr instanceof Error ? wakeErr.message : String(wakeErr);
            log.warn(`bootstrap-reconciliation: wake failed for ${ticket.identifier}: ${wakeMsg}`);
          }
        }

        // Emit deduped warning alert — a heal is evidence a webhook was dropped
        alertBus?.notify({
          severity: "warning",
          source: "bootstrap-reconciled",
          title: `Bootstrap reconciliation healed ${ticket.identifier}`,
          detail: {
            ticket: ticket.identifier,
            issueId: ticket.id,
            workflow: bootstrapResult.workflowId,
            entryState: bootstrapResult.entryState,
            delegate: bootstrapResult.delegateAgentName ?? null,
          },
          ticket: ticket.identifier,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`heal failed for ${ticket.identifier}: ${msg}`);
      log.error(`bootstrap-reconciliation: heal failed for ${ticket.identifier}: ${msg}`);
      alertBus?.notify({
        severity: "warning",
        source: "bootstrap-reconciled",
        title: `Bootstrap reconciliation heal error for ${ticket.identifier}`,
        detail: { error: msg },
        ticket: ticket.identifier,
      });
    }
  }

  return result;
}

// ── Cron registration ───────────────────────────────────────────────────────

/**
 * Register the reconciliation sweep as a recurring interval timer.
 *
 * Returns the NodeJS.Timeout so the caller can clear it (e.g. on shutdown).
 * In production this is called once from index.ts alongside other periodic
 * loops.
 */
export function registerBootstrapReconciliationCron(
  opts?: { intervalMs?: number },
): NodeJS.Timeout {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;

  const timer = setInterval(() => {
    // Fire-and-forget — errors are captured inside the sweep and surfaced
    // via the alert bus, not propagated to the interval handler.
    void runBootstrapReconciliationSweep({
      authToken: process.env.LINEAR_GENERIC_TOKEN ?? "",
    }).catch((err) => {
      log.error(
        `bootstrap-reconciliation: unexpected sweep failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, intervalMs);

  log.info(`bootstrap-reconciliation: cron registered (${intervalMs}ms interval)`);
  return timer;
}
