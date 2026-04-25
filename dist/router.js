"use strict";
/**
 * Event routing: determines which OpenClaw agent should handle a Linear event.
 *
 * Supports both traditional assignee-based routing and OAuth app actor
 * delegation (where the agent appears in the `delegate` field, not `assignee`).
 *
 * Also filters self-triggered events to prevent feedback loops,
 * while allowing agent-to-agent delegation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractAgentTarget = extractAgentTarget;
exports.routeEvent = routeEvent;
const agents_1 = require("./agents");
const logger_1 = require("./logger");
const log = (0, logger_1.componentLogger)((0, logger_1.createLogger)(), "router");
/**
 * Extract the target agent name from a webhook payload.
 * Checks delegate first (OAuth app actors), then assignee, then mentioned users.
 * Returns null if no agent target found or if it's a self-triggered event.
 */
function extractAgentTarget(event) {
    const agentMap = (0, agents_1.buildAgentMap)();
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
    const data = "data" in event ? event.data : null;
    // 1. Check delegate first — OAuth app actors are set as delegates, not assignees
    let target = null;
    let reason = "delegate";
    const delegateId = extractId(data?.delegate);
    if (delegateId && agentMap[delegateId]) {
        target = agentMap[delegateId];
        reason = "delegate";
        log.info(`Routed via delegate: ${delegateId} → ${target}`);
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
    const mentionedUsers = data?.mentionedUsers;
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
    // 5. Self-trigger filtering: skip if the actor IS the target agent
    //    But allow agent-to-agent delegation
    if (isActorOurAgent) {
        if (!target || agentMap[actorId] === target) {
            log.info(`Skipping self-triggered event from ${actorId}`);
            return null;
        }
        log.info(`Agent-to-agent delegation: ${agentMap[actorId]} → ${target}`);
    }
    return target ? { name: target, reason } : null;
}
/** Extract an ID from a field that may be a string, an object with .id, or null */
function extractId(field) {
    if (!field)
        return null;
    if (typeof field === "string")
        return field;
    if (typeof field === "object" && field !== null && "id" in field) {
        return field.id ?? null;
    }
    return null;
}
/** Build a lowercase-name → agentName map for body mention detection */
function buildNameMap() {
    const agents = (0, agents_1.getAgents)();
    const map = {};
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
function detectMentionInBody(body, nameMap) {
    // Match @word or @[Multi Word] patterns
    const mentionPattern = /@\[([^\]]+)\]|@(\w+)/g;
    let match;
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
 * Returns a RouteResult if routing succeeded, null if no agent found.
 */
function routeEvent(event) {
    const result = extractAgentTarget(event);
    if (!result)
        return null;
    const agent = (0, agents_1.getAgent)(result.name);
    const openclawName = (0, agents_1.getOpenclawAgentName)(result.name);
    const d = event.data;
    const sessionData = d?.agentSession;
    const identifier = d?.identifier ??
        d?.issueIdentifier ??
        sessionData?.issue?.identifier;
    const sessionKey = identifier ? `linear-${identifier}` : `linear-${event.type}-${Date.now()}`;
    log.info(`routeEvent: type=${event.type} identifier=${identifier ?? 'none'} reason=${result.reason}`);
    return {
        agentId: openclawName,
        sessionKey,
        priority: 0,
        event,
        routingReason: result.reason,
    };
}
//# sourceMappingURL=router.js.map