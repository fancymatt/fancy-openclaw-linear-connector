# fancy-openclaw-linear-connector

A standalone connector service that bridges [Linear](https://linear.app) webhooks to [OpenClaw](https://openclaw.com) agent sessions. This is **not** an OpenClaw plugin or skill — it's an independent service that receives Linear webhook events and routes them to the appropriate OpenClaw agents.

> **Status:** v0.1 in development

## Design Principles

1. **Linear is the system of record** — the connector never maintains authoritative state
2. **Don't duplicate what Linear tracks** — priority, status, queue position all live in Linear
3. **Agents respond immediately, even when queued** — acknowledgment is instant, execution is ordered
4. **Reliability through derivability** — any agent can reconstruct its queue from Linear alone
5. **Deterministic behavior** — same events + same state = same decisions
6. **Recoverability** — restart should be boring, no operator cleanup required
7. **Config, not code forks** — different deployments are different configs of the same binary
8. **Conservative action model** — when uncertain, avoid destructive actions

## Project Structure

```
src/
  index.ts              Service entrypoint
  config/index.ts       Configuration loader
  webhook/index.ts      Linear webhook handler
  routing/index.ts      Event routing engine
  queue/index.ts        Agent queue manager
  delivery/index.ts     OpenClaw session adapter
  persistence/index.ts  Event store
config/
  connector.example.yaml  Example configuration
docs/
  architecture.md       System architecture
  deployment.md         Deployment guide
  configuration.md      Configuration reference
```

## Getting Started

### Prerequisites

- Node.js >= 20
- A Linear workspace with webhook access
- An OpenClaw installation

### Setup

```bash
git clone https://github.com/fancymatt/fancy-openclaw-linear-connector.git
cd fancy-openclaw-linear-connector
npm install
cp config/connector.example.yaml config/connector.yaml
# Edit config/connector.yaml with your settings
```

### Development

```bash
npm run dev      # Start in development mode
npm run build    # Compile TypeScript
npm run lint     # Run linter
npm test         # Run tests
```

## Related

- [fancy-openclaw-linear-skill](https://github.com/fancymatt/fancy-openclaw-linear-skill) — Companion OpenClaw skill that agents use to interact with Linear

## License

[MIT](LICENSE) © 2026 Matt Henry
