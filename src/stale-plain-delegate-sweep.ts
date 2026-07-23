/**
 * INF-168 — Stale-plain-delegate sweep.
 *
 * Detects and heals plain (non-wf) tickets with a delegate set that have been
 * sitting in a non-terminal active state (Thinking, Doing, To Do) with zero
 * observable progress for a configurable timeout.
 *
 * Existing watchdogs do NOT cover this class:
 *   - DispatchAckTracker acks on session-end ("wake received"), NOT on ticket
 *     progress.
 *   - StuckDelegateDetector only scans wf:* tickets AND only fires on the
 *     "completion comment without transition verb" pattern.
 *   - NoActivityDetector only covers in-flight sessions (5 min window).
 *   - DelegationReconciliationSweep only scans wf:* tickets.
 *
 * This sweep closes the gap by:
 *   1. Querying Linear for plain tickets with delegate set + non-terminal
 *      state (Thinking/Doing/To Do) and no activity beyond a timeout (4h).
 *   2. First hit: re-dispatch the delegate via the standard delivery path.
 *   3. Repeated no-ack (2 attempts): escalate — apply `stale-delegate` label,
 *      fire alert-bus notification.
 *
 * Configuration (env vars, all optional):
 *   STALE_PLAIN_DELEGATE_TIMEOUT_MS     — staleness threshold (default: 4h)
 *   STALE_PLAIN_DELEGATE_POLL_MS        — check interval (default: 15 min)
 */

import { componentLogger, createLogger } from "./logger.js";
import { registerCron, formatIntervalMs, markCronRun } from "./cron/registry.js";
import { getAlertBus, type AlertBus } from "./alerts/alert-bus.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import type { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";

const log = componentLogger(
  createLogger(process.env.LOG_LEVEL ?? "info"),
  "stale-plain-delegate",
);

const LINEAR_API_URL = "https://api.linear.app/graphql";

const DEFAULT_STALE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_REDISPATCH = 2;
/** Re-dispatch guard window: skip tickets dispatched within this period. */
const DEFAULT_RECENT_DISPATCH_WINDOW_MS = 15 * 60 * 1000; // 15 min

export interface StalePlainDelegateOptions {
  authToken: string;
  operationalEventStore: OperationalEventStore;
  alertBus: AlertBus;
  ackTracker?: DispatchAckTracker;
  wakeFn: (agentName: string, ticketIdentifier: string) => Promise<void>;
  fetchFn?: typeof fetch;
  postLinearComment?: (agentName: string, ticketId: string, body: string) => Promise<boolean>;
  staleTimeoutMs?: number;
}

export interface StalePlainDelegateResult {
  scanned: number;
  staleDetected: number;
  redispatched: number;
  escalated: number;
  skippedRecent: number;
  errors: string[];
}

