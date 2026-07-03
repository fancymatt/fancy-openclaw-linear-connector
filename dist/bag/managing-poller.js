/**
 * ManagingPoller — periodic stewardship-wake driver for Managing-state tickets.
 *
 * Every cycle, for each configured agent, queries Linear for issues delegated
 * to that agent in the `Managing` workflow state. For each such issue, decides
 * whether the agent is "due" for a stewardship wake based on:
 *
 *   - `lastDispatchedAt` (persisted in ManagingStateStore)
 *   - `Managing-interval: <duration>` parsed from the issue description body
 *     (defaults to 30m when absent or unparseable)
 *
 * All due tickets for a given agent are bundled into a single wake message
 * (so 4 due tickets become 1 stewardship prompt, not 4 separate ones).
 *
 * Configuration (env vars, all optional):
 *   MANAGING_POLLER_CYCLE_MS     — how often the poller runs (default: 60_000)
 *   MANAGING_POLLER_DEFAULT_MS   — default per-ticket interval (default: 1_800_000 = 30m)
 *
 * The first-wake-after-entering-Managing is always immediate (well: on the
 * next poller tick) because `lastDispatchedAt` is null until the first dispatch.
 */
import { createLogger, componentLogger } from "../logger.js";
import { getAccessToken, getAgents, isAgentLocal } from "../agents.js";
import { sendManagingWakeSignal } from "./managing-wake.js";
import { surfaceStalledChildren } from "../barrier.js";
import { notify } from "../alerts/alert-bus.js";
const log = componentLogger(createLogger(), "managing-poller");
const DEFAULT_CYCLE_MS = 60 * 1000;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
function parseEnvInt(name, defaultVal) {
    const raw = process.env[name];
    const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
    return Number.isNaN(parsed) || parsed <= 0 ? defaultVal : parsed;
}
/**
 * Parse a `Managing-interval: <duration>` marker from an issue description.
 * Returns the interval in ms, or null if absent / unparseable.
 *
 * Recognized formats:
 *   Managing-interval: 30m
 *   Managing-interval: 2h
 *   Managing-interval: 1d
 *   Managing-interval: 90 (treated as minutes for bare numbers)
 *
 * Case-insensitive on the key and unit; only the FIRST match wins (allows
 * the agent to update by adding a new line above the old one, or by replacing).
 */
const INTERVAL_MARKER_RE = /Managing-interval:\s*(\d+)\s*([smhd]?)\b/i;
export function parseManagingInterval(body) {
    if (!body)
        return null;
    const m = INTERVAL_MARKER_RE.exec(body);
    if (!m)
        return null;
    const n = parseInt(m[1], 10);
    if (Number.isNaN(n) || n <= 0)
        return null;
    const unit = (m[2] || "m").toLowerCase();
    switch (unit) {
        case "s": return n * 1000;
        case "m": return n * 60 * 1000;
        case "h": return n * 60 * 60 * 1000;
        case "d": return n * 24 * 60 * 60 * 1000;
        default: return null;
    }
}
/**
 * Decide whether a ticket is due for a stewardship wake.
 *
 * - If never dispatched: due immediately.
 * - Otherwise: due when (now - lastDispatchedAt) >= intervalMs.
 */
export function isDue(now, lastDispatchedAt, intervalMs) {
    if (lastDispatchedAt === null)
        return true;
    return now - lastDispatchedAt >= intervalMs;
}
/**
 * Fetch all Managing-state tickets delegated to an agent from Linear.
 * Uses the agent's own OAuth token. Returns identifier + title + body.
 */
