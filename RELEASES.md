# Releases & Branching

This repo follows a maintenance-branch model: `main` tracks the next major version, and each released major lives on its own long-lived branch. Bug fixes are written on `main` and cherry-picked back when they apply.

## Current state

| Branch / tag   | Purpose                              | Deploys to              |
|----------------|--------------------------------------|-------------------------|
| `main`         | Next major (v1.1 in development)     | fancymatt (after v1.1)  |
| `release-1.0`  | v1.0 maintenance                     | ILL, fancymatt (today)  |
| tag `v1.0.0`   | Frozen v1.0 release point            | —                       |

v1.1 design: see Linear AI-491.

## Branching workflow

- All new development goes to `main`. Do **not** start work on `release-1.0`.
- Active maintenance branches receive only cherry-picked fixes from `main`.
- When a new major releases (e.g. v1.1.0), tag the commit and create `release-1.1` from it.
- The previous maintenance branch (e.g. `release-1.0`) stays alive until its EOL date, then gets archived (no further commits, but keep the branch in the repo for history).

## Cherry-pick policy

What gets backported from `main` to active `release-x.y` branches:

| Change type                       | Backport?                       |
|-----------------------------------|---------------------------------|
| Security fix                      | **Always**                      |
| Data-loss / corruption bug        | **Always**                      |
| Crash or hang bug                 | Yes if reproducible on the older release |
| Behavior bug                      | Case-by-case; default no        |
| Ergonomic / refactor              | **Never**                       |
| New feature                       | **Never**                       |

When backporting, use `git cherry-pick -x <sha>` so the commit message records the original SHA on `main`. Keeps the trail visible in `git log`.

## PR labels

Apply `backport-1.0` to PRs that should land on `release-1.0` after merging to `main`. Whoever merges is responsible for opening the cherry-pick PR (or doing the cherry-pick directly if trivial).

## CI

CI must run against both `main` and active maintenance branches. A regression that only appears on `release-1.0` is still a regression we own.

## Schema coexistence between releases

When a major release introduces a schema change (e.g. v1.1's `PendingWorkBag` vs v1.0's `AgentQueue`), use a **different SQLite file** rather than migrating in place. This way:

- v1.0 and v1.1 binaries can run on the same host without colliding.
- Rollback from v1.1 → v1.0 is just "redeploy the v1.0 binary"; the old database is untouched and remains valid.

## EOL

Each maintenance branch should have an EOL commitment when its successor ships. Default: 6 months of bugfix backports after the next major reaches GA. Document the EOL date in this file when set.

| Release      | Status     | EOL    |
|--------------|------------|--------|
| v1.0.x       | Active     | TBD (set when v1.1 GAs) |

## Sibling repos

`linear-webhook-ill` is maintained independently on its own `main` and does not participate in this branching scheme. Security or data-loss fixes can be manually ported between the two repos as needed.
