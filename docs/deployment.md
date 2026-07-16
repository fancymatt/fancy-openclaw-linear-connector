# Deployment Guide

> **Status:** v0.1 — functional for single-instance deployments. Not yet battle-tested at scale.

## Prerequisites

- **Node.js >= 20** (uses native `fetch`)
- **A Linear workspace** with admin access to create webhooks
- **An OpenClaw installation** with a running gateway

## Local Development Setup

```bash
# 1. Clone and install
git clone https://github.com/fancyfleet/fancy-openclaw-linear-connector.git
cd fancy-openclaw-linear-connector
npm install

# 2. Create your config
cp config/connector.example.yaml config/connector.yaml
# Edit config/connector.yaml — see docs/configuration.md for details

# 3. Set the webhook secret
export LINEAR_WEBHOOK_SECRET="your-secret-from-linear"

# 4. Start in dev mode (auto-restarts on file changes)
npm run dev
```

The server starts on port 3000 by default. Verify it's running:

```bash
curl http://localhost:3000/health
# → {"status":"ok","service":"fancy-openclaw-linear-connector"}
```

### Exposing to Linear During Development

Linear needs a public URL to send webhooks. Options:

- **ngrok:** `ngrok http 3000` — gives you a public URL like `https://abc123.ngrok.io`
- **Tailscale Funnel:** if you're already on Tailscale
- **Cloudflare Tunnel:** `cloudflared tunnel --url http://localhost:3000`

Your Linear webhook URL will be: `https://<your-public-url>/webhooks/linear`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `LINEAR_WEBHOOK_SECRET` | _(none)_ | HMAC secret from Linear webhook config. **Required.** Can also be set in `connector.yaml` but env var is preferred. |
| `LOG_LEVEL` | `info` | One of: `debug`, `info`, `warn`, `error` |

## Data Directory

The connector uses SQLite for its per-agent task queue:

```
data/agent-queue.db
```

This file is created automatically in `<project-root>/data/` on first run. It uses WAL mode for concurrent reads.

**Persistence:** The queue is recoverable — on restart, tasks that were in-flight are marked stale and the queue resumes cleanly. That said, don't delete this file while the service is running. For production, ensure the `data/` directory is on persistent storage (not a tmpfs).

## Health Check

```
GET /health
```

Returns `{"status":"ok","service":"fancy-openclaw-linear-connector"}` with HTTP 200. Use this for load balancer health checks, uptime monitors, or systemd watchdog integration.

## Production Deployment

### Option 1: systemd (Recommended for Linux)

Build first:

```bash
npm run build
```

Create `/etc/systemd/system/openclaw-linear-connector.service`:

```ini
[Unit]
Description=OpenClaw Linear Connector
After=network.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/opt/openclaw-linear-connector
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

Environment=PORT=3000
Environment=LINEAR_WEBHOOK_SECRET=your-secret-here
Environment=LOG_LEVEL=info

# SQLite needs write access to data/
ReadWritePaths=/opt/openclaw-linear-connector/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-linear-connector
sudo systemctl status openclaw-linear-connector
```

### Option 2: PM2

```bash
npm run build
pm2 start dist/index.js --name openclaw-linear-connector \
  --env PORT=3000 \
  --env LINEAR_WEBHOOK_SECRET=your-secret-here
pm2 save
pm2 startup  # generates system startup script
```

### Option 3: Docker

No official Dockerfile yet (v0.1). A minimal one:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ dist/
COPY config/ config/
VOLUME /app/data
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

```bash
npm run build
docker build -t openclaw-linear-connector .
docker run -d \
  -p 3000:3000 \
  -v connector-data:/app/data \
  -e LINEAR_WEBHOOK_SECRET=your-secret \
  openclaw-linear-connector
```

## Reloading Workflow Definitions (Without a Code Deploy)

`POST /admin/api/workflows/reload` re-reads all `.yaml` workflow definition files
from `WORKFLOW_DEFS_DIR` and hot-swaps the registry without restarting the
service or requiring a deploy.

**Usage:**

```bash
curl -X POST http://localhost:3000/admin/api/workflows/reload \
  -H "x-admin-secret: $ADMIN_SECRET"
```

**Success response (200):**

```json
{
  "ok": true,
  "registry": {
    "ui-audit": { "version": 3, "states": ["todo", "doing", "done"] },
    "dev-impl": { "version": 5, "states": ["todo", "implementation", "code-review", "done"] }
  }
}
```

If any def file fails validation (native_state mapping, state-removal check,
gate-anchor drift, fanout/barrier config), the endpoint returns **422** with
diagnostics **and the prior registry is left intact**:

```json
{
  "ok": false,
  "diagnostics": [
    "bad-def.yaml: Workflow definition 'bad-def' has 1 invalid native_state mapping(s): ..."
  ]
}
```

Catastrophic failures (unreadable defs directory, etc.) return **502** with an
error message.

> **Design decision (INF-25):** This is an explicit, audited operation — not a
> filesystem watcher. A def going live because someone saved a file is a worse
> failure mode than the one this fixes. Hot-reload is the only way to activate
> a config-only change without a full code deploy.

## Reverse Proxy

In production, put the connector behind nginx or Caddy with HTTPS. Linear sends webhooks over HTTPS and validates the URL on creation.

Example nginx location block:

```nginx
location /webhooks/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```
