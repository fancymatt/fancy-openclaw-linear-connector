# Runbook: Batch Config-Edit Restarts (AI-2173 AC2 + AC3)

## Problem

Back-to-back container restarts (restart cascade) cause inbound message loss during
the gateway's Matrix re-sync window. When two restart signals arrive within a narrow
window (e.g. one config edit at 09:12:52 and another at 09:13:56), each restart
triggers a full Matrix re-sync that re-delivers recent events. The overlapping init
attempts race on reply-session initialization, and the second racer's message is dropped.

**Incident:** AI-2171 — 4 inbound Matrix messages from Matt silently dropped during a
double-restart cascade on 2026-07-12.

## Operational Procedure

### Rule: One Restart per Config Batch

1. **Collect all config changes first** — before restarting, ensure every planned
   config edit (agents.json, .env, workflow defs, docker-compose.yml changes) is
   staged and committed.
2. **Restart once** — run `docker compose restart` (or `docker compose up -d`) exactly
   once after all changes are applied.
3. **Verify after restart** — check `/health` and monitor for a full heartbeat cycle
   before making additional changes.

### When Config Doesn't Need a Restart

| Change Type | Restart Required? | Mechanism |
|---|---|---|
| `agents.json` edit | No | Hot-reloaded via `onAgentsReloaded` — connector picks up changes live |
| Workflow def YAML changes | No | `POST /admin/api/workflows/reload` hot-swaps defs without restart |
| `.env` changes | **Yes** | Environment is baked at container start |
| `docker-compose.yml` changes | **Yes** | Docker compose re-reads when container is recreated |
| `capability-policy.yaml` changes | No | Loaded on demand from mounted volume |

### Restart Cooldown Guard

The included `scripts/guard-restart-cooldown.sh` script enforces a minimum interval
between restarts. Install it:

```bash
# Replace your restart command with the guarded wrapper:
alias dc-restart='scripts/guard-restart-cooldown.sh docker compose restart'

# Or invoke directly:
scripts/guard-restart-cooldown.sh docker compose restart
```

**Default cooldown:** 120 seconds. Override with `--cooldown <seconds>`.

**Bypass:** `scripts/guard-restart-cooldown.sh --force docker compose restart`
(only for scheduled maintenance windows when the restart is expected).

**Check status:** `scripts/guard-restart-cooldown.sh --status`

## Contention Surface (AC3)

### Trigger: astrid's hourly `connector-ticket-watch` cron

The cron job (id `799850a5...`) shares a target room/sessionKey with inbound Matrix
traffic. During a restart cascade, both the cron's wake-up and Matrix re-delivery
events can race on the same reply-session init.

### Mitigation

Two strategies are available (choose one):

1. **Stagger the cron:** Shift astrid's `connector-ticket-watch` cron to fire at a
   different minute than typical restart events resolve. For example, if restarts
   complete within 30s of the trigger, schedule the cron at `:15` past the hour
   (vs `:00` restart windows). Note: this is a fragile coincidence — restart time
   varies.

2. **Per-sessionKey init lock (upstream):** The upstream fix for AC1 (per-sessionKey
   init lock in `commitReplySessionInitialization`) serializes concurrent init
   attempts regardless of source. This is the durable fix. See
   `docs/upstream/ai-2173-reply-session-init-retry.md`.

3. **Suppress cron during restart window:** A crontab `flock` guard or a git-based
   deploy-pending flag prevents the cron from firing while a restart is in progress.
   Simple, but requires coordination between deploy and cron.

### Current Stance

As of 2026-07-18, **recommend no action on AC3 until AC1 (upstream per-sessionKey
init lock) is resolved.** The lock eliminates the race regardless of source. If AC1
is deferred, revisit AC3 with option 3 (cron flock guard).
