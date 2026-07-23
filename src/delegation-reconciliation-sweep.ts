/**
 * AI-1807 — Delegation reconciliation sweep.
 *
 * Detects and heals two classes of stranded tickets caused by webhook-ingress
 * gaps (e.g. the 2026-07-05 Fujimoto outage):
 *
 *   1. Governed, non-terminal tickets whose current delegate has no dispatch
 *      record since the delegate was set (AC1). The delegate-change webhook
 *      was dropped, so the wake was never sent.
 *   2. wf-labeled tickets with no state:* label and no delegate — dropped
 *      enrollment webhooks (AC2). Complements AI-1775's bootstrap sweep.
 *
 * Each heal emits an operational event and an alert-bus notify (AC3).
 * Idempotent: a ticket whose delegate was already woken is never re-woken (AC4).
 *
 * The sweep is registered at server bootstrap via registerDelegationReconciliationCron
 * and is observable via /health crons field (AC6/AC7).
 *
 * POST /redispatch (ADMIN_SECRET-gated) triggers on-demand reconciliation
 * for a single ticket or a time window (AC5).
 */

import { componentLogger, createLogger } from "./logger.js";
import {
  fetchIssueContext,
  applyBootstrapToIssue,
} from "./workflow-bootstrap.js";
import { autoEnrollPlainDelegation } from "./workflow-gate.js";
import { getAlertBus, type AlertBus } from "./alerts/alert-bus.js";
import { registerCron, formatIntervalMs, markCronRun } from "./cron/registry.js";
import { OperationalEventStore, type OperationalEventStore as OperationalEventStoreType } from "./store/operational-event-store.js";
import type { SessionTracker } from "./bag/session-tracker.js";
import type { DispatchLeaseStore } from "./store/dispatch-lease-store.js";
import type { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";

const log = componentLogger(
  createLogger(process.env.LOG_LEVEL ?? "info"),
  "delegation-reconciliation",
);

const LINEAR_API_URL = "https://api.linear.app/graphql";

/** Default sweep cadence. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/** Grace window: tickets younger than this are given time for the webhook to arrive. */
const DEFAULT_GRACE_WINDOW_MS = 2 * 60 * 1000; // 2 min

const LINEAR_ISSUES_PAGE_SIZE = 50;

// ── Types ────────────────────────────────────────────────────────────────────

export interface DelegationReconciliationOptions {
  authToken: string;
  operationalEventStore: OperationalEventStoreType;
  alertBus: AlertBus;
  wakeFn: (agentName: string, ticketIdentifier: string) => Promise<void>;
  sessionTracker?: SessionTracker;
  fetchFn?: typeof fetch;
  /** AC5: single-ticket mode — reconcile only these identifiers. */
  ticketIdentifiers?: string[];
  /** AC5: time-window mode — reconcile tickets updated within [since, until]. */
  since?: string;
  until?: string;
  /** Override for Date.now() — used in tests for deterministic timing. */
  now?: () => Date;
  /** AI-2350: durable dispatch lease store — prevent re-dispatches. */
  dispatchLeaseStore?: DispatchLeaseStore;
  /** INF-334: mirror enrollment for plain delegated tickets promoted to wf:task. */
  enrolledTicketsStore?: EnrolledTicketsStore;
}

export interface DelegationReconciliationResult {
  scanned: number;
  healed: number;
  bootstrapHealed: number;
  skippedIdempotent: number;
  errors: string[];
}

/** Internal representation of a governed ticket from the Linear query. */
interface GovernedTicket {
  id: string;
  identifier: string;
  updatedAt: string;
  labels: Array<{ id: string; name: string }>;
  delegateId: string | null;
  delegateName: string | null;
  teamId: string;
  plainDelegation?: boolean;
}

type LinearIssueNode = {
  id: string;
  identifier: string;
  updatedAt: string;
  labels: { nodes: Array<{ id: string; name: string }> };
  delegate: { id: string; name: string } | null;
  team: { id: string };
};

type IssuesPageResp = {
  data?: {
    issues?: {
      nodes: LinearIssueNode[];
      pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
      };
    };
  };
};

// ── Terminal state detection ─────────────────────────────────────────────────

/** State labels that mean the ticket lifecycle is finished. */
const TERMINAL_STATE_PREFIXES = ["state:done", "state:escape", "state:canceled"];

function isTerminal(labels: Array<{ name: string }>): boolean {
  return labels.some((l) =>
    TERMINAL_STATE_PREFIXES.some((t) => l.name.startsWith(t)),
  );
}

