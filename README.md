# fancy-openclaw-linear-connector

A standalone connector service that bridges Linear webhooks to OpenClaw agent sessions. Receives Linear webhook events, creates agent sessions in Linear's UI, and routes tasks to the appropriate OpenClaw agents.

> **Status:** v0.1 in development

## Architecture

```
Linear webhook → nginx reverse proxy → connector (port 3100)
                                           ├── Verify HMAC signature
                                           ├── Normalize event
                                           ├── Route to agent (by delegate/mention)
                                           ├── Create Linear agent session (Working indicator)
                                           ├── Deliver to OpenClaw agent (fire-and-forget)
                                           └── Close agent session when agent process exits
```

**Companion skill:** [fancy-openclaw-linear-skill](https://github.com/fancymatt/fancy-openclaw-linear-skill) — the `linear` CLI that agents use to interact with Linear.

## Adding a New Agent (Playbook)

This is the step-by-step process for onboarding a new agent into the connector. Follow it exactly.

### Step 1: Create a Linear OAuth Application

Each agent gets its **own** OAuth application in Linear.

1. Go to [Linear → Settings → API → Applications → Create new](https://linear.app/settings/api/applications/new)
2. **Name and icon** — this is how the agent appears in Linear (mention menu, delegate dropdown, comments). Choose carefully.
3. **Redirect URI**: `https://your-host/oauth/callback` (e.g. `https://ai.fcy.sh/oauth/callback`)
4. Under **Webhooks**, enable: **Issues**, **Comments**, **Agent Session Events**
   - This is an **application-level webhook** (not agent-specific)
   - Agent Session Events enable the Linear UI "Agent working" widget when you @mention agents
   - Issues + Comments enable routing to OpenClaw agents
⚠️ **Important:** Use application-level webhooks, not agent-specific webhooks. Agent-specific webhooks cause duplicate notifications. Only one application webhook is needed per workspace.
5. Note the **Client ID** and **Client Secret**

### Step 2: Authorize as an App (NOT as a personal user)

⚠️ **This is the most common mistake.** You must use `actor=app` in the OAuth URL. Without it, the app authorizes under your personal Linear account, the agent won't appear in the delegate/mention menus, and the self-trigger filter will block legitimate events.

Build this URL and visit it in a browser (you need workspace admin permissions):

```
https://linear.app/oauth/authorize?client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&response_type=code&scope=read,write,app:assignable,app:mentionable&actor=app&state=AGENT_NAME
```

Key parameters:
- **`actor=app`** — installs the app as its own user (not your personal account)
- **`app:assignable`** — allows the app to appear as a delegate on issues
- **`app:mentionable`** — allows the app to be @mentioned in comments
- **`scope=read,write`** — API access

The page will show an **"Install App"** consent screen (not a personal auth screen). After approving, Linear redirects to your callback URL with a `code` parameter.

### Step 3: Exchange the Code for Tokens

```bash
curl -s -X POST https://api.linear.app/oauth/token \
  -d "client_id=CLIENT_ID" \
  -d "client_secret=CLIENT_SECRET" \
  -d "code=CODE_FROM_REDIRECT" \
  -d "redirect_uri=REDIRECT_URI" \
  -d "grant_type=authorization_code"
```

Response:
```json
{
  "access_token": "lin_oauth_...",
  "refresh_token": "lin_refresh_...",
  "scope": "app:assignable app:mentionable read write"
}
```

⚠️ **Verify the scopes include `app:assignable` and `app:mentionable`.** If they don't, the OAuth URL was wrong (missing `actor=app` or the scope params).

### Step 4: Get the Agent's Linear User ID

```bash
curl -s https://api.linear.app/graphql \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id name } }"}'
```

⚠️ **The response must show the agent's name** (e.g. `{"name": "Charles (CTO)"}`). If it shows your personal name (e.g. "Matt Henry"), you authorized as a personal user, not as an app. Go back to Step 2.

### Step 5: Add to agents.json

Add an entry to the connector's `agents.json`:

```json
{
  "name": "agent-name",
  "linearUserId": "UUID_FROM_STEP_4",
  "clientId": "CLIENT_ID",
  "clientSecret": "CLIENT_SECRET",
  "accessToken": "ACCESS_TOKEN",
  "refreshToken": "REFRESH_TOKEN",
  "openclawAgent": "openclaw-agent-name",
  "secretsPath": "/home/you/.openclaw/workspace-agentname/.secrets/linear.env",
  "host": "local"
}
```

**`secretsPath` must point to `linear.env`** (not `linear-oauth.env`). The `linear` CLI reads from `.secrets/linear.env` — this is where the connector syncs refreshed tokens.

### Step 6: Restart the Connector

```bash
sudo systemctl restart fancy-openclaw-linear-connector
```

On startup, the connector will:
- Refresh all agent tokens
- Sync refreshed tokens to each agent's `secretsPath`
- Start receiving webhooks

### Step 7: Create the Linear Webhook

⚠️ **Only create this ONCE per workspace**, not per agent.** This is an application-level webhook that handles all agents.

If you already have a workspace webhook for Linear events, **update the existing one** instead of creating a new one. Enable the same event types for all agents.

1. Linear → Settings → API → Webhooks → Create new (or edit existing)
2. URL: `https://your-host/linear-webhook/`
3. Event types: **Issues**, **Comments**, **Agent Session Events**
   - Use **exact** event type names: `Issue`, `Comment`, `AgentSessionEvent`
   - Avoid redundant types like `Issue.completed` or `Issue.canceled` (covered by `Issue.updated`)
4. Use the signing secret from your OAuth app settings

### Step 8: Test End-to-End

1. Delegate a Linear issue to the agent (should appear in the delegate dropdown)
2. Check connector logs: `journalctl -u fancy-openclaw-linear-connector -f`
3. You should see: `Routed via delegate → agent-name`, `Session created`, `Delivery spawned`
4. The agent should comment on the issue within a minute or two

### Step 9: Configure Exec Permissions (Security)

Agents spawned by the connector need exec permissions to run the `linear` CLI and other tools. OpenClaw's exec approval system defaults to "deny" and requires manual approval for every command — this blocks automated work.

**Standard pattern for connector agents:** Allowlist mode with specific safe commands.

#### A. Identify the Agent Index
Find the agent's index in the OpenClaw config (`~/.openclaw/config/agents.yaml`). For example, `mckell` might be index 17. You'll need this for the config commands.

```bash
openclaw config list | grep -A 2 'mckell'
```

#### B. Set Security Mode to Allowlist

```bash
# Replace 17 with the actual agent index
openclaw config set agents.list[17].tools.exec.security allowlist
openclaw config set agents.list[17].tools.exec.ask on-miss
openclaw config set agents.list[17].tools.exec.askFallback deny
```

**Why this mode:**
- **Safe operations without approval** — allowlisted commands run immediately (linear CLI, basic tools)
- **Destructive ops require approval** — `rm`, `sudo`, system commands not in allowlist trigger prompts
- **Configurable per agent** — each agent gets their own allowlist based on needs

#### C. Add Allowlist Patterns

Edit `~/.openclaw/exec-approvals.json` to add the agent's allowlist entry:

```json
{
  "version": 1,
  "socket": {
    "path": "/home/fancymatt/.openclaw/exec-approvals.sock",
    "token": "0UjXI66lhKNKPXfneUojoJolNMiznj1-"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": true
  },
  "agents": {
    "your-agent-name": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "allowlist": [
        {
          "pattern": "/home/fancymatt/.nvm/**",
          "id": "<generate-unique-uuid>"
        },
        {
          "pattern": "/usr/bin/python3",
          "id": "<generate-unique-uuid>"
        },
        {
          "pattern": "/usr/bin/grep",
          "id": "<generate-unique-uuid>"
        },
        {
          "pattern": "/usr/bin/mkdir",
          "id": "<generate-unique-uuid>"
        },
        {
          "pattern": "/usr/bin/ls",
          "id": "<generate-unique-uuid>"
        },
        {
          "pattern": "/usr/bin/cat",
          "id": "<generate-unique-uuid>"
        },
        {
          "pattern": "/usr/bin/echo",
          "id": "<generate-unique-uuid>"
        },
        {
          "pattern": "/home/fancymatt/.openclaw/workspace-your-agent/**",
          "id": "<generate-unique-uuid>"
        },
        {
          "pattern": "/home/fancymatt/.openclaw/shared/skills/**",
          "id": "<generate-unique-uuid>"
        }
      ]
    }
  }
}
```

**Explanation of patterns:**

| Pattern | Purpose | Risk Level |
|---------|----------|-----------|
| `/home/fancymatt/.nvm/**` | npm, node, and npm-linked CLIs (including `linear` command) | Low |
| `/usr/bin/python3` | Python scripting | Low |
| `/usr/bin/grep`, `/usr/bin/ls`, `/usr/bin/cat`, `/usr/bin/echo` | Basic file operations | Low |
| `/usr/bin/mkdir` | Directory creation | Low |
| `/home/fancymatt/.openclaw/workspace-your-agent/**` | Agent's own workspace | Low |
| `/home/fancymatt/.openclaw/shared/skills/**` | Shared skills access | Low |

**What's NOT in the allowlist (intentionally blocked):**
- `/usr/bin/rm`, `/usr/bin/rmdir` — destructive file operations
- `/usr/bin/sudo`, `/usr/bin/doas` — privilege escalation
- System management commands that could disrupt the host

#### D. Generate UUIDs

Generate a fresh UUID for each allowlist pattern using the OpenClaw CLI:

```bash
openclaw uuid
```

Or use `uuidgen` if installed:

```bash
apt install uuid-runtime  # Ubuntu/Debian
uuidgen
```

**Important:** Each pattern entry must have a unique `id`. Reusing IDs causes the system to treat them as the same rule.

#### E. Verify Configuration

Check that the agent's exec permissions are correctly set:

```bash
openclaw config get agents.list[<agent-index>].tools.exec
```

Expected output:
```yaml
security: allowlist
ask: on-miss
askFallback: deny
```

## Common Mistakes (Learned the Hard Way)

### ❌ Authorizing without `actor=app`
The app installs under your personal account. The agent won't appear in delegate/mention menus. The self-trigger filter will block events because your user ID matches the agent's user ID.

**Fix:** Always include `actor=app` in the OAuth URL. Verify with `{ viewer { id name } }` — it should show the agent's name.

### ❌ `secretsPath` pointing to the wrong file
If the `linear` CLI reads `.secrets/linear.env` but the connector writes to `.secrets/linear-oauth.env`, token refreshes won't reach the CLI. After ~20h, the agent's token expires and all API calls fail.

**Fix:** Set `secretsPath` to `.secrets/linear.env`.

### ❌ Reusing a disabled personal API key alongside OAuth tokens
If `.secrets/linear.env` contains an old `lin_api_...` personal token AND a new OAuth token, the CLI may pick up the wrong one (it matches `linear.*api.*key` patterns). Personal tokens get disabled when OAuth apps take over.

**Fix:** Overwrite `linear.env` with only `LINEAR_API_KEY=<oauth_token>`. Remove any `LINEAR_AGENTNAME_API_KEY` entries.

### ❌ Session closing before agent finishes
Closing the Linear agent session immediately after spawning the delivery process kills the "Working" indicator before the agent has responded. The agent may also see the session as "complete" and skip work.

**Fix:** The connector listens for the spawned process `exit` event and closes the session after.

### ❌ Same session ID for repeated delegations
The session key is `linear-<ISSUE-ID>`. Re-delegating the same issue reuses the session, which may have stale state ("already done"). Use a fresh issue for testing.

## Project Structure

```
src/
  index.ts              Service entrypoint (Express server)
  agents.ts             Agent config, token management, workspace sync
  agent-session.ts      Linear agent session CRUD (create, thought, response/close)
  router.ts             Event routing (delegate + assignee + body mention matching)
  webhook/
    index.ts            Webhook handler (receive, verify, normalize, route, deliver)
    normalize.ts        Raw payload → typed event normalizer
    schema.ts           TypeScript event type definitions
    signature.ts        HMAC signature verification
  token-refresh.ts      OAuth token refresh cron (every 20h)
  queue/
    agent-queue.ts      Per-agent task queue (prevents concurrent sessions)
```

## How It Works

1. **Webhook received** — Linear sends event to the reverse proxy
2. **Signature verified** — HMAC-SHA256 against the signing secret
3. **Event normalized** — raw payload converted to typed event (Issue, Comment, etc.)
4. **Agent routed** — matched by delegate ID, assignee ID, or `@mention` in comment body
5. **Agent session created** — "Working" indicator appears in Linear UI
6. **Task delivered** — `openclaw agent --agent <name> --message "[NEW TASK] ..."` spawned as detached process
7. **Session closed** — when the spawned process exits, response activity emitted, Linear auto-transitions to `complete`

### Routing Logic

Events are routed to agents in this priority order:

1. **Delegate** (OAuth app actor) — the agent was delegated the issue in Linear
2. **Assignee** — the issue was assigned to the agent's Linear user
3. **Body mention** — for Comment events, `@agentname` parsed from the comment body (case-insensitive)

Self-triggered events (agent acting on its own behalf) are filtered out to prevent loops.

### Known Limitations

- **AgentSessionEvent webhooks have no data** — Linear doesn't include issue info. Filtered out to avoid noise.
- **Comment webhooks don't include mentionedUsers** — mention routing parses `@name` patterns from comment body.
- **OAuth tokens refresh every ~20h** — the connector auto-syncs refreshed tokens to agent workspace secrets.
- **Session deduplication** — 30-second window prevents duplicate sessions from rapid webhooks.

## Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3100` | HTTP port |
| `LINEAR_WEBHOOK_SECRET` | Yes | — | Linear webhook signing secret |
| `NODE_ENV` | No | `development` | Set to `production` for systemd |
| `AGENTS_FILE` | No | `agents.json` | Path to agent config file |

### agents.json

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Internal agent name (used for routing) |
| `linearUserId` | Yes | Linear user UUID (obtained via `actor=app` OAuth) |
| `clientId` | Yes | Linear OAuth app client ID |
| `clientSecret` | Yes | Linear OAuth app client secret |
| `accessToken` | Yes* | OAuth access token (auto-refreshed) |
| `refreshToken` | Yes* | OAuth refresh token (auto-refreshed) |
| `openclawAgent` | No | OpenClaw agent name if different from `name` |
| `secretsPath` | No | Path to write `LINEAR_API_KEY` on token refresh (**must be `linear.env`**) |
| `host` | No | `"ishikawa"` or `"local"` (future use) |

## Troubleshooting

### "No agent target for event"
The router didn't match any agent. Check that `agents.json` has the correct `linearUserId` and the issue is delegated/assigned to that user.

### "Skipping self-triggered event"
The event actor matches the target agent. This prevents loops. If this fires for legitimate delegations, the `linearUserId` is wrong (likely set to your personal user ID instead of the app's user ID).

### Token 401 / "Account disabled"
The agent's personal API key was disabled when the OAuth app took over. Ensure `.secrets/linear.env` contains only `LINEAR_API_KEY=<oauth_token>` — no `lin_api_...` keys.

### Agent receives task but doesn't respond in Linear
Check that the `linear` CLI is installed (`npm link` in the skill repo) and that `.secrets/linear.env` has a valid token. The agent's session reads the CLI output to fetch issue details.

### Multiple agent sessions on one issue
Each webhook creates a new session. The connector deduplicates within a 30-second window. Sessions auto-close when the agent process exits.

### ❌ Agent exec permissions not configured
After onboarding, the agent receives Linear tasks but gets stuck on every `exec` command waiting for manual approval. The connector's fire-and-forget delivery can't wait for approvals.

**Symptoms:**
- Agent doesn't comment on Linear issue within expected time
- Connector logs show "Delivery spawned" but no agent activity
- Agent workspace shows exec approval timeout or denial

**Fix:** Follow Step 9 to set up allowlist permissions. Connector-spawned agents need `security: allowlist` mode with the `linear` CLI and basic tools pre-approved.

## License

[MIT](LICENSE) © 2026 Matt Henry
