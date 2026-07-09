/**
 * Event routing: determines which OpenClaw agent should handle a Linear event.
 *
 * Supports both traditional assignee-based routing and OAuth app actor
 * delegation (where the agent appears in the `delegate` field, not `assignee`).
 *
 * Also filters self-triggered events to prevent feedback loops,
 * while allowing agent-to-agent delegation.
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

  // True when this Issue update event represents a genuine workflow state
  // transition — i.e. the Linear native state (stateId) changed. Used by both
  // the AI-1573 no-change-delegate guard and the self-trigger filter below to
  // allow re-dispatch when an agent advances its own ticket to a new step.
  const isStateTransition = ((): boolean => {
    if (event.type !== "Issue" || event.action !== "update") return false;
    const upd = (event as { updatedFrom?: Record<string, unknown> }).updatedFrom;
    return upd !== undefined && "stateId" in upd;
  })();

  // For AgentSessionEvent, route to the agent that owns the session — the
  // session's appUser/creator is the OAuth app user, i.e. the same Linear user
  // id space as delegates. Previously this returned agents[0] (audit #16:
  // widget events woke an arbitrary agent). Unresolvable → wake nobody.
  if (event.type === "AgentSessionEvent") {
    const d = ("data" in event ? event.data : undefined) as Record<string, unknown> | undefined;
    const session = d?.agentSession as Record<string, unknown> | undefined;
    const candidates = [
      extractId(session?.appUser),
      typeof session?.appUserId === "string" ? session.appUserId : null,
      extractId(session?.creator),
    ];
    for (const id of candidates) {
      if (id && agentMap[id]) {
        log.info(`AgentSessionEvent routed via session owner: ${id} → ${agentMap[id]}`);
        return { name: agentMap[id], reason: "delegate" };
      }
    }
    log.info("AgentSessionEvent: no owning agent resolvable from session payload — not waking anyone");
    return null;
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
    //
    // Exception: state transitions (stateId in updatedFrom) always dispatch even
    // when the delegate is unchanged — the agent is starting a new step, not
    // looping on the previous one.
    if (event.type === "Issue" && event.action === "update") {
      const upd = (event as { updatedFrom?: Record<string, unknown> }).updatedFrom;
      if (upd !== undefined && !("delegateId" in upd) && !("delegate" in upd)) {
        if (isStateTransition) {
          log.info(`No-change delegate but stateId changed — dispatching for same-agent workflow transition`);
        } else {
          log.info(`No-change delegate write — skipping dispatch (updatedFrom present, no delegate key, no state change)`);
          target = null;
        }
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

  // 5. Self-trigger filtering is handled downstream by routeEvent() after
  //    consulting the department-roster functionary (AI-1479). Returning the
  //    mechanical target even for self-triggered events lets department-prefix
  //    routing override self-trigger suppression when the resolved target
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
  return detectAllMentionsInBody(body, nameMap)[0] ?? null;
}

/** Detect ALL @mentions in a comment body, in order, deduped (audit #3). */
function detectAllMentionsInBody(body: string, nameMap: Record<string, string>): string[] {
  // Match @word or @[Multi Word] patterns
  const mentionPattern = /@\[([^\]]+)\]|@(\w+)/g;
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(body)) !== null) {
    const name = (match[1] || match[2]).toLowerCase();
    if (nameMap[name] && !found.includes(name)) {
      found.push(name);
    }
  }
  return found;
}

/**
 * All registered agents mentioned in the event beyond the given primary
 * registry name — payload `mentionedUsers` plus comment-body @mentions —
 * excluding the acting agent (self-trigger) and the primary itself.
 * Returns registry names. (Audit #3: only the first mention used to wake.)
 */
