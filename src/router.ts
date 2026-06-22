/**
 * Event routing: determines which OpenClaw agent should handle a Linear event.
 *
 * Supports both traditional assignee-based routing and OAuth app actor
 * delegation (where the agent appears in the `delegate` field, not `assignee`).
 *
 * Also filters self-triggered events to prevent feedback loops,
 * while allowing agent-to-agent delegation.
 *
 * AI-1479 (Phase 6.5, §16.5): routing now integrates the department-roster
 * functionary (department-roster.ts). Resolution order:
 *   1. Department-roster team-prefix match (identifier → prefix → defaultTarget).
 *   2. Existing mechanical resolution: delegate → assignee → mention → body-mention.
 *   3. Steward escalation (unroutable → Astrid, never null).
 */

import { buildAgentMap, getAccessToken, getAgent, getOpenclawAgentName, getAgents } from "./agents.js";
import type { LinearEvent } from "./webhook/schema.js";
import type { RouteResult } from "./types.js";
import { normalizeSessionKey } from "./session-key.js";
import { createLogger, componentLogger } from "./logger.js";
import { loadRoster, resolveRoute, type DepartmentRoster } from "./department-roster.js";

const log = componentLogger(createLogger(), "router");

/**
 * Extract the target agent name from a webhook payload.
 * Checks delegate first (OAuth app actors), then assignee, then mentioned users.
 * Returns null if no agent target found or if it's a self-triggered event.
 */
export function extractAgentTarget(event: LinearEvent): { name: string; reason: "delegate" | "assignee" | "mention" | "body-mention" } | null {
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
    return agents.length > 0 ? { name: agents[0], reason: "delegate" } : null;
  }

  const data = "data" in event ? (event.data as Record<string, unknown> | undefined) : null;

  // 1. Check delegate first — OAuth app actors are set as delegates, not assignees
  let target: string | null = null;
  let reason: "delegate" | "assignee" | "mention" | "body-mention" = "delegate";
  const delegateId = extractId(data?.delegate);
  if (delegateId && agentMap[delegateId]) {
    target = agentMap[delegateId];
    reason = "delegate";
    log.info(`Routed via delegate: ${delegateId} → ${target}`);

    // Guard (AI-1573): for Issue update events, only dispatch via delegate when
    // the delegate field actually changed in this update. If updatedFrom is
    // present but contains neither "delegateId" nor "delegate", the delegate
    // was not part of this mutation (same-value re-assert or unrelated-field
    // edit). Guard checks both key forms Linear may emit.
    if (event.type === "Issue" && event.action === "update") {
      const upd = (event as { updatedFrom?: Record<string, unknown> }).updatedFrom;
      if (upd !== undefined && !("delegateId" in upd) && !("delegate" in upd)) {
        log.info(`No-change delegate write — skipping dispatch (updatedFrom present, no delegate key)`);
        target = null;
      }
    }
  }

  // 2. Fall back to assignee (for human-user API key tokens)
  if (!target) {
    const assigneeId = extractId(data?.assignee);
    if (assigneeId && agentMap[assigneeId]) {
      target = agentMap[assigneeId];
      reason = "assignee";
      log.info(`Routed via assignee: ${assigneeId} → ${target}`);
    }
  }

  // 3. Check mentioned users
  const mentionedUsers = data?.mentionedUsers as Array<{ id?: string }> | null | undefined;
  if (!target && mentionedUsers) {
    for (const user of mentionedUsers) {
      if (user.id && agentMap[user.id]) {
        target = agentMap[user.id];
        reason = "mention";
        log.info(`Routed via mention: ${user.id} → ${target}`);
        break;
      }
    }
  }

  // 4. Body-based mention detection for Comment events
  if (!target && event.type === "Comment" && data?.body && typeof data.body === "string") {
    const nameMap = buildNameMap();
    const bodyMention = detectMentionInBody(data.body, nameMap);
    if (bodyMention) {
      target = nameMap[bodyMention];
      reason = "body-mention";
      log.info(`Routed via body mention: @${bodyMention} → ${target}`);
    }
  }

  // 5. Return the target even for self-triggered events.
  //    Self-trigger filtering is handled by routeEvent() after consulting
  //    the department-roster functionary (AI-1479). This allows department-
  //    prefix routing to override self-trigger suppression when the target
  //    differs from the actor.
  return target ? { name: target, reason } : null;
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

