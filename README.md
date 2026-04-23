# fancy-openclaw-linear-connector

A standalone connector service that bridges Linear webhooks to OpenClaw agent sessions. Receives Linear webhook events, creates agent sessions in Linear's UI, and routes tasks to the appropriate OpenClaw agents.

> **Status:** v0.2 in development — Fully functional, 15 agents onboarded, symlink-escape bug documented

## Quick Start

**Prerequisites:**
- OpenClaw Gateway running on your machine
- Node.js 18+ (`npm install` to run connector)
- Linear workspace with admin permissions
- A domain name pointing to your machine (for webhook delivery)

### Phase 1: Clone & Run the Connector

1. **Clone and install:**
   ```bash
   git clone https://github.com/fancymatt/fancy-openclaw-linear-connector.git
   cd fancy-openclaw-linear-connector
   npm install
   ```

2. **Set up reverse proxy:**
   The connector listens on port 3100. Set up nginx (or similar) to proxy `https://your-host/linear-webhook/` → `http://localhost:3100/webhook`.

   Example nginx config:
   ```nginx
   location /linear-webhook/ {
       proxy_pass http://localhost:3100/webhook;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
   }
   ```

   Verify it's reachable before proceeding — `curl -v https://your-host/linear-webhook/` should connect (even if it returns a 4xx, that means the proxy is working).

3. **Start the connector:**
   ```bash
   npm start
   # Or: systemd service (see Deployment Scenarios below)
   ```

### Phase 2: Set Up the Webhook

4. **Create a Linear webhook:**
   - Linear → Settings → API → Webhooks → Create new
   - URL: `https://your-host/linear-webhook/`
   - Events: `Issue`, `Comment`, `AgentSessionEvent`
   - Note the **signing secret** — you'll need it below
   - ⚠️ **Only create this once per workspace** — one webhook handles all agents

5. **Configure the webhook secret:**
   Set the `LINEAR_WEBHOOK_SECRET` environment variable to the signing secret from step 4. If using systemd, add it to your service file or `.env`.

   ```bash
   export LINEAR_WEBHOOK_SECRET=your-signing-secret
   ```

   Restart the connector if it's already running so it picks up the secret.

### Phase 3: Create OAuth App (Per Agent)

Repeat this phase for each agent you want to connect.

6. **Create OAuth app in Linear:**
   - Settings → API → Applications → Create new
   - Name: your agent's display name (e.g. `Charles (CTO)`)
   - Redirect URI: `https://your-host/oauth/callback`
   - Scopes: `read, write, app:assignable, app:mentionable`
   - Note the **Client ID** and **Client Secret**

7. **Authorize as an app (NOT as your personal user):**
   Visit this URL in your browser (requires workspace admin):
   ```text
   https://linear.app/oauth/authorize?client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&response_type=code&scope=read,write,app:assignable,app:mentionable&actor=app&state=AGENT_NAME
   ```

   ⚠️ **Must include `actor=app`** — this installs the app as its own user. Without it, the agent won't appear in delegate/mention menus and the self-trigger filter will break.

   After approving, Linear redirects to your callback URL with a `code` parameter.

8. **Exchange the code for tokens:**
   ```bash
   curl -s -X POST https://api.linear.app/oauth/token \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "code=CODE_FROM_REDIRECT" \
     -d "redirect_uri=https://your-host/oauth/callback" \
     -d "grant_type=authorization_code"
   ```

   ⚠️ **Verify the response includes scopes `app:assignable` and `app:mentionable`.** If not, the OAuth URL was wrong (missing `actor=app` or scope params).

9. **Get the agent's Linear User ID:**
   ```bash
   curl -s https://api.linear.app/graphql \
     -H "Authorization: Bearer ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"query":"{ viewer { id name } }"}'
   ```

   ⚠️ **Must show the agent's name** (e.g. `Charles (CTO)`). If it shows your personal name, you authorized as a user — redo step 7 with `actor=app`.

### Phase 4: Connect Everything

10. **Add agent to `agents.json`:**
    ```json
    {
      "name": "agent-name",
      "linearUserId": "UUID_FROM_STEP_9",
      "clientId": "CLIENT_ID",
      "clientSecret": "CLIENT_SECRET",
      "accessToken": "ACCESS_TOKEN",
      "refreshToken": "REFRESH_TOKEN",
      "secretsPath": "/path/to/workspace/.secrets/linear.env",
      "openclawAgent": "openclaw-agent-name",
      "host": "local"
    }
    ```

    **`secretsPath` must point to `linear.env`** — the `linear` CLI reads from `.secrets/linear.env`.

11. **Create the secrets file:**
    ```bash
    mkdir -p /path/to/workspace/.secrets
    echo 'LINEAR_API_KEY=ACCESS_TOKEN' > /path/to/workspace/.secrets/linear.env
    ```

