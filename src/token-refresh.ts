/**
 * Periodic OAuth token refresh for all configured agents.
 * Access tokens expire after ~24h; this refreshes every 20h.
 * Modeled after the ILL webhook's token-refresh.ts.
 */

import { getAgents, updateTokens } from "./agents";
import { createLogger, componentLogger } from "./logger";

const log = componentLogger(createLogger(), "token-refresh");
const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

async function refreshAgent(agent: {
  name: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<void> {
  log.info(`Refreshing token for ${agent.name}...`);

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
      return;
    }

    const data = (await res.json()) as TokenResponse;
    updateTokens(agent.name, data.access_token, data.refresh_token ?? agent.refreshToken);
    log.info(`Token refresh OK for ${agent.name}: ${data.access_token.slice(0, 20)}...`);
  } catch (err) {
    log.error(
      `Token refresh exception for ${agent.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function refreshAll(): Promise<void> {
  const agents = getAgents();
  log.info(`Refreshing ${agents.length} agent(s)...`);
  await Promise.all(agents.map((a) => refreshAgent(a)));
}

export function startTokenRefresh(): void {
  // Initial refresh shortly after startup
  setTimeout(() => void refreshAll(), 5000);
  // Then every 20 hours
  setInterval(() => void refreshAll(), REFRESH_INTERVAL_MS);
  log.info(
    `Token refresh scheduled every ${REFRESH_INTERVAL_MS / 3600000}h for ${getAgents().length} agent(s)`,
  );
}
