# fancy-openclaw-linear-connector

A standalone connector service that bridges Linear webhooks to OpenClaw agent sessions. Receives Linear webhook events, creates agent sessions in Linear's UI, and routes tasks to the appropriate OpenClaw agents.

> **Status:** v0.1 in development

## Architecture

```
Linear webhook → nginx reverse proxy → connector (port 3100)
                                           ├── Verify HMAC signature
                                           ├── Normalize event
                                           ├── Route to agent (by assignee/mention)
                                           ├── Create Linear agent session (Working indicator)
                                           ├── Deliver to OpenClaw agent
                                           └── Close agent session (complete)
```

**Companion skill:** [fancy-openclaw-linear-skill](https://github.com/fancymatt/fancy-openclaw-linear-skill) — the `linear` CLI that agents use to interact with Linear.

## Getting Started

### Prerequisites

- Node.js >= 20
- A Linear workspace with admin access
- An OpenClaw installation running on the same host
- nginx or similar reverse proxy (for HTTPS + Linear webhook delivery)

### Step 1: Create a Linear OAuth Application

1. Go to Linear → Settings → API → OAuth Applications → Create new
2. Set redirect URL to `https://your-host/oauth/callback`
3. Note the **Client ID** and **Client Secret**
4. Under Webhooks, create a signing secret and note it

### Step 2: Configure the Connector

```bash
git clone https://github.com/fancymatt/fancy-openclaw-linear-connector.git
cd fancy-openclaw-linear-connector
npm install
npm run build
```

Create `.env` from the example:

```bash
cp .env.example .env
```

Set these values:

```env
PORT=3100
LINEAR_WEBHOOK_SECRET=whs_your_signing_secret
NODE_ENV=production
```

Create `agents.json` with your agent credentials:

```json
{
  "agents": [
    {
      "name": "mckell",
      "linearUserId": "linear-user-uuid",
      "clientId": "linear-oauth-client-id",
      "clientSecret": "linear-oauth-client-secret",
      "accessToken": "will-be-refreshed",
      "refreshToken": "will-be-refreshed",
      "openclawAgent": "mckell",
      "secretsPath": "/home/you/.openclaw/workspace-mckell/.secrets/linear.env"
    }
  ]
}
```

To get the `linearUserId`, complete the OAuth flow once (see Step 5).

### Step 3: Set Up the Reverse Proxy

Point nginx at port 3100:

```nginx
location /linear-webhook/ {
    proxy_pass http://127.0.0.1:3100/webhooks/linear;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Step 4: Run as a Systemd Service

Create `/etc/systemd/system/fancy-openclaw-linear-connector.service`:

```ini
[Unit]
Description=Fancy OpenClaw Linear Connector
After=network.target

[Service]
Type=simple
User=fancymatt
WorkingDirectory=/path/to/fancy-openclaw-linear-connector
ExecStart=/path/to/node /path/to/fancy-openclaw-linear-connector/dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable fancy-openclaw-linear-connector
sudo systemctl start fancy-openclaw-linear-connector
```

### Step 5: OAuth Callback — Authorize Your Agent

Visit `https://your-host/oauth/authorize?agent=mckell` in a browser. This redirects to Linear's OAuth consent screen. After authorization, the connector stores the tokens in `agents.json` and syncs them to the agent's workspace secrets.

### Step 6: Create the Linear Workspace Webhook

1. In Linear, go to Settings → API → Webhooks → Create new
2. Set the URL to `https://your-host/linear-webhook/`
3. Select event types: **Issues**, **Comments**, **Agent Session Events**
4. Paste the signing secret from Step 1
5. Save

### Step 7: Test End-to-End

1. Assign a Linear issue to the agent's Linear user
2. Check connector logs: `journalctl -u fancy-openclaw-linear-connector -f`
3. The agent should receive a `[NEW TASK]` message in OpenClaw

## Project Structure

```
src/
  index.ts              Service entrypoint (Express server)
  agents.ts             Agent config, token management, workspace sync
  agent-session.ts      Linear agent session CRUD (create, thought, response/close)
  router.ts             Event routing (assignee + mention matching)
  webhook/
    index.ts            Webhook handler (receive, verify, normalize, route, deliver)
    normalize.ts        Raw payload → typed event normalizer
    schema.ts           TypeScript event type definitions
    signature.ts        HMAC signature verification
    endpoint.test.ts    Integration tests
  token-refresh.ts      OAuth token refresh cron (every 20h)
```

## How It Works

1. **Webhook received** — Linear sends event to the reverse proxy
2. **Signature verified** — HMAC-SHA256 against the signing secret
3. **Event normalized** — raw payload converted to typed event (Issue, Comment, etc.)
4. **Agent routed** — matched by assignee ID or mentioned user ID
5. **Agent session created** — "Working" indicator appears in Linear UI
6. **Task delivered** — `openclaw agent --agent <name> --message "[NEW TASK] ..."` spawns an agent session
7. **Session closed** — response activity emitted, Linear auto-transitions session to `complete`

### Known Limitations

- **AgentSessionEvent webhooks have no data** — Linear doesn't include issue info in these payloads. Filtered out to avoid noise.
- **Comment webhooks don't include mentionedUsers** — mention routing requires API enrichment (planned).
- **OAuth tokens refresh every ~20h** — the connector syncs refreshed tokens to agent workspace secrets automatically.

## Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3100` | HTTP port |
| `LINEAR_WEBHOOK_SECRET` | Yes | — | Linear webhook signing secret |
| `NODE_ENV` | No | `development` | Set to `production` for systemd |
| `AGENTS_FILE` | No | `agents.json` | Path to agent config file |

### agents.json

Each agent entry:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Internal agent name (used for routing) |
| `linearUserId` | Yes | Linear user UUID for this agent |
| `clientId` | Yes | Linear OAuth app client ID |
| `clientSecret` | Yes | Linear OAuth app client secret |
| `accessToken` | Yes* | OAuth access token (auto-refreshed) |
| `refreshToken` | Yes* | OAuth refresh token (auto-refreshed) |
| `openclawAgent` | No | OpenClaw agent name if different from `name` |
| `secretsPath` | No | Path to write `LINEAR_API_KEY` on token refresh |
| `host` | No | `"ishikawa"` or `"local"` (future use) |

*Initial tokens are obtained via the OAuth callback flow.

## Troubleshooting

### Signature verification fails
Linear uses different header names depending on webhook type. The connector checks both `linear-signature` and `Linear-Signature`. Check that `LINEAR_WEBHOOK_SECRET` matches the value in Linear's webhook settings.

### Token 401 errors
OAuth tokens refresh every 20h. The connector syncs new tokens to `agents.json` and the agent's `secretsPath`. If an agent's session has a cached token, it needs to re-read from the secrets file. The `fancy-openclaw-linear-skill` CLI does this automatically on each invocation.

### Agent not receiving tasks
- Check `agents.json` has the correct `linearUserId`
- Verify the issue is assigned to that Linear user
- Check connector logs for "No agent target"
- Ensure `openclaw` is in PATH for the service user

### Multiple agent sessions on one issue
Each webhook delivery creates a new session. The connector deduplicates within a 30-second window. If you see multiple sessions, it's likely from rapid successive webhooks. Sessions are auto-closed after delivery.

## License

[MIT](LICENSE) © 2026 Matt Henry
