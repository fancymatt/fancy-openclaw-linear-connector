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