export function extractAdditionalMentionTargets(event: LinearEvent, primaryName: string | null): string[] {
  if (event.type === "AgentSessionEvent") return [];
  const agentMap = buildAgentMap();
  const actorId = event.actor?.id;
  const actorAgent = actorId ? agentMap[actorId] : undefined;
  const data = ("data" in event ? event.data : undefined) as Record<string, unknown> | undefined;
  if (!data) return [];

  const targets = new Set<string>();
  const mentionedUsers = data.mentionedUsers as Array<{ id?: string }> | null | undefined;
  if (mentionedUsers) {
    for (const user of mentionedUsers) {
      if (user.id && agentMap[user.id]) targets.add(agentMap[user.id]);
    }
  }
  if (event.type === "Comment" && typeof data.body === "string") {
    const nameMap = buildNameMap();
    for (const key of detectAllMentionsInBody(data.body, nameMap)) {
      targets.add(nameMap[key]);
    }
  }
  if (primaryName) targets.delete(primaryName);
  if (actorAgent) targets.delete(actorAgent);
  return [...targets];
}

/**
 * Routing-candidate ids named by the event (delegate/assignee/mentioned users)
 * that do NOT resolve to a registered agent. Drives the webhook no-route alert
 * (audit #1): an unresolved id is the silent "assigned it and nothing
 * happened" case, whereas an event that names nobody (IssueLabel/Project/...
 * entity writes, unassigned issues, plain comments) no-routes by construction
 * and is not a routing failure.
 */
export function unresolvedRoutingCandidates(event: LinearEvent): string[] {
  if (event.type === "AgentSessionEvent") return [];
  const data = ("data" in event ? event.data : undefined) as Record<string, unknown> | undefined;
  if (!data) return [];
  const agentMap = buildAgentMap();
  const candidates = new Set<string>();
  for (const field of [data.delegate, data.delegateId, data.assignee, data.assigneeId]) {
    const id = extractId(field);
    if (id) candidates.add(id);
  }
  const mentionedUsers = data.mentionedUsers as Array<{ id?: string }> | null | undefined;
  if (Array.isArray(mentionedUsers)) {
    for (const user of mentionedUsers) {
      if (user?.id) candidates.add(user.id);
    }
  }
  return [...candidates].filter((id) => !agentMap[id]);
}

const VALID_ROUTING_REASONS = new Set<string>([
  "delegate",
  "assignee",
  "mention",
  "body-mention",
  "department-prefix",
  "department-override",
  "steward-escalation",
]);

