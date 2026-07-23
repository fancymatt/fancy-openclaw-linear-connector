/**
 * DelegatePingPongDetector — cycle detection + escalation ladder for delegate
 * chains on governed tickets.
 *
 * Problem (INF-195 / INF-218 parent): Blocked work bouncing between delegates
 * loops silently. Example: Hanzo diagnoses a merge-blocked ticket and
 * escalates to Ai; Ai re-delegates back to Hanzo 23 seconds later with no new
 * instruction. The ticket holds two delegates in alternating sequence, and
 * neither can advance it, but the connector treats each re-delegation as a
 * fresh dispatch — no cycle detection, no escalation.
 *
 * This detector closes the gap by:
 *   1. Tracking the delegate chain for each ticket (persisted).
 *   2. Detecting when the same ticket returns to a prior delegate ≥ N times
 *      within a configurable window (default N=3).
 *   3. On detection, firing the escalation ladder (escalate to steward/Ai)
 *      instead of continuing to bounce the delegate.
 *   4. Emitting a structured log entry and operational event for observability.
 *
 * The detector is integrated into the webhook dispatch path (router.ts or
 * webhook/index.ts) so every delegate-change event is recorded and checked.
 *
 * Configuration (env vars, all optional):
 *   PING_PONG_MAX_BOUNCES         — max allowed repeat delegate visits before
 *                                   escalation (default: 3)
 *   PING_PONG_WINDOW_MS           — sliding window for cycle counting
 *                                   (default: 30 min)
 */

import { createLogger, componentLogger } from "./logger.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";
import { getAccessToken, getLinearUserIdForAgent } from "./agents.js";

const log = componentLogger(createLogger(), "delegate-ping-pong-detector");

const DEFAULT_MAX_BOUNCES = 3;
const DEFAULT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const LINEAR_API_URL = "https://api.linear.app/graphql";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DelegatePingPongConfig {
  /**
   * How many times the same delegate must be seen in the chain before
   * a cycle is declared. Default: 3.
   */
  maxBounces: number;
  /**
   * Sliding window (in ms) within which delegate assignments are considered.
   * Assignments older than this are pruned. Default: 30 min.
   */
  windowMs: number;
}

export interface DelegateAssignment {
  /** The ticket identifier (e.g. "GEN-263"). */
  ticketId: string;
  /** The Linear user ID of the delegate. */
  delegateId: string;
  /** The agent name (openclaw name) of the delegate. */
  agentName: string;
  /** ISO timestamp of the assignment. */
  timestamp: string;
  /** Unix epoch ms of the assignment. */
  timestampMs: number;
}

export interface CycleDetectionResult {
  hasCycle: boolean;
  /** The delegate(s) that appeared ≥ maxBounces times. */
  cyclingDelegates: string[];
  /** How many times each cycling delegate appeared. */
  bounceCounts: Record<string, number>;
  /** The configured max bounces threshold. */
  maxAllowed: number;
  /** The full chain for the ticket (within window). */
  chain: DelegateAssignment[];
}

export interface EscalationResult {
  /** Whether escalation was fired. */
  fired: boolean;
  /** Ticket identifier that triggered escalation. */
  ticketId: string;
  /** Agent name that was escalated to (typically "ai"). */
  escalatedTo: string;
  /** Number of bounces detected. */
  bounceCount: number;
  /** The cycling delegate(s). */
  cyclingDelegates: string[];
}

export interface PingPongHandlingResult {
  /** Whether cycle detection was performed. */
  checked: boolean;
  /** Cycle detection result, if checked. */
  detection: CycleDetectionResult | null;
  /** Escalation result, if escalation was attempted. */
  escalation: EscalationResult | null;
  /** Whether the dispatch should be suppressed (cycle detected → no dispatch). */
  suppressDispatch: boolean;
}

// ── DelegateChainTracker ─────────────────────────────────────────────────────

/**
 * Tracks delegate assignments per ticket. Maintains an in-memory chain
 * that records every delegate-change event seen by the webhook.
 */
export class DelegateChainTracker {
  private chains: Map<string, DelegateAssignment[]> = new Map();
  private config: DelegatePingPongConfig;

