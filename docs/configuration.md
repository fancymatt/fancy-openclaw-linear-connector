# Configuration Reference

The connector is configured via `config/connector.yaml`. Copy the example to get started:

```bash
cp config/connector.example.yaml config/connector.yaml
```

## Full Annotated Config

```yaml
# Server settings
server:
  port: 3000                    # HTTP port. Overridden by PORT env var.

# Linear integration
linear:
  # HMAC secret for webhook signature validation.
  # Get this from Linear → Settings → API → Webhooks when creating your webhook.
  # Prefer setting LINEAR_WEBHOOK_SECRET env var over hardcoding here.
  webhookSecret: ""

# OpenClaw integration
openclaw:
  # Base URL of your OpenClaw gateway's HTTP API.
  # The connector POSTs deliveries to {gatewayUrl}/deliveries/openclaw
  gatewayUrl: "http://localhost:8080"

# Routing: how Linear events map to OpenClaw agents
routing:
  # Direct mapping: Linear user → OpenClaw agent
  agents:
    - linearUserId: "abc123-def456"       # Linear user UUID (required)
      linearEmail: "charles@example.com"  # Optional — for your reference only
      agentId: "charles"                  # OpenClaw agent ID
      sessionKey: "agent:charles:main"    # OpenClaw session key to deliver to

    - linearUserId: "xyz789-uvw012"
      agentId: "laren"
      sessionKey: "agent:laren:main"

  # Fallback: when an event has no assignee or the assignee isn't mapped
  teamDefaults:
    - teamKey: "ENG"                      # Linear team key (the short prefix)
      agentId: "charles"
      sessionKey: "agent:charles:main"

    - teamKey: "DESIGN"
      agentId: "laren"
      sessionKey: "agent:laren:main"
```

## How Routing Works

When a Linear webhook event arrives, the connector decides which agent to send it to using this priority chain:

1. **Assignee match (priority 10)** — If the issue has an assignee whose `linearUserId` appears in `routing.agents`, route to that agent.
2. **Team fallback (priority 20)** — If no assignee match, look up the issue's team key in `routing.teamDefaults`.
3. **Unmapped** — If neither matches, the event is dropped (logged but not delivered).

This means: assign an issue to a mapped Linear user and the right agent gets it automatically. For unassigned issues, the team default catches them.

## Finding Linear User IDs

You need Linear user UUIDs for the `linearUserId` field. Here's how to find them:

### Option 1: Linear API (Recommended)

```bash
# Using the Linear API with a personal API key
curl -s https://api.linear.app/graphql \
  -H "Authorization: Bearer lin_api_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ users { nodes { id name email } } }"}' \
  | jq '.data.users.nodes[]'
```

This returns all workspace members with their UUIDs, names, and emails.

### Option 2: Linear UI

Open a user's profile in Linear → the URL contains their UUID:
`https://linear.app/settings/members/abc123-def456-...`

## Setting Up Linear Webhooks

1. Go to **Linear → Settings → API → Webhooks**
2. Click **New webhook**
3. Set the URL to: `https://your-domain.com/webhooks/linear`
4. Select events to subscribe to:
   - **Issues:** Create, Update (these are the primary events the connector routes)
   - **Comments:** Create (if you want agents to receive comment notifications)
5. Copy the **signing secret** — set it as `LINEAR_WEBHOOK_SECRET` env var
6. Click **Create webhook**

### Which Events to Subscribe To

| Event | Recommended | Why |
|-------|-------------|-----|
| Issue created | ✅ Yes | New task assignments |
| Issue updated | ✅ Yes | Status changes, reassignments, priority changes |
| Comment created | Optional | Agents can respond to comments on their issues |
| All others | No | The connector doesn't process them yet |

## Mapping Examples

### Single Agent Setup

If you have one agent handling all Linear work:

```yaml
routing:
  agents: []
  teamDefaults:
    - teamKey: "ENG"
      agentId: "ai"
      sessionKey: "agent:ai:main"
```

### Multi-Agent Setup

Different agents for different domains:

```yaml
routing:
  agents:
    - linearUserId: "user-uuid-for-coding-agent"
      agentId: "charles"
      sessionKey: "agent:charles:main"
    - linearUserId: "user-uuid-for-design-agent"
      agentId: "laren"
      sessionKey: "agent:laren:main"

  teamDefaults:
    - teamKey: "ENG"
      agentId: "charles"
      sessionKey: "agent:charles:main"
    - teamKey: "DESIGN"
      agentId: "laren"
      sessionKey: "agent:laren:main"
    - teamKey: "OPS"
      agentId: "ai"
      sessionKey: "agent:ai:main"
```

### Session Keys

The `sessionKey` determines which agent session receives the event. The format is typically `agent:<agentId>:main` for the agent's primary session. Check your OpenClaw gateway configuration for available session keys.