function toRoutingReason(reason: string): RouteResult["routingReason"] {
  return VALID_ROUTING_REASONS.has(reason) ? (reason as RouteResult["routingReason"]) : undefined;
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
  const openclawName = getOpenclawAgentName(targetName);
  const rawKey = identifier
    ? `linear-${identifier}`
    : `linear-${event.type}-${Date.now()}`;
  const sessionKey = identifier
    ? normalizeSessionKey(rawKey)
    : rawKey;

  if (!identifier) {
    // Phase 1 diagnostic: log event shapes that slip through identifier extraction
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

/**
 * Route a Linear event to an OpenClaw agent.
 *
 * AI-1479 (Phase 6.5, §16.5): integrates the department-roster functionary.
 * - When a roster is loaded and the issue has a team prefix matching a
 *   department, that department's defaultTarget is used directly.
 * - Otherwise the mechanical resolution (delegate/assignee/mention) is used.
 * - When neither matches, the steward (Astrid) receives the event as an
 *   escalation — the functionary never returns null.
 *
 * Self-trigger suppression (moved here from extractAgentTarget): an agent's own
 * write is suppressed to prevent feedback loops, EXCEPT (a) genuine workflow
 * state transitions, which always dispatch so the agent is woken for its new
 * step, and (b) when the functionary redirects to a different department target.
 *
 * Returns a RouteResult if routing succeeded, null only when the event is a
 * self-trigger that should be suppressed.
 */
export function routeEvent(event: LinearEvent): RouteResult | null {
  const identifier = extractIssueIdentifier(event);
  const mechanicalTarget = extractAgentTarget(event);

  // Load department roster (cached in-process; null when unavailable).
  // loadRoster is synchronous and fail-open (returns null on any error).
  const roster: DepartmentRoster | null = loadRoster();

  const actorId = event.actor?.id;
  const agentMap = buildAgentMap();
  const isActorOurAgent = actorId ? !!agentMap[actorId] : false;

  // Genuine workflow state transitions always dispatch, even self-triggered —
  // the agent advanced its own ticket to a new step and must be woken. Mirrors
  // the pre-functionary self-trigger exception that lived in extractAgentTarget.
  const isStateTransition =
    event.type === "Issue" &&
    event.action === "update" &&
    (() => {
      const upd = (event as { updatedFrom?: Record<string, unknown> }).updatedFrom;
      return upd !== undefined && "stateId" in upd;
    })();

  if (
    isActorOurAgent &&
    !isStateTransition &&
    mechanicalTarget &&
    agentMap[actorId!] === mechanicalTarget.name
  ) {
    // The mechanical target IS the actor — suppress, unless the functionary
    // redirects to a department target (which is NOT the actor).
    const functionaryResult = resolveRoute(identifier, event.type, roster, null);
    if (
      functionaryResult.reason === "department-prefix" ||
      functionaryResult.reason === "department-override"
    ) {
      return buildRouteResult(event, functionaryResult.target, identifier, functionaryResult.reason);
    }
    log.info(`Skipping self-triggered event from ${actorId}`);
    return null;
  }

  // Actor is an agent with no mechanical target: consult the roster before
  // suppressing. Dispatch only if the functionary routes to a department target
  // that isn't the actor; otherwise suppress (a steward escalation to self loops).
  if (isActorOurAgent && !mechanicalTarget) {
    const functionaryResult = resolveRoute(identifier, event.type, roster, null);
    const actorName = agentMap[actorId!];
    if (
      (functionaryResult.reason === "department-prefix" ||
        functionaryResult.reason === "department-override") &&
      functionaryResult.target !== actorName
    ) {
      return buildRouteResult(event, functionaryResult.target, identifier, functionaryResult.reason);
    }
    log.info(`Skipping self-triggered event from ${actorId} (no mechanical target, no department match to other target)`);
    return null;
  }

  // Run the routing functionary.
  const functionaryResult = resolveRoute(identifier, event.type, roster, mechanicalTarget);

  // Steward escalation (AC2) is an ACTIVE-functionary behavior: it only fires
  // when a roster is loaded. Fail open otherwise — an event that resolves to no
  // agent simply no-routes (pre-AI-1479 agent-map behavior), matching the
  // fail-open contract documented in department-roster.ts. Additionally,
  // AgentSessionEvent widget events with no resolvable owner never escalate —
  // they route to their owner or nobody (audit #16). Events that name nobody
  // (entity writes, unassigned issues, plain comments) no-route by construction
  // and are not routing failures.
  if (
    functionaryResult.reason === "steward-escalation" &&
    (!roster || event.type === "AgentSessionEvent")
  ) {
    return null;
  }

  return buildRouteResult(event, functionaryResult.target, identifier, functionaryResult.reason);
}

/**
 * Route a Linear event to ALL its targets: the primary route (through the
 * department-roster functionary, including self-trigger suppression and steward
 * escalation) plus one mention route per additional registered agent mentioned
 * in the event (audit #3 — previously only the first mentioned agent was woken).
 */
export function routeEventAll(event: LinearEvent): RouteResult[] {
  const primary = routeEvent(event);
  if (!primary) return [];
  const routes = [primary];
  // Exclude the mechanical primary and the acting agent from the fan-out.
  const mechanicalPrimary = extractAgentTarget(event);
  const identifier = extractIssueIdentifier(event);
  for (const name of extractAdditionalMentionTargets(event, mechanicalPrimary?.name ?? null)) {
    log.info(`Fan-out mention route: ${name} (primary: ${mechanicalPrimary?.name ?? "none"})`);
    routes.push(buildRouteResult(event, name, identifier, "mention"));
  }
  return routes;
}
