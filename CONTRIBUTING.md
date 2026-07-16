# Contributing

Thanks for your interest in contributing to fancy-openclaw-linear-connector!

## Local Setup

```bash
git clone https://github.com/fancymatt/fancy-openclaw-linear-connector.git
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
