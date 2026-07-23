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
import { getCachedRoster, resolveRoute } from "./department-roster.js";
import type { LinearEvent } from "./webhook/schema.js";
import type { RouteResult } from "./types.js";
import { normalizeSessionKey } from "./session-key.js";
import { createLogger, componentLogger } from "./logger.js";

const log = componentLogger(createLogger(), "router");

/**
 * Discriminated union returned by extractAgentTarget.
 *
 * - `{ name, reason }` — a routable agent was found
 * - `{ suppressed: true }` — the AI-1573 guard or self-trigger filter
 *   intentionally suppressed this event (should NOT fall through to
 *   department-prefix / steward-escalation)
 * - `null` — genuinely no route found (may fall through to department-prefix)
 */
export type AgentTargetResult =
  | { name: string; reason: "delegate" | "assignee" | "mention" | "body-mention" }
  | { suppressed: true }
  | null;

/**
 * Extract the target agent name from a webhook payload.
 * Checks delegate first (OAuth app actors), then assignee, then mentioned users.
 * Returns { suppressed: true } when the AI-1573 guard or self-trigger filter
 * intentionally skips the event; null when no route was found at all.
 */
export function extractAgentTarget(event: LinearEvent): AgentTargetResult {
  const agentMap = buildAgentMap();
  if (Object.keys(agentMap).length === 0) {
    log.warn("No agents configured — skipping event");
    return null;
  }

  // Track whether the actor is one of our agents (for self-trigger filtering)
  const actorId = event.actor?.id;
  const isActorOurAgent = actorId ? !!agentMap[actorId] : false;

  // True when this Issue update event represents a genuine workflow state
  // transition — i.e. the Linear native state (stateId) changed, OR the
  // state:* labels changed (same-column workflow advance). Used by both the
  // AI-1573 no-change-delegate guard and the self-trigger filter below to
  // allow re-dispatch when an agent advances its own ticket to a new step.
  const isStateTransition = ((): boolean => {
    if (event.type !== "Issue" || event.action !== "update") return false;
    const upd = (event as { updatedFrom?: Record<string, unknown> }).updatedFrom;
    if (upd === undefined) return false;
    // Native stateId change — always a state transition (cross-column advance).
    if ("stateId" in upd) return true;
    // Same-column workflow advance: state:* labels changed by one of our
    // agents (proxy). The workflow engine advances the state:* label without
    // changing the native Linear column. Without this, the dispatch is
    // suppressed and the next workflow owner is never woken (GEN-198 class).
    // Label edits by human users (isActorOurAgent=false) are NOT workflow
    // advances and must remain suppressed.
    if ("labelIds" in upd && isActorOurAgent) return true;
    return false;
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
    return { suppressed: true };
  }

  const data = "data" in event ? (event.data as Record<string, unknown> | undefined) : null;

  if (event.type === "Issue" && event.action === "update") {
    const upd = (event as { updatedFrom?: Record<string, unknown> }).updatedFrom;
    if (
      upd !== undefined &&
      ("delegateId" in upd || "delegate" in upd) &&
      !extractId(data?.delegate) &&
      !extractId(data?.delegateId)
    ) {
      log.info("Delegate clear event — skipping dispatch instead of falling through to assignee");
      return { suppressed: true };
    }
  }

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
          return { suppressed: true };
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
    // AI-2044: connector-authored notices (routing-guard blocks, escalations)
    // name agents in their body. They are informational — never treat them as
    // routable mentions, or a guard comment can itself wake the agents it names.
    if (data.body.startsWith("[Connector]")) {
      log.info(`Skipping body-mention detection for connector-authored comment`);
    } else {
      const nameMap = buildNameMap();
      const bodyMention = detectMentionInBody(data.body, nameMap);
      if (bodyMention) {
        target = nameMap[bodyMention];
        reason = "body-mention";
        log.info(`Routed via body mention: @${bodyMention} → ${target}`);
      }
    }
  }

  // 5. Self-trigger filtering: skip if the actor IS the target agent.
  //    Prevents feedback loops where an agent's own write re-dispatches itself.
  //    Exception: state transitions always dispatch — the agent advanced to a new
  //    step and needs to be notified even if it is the same agent in the new step.
  if (isActorOurAgent && !isStateTransition) {
    if (!target || agentMap[actorId!] === target) {
      log.info(`Skipping self-triggered event from ${actorId}`);
      return { suppressed: true };
    }
    log.info(`Agent-to-agent delegation: ${agentMap[actorId!]} → ${target}`);
  }

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

function buildRouteResult(
  target: { name: string; reason: "delegate" | "assignee" | "mention" | "body-mention" | "department-prefix" | "steward-escalation" },
  event: LinearEvent,
): RouteResult {
  const openclawName = getOpenclawAgentName(target.name);
  const identifier = extractIssueIdentifier(event);
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
    log.info(`routeEvent: type=${event.type} identifier=${identifier} reason=${target.reason}`);
  }

  return {
    agentId: openclawName,
    sessionKey,
    priority: 0,
    event,
    routingReason: target.reason,
  };
}