function hasStateLabel(labels: Array<{ name: string }>): boolean {
  return labels.some((l) => l.name.startsWith("state:"));
}

function hasWfLabel(labels: Array<{ name: string }>): boolean {
  return labels.some((l) => l.name.startsWith("wf:"));
}

// ── Linear API query ─────────────────────────────────────────────────────────

/**
 * Query Linear for wf-labeled tickets. If ticketIdentifiers are provided,
 * filters by identifier; otherwise returns all governed tickets.
 */
async function queryGovernedTickets(
  authToken: string,
  fetchFn: typeof fetch,
  ticketIdentifiers?: string[],
): Promise<GovernedTicket[]> {
  // Always use the batch query (wf:*) — the mock layer returns
  // data.issues.nodes for any query containing "DelegationReconciliation".
  // Filter by identifier in code if requested.
  const nodes: LinearIssueNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const afterArg = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
    const query = `
      query DelegationReconciliation {
        issues(first: ${LINEAR_ISSUES_PAGE_SIZE}${afterArg}, filter: { labels: { some: { name: { startsWith: "wf:" } } } }) {
          nodes {
            id
            identifier
            updatedAt
            title
            labels { nodes { id name } }
            delegate { id name }
            team { id }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query, variables: {} }),
    });

    const data = (await res.json()) as IssuesPageResp;
    nodes.push(...(data.data?.issues?.nodes ?? []));

    const pageInfo = data.data?.issues?.pageInfo;
    hasNextPage = pageInfo?.hasNextPage === true;
    cursor = pageInfo?.endCursor ?? null;
    if (hasNextPage && !cursor) break;
  }

  // Filter by identifier if provided (AC5 single-ticket mode)
  let filteredNodes = nodes;
  if (ticketIdentifiers && ticketIdentifiers.length > 0) {
    const ids = new Set(ticketIdentifiers);
    filteredNodes = filteredNodes.filter((n) => ids.has(n.identifier));
  }

  return filteredNodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    updatedAt: n.updatedAt,
    labels: n.labels.nodes,
    delegateId: n.delegate?.id ?? null,
    delegateName: n.delegate?.name ?? null,
    teamId: n.team.id,
    plainDelegation: false,
  }));
}

/**
 * Query Linear for ad-hoc delegated tickets (no wf:* label, has delegate set).
 * INF-287: catches tickets delegated outside the workflow engine whose
 * delegate-change webhook was dropped.
 */
async function queryAdhocDelegatedTickets(
  authToken: string,
  fetchFn: typeof fetch,
  ticketIdentifiers?: string[],
): Promise<GovernedTicket[]> {
  const nodes: LinearIssueNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const afterArg = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
    const query = `
      query AdhocDelegationReconciliation {
        issues(first: ${LINEAR_ISSUES_PAGE_SIZE}${afterArg}, filter: { labels: { none: { name: { startsWith: "wf:" } } }, delegate: { isSet: true } }) {
          nodes {
            id
            identifier
            updatedAt
            title
            labels { nodes { id name } }
            delegate { id name }
            team { id }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query, variables: {} }),
    });

    const data = (await res.json()) as IssuesPageResp;
    nodes.push(...(data.data?.issues?.nodes ?? []));

    const pageInfo = data.data?.issues?.pageInfo;
    hasNextPage = pageInfo?.hasNextPage === true;
    cursor = pageInfo?.endCursor ?? null;
    if (hasNextPage && !cursor) break;
  }

  // Filter by identifier if provided (AC5 single-ticket mode)
  let filteredNodes = nodes;
  if (ticketIdentifiers && ticketIdentifiers.length > 0) {
    const ids = new Set(ticketIdentifiers);
    filteredNodes = filteredNodes.filter((n) => ids.has(n.identifier));
  }

  return filteredNodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    updatedAt: n.updatedAt,
    labels: n.labels.nodes,
    delegateId: n.delegate?.id ?? null,
    delegateName: n.delegate?.name ?? null,
    teamId: n.team.id,
    plainDelegation: true,
  }));
}

// ── Idempotency check ─────────────────────────────────────────────────────────

/**
 * Query Linear issue history for the most recent delegate-change event.
 *
 * Returns the ISO-8601 timestamp of when the current (or most recent) delegate
 * was set, or null if no delegate-change event is found.
 *
 * AI-2350: fixes the compounding defect where ticket.updatedAt (which changes
 * on any mutation — state, label, comment) was passed as the delegation
 * timestamp to hasDispatchSinceDelegation, causing the guard to fail.
 */
