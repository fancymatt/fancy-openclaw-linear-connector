/**
 * Periodic OAuth token refresh for all configured agents.
 * Access tokens expire after ~24h; this refreshes every 20h.
 * Modeled after the ILL webhook's token-refresh.ts.
 */
import { getAgents, updateTokens, isAgentLocal } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
import { notify } from "./alerts/alert-bus.js";
const log = componentLogger(createLogger(), "token-refresh");
const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours
async function refreshAgent(agent) {
    // Skip agents whose OpenClaw workspace doesn't exist on this host
    if (!isAgentLocal(agent)) {
        log.info(`Skipping token refresh for ${agent.name}: not a local agent`);
        return;
    }
    log.info(`Refreshing token for ${agent.name}...`);
    // Skip refresh if no refresh token available (newly added agent)
    if (!agent.refreshToken || agent.refreshToken === "") {
        log.warn(`Skipping token refresh for ${agent.name}: no refresh token available yet`);
        return;
    }
    try {
        const params = new URLSearchParams({
            client_id: agent.clientId,
            client_secret: agent.clientSecret,
            refresh_token: agent.refreshToken,
            grant_type: "refresh_token",
        });
        const res = await fetch("https://api.linear.app/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
        });
        if (!res.ok) {
            const text = await res.text();
            log.error(`Token refresh failed for ${agent.name}: ${res.status} ${text}`);
            // Audit finding #10: refresh failures decay silently — the agent's
            // proxied Linear calls start 401ing ~24h later with no visible cause.
            notify({
                severity: "warning",
                source: "token-refresh",
                title: `Linear OAuth refresh failed for ${agent.name} (HTTP ${res.status}) — proxy calls will fail when the current token expires (~24h)`,
                agent: agent.name,
            });
            return;
        }
        const data = (await res.json());
        updateTokens(agent.name, data.access_token, data.refresh_token ?? agent.refreshToken);
        log.info(`Token refresh OK for ${agent.name}: ${data.access_token.slice(0, 20)}...`);
    }
    catch (err) {
        log.error(`Token refresh exception for ${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
        notify({
            severity: "warning",
            source: "token-refresh",
            title: `Linear OAuth refresh threw for ${agent.name} — proxy calls will fail when the current token expires (~24h)`,
            detail: err instanceof Error ? err.message : String(err),
            agent: agent.name,
        });
    }
}
async function refreshAll() {
    const agents = getAgents();
    log.info(`Refreshing ${agents.length} agent(s)...`);
    await Promise.all(agents.map((a) => refreshAgent(a)));
}
export function startTokenRefresh() {
    // Initial refresh shortly after startup
    setTimeout(() => void refreshAll(), 5000);
    // Then every 20 hours
    setInterval(() => void refreshAll(), REFRESH_INTERVAL_MS);
    log.info(`Token refresh scheduled every ${REFRESH_INTERVAL_MS / 3600000}h for ${getAgents().length} agent(s)`);
}
//# sourceMappingURL=token-refresh.js.map