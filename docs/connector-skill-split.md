# Connector vs. Skill: What Does What?

The Linear ↔ OpenClaw integration has two independent components that serve opposite directions of communication.

## The Connector (this project)

**Direction:** Linear → OpenClaw

The connector is a standalone HTTP service that receives Linear webhook events and routes them to the appropriate OpenClaw agent sessions. It answers the question: *"When something happens in Linear, which agent should know about it?"*

**What it does:**
- Receives and validates Linear webhook payloads (HMAC signature verification)
- Routes events to agents based on assignee or team
- Queues tasks per-agent (one active task at a time, FIFO)
- Delivers formatted payloads to the OpenClaw gateway

**What it doesn't do:**
- It never writes back to Linear
- It doesn't give agents the ability to create issues, post comments, or change status

## The Companion Skill

**Direction:** OpenClaw → Linear

The [fancy-openclaw-linear-skill](https://github.com/fancymatt/fancy-openclaw-linear-skill) is an OpenClaw agent skill that gives agents the ability to interact with Linear. It answers the question: *"How does an agent take action on Linear issues?"*

**What it does:**
- Lets agents query, create, update, and comment on Linear issues
- Provides agents with Linear API access through structured skill commands
- Handles authentication and API formatting

**What it doesn't do:**
- It doesn't listen for events — agents only act when prompted

## Architecture

```
┌─────────┐  webhook   ┌─────────────┐  HTTP POST  ┌─────────────┐
│  Linear  │ ────────▶  │  Connector  │ ──────────▶ │  OpenClaw   │
│          │            │  (this svc) │             │  Gateway    │
│          │            └─────────────┘             │             │
│          │                                        │  ┌───────┐  │
│          │  ◀──── Linear API ──────────────────── │  │ Agent │  │
│          │            via skill                   │  │ +Skill│  │
└─────────┘                                        │  └───────┘  │
                                                    └─────────────┘
```

## When Do You Need What?

| Scenario | Connector | Skill |
|----------|:---------:|:-----:|
| Agents should receive Linear task assignments automatically | ✅ | — |
| Agents should be able to update issue status | — | ✅ |
| Agents should be able to comment on issues | — | ✅ |
| Full two-way integration (assign → work → update → close) | ✅ | ✅ |
| Agents only query Linear on demand (no real-time events) | — | ✅ |

### Most Common Setup

Most deployments want **both**: the connector pushes new tasks to agents, and the skill lets agents report progress back to Linear. They're independent services that complement each other — neither requires the other to function.

### Skill-Only Setup

If you don't need real-time event routing (e.g., agents check Linear on a schedule or only interact when asked), you can skip the connector and just install the skill.

### Connector-Only Setup

If agents only need to receive tasks but never write back to Linear (e.g., a notification-only setup where humans update Linear), the connector alone is sufficient.
