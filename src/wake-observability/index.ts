/**
 * INF-84 — agent wake-to-pickup observability: reason-coded clarity on why a
 * delegation sits.
 *
 * Exports the reason-code resolver, per-agent status surface, model-degradation
 * detection, and the types shared by the watchdog integration.
 */

// ── Enums ─────────────────────────────────────────────────────────────────────

/** Machine-readable reason codes for why a delegated ticket is not being picked up. */
export enum StallReasonCode {
  WAKE_NOT_DELIVERED = "wake-not-delivered",
  SESSION_DEAD = "session-dead",
  QUEUE_STARVED = "queue-starved",
  MODEL_DEGRADED = "model-degraded",
  ACTIVELY_PROCESSING = "actively-processing",
  CAPABILITY_BLOCKED = "capability-blocked",
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StallReason {
  reason: StallReasonCode;
  detail: string;
  resolvedAt: number;
}

export interface StallResolverDeps {
  sessionTracker: {
    getActiveSessionKeys: (agentId: string) => string[];
    isTicketActiveForAnyAgent: (sessionKey: string, exceptAgentId?: string) => boolean;
  };
  getActiveSessionKeys: (agentId: string) => string[];
  isTicketActiveForAnyAgent: (sessionKey: string, exceptAgentId?: string) => boolean;
  now: () => number;
  getWakeDeliveryOutcome?: (ticketId: string) => Promise<{ delivered: boolean; deliveredAt: number } | null>;
  getQueueDepth?: (agentId: string) => Promise<number>;
  getTicketDrainOrder?: (ticketId: string, agentId: string) => Promise<number>;
  getResolvedModel?: (agentId: string) => Promise<ResolvedModelInfo | null>;
  getFirstActionAt?: (ticketId: string) => Promise<number | null>;
  getCapabilityBlock?: (agentId: string, ticketId: string) => Promise<{ blocked: boolean; reason: string } | null>;
}

export interface AgentStatus {
  liveSession: boolean;
  activeSessionCount: number;
  resolvedModel: string;
  resolvedModelConfiguredDefault?: string;
  modelIsFallback: boolean;
  tokensPerSecond: number;
  queueDepth: number;
  lastAction: { ticketId: string; actionAt: number; actionType: string } | null;
}

export interface AgentStatusSnapshot {
  agents: Array<{ agentId: string } & AgentStatus>;
  fetchedAt: number;
}

export interface ResolvedModelInfo {
  modelName: string;
  isFallback: boolean;
  tokensPerSecond: number;
  configuredDefault?: string;
  gateway?: string;
}

export interface ModelTrackerDeps {
  getResolvedModel: (agentId: string) => Promise<ResolvedModelInfo | null>;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

/** Minimum acceptable throughput (tokens/second). Below this = degraded. */
const MIN_THROUGHPUT_TOK_S = 5;

/** Known-slow model family prefixes — matched case-insensitively. */
const SLOW_MODEL_PREFIXES = ["ollama/", "local/", "llama.cpp/"];

/** The youngest a delegation needs to be before we consider it a "stall". */
const MIN_STALL_AGE_MS = 2 * 60 * 1000; // 2 minutes

// ── Reason-code resolver (AC1) ─────────────────────────────────────────────────

/**
 * For a delegated ticket with no pickup in >2 min, returns a StallReason with a
 * machine-readable enum value — never a prose guess.
 *
 * Returns null when the ticket was delegated less than MIN_STALL_AGE_MS ago
 * (not yet actionable).
 */
export async function resolveStallReason(
  ticketId: string,
  agentId: string,
  context: { delegatedAtMs: number },
  deps: StallResolverDeps,
): Promise<StallReason | null> {
  const now = deps.now ? deps.now() : Date.now();

  // Not yet a stall — less than 2 minutes old
  if (now - context.delegatedAtMs < MIN_STALL_AGE_MS) {
    return null;
  }

  // 1) Check if wake was delivered
  if (deps.getWakeDeliveryOutcome) {
    const outcome = await deps.getWakeDeliveryOutcome(ticketId);
    if (outcome === null) {
      return {
        reason: StallReasonCode.WAKE_NOT_DELIVERED,
        detail: `Wake for ${ticketId} was never delivered to ${agentId}`,
        resolvedAt: now,
      };
    }
  }

  // 2) If first action occurred after delegation → ACTIVELY_PROCESSING.
  //    This takes priority over model degradation: an agent that IS working,
  //    even on a 2 tok/s model, is actively processing — not degraded.
  if (deps.getFirstActionAt) {
    const firstActionAt = await deps.getFirstActionAt(ticketId);
    if (firstActionAt !== null && firstActionAt > context.delegatedAtMs) {
      const secondsAgo = Math.round((now - firstActionAt) / 1000);
      return {
        reason: StallReasonCode.ACTIVELY_PROCESSING,
        detail: `Agent acted ${secondsAgo}s ago on ${ticketId}`,
        resolvedAt: now,
      };
    }
  }

  // 3) Check model degradation — before session-dead check because a slow model
  //    may have caused the session to time out. An agent with no active session
  //    that IS on a slow local fallback should report MODEL_DEGRADED, not
  //    SESSION_DEAD, because the root cause is the model performance.
  const sessionKeys = deps.getActiveSessionKeys(agentId);
  if (deps.getResolvedModel) {
    const modelInfo = await deps.getResolvedModel(agentId);
    if (modelInfo && isModelDegraded(modelInfo)) {
      return {
        reason: StallReasonCode.MODEL_DEGRADED,
        detail: `${agentId} is on ${modelInfo.modelName} at ${modelInfo.tokensPerSecond} tok/s (fallback: ${modelInfo.isFallback})`,
        resolvedAt: now,
      };
    }
  }

  // 4) Check if agent has a live session (after model check, since a slow model
  //    with no session is MODEL_DEGRADED, not SESSION_DEAD)
  if (sessionKeys.length === 0) {
    return {
      reason: StallReasonCode.SESSION_DEAD,
      detail: `Agent ${agentId} has no active session to wake into`,
      resolvedAt: now,
    };
  }

  // 5) Check capability block
  if (deps.getCapabilityBlock) {
    const block = await deps.getCapabilityBlock(agentId, ticketId);
    if (block?.blocked) {
      return {
        reason: StallReasonCode.CAPABILITY_BLOCKED,
        detail: block.reason,
        resolvedAt: now,
      };
    }
  }

  // 6) Check queue depth (agent is awake but processing other tickets)
  if (deps.getQueueDepth) {
    const queueDepth = await deps.getQueueDepth(agentId);
    if (queueDepth > 0) {
      const detail = deps.getTicketDrainOrder
        ? `${queueDepth} tickets ahead in queue for ${agentId}`
        : `${queueDepth} ticket(s) queued for ${agentId}`;
      return {
        reason: StallReasonCode.QUEUE_STARVED,
        detail,
        resolvedAt: now,
      };
    }
  }

  // Fallback — we know there's a stall but none of the specific reasons matched.
  // Return session-dead as a catch-all; in practice this shouldn't be reached
  // if the dependency injection is complete, but we never return a prose guess.
  return {
    reason: StallReasonCode.SESSION_DEAD,
    detail: `Agent ${agentId} has no active session or all other checks passed without resolution`,
    resolvedAt: now,
  };
}

// ── Agent status surface (AC2) ────────────────────────────────────────────────

export async function getAgentStatus(
  agentId: string,
  deps: {
    sessionTracker: { getActiveSessionKeys: (agentId: string) => string[] };
    getAgentQueueDepth: (agentId: string) => Promise<number>;
    getResolvedModel: (agentId: string) => Promise<ResolvedModelInfo | null>;
    getLastAction: (agentId: string) => Promise<{ ticketId: string; actionAt: number; actionType: string } | null>;
  },
): Promise<AgentStatus> {
  const sessionKeys = deps.sessionTracker.getActiveSessionKeys(agentId);
  const queueDepth = await deps.getAgentQueueDepth(agentId);
  const modelInfo = await deps.getResolvedModel(agentId);
  const lastAction = await deps.getLastAction(agentId);

  return {
    liveSession: sessionKeys.length > 0,
    activeSessionCount: sessionKeys.length,
    resolvedModel: modelInfo?.modelName ?? "unknown",
    resolvedModelConfiguredDefault: modelInfo?.configuredDefault,
    modelIsFallback: modelInfo?.isFallback ?? false,
    tokensPerSecond: modelInfo?.tokensPerSecond ?? 0,
    queueDepth,
    lastAction,
  };
}

export async function getAgentStatusForAll(
  deps: {
    sessionTracker: { getActiveSessionKeys: (agentId: string) => string[] };
    listAgentIds: () => Promise<string[]>;
    getAgentQueueDepth: (agentId: string) => Promise<number>;
    getResolvedModel: (agentId: string) => Promise<ResolvedModelInfo | null>;
    getLastAction: (agentId: string) => Promise<{ ticketId: string; actionAt: number; actionType: string } | null>;
  },
): Promise<AgentStatusSnapshot> {
  const agentIds = await deps.listAgentIds();
  const agents = await Promise.all(
    agentIds.map(async (agentId) => {
      const status = await getAgentStatus(agentId, deps);
      return { agentId, ...status };
    }),
  );

  return {
    agents,
    fetchedAt: Date.now(),
  };
}

// ── Model-degradation detection (AC3) ─────────────────────────────────────────

/**
 * Fetch the resolved model info for an agent.
 */
export async function getAgentResolvedModel(
  agentId: string,
  deps: ModelTrackerDeps,
): Promise<ResolvedModelInfo> {
  const info = await deps.getResolvedModel(agentId);
  return info ?? {
    modelName: "unknown",
    isFallback: false,
    tokensPerSecond: 0,
  };
}

/**
 * Determine whether an agent's resolved model is degraded — meaning it's so
 * slow that the agent is effectively unhealthy even though it responds to
 * liveness probes.
 *
 * Degradation signals (in priority order):
 * 1. Throughput below MIN_THROUGHPUT_TOK_S (< 5 tok/s)
 * 2. Known-slow model family (ollama/, local/, llama.cpp/) AND it's a fallback
 * 3. Known-slow model family with zero/unknown throughput AND isFallback
 *
 * A fallback that is still fast (e.g. claude-sonnet → claude-opus at 60 tok/s)
 * is NOT degraded.
 */
export function isModelDegraded(info: ResolvedModelInfo): boolean {
  // Fast → not degraded regardless of fallback/gateway
  if (info.tokensPerSecond >= MIN_THROUGHPUT_TOK_S) {
    return false;
  }

  // Below threshold throughput — definitely degraded
  if (info.tokensPerSecond > 0 && info.tokensPerSecond < MIN_THROUGHPUT_TOK_S) {
    return true;
  }

  // Zero/unknown throughput — check family + fallback
  const modelNameLower = info.modelName.toLowerCase();
  const isSlowFamily = SLOW_MODEL_PREFIXES.some((prefix) =>
    modelNameLower.startsWith(prefix),
  );

  if (isSlowFamily && info.isFallback) {
    return true;
  }

  // Primary model on local gateway with unknown throughput — not degraded by
  // default (it's the configured primary; local can be fast)
  return false;
}
