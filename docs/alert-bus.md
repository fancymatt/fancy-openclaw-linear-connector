# Alert Bus (Phase 1 — "nothing fails silently")

_Astrid, 2026-07-02. Part of the connector rebuild project
(`~/obsidian-vault/life-os/project-management/linear/connector-rebuild-project.md`)._

## Problem

The 2026-07-02 audit found that **every failure signal in the connector terminates in a log
line, the operational-event store, or a ticket comment — no path pushes to a human.** Watchdog
crons run `--no-report` to `/dev/null`; `config-sanity-watchdog.json` is written and never read;
the `no-route` case leaves no artifact at all. Detection exists; alerting doesn't.

## Design

One module, `src/alerts/`, exposing a single entry point:

```ts
notify({
  severity: "info" | "warning" | "critical",
  source:   "dispatch" | "config-health" | "token-refresh" | ...,  // subsystem slug
  title:    "one-line human summary",
  detail?:  "multiline context",     // redacted + truncated before storage/push
  agent?:   "felix",
  ticket?:  "AI-1234",
  dedupKey?: "custom-key",           // default: source|title|agent|ticket
})
```

Every alert flows to three sinks; sinks never throw into the caller (`notify()` is fire-and-forget
safe to call from any error path):

1. **Log sink** — always. `[alert]` component logger, severity-mapped.
2. **Store sink** — always. New `alerts` SQLite table (`data/alerts.db`), reusing the
   operational-event store's redaction/truncation discipline. This is the console's future
   event feed and the queryable history (`ALERTS` are what a human should see; the existing
   operational-event store remains the full-detail machine log).
3. **Push sink** — severity ≥ `ALERT_PUSH_MIN_SEVERITY` (default `warning`). POSTs
   `push_notification` to the OpenClaw gateway `/tools/invoke` (same mechanism the G-20 canary
   already uses successfully). Controlled by `ALERT_PUSH_ENABLED` (default **on** — silent
   failure is the thing we are killing; opt out, not in).

### Storm control (a paging system that cries wolf gets muted)

- **Per-alert dedup:** repeats of the same `dedupKey` within a suppression window increment a
  counter on the stored row instead of creating new rows/pushes. Window by severity:
  critical 15 min, warning 60 min, info 6 h. When a suppressed alert finally re-fires, the push
  says `(xN since first occurrence)`.
- **Global push budget:** max 10 pushes per 15-minute window. On overflow, one final
  `critical` digest push ("alert storm: N further alerts suppressed, see console/store") and
  then silence until the window frees. Everything still lands in the store.

### What gets wired in (incremental, each its own commit)

| # | Signal | Today | Severity |
|---|---|---|---|
| 1 | Connector startup (with commit hash) | nothing | info (doubles as restart audit trail) |
| 2 | `no-route` events (bad/missing delegate mapping) | ops-store only, no artifact | warning |
| 3 | Delivery retries exhausted (`delivery-failed`) | ops-store + log | warning |
| 4 | Delegate unreachable (`emitDelegateUnavailable`) | ticket comment only | warning |
| 5 | config-health healthy→unhealthy transition | in-process callback (canary only) | critical |
| 6 | Token-refresh failure | log only, decays silently | warning; critical if token <4h from expiry |
| 7 | G-20 canary failure | own ad-hoc push (migrate into bus) | critical |
| 8 | `uncaughtException`/`unhandledRejection` | crash/log | critical (best-effort flush) |
| 9 | No-activity exhaustion (🔴 manual-intervention comment) | ticket comment | warning |

### What this deliberately does NOT solve

**The dead-man problem.** A dead connector can't alert about itself. That assertion lives
host-side (Grover's `config-sanity-watchdog`: `systemctl is-active` + `/health` curl — audit
rec P1-3). The startup alert (#1) is the bus's contribution: an unexpected *silence* after a
restart, or an unexpected restart alert, are both human-visible signals.

## Config

| Env | Default | Meaning |
|---|---|---|
| `ALERT_PUSH_ENABLED` | `true` | Push sink on/off (log+store sinks are unconditional) |
| `ALERT_PUSH_MIN_SEVERITY` | `warning` | Minimum severity that pushes |
| `ALERT_PUSH_BUDGET` | `10` | Max pushes per 15-min window |
| `ALERTS_DB_PATH` | `$DATA_DIR/alerts.db` | Store location |
| `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` | (existing) | Push target, same as G-20 canary |

## Console integration (Phase 3)

The `alerts` table is the console's event feed: list + filter by severity/source/agent, ack
button (`acked_at` column exists from day one), and the storm-digest links here.
