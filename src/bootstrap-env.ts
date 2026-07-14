/**
 * AI-2263: process bootstrap — must be imported *first* in the entrypoint.
 *
 * Loads `.env` and seeds cwd-relative runtime-state defaults from
 * `OPENCLAW_LINEAR_CONNECTOR_STATE` before any module that reads them at load
 * time (e.g. `db.ts`, `agents.ts`). Import order in `index.ts` guarantees this
 * runs ahead of the store modules.
 *
 * Replaces the bare `import 'dotenv/config'`: when the state dir is unset this
 * behaves identically (dotenv loads `.env` from cwd, no env is seeded), so the
 * change is a no-op in dev.
 */
import dotenv from "dotenv";
import { computeStateDefaults } from "./state-dir.js";

const defaults = computeStateDefaults(process.env);

// Load .env first. dotenv never overrides an already-set process.env var, so
// the real environment (systemd, docker) still wins over the file.
dotenv.config(defaults.dotenvPath ? { path: defaults.dotenvPath } : {});

// Then fill state-dir defaults only where still unset, so an explicit env var
// or a `.env` entry takes precedence over the derived default.
if (defaults.DATA_DIR) process.env.DATA_DIR ??= defaults.DATA_DIR;
if (defaults.AGENTS_FILE) process.env.AGENTS_FILE ??= defaults.AGENTS_FILE;
