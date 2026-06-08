# P4-3: Periodic Distillation of Reject Metrics into Skill-Workshop Proposals

## Overview

P4-3 is a scheduled job that automatically creates skill-workshop proposals when reject patterns cross a configurable threshold. It's part of Phase 4's learning loop (design.md §8).

## How It Works

1. **Metric Scanning**: Runs periodically (e.g., hourly) and reads P4-2 metrics from `/api/observations/metrics`
2. **Threshold Detection**: Checks for `(workflow, step, reason_code)` patterns exceeding a configured threshold
3. **Proposal Generation**: Creates a pending skill-workshop proposal for each crossing pattern
4. **Review Pipeline**: The proposal goes through the existing `skill_workshop` propose → review → apply flow (never auto-applied)

## Files

- `p4-metrics-distillation.ts` - Core distillation logic
- `p4-distillation-job.ts` - Standalone job runner script

## Configuration

Environment variables:
- `P4_DISTILL_THRESHOLD` - Threshold for triggering a proposal (default: 3)
- `P4_DISTILL_CRON_SCHEDULE` - Cron schedule for automatic runs (optional)
- `MAX_PROPOSALS_PER_RUN` - Max proposals to generate per run (default: 10)

## Usage

### Manual Run

```bash
# Run distillation once
tsx src/cron/p4-distillation-job.ts

# Run with custom threshold
P4_DISTILL_THRESHOLD=5 tsx src/cron/p4-distillation-job.ts
```

### Scheduled Run (Cron)

The cron job should be registered during connector initialization. Example:

```typescript
import { registerDistillationCron } from "./cron/p4-metrics-distillation.js";

// Register with Gateway cron manager
registerDistillationCron("p4-distillation-job", "main");
```

## Proposal Format

Proposals follow this template:

```
# Skill: <workflow>-<step>-<reason-code>

At the "<step>" step of the "<workflow>" workflow, reviewers rejected for "<reason-code>" N× — proposed guidance: Add <reason-description> checklist items and update step documentation.

## Steps

1. Add <reason-code> checklist items
2. Update step documentation
3. Train on common pitfalls

## Acceptance Criteria

- [ ] <reason-code> checklist added
- [ ] Step documentation updated
- [ ] Reviewer guidelines updated
```

## Acceptance Criteria

From AI-1380:

- ✅ Metric crossing threshold produces exactly one pending skill-workshop proposal, `(workflow, step)`-scoped
- ✅ Proposal is pending — never applied/loaded without explicit approval
- ✅ Below-threshold patterns produce no proposal
- ✅ Re-running does not duplicate an existing open proposal for the same pattern

## Future Enhancements

- Configurable thresholds per workflow/step
- Learning rate adjustments based on proposal acceptance
- Historical analysis and trend detection
