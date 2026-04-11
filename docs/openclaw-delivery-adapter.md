# OpenClaw delivery adapter

The delivery adapter is the boundary between connector-side routing/queue logic and the downstream OpenClaw destination.

## Responsibilities

- accept a routed task payload after routing and queue decisions are already made
- format a stable assignment payload for OpenClaw delivery
- send that payload to the configured OpenClaw destination
- surface delivery failures clearly without owning retry policy, queue policy, or routing policy

## Non-responsibilities

The adapter does not decide:
- whether an event should be routed
- which agent should receive the work
- whether the task is active or queued
- retry scheduling rules

## Payload shape

```ts
interface OpenClawAssignmentPayload {
  version: 1;
  source: "linear";
  agentId: string;
  sessionKey: string;
  priority: number;
  eventType: string;
  action: string;
  issue?: {
    id?: string;
    identifier?: string;
    title?: string;
    url?: string;
    teamKey?: string;
    stateName?: string;
    assigneeName?: string;
    priority?: number;
  };
  summary: string;
  rawEvent: LinearEvent;
}
```

## Configurability

For v0.1 the adapter is configured primarily through:
- the OpenClaw gateway base URL
- the routed destination session key and agent id

Future versions may add alternate transports or payload-template hooks, but the adapter boundary should stay isolated from routing and queue logic.
