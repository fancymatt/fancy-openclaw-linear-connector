# Management Console (Phase 3)

The connector serves a React SPA at `/admin` — the operational console for the
workflow engine. It replaces the old server-rendered admin pages.

## Architecture

- **SPA**: `web/` — React 18 + Vite + TypeScript, no UI framework. Built assets
  land in `web/dist/` (gitignored) and are served statically by the connector
  at `/admin`. Client routes (`/admin/fleet`, `/admin/alerts`, …) fall back to
  `index.html`; `/admin/api/*` is never shadowed.
- **API**: `src/admin.ts` — JSON under `/admin/api/`. All data endpoints
  require auth; static assets are public (they contain no data).
- **Auth** (`src/admin-session.ts`):
  - Header auth unchanged: `x-admin-secret`, `Bearer`, or HTTP Basic with
    `ADMIN_SECRET` — first-class for scripts and the readonly socket.
  - Browser sessions: `POST /admin/api/login {password}` checks against
    `ADMIN_SECRET` (timing-safe, rate-limited 10 failures / 5 min / IP) and
    sets an `admin_session` cookie — an HMAC token keyed by
    HKDF(ADMIN_SECRET), 12 h expiry, HttpOnly, SameSite=Lax. Stateless, so
    sessions survive connector restarts; rotating `ADMIN_SECRET` invalidates
    every session at once.
  - `GET /admin/api/me` reports auth state; `POST /admin/api/logout` clears
    the cookie.

## Endpoints added for the console

| Route | Feeds |
|---|---|
| `GET /admin/api/fleet` | Fleet page — agent rows + dispatch-ack entries (`listRecent`) + registry⇄policy + config health |
| `GET /admin/api/alerts` | Alerts page — `alerts.db` query (severity/source/agent/since/limit) |
| `GET /admin/api/workflows` | Workflows page — full loaded workflow definitions |

Pre-existing endpoints (`dashboard`, `structure`, `events`, `observations*`,
`set-state`, per-ticket snapshots) are unchanged.

## Build & deploy

The host deploy path (`npm run build` = `tsc` → restart) does **not** build the
SPA. Build it in the dev container whenever `web/src` changes:

```sh
npm --prefix web install --include=dev   # once (NODE_ENV=production skips dev deps otherwise)
NODE_ENV=development npm --prefix web run build
```

The repo mount is the host repo, so the fresh `web/dist` is immediately what
prod serves after the normal `.deploy-request` cycle. If `web/dist` is missing,
`/admin` serves a 503 placeholder and the API keeps working.

Local dev loop: `PORT=3199 node dist/index.js` in the repo root, then
`npm --prefix web run dev` (Vite proxies `/admin/api` to 3199).

## Roadmap (rest of Phase 3)

- Fleet management: agent CRUD + onboarding wizard, token status/rotation
- Webhook management: registration, secret rotation, delivery log, replay
- Visual workflow editor with validation, versioned diffs, dry-run simulator
- Capability-policy editor with join-spine visualization
- Ops actions: retry/replay, deploy button
