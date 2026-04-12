/**
 * Event routing: determines which OpenClaw agent should handle a Linear event.
 *
 * Supports both traditional assignee-based routing and OAuth app actor
 * delegation (where the agent appears in the `delegate` field, not `assignee`).
 *
 * Also filters self-triggered events to prevent feedback loops,
 * while allowing agent-to-agent delegation.
 */

import { buildAgentMap, getAccessToken, getAgent, getOpenclawAgentName } from "./agents";
import type { LinearEvent } from "./webhook/schema";
import type { RouteResult } from "./types";
import { createLogger, componentLogger } from "./logger";

const log = componentLogger(createLogger(), "router");

/**
 * Extract the target agent name from a webhook payload.
 * Checks delegate first (OAuth app actors), then assignee, then mentioned users.
 * Returns null if no agent target found or if it's a self-triggered event.
 */
export function extractAgentTarget(event: LinearEvent): string | null {
  const agentMap = buildAgentMap();
  if (Object.keys(agentMap).length === 0) {
    log.warn("No agents configured — skipping event");
    return null;
  }

  // Track whether the actor is one of our agents (for self-trigger filtering)
  const actorId = event.actor?.id;
  const isActorOurAgent = actorId ? !!agentMap[actorId] : false;

  // For AgentSessionEvent, route to the agent that owns the session
  if (event.type === "AgentSessionEvent") {
    // TODO: extract agent from session data if needed
    const agents = Object.values(agentMap);
    return agents.length > 0 ? agents[0] : null;
  }

  const data = "data" in event ? (event.data as Record<string, unknown> | undefined) : null;

  // 1. Check delegate first — OAuth app actors are set as delegates, not assignees
  let target: string | null = null;
  const delegateId = extractId(data?.delegate);
  if (delegateId && agentMap[delegateId]) {
    target = agentMap[delegateId];
    log.info(`Routed via delegate: ${delegateId} → ${target}`);
  }

  // 2. Fall back to assignee (for human-user API key tokens)
  if (!target) {
    const assigneeId = extractId(data?.assignee);
    if (assigneeId && agentMap[assigneeId]) {
      target = agentMap[assigneeId];
      log.info(`Routed via assignee: ${assigneeId} → ${target}`);
    }
  }

  // 3. Check mentioned users
  const mentionedUsers = data?.mentionedUsers as Array<{ id?: string }> | null | undefined;
  if (mentionedUsers) {
    for (const user of mentionedUsers) {
      if (user.id && agentMap[user.id]) {
        target = agentMap[user.id];
        log.info(`Routed via mention: ${user.id} → ${target}`);
        break;
      }
    }
  }

  // 4. Self-trigger filtering: skip if the actor IS the target agent
  //    But allow agent-to-agent delegation (Emi delegates to Aki)
  if (isActorOurAgent) {
    if (!target || agentMap[actorId!] === target) {
      log.info(`Skipping self-triggered event from ${actorId}`);
      return null;
    }
    // Actor is our agent but target is a different agent — allow through
    log.info(`Agent-to-agent delegation: ${agentMap[actorId!]} → ${target}`);
  }

  return target;
}

/** Extract an ID from a field that may be a string, an object with .id, or null */
function extractId(field: unknown): string | null {
  if (!field) return null;
  if (typeof field === "string") return field;
  if (typeof field === "object" && field !== null && "id" in field) {
    return (field as { id?: string }).id ?? null;
  }
  return null;
}

/**
 * Route a Linear event to an OpenClaw agent.
 * Returns a RouteResult if routing succeeded, null if no agent found.
 */
export function routeEvent(event: LinearEvent): RouteResult | null {
  const agentName = extractAgentTarget(event);
  if (!agentName) return null;

  const agent = getAgent(agentName);
  const openclawName = getOpenclawAgentName(agentName);
  const d = event.data as Record<string, unknown> | undefined;
  const sessionData = d?.agentSession as Record<string, unknown> | undefined;
  const identifier =
    (d?.identifier as string | undefined) ??
    (d?.issueIdentifier as string | undefined) ??
    (sessionData?.issue as Record<string, unknown> | undefined)?.identifier as string | undefined;
  log.info(`routeEvent: type=${event.type} d=${JSON.stringify(d).slice(0, 200)} identifier=${identifier}`);

  return {
    agentId: openclawName,
    sessionKey: identifier ? `linear-${identifier}` : `linear-${event.type}-${Date.now()}`,
    priority: 0,
    event,
  };
}
