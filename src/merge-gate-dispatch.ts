import { LinearEvent } from "./webhook/schema.js";
import { componentLogger, createLogger } from "./logger.js";
import { getAccessToken, getAgents } from "./agents.js";
import { RouteResult } from "./types.js";
import { normalizeSessionKey } from "./session-key.js";
import { fetchWorkflowLabels } from "./workflow-gate.js";

const log = componentLogger(createLogger(), "merge-gate-dispatch");

export type MergeGateOutcome = "pass" | "fail" | "held";

export interface MergeGateSignal {
  outcome: MergeGateOutcome;
  ticketId: string;
}

/**
 * AC1: Parse Hanzo's merge-gate outcome from a comment body.
 * Matches "Merge gate <outcome>." or "GATE_RESULT=<outcome>".
 */
export function parseMergeGateOutcome(commentBody: string): MergeGateOutcome | null {
  const normalized = commentBody.trim();
  
  // Match "Merge gate pass.", "Merge gate fail.", "Merge gate held."
  const leadLineMatch = normalized.match(/^Merge gate (pass|fail|held)\./i);
  if (leadLineMatch) {
    return leadLineMatch[1].toLowerCase() as MergeGateOutcome;
  }

  // Match "GATE_RESULT=PASS", etc.
  const tokenMatch = normalized.match(/GATE_RESULT=(PASS|FAIL|HELD)/i);
  if (tokenMatch) {
    return tokenMatch[1].toLowerCase() as MergeGateOutcome;
  }

  return null;
}

/**
 * AC2: Map outcome to next role.
 * - held -> Charles (code-review)
 * - fail -> Igor (implementer, via store or singleton fallback)
 * - pass -> re-poke current owner (Hanzo)
 */
export async function resolveNextRoleRoute(
  signal: MergeGateSignal,
  event: LinearEvent,
): Promise<RouteResult | null> {
  const { outcome, ticketId } = signal;
  const sessionKey = normalizeSessionKey(ticketId);

  // Default target mapping
  let targetAgentId: string | null = null;
  let reason: RouteResult["routingReason"] = "delegate";

  if (outcome === "held") {
    targetAgentId = "charles";
  } else if (outcome === "fail") {
    // In a real implementation, we might look up the implementer from a store.
    // For now, following the subagent's logic: fallback to Igor as singleton-dev.
    targetAgentId = "igor";
  } else if (outcome === "pass") {
    // Pass usually means it's back in Hanzo's court to advance.
    targetAgentId = "hanzo";
  }

  if (!targetAgentId) return null;

  // Verify the target agent exists in our roster
  const agents = getAgents();
  const exists = agents.some(a => a.name === targetAgentId);
  if (!exists) {
    log.error(`Merge gate dispatch: unresolved target agent ${targetAgentId} for ${ticketId}`);
    return null;
  }

  return {
    agentId: targetAgentId,
    sessionKey,
    priority: 0,
    event,
    routingReason: reason,
  };
}
