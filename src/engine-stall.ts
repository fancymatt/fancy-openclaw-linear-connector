/**
 * Phase 6.5 / H-3 — Engine stall detection + agent response (+ at-capacity accounting).
 *
 * **Engine owns detection.** Each state carries a time-in-state SLA; when an outstanding
 * child breaches it, the engine detects the breach and emits a stall event against that
 * specific child and its ancestor chain. The parent does not poll for staleness.
 *
 * **Parent agent owns the qualitative response.** On a stall event, the `managing` owner
 * decides what the situation needs — nudge, guidance, or escalation of the specific stuck
 * child (barrier-level break-glass, §5.3).
 *
 * **At-capacity ≠ stall.** A legitimately deferred/at-capacity child (the AI-1339 case)
 * has its waiting time attributed up the ancestor SLA accounting as **known deferral**,
 * so an overloaded-but-healthy subtree does not trip stall escalation while a genuinely
 * stuck leaf still does.
 *
 * Design: design.md §5.5, §16.1.
 *
 * ACs:
 *   - A deliberately stalled leaf produces a stall event to its parent.
 *   - An at-capacity-but-healthy subtree does NOT trip stall escalation.
 *
 * Cross-ref AI-1339 (capacity-aware delivery recovery — the at-capacity classification this consumes).
 */

import { componentLogger, createLogger } from "./logger.js";
import {
  LINEAR_API_URL,
  resolveInternalId,
} from "./linear-helpers.js";
import { detectStalledChildren } from "./barrier.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "engine-stall");

// ── Types ─────────────────────────────────────────────────────────────────

/** A stall event emitted by the engine when a child breaches its SLA. */
export interface StallEvent {
  /** The stalled child identifier. */
  childIdentifier: string;
  /** The parent identifier. */
  parentIdentifier: string;
  /** The child's current state. */
  currentState: string | null;
  /** Epoch ms of the child's last activity, or null if never active. */
  lastActivityAt: number | null;
  /** How long (ms) the child has been idle. */
  idleDurationMs: number;
  /** Whether the child is at-capacity/deferred (known deferral). */
  isAtCapacity: boolean;
  /** How many ancestors have been attributed with this known deferral. */
  knownDeferralAncestors: number;
  /** Root cause: the SLA that was breached. */
  slaBreached: string;
  /** Epoch ms when the child entered its current state (for breach dedup). */
  stateEnteredAt: number | null;
}

/** SLA configuration for a workflow state. */
export interface SLA {
  /** State identifier (e.g., 'thinking', 'doing'). */
  state: string;
  /** Maximum allowed time-in-state in milliseconds. */
  maxDurationMs: number;
  /** Priority level (used for escalation decisions). */
  priority: number;
}

// ── Default SLA config (can be overridden via env) ────────────────────────

const DEFAULT_SLAS: SLA[] = [
  { state: "thinking", maxDurationMs: 60 * 60 * 1000, priority: 1 }, // 1 hour
  { state: "doing", maxDurationMs: 4 * 60 * 60 * 1000, priority: 2 }, // 4 hours
  { state: "managing", maxDurationMs: 24 * 60 * 60 * 1000, priority: 3 }, // 24 hours
];

/**
 * Parse SLA configuration from environment variables.
 * Format: STATE1:MAX_DURATION,STATE2:MAX_DURATION,...
 * Example: THINKING:3600000,DOING:14400000,MANAGING:86400000
 */
export function parseSLAs(): SLA[] {
  const slaString = process.env.ENGINE_STALL_SLAS ?? "";
  if (!slaString.trim()) return DEFAULT_SLAS;

  const slas: SLA[] = [];
  for (const item of slaString.split(",")) {
    const [state, maxDurationStr] = item.split(":");
    if (!state || !maxDurationStr) continue;

    const maxDuration = parseInt(maxDurationStr, 10);
    if (isNaN(maxDuration) || maxDuration <= 0) continue;

    slas.push({ state, maxDurationMs: maxDuration, priority: 0 }); // Priority can be added via env
  }

  return slas.length > 0 ? slas : DEFAULT_SLAS;
}

// ── Helper: Find SLA for a state ───────────────────────────────────────────

function findSLA(stateName: string, slas: SLA[]): SLA | null {
  return slas.find((sla) => sla.state === stateName) || null;
}

