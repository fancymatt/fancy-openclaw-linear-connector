# AI-2207: capability-policy.yaml additions

These changes were applied directly to the live instance config at
`/home/node/linear-connector/config/capability-policy.yaml` on Nakazawa.

The connector repo does not version-control instance config — this doc records
the diff for review and historical reference. Once the connector supports a
template-driven capability policy workflow, this pattern can change.

## New role: `visual-reviewer`

```yaml
  - id: visual-reviewer
    requires: [linear:transition]
    note: >
      Visual audit role for ui-audit workflow (AI-2207). Reviews screenshots at
      multiple breakpoints, produces structured pass/fail verdicts. Model-level
      vision capability required (not a system capability). Multi-body: Signe
      (UX lens) and Caspar (visual fidelity lens). Capture state uses this role
      for v1; browser-automation role + Playwright agent is follow-up work.
```

## Updated bodies

### signe
Before: `fills_roles: [ux-researcher, worker]`
After:  `fills_roles: [ux-researcher, visual-reviewer, worker]`

### caspar
Before: `fills_roles: [image-generator, worker]`
After:  `fills_roles: [image-generator, visual-reviewer, worker]`

## AI-2525 follow-up: new role `browser-automation`

```yaml
  - id: browser-automation
    requires: [browser:execute]
    capabilities: [browser:execute]
    note: >
      Automated browser capture role for ui-audit workflow (AI-2525).
      Runs headless Chromium via Playwright to capture screenshots at
      multiple breakpoints. Single-body assignment (igor).
```

## Updated bodies

### igor
Before: `fills_roles: [backend-dev, worker]`
After:  `fills_roles: [backend-dev, browser-automation, worker]`
