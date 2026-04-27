import { getAgent, upsertAgent } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";
const log = componentLogger(createLogger(), "oauth-callback");
/**
 * Handles the OAuth callback from Linear.
 *
 * Expected query params:
 *   code  — authorization code from Linear
 *   state — agent name (set when building the authorize URL)
 *
 * The agent must already exist in agents.json with at least `name`,
 * `clientId`, and `clientSecret` populated (a "partial" entry).
 * The callback fills in `linearUserId`, `accessToken`, and `refreshToken`.
 */
export async function handleOAuthCallback(req, res) {
    const { code, state, error, error_description } = req.query;
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
    // Look up the agent's OAuth credentials from agents.json
    const existing = getAgent(agentName);
    if (!existing) {
        res.status(400).send(`No agent "${agentName}" found in agents.json. ` +
            `Add a partial entry with name, clientId, and clientSecret first.`);
        return;
    }
    if (!existing.clientId || !existing.clientSecret) {
        res.status(400).send(`Agent "${agentName}" is missing clientId or clientSecret in agents.json. ` +
            `Add them before authorizing.`);
        return;
    }
    const redirectUri = process.env.OAUTH_REDIRECT_URI ?? `${req.protocol}://${req.get("host")}${req.path}`;
    // Step 1: Exchange code for tokens
    log.info(`Exchanging OAuth code for agent "${agentName}"...`);
    let tokenResponse;
    try {
        const params = new URLSearchParams({
            client_id: existing.clientId,
            client_secret: existing.clientSecret,
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
        tokenResponse = await tokenRes.json();
    }
    catch (err) {
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
    let linearUserId;
    let linearUserName;
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
        const viewerData = await viewerRes.json();
        linearUserId = viewerData.data.viewer.id;
        linearUserName = viewerData.data.viewer.name;
    }
    catch (err) {
        log.error(`Viewer query error: ${err instanceof Error ? err.message : String(err)}`);
        res.status(500).send("Failed to fetch user info.");
        return;
    }
    log.info(`Agent "${agentName}" → Linear user "${linearUserName}" (${linearUserId})`);
    // Step 3: Update agents.json with full credentials
    const agentConfig = {
        ...existing,
        linearUserId,
        accessToken: access_token,
        refreshToken: refresh_token,
        openclawAgent: existing.openclawAgent ?? agentName,
        host: existing.host ?? "local",
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
      <h3>Agent entry in agents.json:</h3>
      <pre>${JSON.stringify(agentConfig, null, 2)}</pre>
      <p>The connector will pick up the new agent automatically. No restart needed.</p>
    </body>
    </html>
  `);
}
//# sourceMappingURL=oauth-callback.js.map