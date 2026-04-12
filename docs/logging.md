# Logging

The connector uses [pino](https://github.com/pinojs/pino) for structured JSON logging.

## Setting the log level

Priority order (highest wins):

1. `LOG_LEVEL` environment variable — `debug`, `info`, `warn`, or `error`
2. `logLevel` field in connector config file
3. Default: `info`

```bash
# Run with debug logging
LOG_LEVEL=debug node dist/index.js

# Pretty-print in development
LOG_LEVEL=debug node dist/index.js | npx pino-pretty
```

## What each component logs

Every log entry includes a `component` field for filtering.

| Component    | Key events                                                        |
|-------------|-------------------------------------------------------------------|
| **server**  | Startup, incoming requests (debug)                                |
| **webhook** | Event received (type + action), signature validation, rejections  |
| **routing** | Match found (agent + reason: assignee/team), unmapped events      |
| **queue**   | Enqueue decision (deliver vs queued), complete, promote           |
| **delivery**| Attempt, success (status code), failure (status code or error)    |

## Tracing a single event

Filter logs by `component` to follow an event through the pipeline:

```bash
# Full pipeline trace for a single run
node dist/index.js | npx pino-pretty | grep -E '"component":"(webhook|routing|queue|delivery)"'
```

A successful event produces this sequence:

1. `webhook` → `"event accepted"` (eventType, action)
2. `routing` → `"routed by assignee match"` or `"routed by team fallback"` (agentId, reason)
3. `queue` → `"task activated for immediate delivery"` or `"task queued behind active task"` (agentId)
4. `delivery` → `"attempting delivery"` → `"delivery succeeded"` (agentId, statusCode)

### Diagnosing dropped events

- **No webhook log** → event never reached the server (check Linear webhook config, network)
- **webhook `rejected:`** → signature/payload issue (check `LINEAR_WEBHOOK_SECRET`)
- **routing `unmapped event`** → no routing rule matched (check routing config for agent/team mappings)
- **queue `queued`** → agent already busy; task will be promoted when current task completes
- **delivery `failed`/`error`** → gateway rejected or unreachable (check `openclawGatewayUrl`, gateway status)
