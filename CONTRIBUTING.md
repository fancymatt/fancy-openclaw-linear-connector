# Contributing

Thanks for your interest in contributing to fancy-openclaw-linear-connector!

## Local Setup

```bash
git clone https://github.com/fancymatt/fancy-openclaw-linear-connector.git
cd fancy-openclaw-linear-connector
npm install
npm run build
```

## Branch Naming

Use Linear's auto-generated branch names (e.g., `ai-205-bootstrap-repo`). This keeps branches linked to their tickets automatically.

## Pull Request Process

1. Create a branch from `main` using the Linear branch name
2. Make your changes with clear, atomic commits
3. Ensure `npm run build` and `npm run lint` pass
4. **Run the full test suite and confirm it is green:**
   ```bash
   npm test
   ```
   Every `*.test.ts` file must load and run. A suite that fails to load (e.g. wrong import specifier) is a red result even if jest reports 0 failures — check that the suite count matches expectations. Do not rely on a test count reported by the developer; run it yourself.
5. Open a PR referencing the Linear ticket ID (e.g., `AI-205`)
6. Fill out the PR template — the Linear ticket link is required

## Code Review Gate (reviewers)

Before approving any PR:

1. Check out the branch locally and run `npm test` to completion.
2. Treat **any** of the following as a red result requiring `request-changes`:
   - Any test failure
   - Any suite that errors at load (e.g. `Cannot find module`, wrong import specifier)
   - A test count that is lower than main — suites that failed to load are invisible in the pass count
3. Do not approve based on a developer-reported test count. Run the suite yourself and read the suite count line, not just the test count line.

## Code Style

- **TypeScript strict mode** — no implicit `any`, strict null checks enabled
- **ESLint** — run `npm run lint` before committing
- Keep modules focused and small
- Prefer explicit types over inference for public APIs
- Write comments that explain *why*, not *what*

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind.