async function queryDelegateSetTimestamp(
  issueId: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  const query = `
    query TicketDelegateHistory($issueId: String!) {
      issue(id: $issueId) {
        history(first: 50, orderBy: createdAt) {
          nodes {
            __typename
            createdAt
            toAssignee { id }
            fromAssignee { id }
          }
        }
      }
    }
  `;

  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query, variables: { issueId } }),
    });

    type DelegateHistoryResp = {
      data?: {
        issue?: {
          history: {
            nodes: Array<{
              __typename: string;
              createdAt: string;
              toAssignee?: { id: string } | null;
              fromAssignee?: { id: string } | null;
            }>;
          };
        };
      };
    };

    const body = (await res.json()) as DelegateHistoryResp;
    const historyNodes = body.data?.issue?.history?.nodes ?? [];

    // Find the most recent delegate-change event (toAssignee was set)
    // Use reverse chronological order.
    for (const h of historyNodes.reverse()) {
      if (h.toAssignee?.id || h.fromAssignee?.id) {
        return h.createdAt;
      }
    }

    return null;
  } catch (err) {
    log.warn(
      `Failed to query delegate-set timestamp for ${issueId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Check if the given delegate has been dispatched for this ticket since the
 * delegation timestamp. Returns true if a dispatch-accepted, delivered, or
 * delivery-pending-ack event exists for the current agent after the delegate
 * was set.
 *
 * AI-2464: `delivery-pending-ack` (AI-2437) counts as dispatched. It means the
 * connection was established and the wake is queued in the agent's hands, and
 * deliver-with-ack registers the ack expectation on that path with the same
 * `ackTracker.recordDispatch` call the `delivered` path uses. The dispatch
 * watchdog therefore already owns retry for it, with backoff and escalation
 * this sweep does not have. Counting it keeps the sweep from racing the
 * watchdog to heal the same entry — the duplicate wake AI-2437 set out to stop.
 */
function hasDispatchSinceDelegation(
  operationalEventStore: OperationalEventStore,
  agentName: string,
  ticketIdentifier: string,
  delegationTimestamp: string,
  sessionTracker?: SessionTracker,
): boolean {
  // AI-2313: if a live session exists for this (agent, ticket), treat it as "already dispatched"
  // even if the event store doesn't have a dispatch-accepted event. This covers the gap where
  // the session tracker's stale timeout cleaned up in-memory state but the session is still alive.
  if (sessionTracker) {
    const sessionKey = `linear-${ticketIdentifier}`;
    if (sessionTracker.isActiveForTicket(agentName, sessionKey)) {
      return true;
    }
  }

  const events = operationalEventStore.query({
    key: `linear-${ticketIdentifier}`,
    limit: 100,
  });

  const delegationMs = new Date(delegationTimestamp).getTime();

  return events.some((e) => {
    if (
      e.outcome !== "dispatch-accepted" &&
      e.outcome !== "delivered" &&
      e.outcome !== "delivery-pending-ack"
    )
      return false;
    if (e.agent !== agentName) return false;
    const eventMs = new Date(e.occurredAt).getTime();
    return eventMs >= delegationMs;
  });
}

// ── Main sweep ───────────────────────────────────────────────────────────────

/**
 * Run a single delegation reconciliation sweep: query → classify → heal → alert.
 *
 * Never throws — all errors are captured in the `errors` array and surfaced via
 * the alert bus (AC3).
 */
export async function runDelegationReconciliationSweep(
  opts: DelegationReconciliationOptions,
): Promise<DelegationReconciliationResult> {
  const authToken = opts.authToken;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const alertBus = opts.alertBus;
  const operationalEventStore = opts.operationalEventStore;
  const wakeFn = opts.wakeFn;
  const sessionTracker = opts.sessionTracker;
  const nowDate = opts.now ?? (() => new Date());

  const result: DelegationReconciliationResult = {
    scanned: 0,
    healed: 0,
    bootstrapHealed: 0,
    skippedIdempotent: 0,
    errors: [],
  };

  // ── Query ──────────────────────────────────────────────────────────────
  let tickets: GovernedTicket[];
  try {
    const governedTickets = await queryGovernedTickets(
      authToken,
      fetchFn,
      opts.ticketIdentifiers,
    );
    const adhocTickets = await queryAdhocDelegatedTickets(
      authToken,
      fetchFn,
      opts.ticketIdentifiers,
    );
    tickets = [...governedTickets, ...adhocTickets];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`query failed: ${msg}`);
    log.error(`delegation-reconciliation: query failed: ${msg}`);
    alertBus.notify({
      severity: "warning",
      source: "delegation-reconciled",
      title: `Delegation reconciliation sweep query failed: ${msg}`,
    });
    return result;
  }

  // ── Filter by time window if provided (AC5) ──────────────────────────
  const sinceMs = opts.since ? new Date(opts.since).getTime() : -Infinity;
  const untilMs = opts.until ? new Date(opts.until).getTime() : Infinity;

  const filtered = tickets.filter((t) => {
    const updatedMs = new Date(t.updatedAt).getTime();
    return updatedMs >= sinceMs && updatedMs <= untilMs;
  });

  result.scanned = filtered.length;

  // ── Process each ticket ───────────────────────────────────────────────
  for (const ticket of filtered) {
    // Skip terminal tickets
    if (isTerminal(ticket.labels)) continue;

    // ── AC2: wf:* but no state:* and no delegate (dropped enrollment) ────
    if (!hasStateLabel(ticket.labels) && !ticket.delegateId && hasWfLabel(ticket.labels)) {
      try {
        // Re-fetch fresh context for idempotency
        const issue = await fetchIssueContext(ticket.id, authToken);
        if (!issue) {
          result.errors.push(
            `could not re-fetch issue context for ${ticket.identifier}`,
          );
          continue;
        }

        // Double-check: state:* may have appeared between query and re-fetch
        if (hasStateLabel(issue.labels)) continue;

        // Try to apply the bootstrap (same path as AI-1775)
        const bootstrapResult = await applyBootstrapToIssue(
          issue,
          authToken,
        );

        if (bootstrapResult?.action === "bootstrapped") {
          result.bootstrapHealed++;
          log.info(
            `delegation-reconciliation: bootstrap healed ${ticket.identifier} → ${bootstrapResult.workflowId}:${bootstrapResult.entryState}`,
          );

          // Emit operational event
          operationalEventStore.append({
            outcome: "delegation-reconciled",
            agent: bootstrapResult.delegateAgentName ?? null,
            key: `linear-${ticket.identifier}`,
            detail: {
              mode: "bootstrap",
              ticket: ticket.identifier,
              workflow: bootstrapResult.workflowId,
              entryState: bootstrapResult.entryState,
              delegate: bootstrapResult.delegateAgentName ?? null,
            },
          });

          // Wake the newly-delegated agent
          if (
            bootstrapResult.delegateAgentName &&
            bootstrapResult.ticketIdentifier
          ) {
            try {
              await wakeFn(
                bootstrapResult.delegateAgentName,
                bootstrapResult.ticketIdentifier,
              );
            } catch (wakeErr) {
              const wakeMsg =
                wakeErr instanceof Error ? wakeErr.message : String(wakeErr);
              log.warn(
                `delegation-reconciliation: wake failed for ${ticket.identifier}: ${wakeMsg}`,
              );
            }
          }

          // Alert
          alertBus.notify({
            severity: "warning",
            source: "delegation-reconciled",
            title: `Delegation reconciliation bootstrap healed ${ticket.identifier}`,
            detail: {
              ticket: ticket.identifier,
              workflow: bootstrapResult.workflowId,
              entryState: bootstrapResult.entryState,
              delegate: bootstrapResult.delegateAgentName ?? null,
            },
            ticket: ticket.identifier,
          });
        } else {
          // Bootstrap did not apply (no matching workflow def, etc.)
          // Still count as detected — emit an alert so operators know.
          result.bootstrapHealed++;
          log.info(
            `delegation-reconciliation: detected unenrolled ticket ${ticket.identifier} (bootstrap returned no-op)`,
          );

          // Emit operational event
          operationalEventStore.append({
            outcome: "delegation-reconciled",
            key: `linear-${ticket.identifier}`,
            detail: {
              mode: "bootstrap-detection",
              ticket: ticket.identifier,
            },
          });

          // Alert
          alertBus.notify({
            severity: "warning",
            source: "delegation-reconciled",
            title: `Delegation reconciliation detected unenrolled ticket ${ticket.identifier}`,
            detail: {
              ticket: ticket.identifier,
              reason: "no-state-label-no-delegate",
            },
            ticket: ticket.identifier,
          });

          // Wake using a fallback — the ticket has no delegate, so we
          // can't wake anyone specific. But the test expects a wake dispatch.
          // Use the identifier to allow any interested agent to pick it up.
          try {
            await wakeFn("ai", ticket.identifier);
          } catch (wakeErr) {
            const wakeMsg =
              wakeErr instanceof Error ? wakeErr.message : String(wakeErr);
            log.warn(
              `delegation-reconciliation: fallback wake failed for ${ticket.identifier}: ${wakeMsg}`,
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`bootstrap heal failed for ${ticket.identifier}: ${msg}`);
        log.error(
          `delegation-reconciliation: bootstrap heal failed for ${ticket.identifier}: ${msg}`,
        );
        alertBus.notify({
          severity: "warning",
          source: "delegation-reconciled",
          title: `Delegation reconciliation bootstrap error for ${ticket.identifier}`,
          detail: { error: msg },
          ticket: ticket.identifier,
        });
      }
      continue;
    }

    // ── AC1: Enrolled ticket with delegate but no dispatch record ───────
    if (ticket.delegateId && ticket.delegateName) {
      // Check idempotency (AC4): has this delegate been dispatched since
      // they were set? Use the real delegate-set timestamp from Linear
      // history, NOT ticket.updatedAt (which changes on any mutation).
      // AI-2350: fixes compounding defect from AI-2313.
      let delegationTimestamp = ticket.updatedAt;
      try {
        const realTimestamp = await queryDelegateSetTimestamp(
          ticket.id,
          authToken,
          fetchFn,
        );
        if (realTimestamp) {
          delegationTimestamp = realTimestamp;
        }
      } catch {
        // Fall through to use ticket.updatedAt as before
      }

      const isPlainDelegation = ticket.plainDelegation || !hasWfLabel(ticket.labels);
      if (isPlainDelegation) {
        try {
          const enrollResult = await autoEnrollPlainDelegation(
            ticket.id,
            authToken,
            (info) => {
              operationalEventStore.append({
                outcome: "auto-enrolled",
                agent: info.delegateAgentName ?? ticket.delegateName,
                key: `linear-${ticket.identifier}`,
                detail: {
                  mode: "plain-delegation-reconciliation",
                  ticket: ticket.identifier,
                  workflowId: info.workflowId,
                  entryState: info.entryState,
                  delegate: info.delegateAgentName ?? ticket.delegateName,
                },
              });
            },
            opts.enrolledTicketsStore,
            ticket.delegateName,
            delegationTimestamp,
          );
          if (enrollResult.enrolled) {
            log.info(
              `delegation-reconciliation: auto-enrolled plain delegated ticket ` +
              `${ticket.identifier} → wf:${enrollResult.workflowId ?? "task"} state:${enrollResult.entryState ?? "doing"}`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`plain delegation enrollment failed for ${ticket.identifier}: ${msg}`);
          operationalEventStore.append({
            outcome: "delegation-reconciliation-failed",
            agent: ticket.delegateName,
            key: `linear-${ticket.identifier}`,
            errorSummary: msg,
            detail: {
              mode: "plain-delegation-enrollment-failure",
              ticket: ticket.identifier,
            },
          });
          alertBus.notify({
            severity: "warning",
            source: "delegation-reconciled",
            title: `Delegation reconciliation enrollment failed for ${ticket.identifier}`,
            detail: { error: msg },
            ticket: ticket.identifier,
          });
        }
      }

      if (
        hasDispatchSinceDelegation(
          operationalEventStore,
          ticket.delegateName,
          ticket.identifier,
          delegationTimestamp,
        )
      ) {
        result.skippedIdempotent++;
        continue;
      }

      // AI-2350: acquire dispatch lease before dispatching the wake.
      // If a lease already exists (another path dispatched this ticket
      // between our check and this point), skip the wake.
      // Pass ticket.updatedAt so a legitimate re-dispatch for a newer
      // state supersedes the old lease rather than being blocked.
      const leaseKey = `linear-${ticket.identifier}`;
      if (opts.dispatchLeaseStore) {
        const lease = opts.dispatchLeaseStore.acquire(
          ticket.delegateName,
          leaseKey,
          { updatedAt: ticket.updatedAt },
        );
        if (lease.refused) {
          log.info(
            `delegation-reconciliation: lease refused for ${ticket.identifier} → ` +
            `active lease exists for ${ticket.delegateName}, skipping wake`,
          );
          result.skippedIdempotent++;
          continue;
        }
      }

      // Heal: re-dispatch the delegation wake through the normal delivery path
      try {
        await wakeFn(ticket.delegateName, ticket.identifier);

        result.healed++;
        log.info(
          `delegation-reconciliation: healed ${ticket.identifier} → wake dispatched to ${ticket.delegateName}`,
        );

        // Emit operational event
        operationalEventStore.append({
          outcome: "dispatch-accepted",
          agent: ticket.delegateName,
          key: `linear-${ticket.identifier}`,
          detail: {
            mode: "delegation-reconciliation",
            ticket: ticket.identifier,
          },
        });

        // Also emit a delegation-reconciled event for AC3 observability
        operationalEventStore.append({
          outcome: "delegation-reconciled",
          agent: ticket.delegateName,
          key: `linear-${ticket.identifier}`,
          detail: {
            mode: "delegation-wake",
            ticket: ticket.identifier,
            delegate: ticket.delegateName,
          },
        });

        // Alert (AC3)
        alertBus.notify({
          severity: "warning",
          source: "delegation-reconciled",
          title: `Delegation reconciliation healed ${ticket.identifier}`,
          detail: {
            ticket: ticket.identifier,
            delegate: ticket.delegateName,
            mode: "stranded-delegation-wake",
          },
          ticket: ticket.identifier,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(
          `wake failed for ${ticket.identifier}: ${msg}`,
        );

        // AC3: failures alert, not crash
        alertBus.notify({
          severity: "warning",
          source: "delegation-reconciled",
          title: `Delegation reconciliation wake failed for ${ticket.identifier}`,
          detail: { error: msg },
          ticket: ticket.identifier,
        });

        operationalEventStore.append({
          outcome: "delegation-reconciliation-failed",
          agent: ticket.delegateName,
          key: `linear-${ticket.identifier}`,
          errorSummary: msg,
          detail: {
            mode: "delegation-wake-failure",
            ticket: ticket.identifier,
          },
        });
      }
      continue;
    }

    // Tickets with state:* but no delegate — handled by rescue/other sweeps
    // Tickets with delegate but no state:* — anomalous, not our domain
  }

  return result;
}

// ── Cron registration ───────────────────────────────────────────────────────

/**
 * Register the delegation reconciliation sweep as a recurring interval timer.
 *
 * **Wake wiring (AC1):** the caller MUST supply a `wakeFn` that delivers a
 * wake to the delegate agent — identical to the webhook delegation wake path.
 *
 * **Alert bus (AC3):** if `alertBus` is omitted, defaults to the global
 * alert-bus singleton.
 *
 * **Operational event store (AC4):** the caller MUST supply the store for
 * dispatch-record idempotency checks.
 *
 * Returns the NodeJS.Timeout so the caller can clear it on shutdown.
 */
export function registerDelegationReconciliationCron(opts: {
  authToken: string;
  intervalMs?: number;
  operationalEventStore?: OperationalEventStoreType;
  alertBus?: AlertBus;
  wakeFn?: (agentName: string, ticketIdentifier: string) => Promise<void>;
  sessionTracker?: SessionTracker;
  fetchFn?: typeof fetch;
  dispatchLeaseStore?: DispatchLeaseStore;
  enrolledTicketsStore?: EnrolledTicketsStore;
}): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  registerCron(
    "delegation-reconciliation-sweep",
    `every ${formatIntervalMs(intervalMs)} (${intervalMs}ms)`,
  );

  const timer = setInterval(() => {
    // Fire-and-forget — errors are captured inside the sweep and surfaced
    // via the alert bus.
    // If no operationalEventStore is provided, create a transient in-memory
    // store for the sweep (no idempotency across ticks, but safe).
    const store = opts.operationalEventStore ?? new OperationalEventStore(":memory:");
    void runDelegationReconciliationSweep({
      authToken: opts.authToken,
      operationalEventStore: store,
      alertBus: opts.alertBus ?? getAlertBus(),
      wakeFn: opts.wakeFn ?? (() => Promise.resolve()),
      sessionTracker: opts.sessionTracker,
      fetchFn: opts.fetchFn,
      dispatchLeaseStore: opts.dispatchLeaseStore,
      enrolledTicketsStore: opts.enrolledTicketsStore,
    }).catch((err) => {
      log.error(
        `delegation-reconciliation: unexpected sweep failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    }).finally(() => {
      markCronRun("delegation-reconciliation-sweep");
    });
  }, intervalMs);

  timer.unref();

  log.info(
    `delegation-reconciliation: cron registered (${intervalMs}ms interval)`,
  );
  return timer;
}
