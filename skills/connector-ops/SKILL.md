---
name: connector-ops
description: Privileged operational diagnostics and provisioning toolkit for the fancy-openclaw-linear-connector. Use for fleet diagnostics, dispatch troubleshooting, redispatch, steward lookup, and workflow label provisioning.
restrict: true
allowlisted_agents:
  - astrid
  - grover
---

# Connector Ops

**Privileged toolkit for connector operators.** Reads live dispatch/auth/role state via the admin API, root-causes stuck/ping-ponging tickets, and provisions workflow labels on parent teams via the proxy.

**Authorized operators only:** Astrid, Grover.

## Environment

All scripts accept these env vars with sensible fallbacks:

| Env var                     | Default                         | Purpose                          |
|-----------------------------|---------------------------------|----------------------------------|
| `CONNECTOR_BASE_URL`        | `http://127.0.0.1:3100`         | Admin API base URL               |
| `CONNECTOR_ADMIN_SECRET`    | *(from .env or prompt)*         | Bearer token for admin auth      |
| `LINEAR_PROXY_URL`          | `http://127.0.0.1:3100/proxy`   | Linear proxy/graphql endpoint    |
| `LINEAR_OAUTH_TOKEN`        | *(from secrets)*                | OAuth token for proxy mutations  |

## Scripts

### `fleet-status`

Dump the live agent fleet from the admin API: which agents are registered, their OAuth state, identity mapping, and any alerts.

```bash
./scripts/fleet-status.sh
```

### `dispatch-acks`

Show the dispatch acknowledgment ledger — which dispatches have been acked, which are pending, and any that timed out.

```bash
./scripts/dispatch-acks.sh
```

### `redispatch <ticketId>`

Force-redispatch a single ticket. Useful for stuck dispatch, ping-ponging tickets, or zombie loops.

```bash
./scripts/redispatch.sh INF-123
```

### `provision-wf-label <teamKey> <labelName>`

Provision a `wf:` label on a parent team via the proxy. Used to set up workflow labels for teams that are being onboarded.

```bash
./scripts/provision-wf-label.sh INF wf:dev-impl
```

### `steward-lookup <ticketId>`

Look up which steward/agent is responsible for a ticket — traces the delegate chain, dispatch state, and current assignment.

```bash
./scripts/steward-lookup.sh INF-123
```

## Categorization (Failure Taxonomy)

Common stuck-ticket patterns and which script to reach for:

| Pattern | Script | Example |
|---|---|---|
| **Ad-hoc strand** — agent was dispatched but lost track of ticket | `redispatch` | INF-287 |
| **Steward ping-pong** — dispatch bounces between two agents | `dispatch-acks` + `redispatch` | INF-290, LSO-1 |
| **Spawn-arms spec** — workflow engine spawned multiple children | `steward-lookup` | INF-283 |
| **Unprovisioned team** — no `wf:` label on the team's project | `provision-wf-label` | — |
| **Revoked OAuth** — agent token expired or was revoked | `fleet-status` | — |

## Security

- All scripts are gated behind the admin API's `ADMIN_SECRET` check.
- The `restrict: true` field in this skill header prevents non-operator agents from reading or using these scripts.
- Never expose `ADMIN_SECRET` in chat or ticket comments.
- The scripts fall back to `$CONNECTOR_ADMIN_SECRET` from `.env` so you don't paste secrets into command lines.