async function queryStalePlainTickets(
  authToken: string,
  staleTimeoutMs: number,
  fetchFn: typeof fetch,
): Promise<Array<{
  id: string;
  identifier: string;
  updatedAt: string;
  state: { name: string } | null;
  delegate: { id: string; name: string } | null;
}>> {
  const cutoff = new Date(Date.now() - staleTimeoutMs).toISOString();

  const query = `
    query StalePlainDelegates($cutoff: DateTime!) {
      issues(
        filter: {
          updatedAt: { lte: $cutoff }
          state: { name: { in: ["Thinking", "Doing", "To Do"] } }
          delegate: { id: { neq: null } }
        }
        first: 100
        orderBy: updatedAt
      ) {
        nodes {
          id
          identifier
          updatedAt
          state { name }
          labels { nodes { name } }
          delegate { id name }
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
    body: JSON.stringify({ query, variables: { cutoff } }),
  });

  const body = (await res.json()) as {
    data?: {
      issues?: {
        nodes: Array<{
          id: string;
          identifier: string;
          updatedAt: string;
          state: { name: string } | null;
          labels: { nodes: Array<{ name: string }> };
          delegate: { id: string; name: string } | null;
        }>;
      };
    };
  };

  const nodes = body.data?.issues?.nodes ?? [];

  // Filter OUT any wf:* tickets — they belong to DelegationReconciliationSweep
  return nodes
    .filter((n) => !n.labels.nodes.some((l) => l.name.startsWith("wf:")))
    .map((n) => ({
      id: n.id,
      identifier: n.identifier,
      updatedAt: n.updatedAt,
      state: n.state,
      delegate: n.delegate,
    }));
}

async function applyStaleDelegateLabel(
  issueId: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  const labelQuery = `
    query StaleDelegateLabel {
      organization { labels(first: 50) { nodes { id name } } }
    }
  `;

  try {
    const labelRes = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query: labelQuery, variables: {} }),
    });

    const labelBody = (await labelRes.json()) as {
      data?: { organization?: { labels?: { nodes: Array<{ id: string; name: string }> } } };
    };
    const staleLabel = labelBody.data?.organization?.labels?.nodes
      .find((l) => l.name === "stale-delegate");

    if (!staleLabel) {
      log.warn("stale-delegate label not found in organization");
      return false;
    }

    const updateQuery = `
      mutation AddStaleDelegateLabel($issueId: String!, $labelId: String!) {
        issueUpdate(id: $issueId, input: { labelIds: { add: [$labelId] } }) { success }
      }
    `;

    const updateRes = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query: updateQuery, variables: { issueId, labelId: staleLabel.id } }),
    });

    const updateBody = (await updateRes.json()) as { data?: { issueUpdate?: { success?: boolean } } };
    return updateBody.data?.issueUpdate?.success === true;
  } catch (err) {
    log.warn(`Failed to apply stale-delegate label: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function runStalePlainDelegateSweep(
  opts: StalePlainDelegateOptions,
): Promise<StalePlainDelegateResult> {
  const {
    authToken,
    operationalEventStore,
    alertBus,
    ackTracker,
    wakeFn,
    postLinearComment,
  } = opts;

  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const staleTimeoutMs = opts.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;

  const result: StalePlainDelegateResult = {
    scanned: 0,
    staleDetected: 0,
    redispatched: 0,
    escalated: 0,
    skippedRecent: 0,
    errors: [],
  };

  let tickets: Array<{
    id: string;
    identifier: string;
    updatedAt: string;
    state: { name: string } | null;
    delegate: { id: string; name: string } | null;
  }>;

  try {
    tickets = await queryStalePlainTickets(authToken, staleTimeoutMs, fetchFn);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`query failed: ${msg}`);
    log.error(`stale-plain-delegate: query failed: ${msg}`);
    alertBus.notify({
      severity: "warning",
      source: "stale-plain-delegate",
      title: `Stale-plain-delegate sweep query failed: ${msg}`,
    });
    return result;
  }

  for (const ticket of tickets) {
    result.scanned++;

    if (!ticket.delegate?.name || !ticket.state) {
      result.errors.push(`missing delegate or state for ${ticket.identifier}`);
      continue;
    }

    const agentName = ticket.delegate.name;
    const ticketId = ticket.identifier;

    // Idempotency: skip if ack-tracker shows a dispatch within the recent
    // window (default 15m) — prevents re-dispatch during the same sweep cycle.
    // Uses the shorter RECENT window, NOT the staleness timeout, so tickets
    // dispatched hours ago can still be detected as stale.
    if (ackTracker?.hasRecentPending(agentName, ticketId, DEFAULT_RECENT_DISPATCH_WINDOW_MS)) {
      result.skippedRecent++;
      continue;
    }

    result.staleDetected++;

    // Determine attempt count from existing ack-traker entries
    let attemptCount = 0;
    if (ackTracker) {
      const entries = ackTracker.listFiltered({ agentId: agentName });
      // ticketId in ack tracker is normalized (prefixed with linear-), so
      // strip the prefix when comparing with raw ticket identifier
      const existing = entries.find((e) => {
        const normalized = e.ticketId.replace(/^linear-/i, "").toLowerCase();
        return normalized === ticketId.toLowerCase();
      });
      if (existing) {
        attemptCount = existing.attemptCount;
      }
    }

    if (attemptCount >= DEFAULT_MAX_REDISPATCH) {
      // Escalation path
      result.escalated++;
      log.error(`stale-plain-delegate: escalating ${ticketId} for ${agentName} (${attemptCount} attempts)`);

      await applyStaleDelegateLabel(ticket.id, authToken, fetchFn);
      ackTracker?.markEscalated(agentName, ticketId);

      alertBus.notify({
        severity: "warning",
        source: "stale-plain-delegate",
        title: `Stale-plain-delegate escalated: ${ticketId}`,
        detail: { ticket: ticketId, delegate: agentName, state: ticket.state.name, attemptCount },
        ticket: ticketId,
      });

      if (postLinearComment) {
        const body = `🔴 **Stale delegate escalation** — ${ticketId} delegated to ${agentName} in "${ticket.state.name}" with no progress for >${Math.round(staleTimeoutMs / 3_600_000)}h after ${attemptCount} re-dispatch(s). Labeled \`stale-delegate\`. Manual intervention required.`;
        await postLinearComment(agentName, ticketId, body).catch(() => {});
      }

      operationalEventStore.append({
        outcome: "stale-delegate-escalated" as any,
        agent: agentName,
        key: `linear-${ticketId}`,
        detail: { ticket: ticketId, delegate: agentName, state: ticket.state.name, attemptCount },
      });

      continue;
    }

    // Re-dispatch path
    try {
      await wakeFn(agentName, ticketId);
      result.redispatched++;
      ackTracker?.recordDispatch(agentName, ticketId);

      log.info(`stale-plain-delegate: re-dispatched ${ticketId} → ${agentName} (attempt ${attemptCount + 1}/${DEFAULT_MAX_REDISPATCH})`);

      if (postLinearComment) {
        const body = `⚠️ **Stale delegate detected** — ${ticketId} delegated to ${agentName} in "${ticket.state.name}" with no progress for >${Math.round(staleTimeoutMs / 3_600_000)}h. Re-dispatching (attempt ${attemptCount + 1}/${DEFAULT_MAX_REDISPATCH}).`;
        await postLinearComment(agentName, ticketId, body).catch(() => {});
      }

      alertBus.notify({
        severity: "info",
        source: "stale-plain-delegate",
        title: `Stale-plain-delegate re-dispatched: ${ticketId}`,
        detail: { ticket: ticketId, delegate: agentName, state: ticket.state.name, attemptCount: attemptCount + 1 },
        ticket: ticketId,
      });

      operationalEventStore.append({
        outcome: "stale-plain-delegate-redispatch" as any,
        agent: agentName,
        key: `linear-${ticketId}`,
        detail: { ticket: ticketId, delegate: agentName, state: ticket.state.name, attemptCount: attemptCount + 1 },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`re-dispatch failed for ${ticketId}: ${msg}`);
      log.error(`stale-plain-delegate: re-dispatch failed for ${ticketId}: ${msg}`);

      alertBus.notify({
        severity: "warning",
        source: "stale-plain-delegate",
        title: `Stale-plain-delegate re-dispatch failed for ${ticketId}: ${msg}`,
        detail: { error: msg },
        ticket: ticketId,
      });

      operationalEventStore.append({
        outcome: "stale-plain-delegate-redispatch-failed" as any,
        agent: agentName,
        key: `linear-${ticketId}`,
        errorSummary: msg,
        detail: { ticket: ticketId },
      });
    }
  }

  return result;
}

export function registerStalePlainDelegateCron(opts: {
  authToken: string;
  intervalMs?: number;
  staleTimeoutMs?: number;
  operationalEventStore?: OperationalEventStore;
  alertBus?: AlertBus;
  ackTracker?: DispatchAckTracker;
  wakeFn?: (agentName: string, ticketIdentifier: string) => Promise<void>;
  fetchFn?: typeof fetch;
  postLinearComment?: (agentName: string, ticketId: string, body: string) => Promise<boolean>;
}): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_MS;
  const staleTimeoutMs = opts.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;

  registerCron(
    "stale-plain-delegate-sweep",
    `every ${formatIntervalMs(intervalMs)} (stale=${formatIntervalMs(staleTimeoutMs)})`,
  );

  const timer = setInterval(() => {
    const store = opts.operationalEventStore ?? new OperationalEventStore(":memory:");
    const alert = opts.alertBus ?? getAlertBus();

    void runStalePlainDelegateSweep({
      authToken: opts.authToken,
      operationalEventStore: store,
      alertBus: alert,
      ackTracker: opts.ackTracker,
      wakeFn: opts.wakeFn ?? (() => Promise.resolve()),
      staleTimeoutMs,
      fetchFn: opts.fetchFn,
      postLinearComment: opts.postLinearComment,
    }).then(() => {
      markCronRun("stale-plain-delegate-sweep");
    }).catch((err: unknown) => {
      log.error(`stale-plain-delegate: sweep error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, intervalMs);

  timer.unref();
  log.info(`stale-plain-delegate: cron registered (${intervalMs}ms, stale=${staleTimeoutMs}ms)`);
  return timer;
}
