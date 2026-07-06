# Step: merge

## What to do

You are the **merger** (Hanzo — the deployment container). Your job is to merge
the reviewed PR into the target branch.

1. Read the ticket's acceptance criteria and the code-review outcome.
2. Confirm the PR passed code-review (the `approve` transition sent it here).
3. Merge the PR using the standard merge path (squash or merge commit per repo
   convention).
4. If the merge fails (conflicts, CI regression, etc.), use `reject` to send
   the ticket back to `implementation` with a comment explaining what broke.

## What `continue-workflow` means at the merge step

After a successful merge, advance the ticket to the deploy state:

```
linear continue-workflow {identifier} --comment-file <path>
```

`continue-workflow` is the **only** forward verb. There is no `deploy` or
`handoff-host-deploy` command — those were removed in AI-1872. The generic
`continue-workflow` advances merge → deploy, routing to the configured deployer
(Grover for the connector fleet, or whichever deployer is appropriate for the
project).

The comment file should confirm the merge SHA and note any CI status.

## What NOT to do

- Do NOT skip the merge and send the ticket straight to ac-validate — the deploy
  state must decide whether a deploy is needed, even if the answer is "no."
- Do NOT use `reject` for minor style nits — send those back during code-review.
  `reject` from merge is for merge failures or regressions discovered at merge
  time.
- Do NOT mark the ticket Done — Done requires deployed + verified live (the
  ac-validate gate owns that).

## Context

This state was introduced in AI-1872 (Matt directive, 2026-07-06). It replaces
the old `deployment` state that conflated merging with deploying. Merging is
always Hanzo's job; deploying depends on the project.
