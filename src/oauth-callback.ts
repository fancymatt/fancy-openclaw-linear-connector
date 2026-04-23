import { Request, Response } from "express";
import { upsertAgent, AgentConfig } from "./agents";
import { createLogger, componentLogger } from "./logger";

const log = componentLogger(createLogger(), "oauth-callback");

/**
 * Handles the OAuth callback from Linear.
 *
 * Expected query params:
 *   code  — authorization code from Linear
 *   state — agent name (set when building the authorize URL)
 *
 * Requires the agent's OAuth app credentials to be registered in a
 * staging file (`oauth-apps.json`) so the connector can exchange the code.
 *
 * oauth-apps.json format:
 *   { "apps": { "<agent-name>": { "clientId": "...", "clientSecret": "..." } } }
 */
export async function handleOAuthCallback(req: Request, res: Response): Promise<void> {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    log.error(`OAuth error: ${error} — ${error_description}`);
    res.status(400).send(`OAuth error: ${error} — ${error_description}`);
    return;
  }

  if (!code || !state) {
    res.status(400).send("Missing `code` or `state` query parameter.");
    return;
  }

  const agentName = state;

  // Load app credentials from oauth-apps.json
  const apps = loadOAuthApps();
  const appConfig = apps[agentName];
  if (!appConfig) {
    res.status(400).send(
      `No OAuth app registered for agent "${agentName}". ` +
      `Add it to oauth-apps.json first. ` +
      `Registered agents: ${Object.keys(apps).join(", ") || "(none)"}`
    );
    return;
  }

  const redirectUri = process.env.OAUTH_REDIRECT_URI ?? `https://${req.hostname}/linear-webhook/callback`;

  // Step 1: Exchange code for tokens
  log.info(`Exchanging OAuth code for agent "${agentName}"...`);
  let tokenResponse: { access_token: string; refresh_token: string; scope?: string };
  try {
    const params = new URLSearchParams({
      client_id: appConfig.clientId,
      client_secret: appConfig.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    const tokenRes = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      log.error(`Token exchange failed (${tokenRes.status}): ${body}`);
      res.status(502).send(`Token exchange failed: ${body}`);
      return;
    }

    tokenResponse = await tokenRes.json() as typeof tokenResponse;
  } catch (err) {
    log.error(`Token exchange error: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).send("Token exchange failed.");
    return;
  }

  const { access_token, refresh_token, scope } = tokenResponse;

  // Verify scopes
  if (!scope?.includes("app:assignable") || !scope?.includes("app:mentionable")) {
    log.warn(`Incomplete scopes for ${agentName}: ${scope}. Did you use actor=app?`);
  }

  // Step 2: Get agent's Linear user ID
  log.info(`Fetching Linear user ID for agent "${agentName}"...`);
  let linearUserId: string;
  let linearUserName: string;
  try {
    const viewerRes = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "{ viewer { id name } }" }),
    });

    if (!viewerRes.ok) {
      const body = await viewerRes.text();
      log.error(`Viewer query failed (${viewerRes.status}): ${body}`);
      res.status(502).send(`Failed to fetch user info: ${body}`);
      return;
    }

    const viewerData = await viewerRes.json() as { data: { viewer: { id: string; name: string } } };
    linearUserId = viewerData.data.viewer.id;
    linearUserName = viewerData.data.viewer.name;
  } catch (err) {
    log.error(`Viewer query error: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).send("Failed to fetch user info.");
    return;
  }

  log.info(`Agent "${agentName}" → Linear user "${linearUserName}" (${linearUserId})`);

  // Step 3: Add to agents.json
  const agentConfig: AgentConfig = {
    name: agentName,
    linearUserId,
    clientId: appConfig.clientId,
    clientSecret: appConfig.clientSecret,
    accessToken: access_token,
    refreshToken: refresh_token,
    openclawAgent: agentName,
    host: "local",
  };

  const { isNew } = upsertAgent(agentConfig);

  log.info(`Agent "${agentName}" ${isNew ? "added to" : "updated in"} agents.json`);

  // Step 4: Show success page
  res.send(`
    <html>
    <head><title>OAuth Success</title>
    <style>
      body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
      .success { color: #16a34a; }
      pre { background: #f5f5f5; padding: 16px; border-radius: 8px; overflow-x: auto; }
      .warning { color: #d97706; }
    </style>
    </head>
    <body>
      <h1 class="success">✅ Agent "${agentName}" ${isNew ? "registered" : "updated"}</h1>
      <p>Linear user: <strong>${linearUserName}</strong> (${linearUserId})</p>
      ${!scope?.includes("app:assignable") ? '<p class="warning">⚠️ Missing app:assignable scope. Did you use actor=app in the authorize URL?</p>' : ""}
      <h3>Agent entry written to agents.json:</h3>
      <pre>${JSON.stringify(agentConfig, null, 2)}</pre>
      <p>Restart the connector to load the new agent and start token refresh.</p>
    </body>
    </html>
  `);
}

// --- oauth-apps.json loader ---

interface OAuthAppsFile {
  apps: Record<string, { clientId: string; clientSecret: string }>;
}

function loadOAuthApps(): Record<string, { clientId: string; clientSecret: string }> {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");

  const appsPath = path.resolve(process.cwd(), "oauth-apps.json");
  if (!fs.existsSync(appsPath)) return {};

  try {
    const raw = fs.readFileSync(appsPath, "utf8");
    const data = JSON.parse(raw) as OAuthAppsFile;
    return data.apps ?? {};
  } catch {
    log.error(`Failed to load oauth-apps.json`);
    return {};
  }
}
