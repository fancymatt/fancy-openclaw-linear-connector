/**
 * INF-314 — Stall detection core: liveness-based classification.
 *
 * Rather than relying on time-in-state (which conflates healthy slow work
 * with truly stuck tickets), stall is determined by the absence of a
 * liveness signal: null delegate, no ack, or no progress within configurable
 * windows.
 *
 * classifyStall() is a pure function — give it a LivenessRecord and a
 * config, get a StallResult. getStalledTickets() maps it over a batch.
 *
 * AC coverage:
 *   AC1 — null-delegate → stalled immediately (within one detection cycle)
 *   AC2 — no-ack after ACK_TIMEOUT → stalled + redispatch/escalate
 *   AC3 — no-progress after PROGRESS_TIMEOUT → stalled + redispatch/escalate
 *   AC4 — active work (progress within window) → never flagged
 *   AC5 — getStalledTickets returns stalled entries with reasons
 *   AC6 — thresholds are config, not hardcoded
 *   AC7 — regression tests for each stall class + no-false-positive
 */

/** Terminal workflow states — finished tickets are never "stalled". */
const TERMINAL_STATES = new Set([
  "done",
  "escape",
  "cancelled",
  "canceled",
  "closed",
  "completed",
  "duplicate",
]);

export interface LivenessRecord {
  ticketId: string;
  /** Epoch ms when the ticket was dispatched to the current delegate. */
  dispatchedAt: number;
  /** Epoch ms when the delegate first acknowledged (e.g. proxy call, session start). */
  ackedAt?: number;
  /** Epoch ms of the most recent progress signal (state transition, comment, commit). */
  lastProgressAt?: number;
  /** Current delegate (agent name) or null if the delegate was cleared. */
  delegate: string | null;
  /** Current workflow state name (e.g. "implementation", "code-review", "done"). */
  state: string;
  /** Whether the ticket has already been redispatched once after a prior stall. */
  redispatched: boolean;
}

export interface StallClassifierConfig {
  /** Max ms a dispatch can go un-acked before it's considered stalled. */
  ackTimeoutMs: number;
  /** Max ms since last progress before an acked ticket is considered stalled. */
  progressTimeoutMs: number;
  /** Optional override for current time (testing). */
  now?: number;
}

export interface StallResult {
  stalled: boolean;
  reason?: "null-delegate" | "no-ack" | "no-progress";
  /** True when this is the first stall → auto-redispatch. */
  redispatched: boolean;
  /** True when this is the second stall (already redispatched) → escalate. */
  escalated: boolean;
}

export interface StalledTicketInfo {
  ticketId: string;
  reason: string;
}

/**
 * Classify whether a single liveness record represents a stalled ticket.
 *
 * Evaluation order (first match wins):
 *   1. Terminal state → not stalled (ticket is finished).
 *   2. Null delegate in a working state → stalled immediately (null-delegate).
 *   3. No ack and ACK_TIMEOUT elapsed → stalled (no-ack).
 *   4. Acked but no progress for PROGRESS_TIMEOUT → stalled (no-progress).
 *   5. Otherwise → not stalled.
 *
 * Redispatch vs escalate logic:
 *   - First stall (redispatched=false on the record) → redispatched=true on result.
 *   - Second stall (redispatched=true on the record) → escalated=true on result.
 *   This ensures auto-recovery fires once, then escalates rather than looping.
 */
export function classifyStall(
  record: LivenessRecord,
  config: StallClassifierConfig,
  now?: number,
): StallResult {
  const currentTime = now ?? config.now ?? Date.now();

  // 1. Terminal state — ticket is finished, not stalled.
  if (TERMINAL_STATES.has(record.state.toLowerCase())) {
    return { stalled: false, redispatched: false, escalated: false };
  }

  // 2. Null delegate in a working state — orphaned ticket, immediate stall.
  if (record.delegate === null) {
    return {
      stalled: true,
      reason: "null-delegate",
      redispatched: !record.redispatched,
      escalated: record.redispatched,
    };
  }

  // 3. No ack within ACK_TIMEOUT — dispatch was swallowed or agent never started.
  if (record.ackedAt === undefined) {
    const elapsedSinceDispatch = currentTime - record.dispatchedAt;
    if (elapsedSinceDispatch >= config.ackTimeoutMs) {
      return {
        stalled: true,
        reason: "no-ack",
        redispatched: !record.redispatched,
        escalated: record.redispatched,
      };
    }
  }

  // 4. Acked but no progress within PROGRESS_TIMEOUT — agent went silent.
  if (record.ackedAt !== undefined) {
    const progressReference = record.lastProgressAt ?? record.ackedAt;
    const elapsedSinceProgress = currentTime - progressReference;
    if (elapsedSinceProgress >= config.progressTimeoutMs) {
      return {
        stalled: true,
        reason: "no-progress",
        redispatched: !record.redispatched,
        escalated: record.redispatched,
      };
    }
  }

  // 5. Healthy — making progress within expected windows.
  return { stalled: false, redispatched: false, escalated: false };
}

/**
 * Filter a batch of liveness records, returning only those that are stalled.
 * Each entry includes the ticketId and the stall reason.
 */
export function getStalledTickets(
  records: LivenessRecord[],
  config: StallClassifierConfig & { now?: number },
): StalledTicketInfo[] {
  const stalled: StalledTicketInfo[] = [];
  for (const record of records) {
    const result = classifyStall(record, config, config.now);
    if (result.stalled && result.reason) {
      stalled.push({ ticketId: record.ticketId, reason: result.reason });
    }
  }
  return stalled;
}
