import path from "node:path";

/**
 * AI-2263: decouple the production connector's runtime state from `cwd`.
 *
 * The production connector runs from a dev checkout. Any `npm run build` there
 * rewrites `dist/` in place, so the next restart ships unreviewed WIP. To let a
 * clean deploy tree be wired up, all runtime state (agents.json, the data/
 * SQLite databases, .env, config/) must resolve relative to a stable state dir
 * instead of `cwd`. `OPENCLAW_LINEAR_CONNECTOR_STATE` names that dir.
 *
 * Backward compat is the whole safety of this change: when the var is unset,
 * every path resolves from `cwd` exactly as before — the change is a no-op in
 * dev until the host cutover (AI-2255) flips the var.
 */
export const STATE_DIR_ENV = "OPENCLAW_LINEAR_CONNECTOR_STATE";

/**
 * The configured state dir, or `undefined` when the var is unset/blank (which
 * restores the legacy cwd-relative behavior).
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[STATE_DIR_ENV];
  return v && v.trim() !== "" ? v : undefined;
}

/**
 * Resolve `segments` against the state dir when set, else against `cwd`.
 * Reads the env at call time so tests and late env mutation are honored.
 */
export function resolveStatePath(...segments: string[]): string {
  return path.resolve(stateDir() ?? process.cwd(), ...segments);
}

/** Default env values derived from the state dir, applied at bootstrap. */
export interface StateEnvDefaults {
  /** Where `.env` should be loaded from; undefined → dotenv's cwd default. */
  dotenvPath?: string;
  DATA_DIR?: string;
  AGENTS_FILE?: string;
}

/**
 * Pure computation of the env defaults implied by the state dir. When the var
 * is unset this returns `{}` so the bootstrap is a strict no-op (backward
 * compat). These are *defaults*: the bootstrap fills them only where the env is
 * not already set, so an explicit env var (or `.env` entry) always wins.
 */
export function computeStateDefaults(env: NodeJS.ProcessEnv = process.env): StateEnvDefaults {
  const dir = stateDir(env);
  if (!dir) return {};
  return {
    dotenvPath: path.resolve(dir, ".env"),
    DATA_DIR: path.resolve(dir, "data"),
    AGENTS_FILE: path.resolve(dir, "agents.json"),
  };
}
