"use strict";
/**
 * Routing engine for Linear → OpenClaw event dispatch.
 *
 * Pure function: takes a normalized `LinearEvent` and a `RoutingConfig`,
 * returns a `RouteResult` identifying the target agent, or `null` if no
 * mapping exists.
 *
 * ## Routing priority
 * 1. **Assignee match** — if the event carries an assigneeId that maps to
 *    an agent in `config.agents`, route there (priority 10).
 * 2. **Team fallback** — if the event carries a teamKey that maps to an
 *    agent in `config.teamDefaults`, route there (priority 20).
 * 3. **Unmapped** — return `null`. The caller decides what to do.
 *
 * ## Extracting routing signals
 * - `Issue` events: `data.assigneeId` and `data.teamKey`
 * - `Comment` events: no assignee/team on the comment itself, so comments
 *   always fall through to team-based or unmapped unless enriched upstream.
 * - Unknown event types: always unmapped.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeEvent = routeEvent;
/** Priority constants — lower = higher priority. */
const PRIORITY_ASSIGNEE = 10;
const PRIORITY_TEAM = 20;
/**
 * Routes a normalized Linear event to an OpenClaw agent.
 *
 * @param event - A normalized `LinearEvent` from the webhook layer.
 * @param config - Validated routing configuration.
 * @returns A `RouteResult` if a mapping is found, or `null` if unmapped.
 */
function routeEvent(event, config) {
    // 1. Try assignee-based routing (Issue events only)
    if (isIssueEvent(event)) {
        const assigneeId = event.data.assigneeId;
        if (assigneeId) {
            const match = config.agents.find((a) => a.linearUserId === assigneeId);
            if (match) {
                return {
                    agentId: match.agentId,
                    sessionKey: match.sessionKey,
                    priority: PRIORITY_ASSIGNEE,
                    event,
                };
            }
        }
    }
    // 2. Try team-based fallback (Issue events have teamKey directly)
    const teamKey = extractTeamKey(event);
    if (teamKey) {
        const match = config.teamDefaults.find((t) => t.teamKey === teamKey);
        if (match) {
            return {
                agentId: match.agentId,
                sessionKey: match.sessionKey,
                priority: PRIORITY_TEAM,
                event,
            };
        }
    }
    // 3. Unmapped
    return null;
}
/**
 * Extracts the team key from an event, if available.
 */
function isIssueEvent(event) {
    return event.type === "Issue" && (event.action === "create" || event.action === "update");
}
function extractTeamKey(event) {
    if (isIssueEvent(event)) {
        return event.data.teamKey || undefined;
    }
    // Comments and unknown events don't carry a team key directly
    return undefined;
}
//# sourceMappingURL=router.js.map