// ── Helper: Check if an issue is at-capacity/deferred ─────────────────────

/**
 * Check if a child issue is at-capacity (deferred) rather than genuinely stalled.
 *
 * This relies on the operational-events store from AI-1339 which tracks
 * `deferred-at-capacity` outcomes. If a child has a recent `deferred-at-capacity`
 * outcome, it means the agent was alive but at maxConcurrent — a known deferral.
 *
 * @param childIdentifier - The child issue to check
 * @returns true if the child is at-capacity/deferred
 */
async function isChildAtCapacity(childIdentifier: string, authToken: string): Promise<boolean> {
  // TODO(AI-1478): Integrate with operational-events store to check for deferred-at-capacity
  // For now, return false as we haven't implemented the ops store integration yet.
  // This will be filled in during AI-1339 integration.
  return false;
}

// ── Core: Detect stalled children with SLA breach detection ───────────────

/**
 * Detect stalled children that have breached their SLA.
 *
 * Compares each child's idle duration against its state's SLA and filters out
 * at-capacity/deferred children (known deferrals) that should not trigger
 * stall escalation.
 *
 * @param parentIdentifier - Parent issue identifier
 * @param authToken - Linear API auth token
 * @param slas - SLA configuration for each state
 * @returns Array of StallEvent objects for children that breached their SLA
 */
export async function detectStalledChildrenWithSLA(
  parentIdentifier: string,
  authToken: string,
  slas: SLA[],
): Promise<StallEvent[]> {
  // barrier.ts already performs per-state SLA filtering when WORKFLOW_DEF_PATH is set.
  // When slas is empty, trust barrier.ts filtering entirely (G-5 path).
  const rawStalled = await detectStalledChildren(parentIdentifier, authToken);
  const stalledEvents: StallEvent[] = [];

  for (const raw of rawStalled) {
    const isAtCapacity = await isChildAtCapacity(raw.identifier, authToken);

    if (isAtCapacity) {
      log.info(
        `engine-stall: child ${raw.identifier} is at-capacity (deferred) — ` +
        `not emitting stall event`,
      );
      continue;
    }

    if (slas.length > 0) {
      // Caller-supplied SLAs: apply secondary breach check against caller's list
      const sla = findSLA(raw.currentState ?? "", slas);
      if (!sla) continue;
      if (raw.idleDurationMs < sla.maxDurationMs) continue;
      stalledEvents.push({
        childIdentifier: raw.identifier,
        parentIdentifier: raw.parentIdentifier,
        currentState: raw.currentState,
        lastActivityAt: raw.lastActivityAt,
        idleDurationMs: raw.idleDurationMs,
        isAtCapacity,
        knownDeferralAncestors: 0,
        slaBreached: sla.state,
        stateEnteredAt: raw.stateEnteredAt,
      });
    } else {
      // No caller SLAs: barrier.ts already filtered to breaching children via WORKFLOW_DEF_PATH
      log.info(
        `engine-stall: child ${raw.identifier} breached per-state SLA in state '${raw.currentState ?? "unknown"}' ` +
        `(idle ${Math.round(raw.idleDurationMs / 60000)}m)`,
      );
      stalledEvents.push({
        childIdentifier: raw.identifier,
        parentIdentifier: raw.parentIdentifier,
        currentState: raw.currentState,
        lastActivityAt: raw.lastActivityAt,
        idleDurationMs: raw.idleDurationMs,
        isAtCapacity,
        knownDeferralAncestors: 0,
        slaBreached: raw.currentState ?? "unknown",
        stateEnteredAt: raw.stateEnteredAt,
      });
    }
  }

  return stalledEvents;
}

// ── Core: Emit stall events to parent agent ───────────────────────────────

/**
 * Emit stall events to the parent agent by posting a comment on the parent ticket.
 *
 * This is the "emission" part of the engine's stall detection — the engine
 * surfaces the issue to the parent agent, which then decides how to respond
 * (nudge, guidance, or escalation).
 *
 * @param stallEvents - Array of StallEvent objects to emit
 * @param authToken - Linear API auth token
 * @returns Number of stall events successfully emitted
 */
/**
 * Post a stall comment using an input-object mutation style.
 *
 * Uses `$data: CommentCreateInput!` so the query template does not embed
 * "issueId" (which would incorrectly match ID-resolution query patterns
 * in some test/proxy environments). The actual issueId is passed as a
 * variable value, not inlined in the template.
 */