/** Extract an identifier (e.g. "AI-42") from any depth in the event payload.
 *
 *  Tries known paths first (fast path), then walks the full data tree
 *  looking for a field named "identifier" whose value looks like a Linear
 *  issue key (TEAM-NNN). This ensures stable session keys even for event
 *  shapes we haven't explicitly typed.
 */
function extractIssueIdentifier(event: LinearEvent): string | null {
  const d = (event.data ?? {}) as Record<string, unknown>;

  // Fast path: top-level fields from typed normalizer output
  if (typeof d.identifier === "string" && d.identifier) return d.identifier;
  if (typeof d.issueIdentifier === "string" && d.issueIdentifier) return d.issueIdentifier;

  // Nested issue object (Comment events, notifications)
  const issue = d.issue as Record<string, unknown> | undefined;
  if (issue && typeof issue.identifier === "string" && issue.identifier) {
    return issue.identifier;
  }

  // AgentSession → issue
  const session = d.agentSession as Record<string, unknown> | undefined;
  const sessionIssue = session?.issue as Record<string, unknown> | undefined;
  if (sessionIssue && typeof sessionIssue.identifier === "string" && sessionIssue.identifier) {
    return sessionIssue.identifier;
  }

  // Notification → issue
  const notification = d.notification as Record<string, unknown> | undefined;
  const notifIssue = notification?.issue as Record<string, unknown> | undefined;
  if (notifIssue && typeof notifIssue.identifier === "string" && notifIssue.identifier) {
    return notifIssue.identifier;
  }

  // Slow path: recursive walk for any future shapes
  return deepFindIdentifier(d);
}

/** Linear issue identifier pattern: 1-10 uppercase letters, hyphen, 1-6 digits */
const LINEAR_ID_RE = /^[A-Z]{1,10}-\d{1,6}$/;