async function fetchManagingTicketsForAgent(agent) {
    const token = getAccessToken(agent.name);
    if (!token) {
        log.warn(`No access token for agent ${agent.name}; skipping`);
        return [];
    }
    const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
    const query = `
    query ManagingForAgent($delegateId: ID!) {
      issues(first: 100, filter: {
        delegate: { id: { eq: $delegateId } },
        state: { name: { eq: "Managing" } }
      }) {
        nodes {
          identifier
          title
          description
        }
      }
    }
  `;
    const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: authHeader },
        body: JSON.stringify({ query, variables: { delegateId: agent.linearUserId } }),
    });
    if (!res.ok) {
        throw new Error(`Linear API returned ${res.status} for agent ${agent.name}`);
    }
    const body = (await res.json());
    if (body.errors) {
        throw new Error(`Linear API errors for agent ${agent.name}: ${JSON.stringify(body.errors)}`);
    }
    return body.data?.issues?.nodes ?? [];
}
export class ManagingPoller {
    constructor(deps, config) {
        this.config = {
            cycleMs: config?.cycleMs ?? parseEnvInt("MANAGING_POLLER_CYCLE_MS", DEFAULT_CYCLE_MS),
            defaultIntervalMs: config?.defaultIntervalMs ?? parseEnvInt("MANAGING_POLLER_DEFAULT_MS", DEFAULT_INTERVAL_MS),
        };
        this.deps = {
            store: deps.store,
            operationalEventStore: deps.operationalEventStore,
            resolveDeliveryConfig: deps.resolveDeliveryConfig,
            listAgents: deps.listAgents ?? (() => getAgents().filter(isAgentLocal)),
            fetchManagingTickets: deps.fetchManagingTickets ?? fetchManagingTicketsForAgent,
            sendWake: deps.sendWake ?? sendManagingWakeSignal,
            now: deps.now ?? (() => Date.now()),
        };
    }
    start() {
        if (this.timer)
            return;
        log.info(`Managing poller started — cycle=${this.config.cycleMs}ms defaultInterval=${this.config.defaultIntervalMs}ms`);
        this.timer = setInterval(() => {
            this.runCycle().catch((err) => {
                log.error(`Managing poller cycle error: ${err instanceof Error ? err.message : String(err)}`);
            });
        }, this.config.cycleMs);
        this.timer.unref();
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    /**
     * Run one poll cycle. Returns a summary of what happened — useful for tests
     * and operator visibility.
     */
    async runCycle() {
        const { store, operationalEventStore, resolveDeliveryConfig, listAgents, fetchManagingTickets, sendWake, now } = this.deps;
        const agents = listAgents();
        const result = {
            agentsChecked: 0,
            ticketsSeen: 0,
            ticketsDispatched: 0,
            agentsWaked: 0,
            errors: 0,
        };
        for (const agent of agents) {
            result.agentsChecked++;
            let issues = [];
            try {
                issues = await fetchManagingTickets(agent);
            }
            catch (err) {
                result.errors++;
                log.error(`Managing fetch failed for ${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
                continue;
            }
            result.ticketsSeen += issues.length;
            // Prune store entries that no longer belong (ticket left Managing or was reassigned).
            store.pruneAgent(agent.name, issues.map((i) => i.identifier));
            const dueTickets = [];
            const tsNow = now();
            for (const issue of issues) {
                const intervalMs = parseManagingInterval(issue.description) ?? this.config.defaultIntervalMs;
                const lastDispatchedAt = store.getLastDispatched(agent.name, issue.identifier);
                if (!isDue(tsNow, lastDispatchedAt, intervalMs)) {
                    store.ensure(agent.name, issue.identifier);
                    continue;
                }
                dueTickets.push({
                    identifier: issue.identifier,
                    title: issue.title,
                    lastDispatchedAt,
                });
            }
            if (dueTickets.length === 0)
                continue;
            const openclawAgent = agent.openclawAgent ?? agent.name;
            // §5.5 stall detection: surface stalled children via tripwire comments
            // before sending the stewardship wake. This wires the stall detection
            // to a real production trigger (the managing-wake cycle).
            const stallToken = getAccessToken(agent.name);
            if (stallToken) {
                for (const ticket of dueTickets) {
                    try {
                        const stallResult = await surfaceStalledChildren(ticket.identifier, /^Bearer\s+/i.test(stallToken) ? stallToken : `Bearer ${stallToken}`);
                        if (stallResult.surfaced > 0) {
                            log.info(`§5.5 tripwire: ${stallResult.surfaced} stalled child(ren) surfaced on ${ticket.identifier}`);
                        }
                    }
                    catch (err) {
                        log.warn(`Stall detection failed for ${ticket.identifier}: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
            try {
                const agentDeliveryConfig = resolveDeliveryConfig(openclawAgent);
                await sendWake(openclawAgent, dueTickets, agentDeliveryConfig);
                result.ticketsDispatched += dueTickets.length;
                result.agentsWaked++;
                const stamp = now();
                for (const t of dueTickets) {
                    store.recordDispatch(agent.name, t.identifier, stamp);
                }
                operationalEventStore.append({
                    outcome: "delivered",
                    type: "managing-wake",
                    agent: openclawAgent,
                    key: dueTickets[0].identifier,
                    sessionKey: `linear-${dueTickets[0].identifier}`,
                    deliveryMode: "managing-poll",
                    attemptCount: dueTickets.length,
                    detail: { tickets: dueTickets.map((t) => t.identifier) },
                });
            }
            catch (err) {
                result.errors++;
                log.error(`Managing wake delivery failed for ${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
                notify({
                    severity: "warning",
                    source: "dispatch",
                    title: `managing-wake delivery failed for ${agent.name}`,
                    detail: err instanceof Error ? err.message : String(err),
                    agent: openclawAgent,
                    ticket: dueTickets[0].identifier,
                });
                operationalEventStore.append({
                    outcome: "delivery-failed",
                    type: "managing-wake",
                    agent: openclawAgent,
                    key: dueTickets[0].identifier,
                    sessionKey: `linear-${dueTickets[0].identifier}`,
                    deliveryMode: "managing-poll",
                    attemptCount: dueTickets.length,
                    errorSummary: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return result;
    }
}
//# sourceMappingURL=managing-poller.js.map