12. **Restart the connector:**
    ```bash
    sudo systemctl restart fancy-openclaw-linear-connector
    # Or just: npm start
    ```
    On startup, the connector refreshes all agent tokens and syncs them to each agent's `secretsPath`.

13. **Test:** Delegate a Linear issue to the agent. Check connector logs:
    ```bash
    journalctl -u fancy-openclaw-linear-connector -f
    ```
    You should see: `Routed via delegate → agent-name`, `Session created`, `Delivery spawned`. The agent should comment on the issue within a minute or two.

---

## Deployment Scenarios

### Scenario A: Same Machine as Current Setup

Use this if you already have OpenClaw Gateway and agents running on the same machine (like Nakazawa).

**Requirements:**
- OpenClaw Gateway accessible (`openclaw` CLI working)
- Agent workspaces exist (`~/.openclaw/workspace-{agent}/`)
- Domain name pointing to your machine

**Steps:**
1. Clone connector repo locally
2. Copy existing `agents.json` from production setup
3. Update `secretsPath` to match your workspace structure
4. Create/reuse Linear webhook pointing to your domain
5. Set `LINEAR_WEBHOOK_SECRET` environment variable
6. Start connector with `npm start` or systemd

**When to use this:**
- Adding agents to existing OpenClaw setup
- Moving connector to a new primary machine
- Testing on localhost before going live

---

### Scenario B: Separate Machine / New Instance

Use this for a fresh OpenClaw + connector installation on a different server.

**Requirements:**
- New machine with Node.js 18+
- Ability to expose HTTP ports (port 3100)
- Ability to configure nginx reverse proxy
- New Linear webhook URL (or ability to update existing one)

**Steps:**
1. Install OpenClaw on new machine
2. Clone connector repo: `git clone https://github.com/fancymatt/fancy-openclaw-linear-connector.git`
3. Copy `agents.json.example` to `agents.json` and configure all agents
4. Set up nginx reverse proxy for `/linear-webhook` → `http://localhost:3100/webhook`
5. Update Linear webhook URL to point to your new domain
6. Update OAuth apps' `redirect_uri` to new domain (or keep `ai.fcy.sh` if using same domain)
7. Create agent workspaces and `.secrets/linear.env` files
8. Start systemd service for connector
9. Configure each agent's exec permissions (see Step 9 below)

**When to use this:**
- Creating a separate production environment
- Running on a different network/physical machine
- Wanting isolation from existing setup

---

### Scenario C: Docker / Containerized Deployment

Use this for running the connector in a container.

**Requirements:**
- Docker or Docker Compose installed
- Ability to map ports and volumes

**Steps:**
1. Clone connector repo
2. Set environment variables in `docker-compose.yml`:
   ```yaml
   environment:
     - PORT=3100
     - LINEAR_WEBHOOK_SECRET=your-secret
     - AGENTS_FILE=./agents.json
   ```
3. Build and run container
4. Configure webhook URL to point to container host

**When to use this:**
- Testing without affecting host system
- Isolated deployment environment
- Easy rollback (`docker-compose down`)

---

## Architecture

```text
Linear webhook → nginx reverse proxy → connector (port 3100)
                                           ├── Verify HMAC signature
                                           ├── Normalize event
                                           ├── Route to agent (by delegate/mention)
                                           ├── Create Linear agent session (Working indicator)
                                           ├── Deliver to OpenClaw agent (fire-and-forget)
                                           └── Close agent session when agent process exits
```

**Companion skill:** [fancy-openclaw-linear-skill](https://github.com/fancymatt/fancy-openclaw-linear-skill) — `linear` CLI that agents use to interact with Linear.

## Adding a New Agent (Playbook)

[Content continues in next section...]

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

```text
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

⚠️ **Only create this ONCE per workspace**, not per agent. This is an application-level webhook that handles all agents.

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

```text
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

## Known Issues & Recommendations

### Symlink-Escape Gateway Configuration Issue

The gateway has a flawed `symlink-escape` check that compares the symlink target path against the workspace root, not the actual filesystem path. Even though agents now have **directory copies** of the skill (not symlinks), the gateway still rejects them.

**Current Status:**
- All agents can use the global `linear` CLI directly
- The `fancy-openclaw-linear-skill` SKILL.md exists in their agent workspaces
- However, the gateway does not load it into sessions because it rejects directory copies as "escaped"

**Recommendation:**
1. Gateway fix: Update the symlink-escape check to verify the actual path type (directory vs symlink) using `fs.statSync()` before comparing
2. Or: Add `~/Code/openclaw-linear/fancy-openclaw-linear-skill` to the gateway’s allowed skill roots (configure `skills.allowlist=[...]`)
3. Or: For immediate relief, agents can run `linear` CLI commands without skill loading (CLI is globally installed)

## License

[MIT](LICENSE) © 2026 Matt Henry
