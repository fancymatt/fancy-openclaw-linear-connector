# Step: deploy

## What to do

You are the **deployer** (Grover for the connector/host-services fleet; this
role is configurable per project). The PR has already been merged in the
`merge` state. Your job is to deploy the artifact to production, or decide
that no deploy is needed.

### Deploy path

If a deployment is required:

1. Read the ticket's AC and the merge outcome (merge SHA from the `merge` step).
2. Deploy the artifact using the project's deploy procedure:
   - **Host services (connector, CLI):** restart the connector on Nakazawa,
     roll the CLI to agent containers, run any pending migrations.
   - **CI auto-deploy repos:** confirm the CI pipeline picked up the merge and
     deployed successfully — verify the live endpoint or published package.
   - **TestFlight/mobile:** push the build and confirm it appears in TestFlight.
3. Confirm the deployed version matches the merged SHA.
4. Advance to ac-validate.

### No deploy needed path

Some changes require no artifact deployment:

- **Library releases** where the merge is the release (consumers pull at their
  own cadence).
- **Docs-only or config-only changes** that take effect on merge.
- **CI-auto-deploy repos** where CI already deployed — in this case you
  verify the deploy happened and continue forward. Do NOT sit on the ticket.

When no deploy is needed, say so in your comment and advance:

```
linear continue-workflow {identifier} --comment-file <path>
```

The comment should state explicitly: "No deploy needed — [reason]" or "Deployed:
[version/SHA] — [verification]."

## What `continue-workflow` means at the deploy step

`continue-workflow` is the **only** forward verb. It advances deploy →
ac-validate regardless of whether a deploy action was performed. The generic
verb is identical to the one used in `merge` and `implementation` — only the
routing target changes.

```
linear continue-workflow {identifier} --comment-file <path>
```

## What NOT to do

- Do NOT skip this state silently — even if no deploy is needed, you must run
  `continue-workflow` to advance the ticket. A ticket stuck in `deploy` blocks
  the ac-validate gate.
- Do NOT use `reject` unless the deploy revealed a real regression that needs
  implementation work. CI flakiness or infra hiccups are not regressions.
- Do NOT mark the ticket Done — Done requires deployed + verified live (the
  ac-validate gate owns that).
- Do NOT re-merge the PR — the merge already happened in `merge`.

## Context

This state was introduced in AI-1872 (Matt directive, 2026-07-06). It replaces
the old `host-deploy` state and the `deploy` custom verb. The key design
principle: `continue-workflow` is the exit whether or not a deploy action
occurred — the deployer decides what's needed and advances the ticket.
