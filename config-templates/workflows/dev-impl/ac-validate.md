# Step: ac-validate

## What to do

You are the **validator** (Astrid — steward). A ticket reaches this state after
the artifact has been deployed by the deployer. Your job is to verify that the
**running** artifact matches what was merged, and that the captured acceptance
criteria are satisfied.

### Verify the artifact

1. Read the ticket's acceptance criteria (captured at intake) and note the merge
   commit SHA from the `merge` step.
2. Determine the running commit on the target service:
   - **Connector fleet:** `curl <health-endpoint>/health` → `DEPLOY_COMMIT`
   - **Other services:** per the project's deploy-verification procedure
3. **Compare:** if the running commit does NOT include the merge commit, the
   deploy didn't land (or skipped silently). The code is correct but the
   artifact is stale — **do NOT route to a dev body**.

### Stale artifact path (AI-2463)

If the artifact is stale, use the dedicated `ac-mismatch` command to route back
to the `deploy` state for a redeploy:

```
linear ac-mismatch {identifier} --category stale-artifact --comment "reason"
```

This routes the ticket back to `deploy`, auto-assigned to the host-deployer
(Grover), without involving a dev body — the code was correct, the artifact
simply needs redeploying. The `ac-mismatch` path is separate from `ac-fail`,
which assumes a code defect and routes to a dev implementer.

### Code defect path

If the artifact is current but fails validation (acceptance criteria not met,
regression found), use `ac-fail` to route back to implementation:

```
linear ac-fail {identifier} --comment-file <path>
```

Provide specific feedback with a category so the implementer knows what to fix:
- `missing-tests`: tests don't cover the AC
- `correctness`: the implementation is wrong
- `ac-mismatch`: the implementation doesn't match the AC

### Validated path

If the running artifact satisfies all acceptance criteria:

```
linear continue-workflow {identifier} --comment-file <path>
```

This advances the ticket to `done` — the terminal state. The ticket is complete.

## What NOT to do

- Do NOT validate a stale artifact — `continue-workflow` on an undeployed change
  puts a non-functional ticket in `done`, invisible to all sweep and stall
  detectors. Always verify the running commit first.
- Do NOT use `ac-fail` for a stale artifact — that routes to a dev implementer
  who has no host access and would have to bounce it back. Use `ac-mismatch`.
- Do NOT skip verification because "the tests passed at code-review" — code
  review verifies the *code*, ac-validate verifies the *running artifact*. These
  are different things.
- Do NOT leave the ticket in `ac-validate` without completing it — unresolved
  `ac-validate` tickets block the pipeline.

## Context

This state was introduced in v8 (2026-06-10, Matt directive) as the final gate
before `done`. It addresses a historical gap: every previous step verified the
*artifact version*, none verified the *outcome* (AI-763). The steward who
validated AC at intake is the same steward who validates outcome at the final
gate, providing continuity.

The `ac-mismatch` path was added in v11 (AI-2463, 2026-07-16) to handle the
specific case where code is correct but the artifact hasn't been deployed — a
failure mode that previously had no legal route out of `ac-validate`.
