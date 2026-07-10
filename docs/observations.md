# Observations (Phase 4 learning loop)

## What This Is

`data/observations.db` is an **append-only record of reviewer feedback**. Every
workflow transition whose definition carries `feedback.required: true` — dev-impl
`request-changes`, `reject`, `ac-fail` — writes exactly one row. Rows are never
updated or deleted.

This is the input to the Phase 4 learning loop (clustering → proposals → apply).
It is *not* business truth; Linear remains authoritative for issue state.

| Column          | Meaning                                                        |
|-----------------|----------------------------------------------------------------|
| `ticket`        | Issue identifier, e.g. `AI-2036`                                |
| `workflow`      | Workflow ID, e.g. `dev-impl`                                    |
| `step`          | The state feedback was given **from**, e.g. `code-review`       |
| `from_body`     | The **implementer** whose work was rejected                     |
| `reviewer_body` | The agent that gave the feedback                                |
| `reason_code`   | A `category_enum` value, or `unspecified` (see below)           |
| `free_text`     | The reviewer's comment body                                     |
| `wake_id`       | Dispatch-cycle correlation id; nullable, no backfill            |
| `created_at`    | ISO-8601 write time                                             |

Indexed on `(workflow, step, reason_code)` — the grouping the metric rollup and
clustering both use.

## How a row gets written

The connector derives everything server-side. **No CLI flag or header is
required.** Two fields resolve through a fallback chain, highest priority first:

**`from_body`**
1. `X-Openclaw-From-Body` header (no released CLI sends this)
2. The delegate resolved for this transition — every feedback-required transition
   routes back to the worker state, so its destination delegate *is* the implementer
3. The recorded implementer from `implementer-store`

**`reason_code`**
1. `X-Openclaw-Feedback-Category` header (no released CLI sends this)
2. A `Category:` directive on its own line in the reviewer's comment
3. `unspecified` — a **degraded** write

### Declaring a category as a reviewer

Put a directive on its own line anywhere in the `request-changes` comment:

```
The retry path has no coverage. Please add tests before resubmitting.

Category: missing-tests
```

`Category:`, `Reason:`, and `reason_code:` are all accepted, case-insensitively.
The value must be one of the transition's `category_enum` values. A category
mentioned in prose is ignored — only a directive on its own line counts.

Without a directive the row still lands, carrying `reason_code = unspecified`.
That is deliberate: `(workflow, step, from_body)` is worth keeping even when the
category is missing, and every degraded write is counted so the gap stays visible.

## Why this was rewritten (AI-2036)

The table held **zero rows** from the day it shipped (AI-1378) until AI-2036.

The write was guarded by four preconditions. The spike (AI-2027) suspected the
`X-Openclaw-From-Body` header. It was not the culprit — it was not even reachable.
Each precondition was checked independently against the commit production was
running at diagnosis time (`98cb64e`, confirmed via `GET /health`):

| # | Precondition | Verdict | Evidence |
|---|--------------|---------|----------|
| a | `feedback.required` on the transition | **satisfied** | `canonical-dev-impl.yaml` sets `feedback.required: true` with a `category_enum` on `request-changes` / `reject` / `ac-fail` |
| b | `observationStore` wiring | **satisfied** | `index.ts` constructed the store and passed it into the `/proxy/graphql` deps |
| c | `feedback` payload present | **ROOT CAUSE** | `proxy.ts` built the payload only `if (feedbackCategoryHeader && ...)`. No client sends `X-Openclaw-Feedback-Category` — zero matches across the CLI's `src/`, `dist/`, and `scripts/`. So `options.feedback` was always `undefined` |
| d | `X-Openclaw-From-Body` header | latent, **unreachable** | Also never sent by any client — but its check lived *inside* the block that (c) short-circuited, so it never executed |

The decisive detail is the shape of the guard:

```ts
if (matchedTransition?.feedback?.required && options?.observationStore && options?.feedback)
```

Preconditions (a)–(c) sat in the `if` condition itself, so failing (c) skipped the
block with **no row, no counter, and no log line**. Only (d) and an invalid reason
code had `log.warn` calls — and both were inside the block, downstream of (c).

That yields a falsifiable prediction, and it is the evidence AC1.1 asks for: the
warn `fromBody not provided (X-Openclaw-From-Body header absent)` was emitted
**zero times** in production. Had (d) been the culprit, that warn would fire on
every review transition while the store stayed empty. The simultaneous absence of
the warn *and* of any rows is consistent only with (c).

Fixing (d) alone — shipping a CLI that sends `X-Openclaw-From-Body` — would have
left the table at zero rows, because (c) short-circuits first.

The fix removes the dependency on clients telling the connector what it already
knows, and makes every outcome countable.

### Consequence for P4-3

The table filling up wakes the hourly distillation cron, which had never run
against real data. Its threshold is 3, so the first cluster to cross would be
`unspecified` — proposing "unspecified rejected 3× — add checklist". Degraded rows
are therefore counted and reported as crossed, but never proposed from.

## Liveness and telemetry

A silent skip is no longer possible. Each outcome increments an in-process
counter and emits an operational event:

| Outcome                | Meaning                                               |
|------------------------|-------------------------------------------------------|
| `observation-written`  | Row appended with a real reviewer category             |
| `observation-degraded` | Row appended with `reason_code = unspecified`          |
| `observation-skipped`  | No row. `detail.skipReason` says why                   |

Skip reasons: `store-unwired` (bootstrap wiring gap), `from-body-unresolved`
(no implementer could be derived), `write-failed` (the insert threw).

`GET /health` exposes the write path without waiting for a transition to occur:

```json
"observations": {
  "registered": true,
  "dbPath": "/srv/connector/data/observations.db",
  "rows": 42,
  "appended": 3, "degraded": 1, "skipped": 0,
  "skipsByReason": { "store-unwired": 0, "from-body-unresolved": 0, "write-failed": 0 }
}
```

`registered` is set only by `registerObservationWriter()` at server bootstrap, and
`rows` is read live from SQLite — neither is a literal. If a refactor ever drops
the bootstrap call, `registered` goes false and every feedback transition emits a
counted `store-unwired` skip.

Nothing on this path can block a transition: observation failures are counted,
logged, and swallowed.

## Reading the data

- `GET /admin/api/observations` — raw rows
- `GET /admin/api/observations/counts` — grouped by `(workflow, step, reason_code)`
- `GET /admin/api/observations/metrics?threshold=N` — the rollup, with
  `exceedsThreshold` flags. This is the "missing-tests ×14 this month" view.

## Safe to delete?

Yes, but you lose learning-loop history. Nothing else depends on it.
