/**
 * Test-env isolation. The connector's production `.env` (loaded via
 * `import 'dotenv/config'` when tests import app modules) must never leak
 * deployment config into the suite. dotenv does NOT override variables that
 * already exist, so pinning these to "" here — before any test module loads —
 * keeps them falsy regardless of what `.env` or the host shell carries.
 *
 * Tests that need one of these set their own value in beforeAll/beforeEach.
 */
import fs from "fs";
import os from "os";
import path from "path";

// Every sqlite store defaults to DATA_DIR (falling back to <cwd>/data — the
// LIVE deployment databases, since jest runs from the service's working
// directory). Tests that skip explicit db paths were writing session-end,
// dispatch-ack, and webhook-dedup rows straight into production state.
// A fresh temp dir per jest worker keeps every defaulted store isolated.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "connector-jest-"));
// jest only sets NODE_ENV=test when it is unset; the deployment container
// exports NODE_ENV=production, which silently disabled createApp's test-mode
// delivery config (50ms timeout, 0 retries) and let tests run with the
// production 30s/1-retry schedule.
process.env.NODE_ENV = "test";

// dir-mode defs dir points at the prod instance-config path; tests build
// their own single-file defs via WORKFLOW_DEF_PATH fixtures. Pinned to ""
// (falsy) because it IS in .env and dotenv skips existing vars.
process.env.WORKFLOW_DEFS_DIR = "";

// Both ARE in .env. With them set, delivery goes through deliverViaHooks and
// tests fire real HTTP wake-ups at the production gateway (re-signal test:
// two ~10s failed fetches + 5s retry delay blew the 15s test timeout).
// Pinned to "" so delivery falls back to CLI-spawn mode, which fails fast
// and stays on-host.
process.env.OPENCLAW_HOOKS_URL = "";
process.env.OPENCLAW_HOOKS_TOKEN = "";

// A live token in the container/shell env changes linear-actionable behavior
// (previously worked around with `env -u LINEAR_OAUTH_TOKEN npm test`).
// Deleted rather than blanked — those tests distinguish unset from empty —
// and it is NOT in .env, so dotenv cannot re-add it.
delete process.env.LINEAR_OAUTH_TOKEN;

// agents.json in the repo root is encrypted for production. Without clearing
// the encryption key env vars, agents.ts throws at module import time (which
// fails every test that imports any module transitively depending on agents.ts).
// Point AGENTS_FILE at a non-existent path so agents.ts returns [] on boot;
// tests set their own AGENTS_FILE (pointing to a temp fixture) in beforeAll.
delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE;
delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;
process.env.AGENTS_FILE = path.join(os.tmpdir(), "connector-jest-no-agents.json");
