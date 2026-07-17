# Escape and Rewind

`escape` has no fleet-wide meaning. Each workflow defines its own escape behavior in its `break_glass:` block: the command name, the `to:` state, and that target state's `kind` and `native_state`.

Before running `escape` on an unfamiliar workflow, read the workflow def and inspect `break_glass.to`. If that target state's `kind` is `terminal`, or its `native_state` is `invalid`, escape is destructive for that workflow.

| Shape | Live example | What `escape` does | Recovery risk |
| --- | --- | --- | --- |
| Re-entry escape | `wf:dev-impl` | Sends the ticket back to `intake` | Recoverable; this behaves like a workflow re-entry. |
| Terminal escape | `wf:sprint-spawner` | Sends the ticket to `escape`, whose native Linear state is `invalid` | Destructive; the ticket is no longer live in the workflow. |

The same verb name can mean opposite things. In `wf:dev-impl`, `escape` re-enters the workflow. In `wf:sprint-spawner`, `escape` is terminal and invalidates the ticket.

`escape` is not a rewind. To correct a state the engine advanced in error, use the steward `rewind` verb instead:

- capability: `workflow:break-glass`
- intent: `rewind`
- target header: `X-Openclaw-Rewind-Target`
- target rule: the target must be a live state in the ticket's own workflow def
- audit: the connector records an operational event and posts a Linear comment

The deployed `sprint-spawner.yaml` is vault-resident under `life-os/project-management/workflows/sprint-spawner/`, not in this repository. Any def-level rename or guard for its terminal-invalid escape is tracked outside this repo under INF-30.