/**
 * Route a Linear event to an OpenClaw agent.
 * Returns a RouteResult if routing succeeded, null if no agent found or suppressed.
 */
export function routeEvent(event: LinearEvent): RouteResult | null {
  const result = extractAgentTarget(event);
  if (!result || "suppressed" in result) return null;
  return buildRouteResult(result, event);
}

/**
 * Route a Linear event to ALL its targets: the primary route (delegate →
 * assignee → first mention, exactly as routeEvent) plus one mention route per
 * additional registered agent mentioned in the event (audit #3 — previously
 * only the first mentioned agent was ever woken).
 */
export function routeEventAll(event: LinearEvent): RouteResult[] {
  const primary = extractAgentTarget(event);

  // AI-2170: if the guard intentionally suppressed this event, return empty
  // immediately — do NOT fall through to department-prefix/steward-escalation.
  if (primary && "suppressed" in primary) {
    return [];
  }

  if (primary) {
    const routes = [buildRouteResult(primary, event)];
    for (const name of extractAdditionalMentionTargets(event, primary.name)) {
      log.info(`Fan-out mention route: ${name} (primary: ${primary.name})`);
      routes.push(buildRouteResult({ name, reason: "mention" }, event));
    }
    return routes;
  }

  // AI-1479 (Phase 6.5 / H-4): routing functionary — a *fallback* consulted only
  // when nothing was explicitly delegated/assigned/mentioned (mechanical-first
  // ordering). A clean department-prefix match routes to the department default
  // with no person in the loop.
  //
  // AI-2017: a prefix that matches no department is a *steward escalation* — the
  // match failed and now a person (the roster steward) takes over. This must
  // reach the live dispatch path, not be computed and discarded. Compose with —
  // do not revert — the existing no-route paths:
  //   • no roster loaded → no steward to escalate to (the `if (roster)` guard).
  //   • no issue identifier → nothing to escalate on; resolveRoute() still
  //     returns steward-escalation for a null identifier, so we gate on the
  //     identifier here rather than the decision reason (AI-1900 / no-route).
  //   • AgentSessionEvent with no resolvable owner → a UI-widget event, not a
  //     routable request; audit #16 (wake-nobody) forbids paging the steward for
  //     it even though it carries an identifier.
  const roster = getCachedRoster();
  if (roster) {
    const identifier = extractIssueIdentifier(event);
    const decision = resolveRoute(identifier, event.type, roster, null);
    if (decision.reason === "department-prefix") {
      log.info(
        `Department route: ${event.type} identifier=${identifier} → ${decision.target} (prefix=${decision.matchedPrefix})`,
      );
      return [buildRouteResult({ name: decision.target, reason: "department-prefix" }, event)];
    }
    if (
      decision.reason === "steward-escalation" &&
      identifier &&
      event.type !== "AgentSessionEvent"
    ) {
      log.info(
        `Steward escalation: ${event.type} identifier=${identifier} → ${decision.target} (prefix matched no department)`,
      );
      return [buildRouteResult({ name: decision.target, reason: "steward-escalation" }, event)];
    }
  }
  return [];
}
