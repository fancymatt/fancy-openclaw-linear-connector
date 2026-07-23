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
 *   - Heal (Pass 1 — unenrolled): re-fetch issue context (idempotency) then
 *     call `applyBootstrapToIssue` — the exact same core the webhook bootstrap uses.
 *   - Heal (Pass 2 — enrolled, AI-2016 AC3): for tickets WITH state:* labels that
 *     are native-Done with merged PRs, strip wf:* and state:* labels and clear
 *     delegate so the workflow record closes.
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
import { getAlertBus, type AlertBus } from "./alerts/alert-bus.js";
import { registerCron, markCronRun, formatIntervalMs } from "./cron/registry.js";

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

// ── Enrolled-ticket helpers (AI-2016 AC3) ────────────────────────────────────

interface EnrolledTicketNativeState {
  state: { id: string; name: string; type: string } | null;
  delegate: { id: string } | null;
}

/**
 * Fetch native state and delegate for an enrolled ticket.
 * Uses a query name that includes "IssueContext" so test mocks can intercept it
 * without the "IssueWithLabels" exclusion.
 */
async function queryEnrolledTicketState(
  issueId: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<EnrolledTicketNativeState | null> {
  const query = `
    query IssueContextSweep($id: String!) {
      issue(id: $id) {
        id
        state { id name type }
        delegate { id }
      }
    }
  `;
  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = {
      data?: {
        issue?: {
          state: { id: string; name: string; type: string } | null;
          delegate: { id: string } | null;
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const issue = data.data?.issue;
    if (!issue) return null;
    return {
      state: issue.state,
      delegate: issue.delegate,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch PR merge status for an enrolled ticket (inline — mirrors
 * fetchBranchAndPRStatus from workflow-gate.ts but avoids the export dependency).
 */
async function queryEnrolledPRStatus(
  issueId: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<{ hasMergedPR: boolean } | null> {
  const query = `
    query IssueBranchAndPR($id: String!) {
      issue(id: $id) {
        attachments {
          nodes {
            url
            sourceType
            metadata
          }
        }
      }
    }
  `;
  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = {
      data?: {
        issue?: {
          attachments: { nodes: Array<{ url?: string | null; sourceType?: string | null; metadata?: Record<string, unknown> | null }> };
        } | null;
      };
    };
    const data = (await res.json()) as Resp;
    const nodes = data.data?.issue?.attachments?.nodes ?? [];
    const prNodes = nodes.filter((n) =>
      typeof n.url === "string" && /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(n.url),
    );
    const hasMergedPR = prNodes.some((n) => {
      const meta = n.metadata ?? {};
      const status = (meta as { status?: unknown; state?: unknown }).status ?? (meta as { state?: unknown }).state;
      return typeof status === "string" && status.toLowerCase() === "merged";
    });
    return { hasMergedPR };
  } catch {
    return null;
  }
}

/**
 * Heal an enrolled ticket that is native-Done with merged PRs:
 * strip wf:* and state:* labels, clear delegate.
 *
 * Uses the injected fetchFn (not global fetch) so tests can mock it.
 * Inlines the queries rather than calling shared helpers because those
 * helpers use globalThis.fetch which the mock cannot intercept.
 */
async function closeEnrolledTicket(
  issueId: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  // Re-fetch to get label IDs for stripping (IssueWithLabels query)
  const labelsQuery = `
    query IssueWithLabelsForClose($id: String!) {
      issue(id: $id) {
        id
        identifier
        team { id }
        labels { nodes { id name } }
      }
    }
  `;
  let issueLabels: Array<{ id: string; name: string }> = [];
  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: labelsQuery, variables: { id: issueId } }),
    });
    type LResp = {
      data?: { issue?: { labels: { nodes: Array<{ id: string; name: string }> } } | null };
    };
    const data = (await res.json()) as LResp;
    issueLabels = data.data?.issue?.labels?.nodes ?? [];
  } catch {
    return false;
  }

  // Filter OUT labels that start with wf:* or state:*
  const keepIds = issueLabels
    .filter((l) => !l.name.startsWith("state:") && !l.name.startsWith("wf:"))
    .map((l) => l.id);

  // Clear delegate and set remaining labels in one mutation
  const mutation = `
    mutation CloseEnrolledTicket($issueId: String!, $labelIds: [String!]!) {
      issueUpdate(id: $issueId, input: { labelIds: $labelIds, delegateId: null }) {
        success
      }
    }
  `;
  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({
        query: mutation,
        variables: { issueId, labelIds: keepIds },
      }),
    });
    type MResp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as MResp;
    return data.data?.issueUpdate?.success ?? false;
  } catch {
    return false;
  }
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
  // Default to the global alert bus singleton so the prod cron path always
  // emits alerts even when the caller (index.ts) doesn't inject one.
  // Tests inject their own bus to assert alert behavior.
  const alertBus = opts.alertBus ?? getAlertBus();
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
    alertBus.notify({
      severity: "warning",
      source: "bootstrap-reconciled",
      title: `Bootstrap reconciliation sweep query failed: ${msg}`,
    });
    return result;
  }

  result.scanned = candidates.length;

  // ── Pass 1: Unenrolled tickets ────────────────────────────────────────────
  for (const ticket of candidates) {
    // Filter: must have a wf:* label but NO state:* label
    const hasStateLabel = ticket.labels.some((l) => l.name.startsWith("state:"));
    if (hasStateLabel) continue; // already enrolled — handled in Pass 2

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
        alertBus.notify({
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
      alertBus.notify({
        severity: "warning",
        source: "bootstrap-reconciled",
        title: `Bootstrap reconciliation heal error for ${ticket.identifier}`,
        detail: { error: msg },
        ticket: ticket.identifier,
      });
    }
  }

  // ── Pass 2: Enrolled tickets that are native-Done with merged PRs (AI-2016 AC3) ──
  for (const ticket of candidates) {
    const hasStateLabel = ticket.labels.some((l) => l.name.startsWith("state:"));
    if (!hasStateLabel) continue; // only enrolled tickets

    try {
      // Fetch native state — must be terminal (completed) to auto-close
      const stateData = await queryEnrolledTicketState(ticket.id, authToken, fetchFn);
      if (!stateData || !stateData.state || stateData.state.type !== "completed") continue;

      // Fetch PR status — must have merged PRs to confirm shipped
      const prStatus = await queryEnrolledPRStatus(ticket.id, authToken, fetchFn);
      if (!prStatus || !prStatus.hasMergedPR) continue;

      // Native-Done + merged PRs: close the workflow record
      const closed = await closeEnrolledTicket(ticket.id, authToken, fetchFn);
      if (closed) {
        result.healed++;
        log.info(
          `bootstrap-reconciliation: closed enrolled shipped ticket ${ticket.identifier}` +
          ` (native state: ${stateData.state.name}, merged PRs confirmed)`,
        );
        alertBus.notify({
          severity: "warning",
          source: "bootstrap-reconciled",
          title: `Bootstrap reconciliation closed enrolled shipped ticket ${ticket.identifier}`,
          detail: {
            ticket: ticket.identifier,
            issueId: ticket.id,
            nativeState: stateData.state.name,
          },
          ticket: ticket.identifier,
        });
      } else {
        result.errors.push(`close enrolled mutation failed for ${ticket.identifier}`);
        log.warn(`bootstrap-reconciliation: close enrolled mutation returned false for ${ticket.identifier}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`enrolled-ticket close failed for ${ticket.identifier}: ${msg}`);
      log.error(`bootstrap-reconciliation: enrolled-ticket close error for ${ticket.identifier}: ${msg}`);
      alertBus.notify({
        severity: "warning",
        source: "bootstrap-reconciled",
        title: `Bootstrap reconciliation enrolled-ticket error for ${ticket.identifier}`,
        detail: { error: msg },
        ticket: ticket.identifier,
      });
    }
  }

  markCronRun("bootstrap-reconciliation-sweep");
  return result;
}

// ── Cron registration ───────────────────────────────────────────────────────

/**
 * Register the reconciliation sweep as a recurring interval timer.
 *
 * The caller MUST supply the Linear auth token — typically resolved in
 * `index.ts` via `getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ??
 * process.env.LINEAR_API_KEY`, matching every other server-side Linear call.
 *
 * **Wake wiring (AC1):** the caller MUST supply a `wakeFn` that delivers a
 * workflow-aware wake to the healed delegate — identical to the post-bootstrap
 * wake delivery in the webhook path. Without it, a healed ticket gets labels
 * + delegate but the delegate is never notified.
 *
 * **Alert bus (AC2/AC4):** if `alertBus` is omitted, the sweep defaults to the
 * global alert-bus singleton (`getAlertBus()`), so alerts always fire in prod.
 *
 * Returns the NodeJS.Timeout so the caller can clear it (e.g. on shutdown).
 * In production this is called once from index.ts alongside other periodic
 * loops.
 */
export function registerBootstrapReconciliationCron(
  opts: {
    authToken: string;
    intervalMs?: number;
    /** Alert bus for heal/failure notifications. Defaults to the global singleton. */
    alertBus?: AlertBus;
    /** Delivers a wake to the first-owner delegate after a successful heal.
     *  Required for AC1 in the prod path — index.ts wires this to the same
     *  delivery mechanism the webhook bootstrap path uses. */
    wakeFn?: (agentName: string, ticketIdentifier: string) => Promise<void>;
  },
): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  registerCron("bootstrap-reconciliation-sweep", `every ${formatIntervalMs(intervalMs)}`);

  if (!opts.authToken) {
    log.warn(
      "bootstrap-reconciliation: no auth token provided — sweep will be skipped until the next call",
    );
  }

  const timer = setInterval(() => {
    // Fire-and-forget — errors are captured inside the sweep and surfaced
    // via the alert bus, not propagated to the interval handler.
    void runBootstrapReconciliationSweep({
      authToken: opts.authToken,
      alertBus: opts.alertBus,
      wakeFn: opts.wakeFn,
    }).catch((err) => {
      log.error(
        `bootstrap-reconciliation: unexpected sweep failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, intervalMs);

  timer.unref();

  log.info(`bootstrap-reconciliation: cron registered (${intervalMs}ms interval, wakeFn=${opts.wakeFn ? "wired" : "absent"})`);
  return timer;
}