  constructor(config?: Partial<DelegatePingPongConfig>) {
    this.config = {
      maxBounces: config?.maxBounces ??
        (parseInt(process.env.PING_PONG_MAX_BOUNCES ?? "", 10) || DEFAULT_MAX_BOUNCES),
      windowMs: config?.windowMs ??
        (parseInt(process.env.PING_PONG_WINDOW_MS ?? "", 10) || DEFAULT_WINDOW_MS),
    };
  }

  /**
   * Record a delegate assignment for a ticket.
   */
  recordAssignment(ticketId: string, delegateId: string, agentName: string, now?: number): void {
    const timestampMs = now ?? Date.now();
    const assignment: DelegateAssignment = {
      ticketId,
      delegateId,
      agentName,
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
    };
    const chain = this.pruneChain(this.chains.get(ticketId) ?? [], timestampMs);
    chain.push(assignment);
    this.chains.set(ticketId, chain);
  }

  /**
   * Get the delegate assignment chain for a ticket (within the configured window).
   */
  getChain(ticketId: string): DelegateAssignment[] {
    return [...(this.chains.get(ticketId) ?? [])];
  }

  /**
   * Detect whether a ticket's delegate chain shows a ping-pong cycle.
   */
  detectCycle(ticketId: string, now?: number): CycleDetectionResult {
    const timestampMs = now ?? Date.now();
    const chain = this.pruneChain(this.chains.get(ticketId) ?? [], timestampMs);
    this.chains.set(ticketId, chain);

    const bounceCounts: Record<string, number> = {};
    for (const assignment of chain) {
      bounceCounts[assignment.delegateId] = (bounceCounts[assignment.delegateId] ?? 0) + 1;
    }

    const cyclingDelegates = Object.entries(bounceCounts)
      .filter(([, count]) => count >= this.config.maxBounces)
      .map(([delegateId]) => delegateId);

    return {
      hasCycle: cyclingDelegates.length > 0,
      cyclingDelegates,
      bounceCounts,
      maxAllowed: this.config.maxBounces,
      chain,
    };
  }

  /**
   * Clear the chain for a ticket.
   */
  clearTicket(ticketId: string): void {
    this.chains.delete(ticketId);
  }

  /**
   * Clear all chains.
   */
  clearAll(): void {
    this.chains.clear();
  }

  private pruneChain(chain: DelegateAssignment[], now: number): DelegateAssignment[] {
    const cutoff = now - this.config.windowMs;
    return chain.filter((assignment) => assignment.timestampMs >= cutoff);
  }
}

// ── Escalation ───────────────────────────────────────────────────────────────

/**
 * Fire the escalation ladder: post a comment to the Linear ticket and
 * re-delegate to the steward (Ai).
 */
export async function fireEscalation(
  ticketId: string,
  cyclingDelegates: string[],
  bounceCount: number,
  authToken?: string,
): Promise<EscalationResult> {
  const token =
    authToken ??
    getAccessToken("ai") ??
    process.env.LINEAR_OAUTH_TOKEN ??
    process.env.LINEAR_API_KEY;

  if (!token) {
    log.error(`ping-pong escalation: no auth token for ${ticketId}`);
    return {
      fired: false,
      ticketId,
      escalatedTo: "ai",
      bounceCount,
      cyclingDelegates,
    };
  }

  const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  const issueId = await resolveIssueId(ticketId, authHeader);
  if (!issueId) {
    log.error(`ping-pong escalation: could not resolve issue ID for ${ticketId}`);
    return {
      fired: false,
      ticketId,
      escalatedTo: "ai",
      bounceCount,
      cyclingDelegates,
    };
  }

  const delegates = cyclingDelegates.join(", ");
  const body =
    `[Connector] Delegate ping-pong cycle detected on ${ticketId}: ` +
    `${delegates} reached ${bounceCount} assignment(s) within the configured window. ` +
    "Suppressing this dispatch and escalating to steward (Ai).";
  const commentPosted = await postComment(issueId, body, authHeader);

  const stewardUserId = getLinearUserIdForAgent("ai");
  const delegateChanged = stewardUserId
    ? await updateDelegate(issueId, stewardUserId, authHeader)
    : false;

  if (!stewardUserId) {
    log.error("ping-pong escalation: steward 'ai' has no Linear user ID");
  }

  const fired = commentPosted && delegateChanged;
  log.warn(
    `PING_PONG_CYCLE_DETECTED: issue=${ticketId} delegates=${delegates} ` +
    `bounceCount=${bounceCount} escalatedTo=ai fired=${fired}`,
  );

  return {
    fired,
    ticketId,
    escalatedTo: "ai",
    bounceCount,
    cyclingDelegates,
  };
}