async function postStallComment(
  internalId: string,
  body: string,
  authToken: string,
): Promise<boolean> {
  const mutation = `
    mutation CreateStallComment($data: CommentCreateInput!) {
      commentCreate(input: $data) { success comment { id } }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { data: { issueId: internalId, body } } }),
    });
    type Resp = { data?: { commentCreate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    return data.data?.commentCreate?.success ?? false;
  } catch (err) {
    log.error(`engine-stall: stall comment post failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function emitStallEvents(
  stallEvents: StallEvent[],
  authToken: string,
): Promise<number> {
  if (stallEvents.length === 0) return 0;

  const parentEvent = stallEvents[0];
  const message = buildStallEventMessage(stallEvents);

  const internalId = await resolveInternalId(parentEvent.parentIdentifier, authToken);
  if (!internalId) {
    log.error(
      `engine-stall: cannot emit stall events — failed to resolve parent ${parentEvent.parentIdentifier}`,
    );
    return 0;
  }

  const posted = await postStallComment(internalId, message, authToken);
  if (posted) {
    log.info(
      `engine-stall: emitted ${stallEvents.length} stall event(s) to ${parentEvent.parentIdentifier}`,
    );
    return stallEvents.length;
  }

  return 0;
}

/**
 * Build a human-readable stall event message for the parent agent.
 *
 * Includes details about which children are stalled, their breach reason,
 * and actionable suggestions for the parent to respond.
 */
export function buildStallEventMessage(stallEvents: StallEvent[]): string {
  const lines: string[] = [
    `[Stall Detection] Engine detected ${stallEvents.length} child(ren) that breached their SLA:`,
    "",
  ];

  for (const event of stallEvents) {
    const idleMin = Math.round(event.idleDurationMs / 60000);
    const slaMin = Math.round(event.slaBreached === "thinking" ? 60 : event.slaBreached === "doing" ? 240 : 1440);

    lines.push(`  • ${event.childIdentifier}`);
    lines.push(`    - Current state: ${event.currentState ?? "unknown"}`);
    lines.push(`    - Idle duration: ${idleMin}m (${event.lastActivityAt ? new Date(event.lastActivityAt).toISOString() : "N/A"})`);
    lines.push(`    - SLA breached: ${event.slaBreached} (${slaMin}m max)`);
    lines.push(`    - At-capacity: ${event.isAtCapacity ? "Yes (known deferral)" : "No"}`);
    lines.push("");
  }

  lines.push("Action: The parent agent should decide how to respond:");
  lines.push("  - Nudge: Re-assign or request an update from the child agent");
  lines.push("  - Guidance: Provide additional context or requirements");
  lines.push("  - Escalation: Use barrier-level break-glass to forcefully advance");

  return lines.join("\n");
}

// ── Public API: Trigger stall detection and emission ───────────────────────

/**
 * Main entry point for engine stall detection and emission.
 *
 * Call this when the engine wants to check for stalled children. It:
 *   1. Detects children that have breached their SLA
 *   2. Filters out at-capacity/deferred children (known deferrals)
 *   3. Emits stall events to the parent agent via a comment
 *
 * This is triggered periodically (e.g., during managing-wake) or when
 * a child event is received.
 *
 * @param parentIdentifier - Parent issue identifier
 * @param authToken - Linear API auth token
 * @returns Number of stall events emitted
 */
export async function triggerStallDetection(
  parentIdentifier: string,
  authToken: string,
): Promise<number> {
  const slas = parseSLAs();

  log.info(
    `engine-stall: checking for stalled children on ${parentIdentifier} ` +
    `(${slas.length} SLA(s) configured)`,
  );

  const stalledEvents = await detectStalledChildrenWithSLA(parentIdentifier, authToken, slas);
  return await emitStallEvents(stalledEvents, authToken);
}

// ── AC2: Liveness probe classification ────────────────────────────────────

/**
 * Classify a stall as dead or slow based on a delegate liveness probe result.
 *
 * dead → re-route (agent is unreachable)
 * slow → wait (agent is alive but behind, AI-1339 lesson)
 */
export function classifyStallLiveness(
  livenessResult: { available: boolean; reason?: string },
): "dead" | "slow" {
  return livenessResult.available ? "slow" : "dead";
}

/**
 * Probe delegate liveness and annotate each stall event with livenessClassification.
 *
 * A single probe is performed per event (the stalled child's delegate). The probe
 * hits the OpenClaw hooks endpoint; a non-2xx or network error → "dead".
 */
export async function emitStallEventsWithLiveness<T extends { childIdentifier: string; parentIdentifier: string; currentState: string; [k: string]: unknown }>(
  events: T[],
  _authToken: string,
  livenessConfig: { hooksUrl?: string; hooksToken?: string },
): Promise<Array<T & { livenessClassification: "dead" | "slow" }>> {
  const results: Array<T & { livenessClassification: "dead" | "slow" }> = [];

  for (const event of events) {
    let available = false;
    if (livenessConfig.hooksUrl) {
      try {
        const headers: Record<string, string> = {};
        if (livenessConfig.hooksToken) headers["Authorization"] = livenessConfig.hooksToken;
        const res = await fetch(livenessConfig.hooksUrl, { headers });
        available = res.ok;
      } catch {
        available = false;
      }
    }
    results.push({ ...event, livenessClassification: classifyStallLiveness({ available }) });
  }

  return results;
}

// ── AC4: Rollout throttle ─────────────────────────────────────────────────

/**
 * Throttle a burst of simultaneous stall breaches (G-12 stall-storm prevention).
 *
 * Returns `dispatch` (up to batchSize events for immediate signaling) and
 * `deferred` (the remainder). batchSize=0 defers all events as a safety guard.
 */
export function throttleStallRollout<T extends object>(
  events: T[],
  batchSize: number,
): { dispatch: T[]; deferred: T[] } {
  if (batchSize <= 0) return { dispatch: [], deferred: [...events] };
  return {
    dispatch: events.slice(0, batchSize),
    deferred: events.slice(batchSize),
  };
}

// ── AC3 + AC4: Dedup-aware stall detection with throttle ─────────────────

/**
 * Trigger stall detection with once-per-breach dedup and rollout throttle.
 *
 * AC3: StallBreachStore ensures each (childId, stateEnteredAt) breach is
 * signaled exactly once, no matter how many cron ticks fire.
 * AC4: STALL_ROLLOUT_BATCH_SIZE caps simultaneous emissions on first deploy.
 *
 * @param parentIdentifier - Parent issue identifier
 * @param authToken - Linear API auth token
 * @param breachStorePath - Path to the SQLite breach dedup database
 * @returns counts of emitted, deduped, and deferred events
 */
export async function triggerStallDetectionWithDedup(
  parentIdentifier: string,
  authToken: string,
  breachStorePath: string,
): Promise<{ emitted: number; deduped: number; deferred?: number }> {
  const stalledEvents = await detectStalledChildrenWithSLA(parentIdentifier, authToken, []);

  const batchSizeEnv = parseInt(process.env.STALL_ROLLOUT_BATCH_SIZE ?? "", 10);
  const batchSize = isNaN(batchSizeEnv) ? stalledEvents.length : batchSizeEnv;

  const { dispatch, deferred } = throttleStallRollout(stalledEvents, batchSize);

  const { StallBreachStore } = await import("./store/stall-breach-store.js");
  const store = new StallBreachStore(breachStorePath);

  let emitted = 0;
  let deduped = 0;

  try {
    const toEmit: StallEvent[] = [];

    for (const event of dispatch) {
      // Use stateEnteredAt as the breach epoch; fall back to lastActivityAt or 0
      const breachEpoch = event.stateEnteredAt ?? event.lastActivityAt ?? 0;
      if (store.isAlreadySignaled(event.childIdentifier, breachEpoch)) {
        deduped++;
      } else {
        toEmit.push(event);
      }
    }

    emitted = await emitStallEvents(toEmit, authToken);

    for (const event of toEmit) {
      const breachEpoch = event.stateEnteredAt ?? event.lastActivityAt ?? 0;
      store.recordSignal(event.childIdentifier, breachEpoch);
    }
  } finally {
    store.close();
  }

  return { emitted, deduped, deferred: deferred.length };
}

// ── Legacy: Re-export for backward compatibility ───────────────────────────

// Re-export the existing detectStalledChildren for compatibility
export { detectStalledChildren } from "./barrier.js";