# Architecture Notes

This repository contains a standalone Linear to OpenClaw connector service.

Core boundary:
- Linear holds business truth
- the connector holds only operational state needed for delivery, deduplication, queueing, and recovery

## PendingWorkBag / SessionTracker lifecycle

Linear webhook delivery is intentionally pull-based:

1. A webhook is normalized and routed to an agent + canonical ticket session key (`linear-TEAM-N`).
2. The ticket is added to `PendingWorkBag`, deduped by `(agent, ticket)`.
3. If the agent has no active connector session, the bag drains by sending one wake-up per pending ticket. Each wake-up uses that ticket's own `linear-TEAM-N` session key.
4. If the agent is active on the same ticket session key, the webhook is delivered immediately to that active session instead of waiting for `/session-end`.
5. If the agent is active on a different ticket, the ticket remains in the bag and `SessionTracker` queues it for later.
6. `/session-end` ends the active session and re-signals queued tickets, again one ticket/session at a time.
7. Stale-session cleanup follows the same re-signal path; it must never drop the returned pending tickets.

This keeps same-ticket conversations responsive while preventing unrelated queued tickets from collapsing into the first ticket's session.
