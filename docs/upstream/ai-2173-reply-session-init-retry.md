# Upstream: Reply-Session Init Retry + Dead-Letter (AI-2173 AC1)

**Filed:** 2026-07-18  
**Tracker:** AI-2173 (fancyfleet)  
**Target:** OpenClaw Gateway core (`get-reply.js` / `session-accessor.js`)

## Problem

When two reply-session initializations race for the same `sessionKey`, OpenClaw's optimistic-concurrency guard (`commitReplySessionInitialization` with `expectedRevision` check) retries **once** (`staleSnapshotRetried`), then throws:

```
Error: reply session initialization conflicted for <sessionKey>
```

The inbound message is dropped with `outcome=error`. No re-queue, no backoff, no dead-letter, no alert.

During a gateway restart cascade (config edit → double restart → Matrix re-sync re-delivering recent events), this reliably eats real inbound messages. On 2026-07-12 it ate 4 messages from Matt (see AI-2171 for incident details).

## Current Behavior

In `get-reply-CknL88Yv.js` (`initSessionStateAttemptLocked` path):

```
1. commitReplySessionInitialization() — optimistic write with expectedRevision
2. On !committed.ok:
   - If not staleSnapshotRetried → retry once (call initSessionStateAttemptLocked with staleSnapshotRetried=true)
   - If staleSnapshotRetried → throw Error, message dropped
```

The single retry has no backoff (same tick). The failure has no durable landing zone.

## Desired Behavior

1. **Retry with exponential backoff** (3 attempts: 1s, 2s, 4s or similar) instead of a single immediate retry.
2. **Dead-letter on exhaustion:** after max retries, write the inbound message to a durable dead-letter queue/ingress store instead of discarding it.
3. **Alert on dead-letter:** emit a warning/alert when a message is dead-lettered, so operators know ingestion stalled.
4. **SessionKey-level init lock** (optional, depending on architecture): a per-`sessionKey` mutex so concurrent init attempts serialize rather than race. This would prevent the conflict entirely, making retry a backstop rather than the primary defense.

## Affected Files

- `dist/get-reply-*.js` — the `initSessionStateAttemptLocked` path that calls `commitReplySessionInitialization` and throws on second failure
- `dist/session-accessor-*.js` — `commitReplySessionInitialization` implementation, optimistic-concurrency write

## Suggested Implementation Approach

### Option A: Inline retry + dead-letter in get-reply handler

Modify the get-reply handler's `initSessionStateAttemptLocked`:

```
staleSnapshotRetried → attempt counter with maxAttempts=3
  attempt 1: immediate retry (keep current)
  attempt 2: 1s backoff
  attempt 3: 2s backoff
  exhausted: write to dead-letter store, emit circuit-breaker event, return 503/dropped-but-tracked
```

Pros: contained change, no architectural changes  
Cons: dead-letter store needs to be wired, restart may lose in-flight dead letters

### Option B: Per-sessionKey init lock

Add a `Map<sessionKey, Promise>` guard in the `get-reply` handler that coalesces concurrent inits for the same key:

```
if (initLock.has(sessionKey)) return initLock.get(sessionKey);
const promise = commitReplySessionInitialization(...).finally(() => initLock.delete(sessionKey));
initLock.set(sessionKey, promise);
return promise;
```

Pros: prevents the race entirely, not just handles the aftermath  
Cons: in-memory state can leak if the promise never settles; needs a timeout

### Recommended: A + B

Deploy the sessionKey lock as the primary defense (prevents the race) and the retry+dead-letter as the backstop (catches any residual failures from other causes). The lock alone doesn't help if the race is between two different gateway instances.

## Tracking

- [ ] filed as upstream OpenClaw issue  
- [ ] retry-with-backoff implemented  
- [ ] dead-letter queue wired  
- [ ] alert path wired  
- [ ] sessionKey init lock evaluated and implemented if appropriate  

## References

- AI-2171 (incident report, root cause, log excerpts)
- AI-2173 (this ticket — overall hardening work)