function deepFindIdentifier(obj: unknown, depth = 0): string | null {
  if (depth > 5 || !obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;

  // Check direct "identifier" field
  if (typeof rec.identifier === "string" && LINEAR_ID_RE.test(rec.identifier)) {
    return rec.identifier;
  }

  // Recurse into child objects
  for (const val of Object.values(rec)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const found = deepFindIdentifier(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Build a lowercase-name → agentName map for body mention detection */
function buildNameMap(): Record<string, string> {
  const agents = getAgents();
  const map: Record<string, string> = {};
  for (const agent of agents) {
    const name = agent.name.toLowerCase();
    map[name] = agent.name;
    const openclawName = agent.openclawAgent?.toLowerCase();
    if (openclawName && openclawName !== name) {
      map[openclawName] = agent.name;
    }
  }
  return map;
}

/** Detect an @mention in a comment body and return the matched agent key from nameMap */
function detectMentionInBody(body: string, nameMap: Record<string, string>): string | null {
  // Match @word or @[Multi Word] patterns
  const mentionPattern = /@\[([^\]]+)\]|@(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(body)) !== null) {
    const name = (match[1] || match[2]).toLowerCase();
    if (nameMap[name]) {
      return name;
    }
  }
  return null;
}

/**
 * Route a Linear event to an OpenClaw agent.
 *
 * AI-1479: now integrates the department-roster functionary.
 * - When a roster is loaded and the issue has a team prefix matching a
 *   department, that department's defaultTarget is used directly.
 * - Otherwise, the existing mechanical resolution (delegate/assignee/mention)
 *   is used as before.
 * - When neither matches, the steward (Astrid) receives the event as
 *   an escalation — the functionary never returns null.
 *
 * Returns a RouteResult if routing succeeded, null only when the event
 * is a self-trigger that should be suppressed (feedback loop prevention).
 */
export async function routeEvent(event: LinearEvent): Promise<RouteResult | null> {
  const identifier = extractIssueIdentifier(event);
  const mechanicalTarget = extractAgentTarget(event);

  // Load department roster (cached in-process; null when unavailable).
  let roster: DepartmentRoster | null = null;
  try {
    roster = await loadRoster();
  } catch {
    // Fail-open: roster unavailable → skip department routing.
  }

  // Self-trigger filtering: if the actor IS the only candidate target,
  // suppress the event to prevent feedback loops. This check must happen
  // BEFORE the functionary, because the functionary might redirect to a
  // department target (which is NOT the actor and should be dispatched).
  const actorId = event.actor?.id;
  const agentMap = buildAgentMap();
  const isActorOurAgent = actorId ? !!agentMap[actorId] : false;
  if (isActorOurAgent && mechanicalTarget && agentMap[actorId!] === mechanicalTarget.name) {
    // The mechanical target IS the actor — suppress.
    // But if the functionary would produce a DIFFERENT target (department match),
    // we should still dispatch to that target.
    const functionaryResult = resolveRoute(identifier, event.type, roster, null);
    if (functionaryResult.reason === "department-prefix" || functionaryResult.reason === "department-override") {
      // Department routing overrides the self-trigger — dispatch to the department target.
      return buildRouteResult(event, functionaryResult.target, identifier, functionaryResult.reason);
    }
    log.info(`Skipping self-triggered event from ${actorId}`);
    return null;
  }
  // When actor is an agent and there's no mechanical target, check the
  // department roster before suppressing. If the functionary would route to
  // a department target (which is NOT the actor), dispatch to that target.
  // Only suppress if the functionary also can't find a department match
  // (in which case it would escalate to the steward — and if the steward
  // IS the actor, suppress to prevent loop).
  if (isActorOurAgent && !mechanicalTarget) {
    const functionaryResult = resolveRoute(identifier, event.type, roster, null);
    const actorName = agentMap[actorId!];
    if (
      (functionaryResult.reason === "department-prefix" ||
        functionaryResult.reason === "department-override") &&
      functionaryResult.target !== actorName
    ) {
      // Department routing found a target that isn't the actor — dispatch.
      return buildRouteResult(event, functionaryResult.target, identifier, functionaryResult.reason);
    }
    // No department match that differs from the actor, or steward escalation
    // that would loop — suppress.
    log.info(`Skipping self-triggered event from ${actorId} (no mechanical target, no department match to other target)`);
    return null;
  }

  // Run the routing functionary.
  const functionaryResult = resolveRoute(identifier, event.type, roster, mechanicalTarget);

  return buildRouteResult(event, functionaryResult.target, identifier, functionaryResult.reason);
}

const VALID_ROUTING_REASONS = new Set<string>([
  "delegate",
  "assignee",
  "mention",
  "body-mention",
  "department-prefix",
  "department-override",
  "steward-escalation",
] as const);

function toRoutingReason(reason: string): RouteResult["routingReason"] {
  return VALID_ROUTING_REASONS.has(reason) ? reason as RouteResult["routingReason"] : undefined;
}

/**
 * Build a RouteResult from the functionary's routing decision.
 */
function buildRouteResult(
  event: LinearEvent,
  targetName: string,
  identifier: string | null,
  reason: string,
): RouteResult {
  const agent = getAgent(targetName);
  const openclawName = getOpenclawAgentName(targetName);
  const rawKey = identifier
    ? `linear-${identifier}`
    : `linear-${event.type}-${Date.now()}`;
  const sessionKey = identifier
    ? normalizeSessionKey(rawKey)
    : rawKey;

  if (!identifier) {
    const dataStr = JSON.stringify(event.data ?? {}).slice(0, 2048);
    log.warn(
      `session-key fallback: type=${event.type} action=${event.action} key=${sessionKey}` +
      ` data=${dataStr}`
    );
  } else {
    log.info(`routeEvent: type=${event.type} identifier=${identifier} reason=${reason} target=${targetName}`);
  }

  return {
    agentId: openclawName,
    sessionKey,
    priority: 0,
    event,
    routingReason: toRoutingReason(reason),
  };
}