async function resolveIssueId(
  identifier: string,
  authHeader: string,
): Promise<string | null> {
  const query = `query($id: String!) { issue(id: $id) { id } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({ query, variables: { id: identifier } }),
    });
    type Resp = { data?: { issue?: { id: string } | null } };
    const data = (await res.json()) as Resp;
    return data.data?.issue?.id ?? null;
  } catch (err) {
    log.error(`ping-pong escalation: issue lookup failed for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function postComment(
  issueId: string,
  body: string,
  authHeader: string,
): Promise<boolean> {
  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({ query: mutation, variables: { issueId, body } }),
    });
    type Resp = { data?: { commentCreate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    return data.data?.commentCreate?.success === true;
  } catch (err) {
    log.error(`ping-pong escalation: comment post failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function updateDelegate(
  issueId: string,
  delegateId: string,
  authHeader: string,
): Promise<boolean> {
  const mutation = `
    mutation UpdateDelegate($issueId: String!, $delegateId: String!) {
      issueUpdate(id: $issueId, input: { delegateId: $delegateId }) {
        success
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ query: mutation, variables: { issueId, delegateId } }),
    });
    const data = (await res.json()) as { data?: { issueUpdate?: { success: boolean } } };
    return Boolean(data.data?.issueUpdate?.success);
  } catch (err) {
    log.error(`ping-pong escalation: delegate update failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── Main Detector ────────────────────────────────────────────────────────────

/**
 * High-level detector that checks a delegate assignment against the chain
 * and fires escalation if a cycle is detected.
 */
export class DelegatePingPongDetector {
  private chainTracker: DelegateChainTracker;
  private config: DelegatePingPongConfig;
  private operationalEventStore?: OperationalEventStore;

  constructor(
    chainTracker?: DelegateChainTracker,
    config?: Partial<DelegatePingPongConfig>,
    operationalEventStore?: OperationalEventStore,
  ) {
    this.chainTracker = chainTracker ?? new DelegateChainTracker(config);
    this.config = {
      maxBounces: config?.maxBounces ??
        (parseInt(process.env.PING_PONG_MAX_BOUNCES ?? "", 10) || DEFAULT_MAX_BOUNCES),
      windowMs: config?.windowMs ??
        (parseInt(process.env.PING_PONG_WINDOW_MS ?? "", 10) || DEFAULT_WINDOW_MS),
    };
    this.operationalEventStore = operationalEventStore;
  }

  getChainTracker(): DelegateChainTracker {
    return this.chainTracker;
  }

  /**
   * Check a delegate assignment for ping-pong cycles.
   * Records the assignment, detects cycles, and fires escalation if needed.
   *
   * Returns a PingPongHandlingResult describing what happened.
   */
  async checkAndHandle(
    ticketId: string,
    delegateId: string,
    agentName: string,
    now?: number,
  ): Promise<PingPongHandlingResult> {
    this.chainTracker.recordAssignment(ticketId, delegateId, agentName, now);
    const detection = this.chainTracker.detectCycle(ticketId, now);
    let escalation: EscalationResult | null = null;
    let suppressDispatch = false;

    if (detection.hasCycle) {
      escalation = await fireEscalation(
        ticketId,
        detection.cyclingDelegates,
        Object.values(detection.bounceCounts).reduce((a, b) => Math.max(a, b), 0),
      );

      suppressDispatch = true;

      // Post operational event for observability
      if (this.operationalEventStore) {
        try {
          this.operationalEventStore.append({
            outcome: "ping-pong-cycle-detected",
            agent: agentName,
            key: ticketId,
            sessionKey: ticketId,
            deliveryMode: "delegate-ping-pong-detector",
            attemptCount: Object.values(detection.bounceCounts).reduce((a, b) => Math.max(a, b), 0),
            detail: {
              ticketId,
              cyclingDelegates: detection.cyclingDelegates,
              bounceCounts: detection.bounceCounts,
              maxAllowed: detection.maxAllowed,
              escalationFired: escalation.fired,
            },
          });
        } catch (err) {
          log.error(
            `Operational event append failed for ping-pong cycle on ${ticketId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    return {
      checked: true,
      detection,
      escalation,
      suppressDispatch,
    };
  }
}
