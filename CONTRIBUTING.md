# Contributing

Thanks for your interest in contributing to fancy-openclaw-linear-connector!

## Local Setup

```bash
git clone https://github.com/fancyfleet/fancy-openclaw-linear-connector.git
cd fancy-openclaw-linear-connector
npm install
npm run build
```

## Concurrent Sessions — Use a Worktree (required for agents)

Several agent sessions share one clone of this repo. A single working tree and
HEAD means a concurrent session's `git checkout` can yank your checkout mid-edit,
and a `git add -A` can capture another session's half-finished state under your
commit (AI-2475). **Do not do connector dev directly in the shared clone's
primary tree.** Instead, spin an isolated worktree as your first step:

```bash
# creates/reuses .worktrees/<slug> with its own HEAD, index, and files
cd "$(./scripts/connector-worktree.sh <linear-branch-name>)"
# ...edit, commit, push from here — the primary tree can't touch it...

# when done (from anywhere in the repo):
./scripts/connector-worktree-remove.sh <linear-branch-name>
```

Worktrees live under `.worktrees/` (gitignored) and share `.git/objects`, so
setup is instant and costs no extra disk. Never `git add` a worktree directory.

### Arming the isolation hook — and keeping it current (INF-19)

The worktree guard above is enforced by a `reference-transaction` hook that is
**armed by copying it out of the tree** into `.git/hooks/` via
`scripts/connector-reftxn-arm.sh`. Because the armed copy lives outside the
working tree, nothing makes it converge when the tracked hook changes upstream —
**"the fix merged" is not "the fix is live."** A clone can run an arbitrarily old
hook while `git log` shows the fix landed hours ago; that exact
tracked-vs-armed drift made INF-17 look like a different bug than it was.

Two guards close this:

```bash
# Arm (or re-arm) a clone. Self-gates on 15m HEAD quiescence; --force bypasses.
# Arming ALSO installs post-merge + post-rewrite hooks that auto-re-arm on every
# pull/rebase, so an already-armed clone self-converges from then on.
scripts/connector-reftxn-arm.sh

# Is my armed copy current? 0 in-sync, 1 drift, 2 not-armed, 3 no tracked source.
scripts/connector-reftxn-arm.sh --check

# What's armed, what version, is auto-re-arm on?
scripts/connector-reftxn-arm.sh --status
```

Rules of thumb:

- **A fresh clone, or one parked on a branch that predates the hook, is NOT
  protected.** Auto-re-arm only maintains an *already-armed* clone — it will not
  silently arm one left disarmed on purpose. Run the arm script **once by hand**
  to bootstrap; after that, pulls keep it current automatically.
- **After merging any change to the hook**, every already-armed live clone
  refreshes on its next pull. To confirm (or to converge a clone that hasn't
  pulled), run `--check` and re-arm if it reports `DRIFT` / `NOT-ARMED`.
- The hook carries a `REFTXN_HOOK_VERSION` stamp. A refusal prints it, and
  `.git/hooks/reference-transaction --version` prints it — so a bug report can
  state exactly **which hook actually ran**.

## Branch Naming

Use Linear's auto-generated branch names (e.g., `ai-205-bootstrap-repo`). This keeps branches linked to their tickets automatically.

## Pull Request Process

1. Create a branch from `main` using the Linear branch name
2. Make your changes with clear, atomic commits
3. Ensure `npm run build` and `npm run lint` pass
4. Open a PR referencing the Linear ticket ID (e.g., `AI-205`)
5. Fill out the PR template — the Linear ticket link is required

## Code Style

- **TypeScript strict mode** — no implicit `any`, strict null checks enabled
- **ESLint** — run `npm run lint` before committing
- Keep modules focused and small
- Prefer explicit types over inference for public APIs
- Write comments that explain *why*, not *what*

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind.
