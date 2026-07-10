/**
 * AI-2036 AC1.5 / AC1.6 — bootstrap wiring + liveness for the observation write path.
 *
 * Required by the steward's AI-1808 intake addendum: `observationStore` wiring was
 * itself a suspected root cause (AC1.1b), which is the AI-1773 / AI-1775 failure
 * mode — a fully unit-tested component that nothing at bootstrap ever registered.
 * "A module-level unit test does NOT satisfy this."
 *
 * So this test boots the PRODUCTION entry point — the exact built artifact systemd
 * runs (`node dist/index.js`) — and asserts, from the outside, that the observation
 * store is wired and its transition-handler hook subscribed:
 *
 *   observations: { wired: true, subscribed: true, registeredAt: <iso>, rows: 0, ... }
 *
 * AC1.6 is the same assertion read a different way: liveness is observable at
 * ac-validate by curling /health, without waiting for a reviewer to reject
 * something. `rows` is read from the live table, so a table that failed to migrate
 * surfaces as null rather than as a confident zero.
 *
 * Requires a fresh `npm run build` (CI builds before jest; see ci.yml).
 * Mirrors the harness in ai-2008-bootstrap-wiring.test.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");

const PORT = 4900 + (process.pid % 300);

const sampleAgent = {
  name: "igor",
  linearUserId: "user-igor-12345678",
  openclawAgent: "igor",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  host: "local" as const,
};

async function pollHealth(url: string, timeoutMs: number): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error("never attempted");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      // Accept any body (healthy=200, degraded=503) — we assert on fields, not status.
      const json = (await res.json()) as Record<string, any>;
      if (json && typeof json === "object") return json;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
}

describe("AI-2036: production entry point registers the observation write path", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest (CI does; see ci.yml)`,
      );
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2036-bootstrap-"));
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [sampleAgent] }), "utf8");

    child = spawn(process.execPath, [DIST_ENTRY], {
      cwd: dir,
      env: {
        ...process.env,
        AGENTS_FILE: agentsFile,
        DATA_DIR: path.join(dir, "data"),
        PORT: String(PORT),
        LOG_LEVEL: "error",
        LINEAR_WEBHOOK_SECRET: process.env.LINEAR_WEBHOOK_SECRET ?? "test-secret",
        LINEAR_OAUTH_TOKEN: "test-linear-oauth-token",
        OPENCLAW_HOOKS_URL: `http://127.0.0.1:${PORT}/nonexistent-hooks`,
        OPENCLAW_HOOKS_TOKEN: "test-token",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      childStderr += chunk.toString("utf8");
    });
  });

  afterAll(async () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          child?.kill("SIGKILL");
          resolve();
        }, 2000);
        child?.on("exit", () => {
          clearTimeout(force);
          resolve();
        });
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test(
    "/health.observations reports the store wired and the transition hook subscribed (AC1.5, AC1.6)",
    async () => {
      let body: Record<string, any>;
      try {
        body = await pollHealth(`http://127.0.0.1:${PORT}/health`, 30_000);
      } catch (err) {
        throw new Error(
          `entry point never responded on /health: ${err instanceof Error ? err.message : String(err)}\n` +
            `child stderr:\n${childStderr}`,
        );
      }

      expect(body.observations).toBeDefined();

      // wired/subscribed are set only by registerObservationWritePath(), which
      // only bootstrap calls — importing the module is not enough to flip them.
      expect(body.observations.wired).toBe(true);
      expect(body.observations.subscribed).toBe(true);
      expect(typeof body.observations.registeredAt).toBe("string");

      // Read from the live table: a schema that failed to migrate reports null,
      // not a confident 0. A fresh DATA_DIR starts empty.
      expect(body.observations.rows).toBe(0);

      // Skip telemetry is exposed for ac-validate, and starts clean.
      expect(body.observations.recorded).toBe(0);
      expect(body.observations.skipped).toBe(0);
      expect(body.observations.skippedByReason).toEqual({});
    },
    60_000,
  );

  test(
    "the observations table exists on disk after boot, with wake_id and the reason index (AC1.4)",
    async () => {
      await pollHealth(`http://127.0.0.1:${PORT}/health`, 30_000);

      const dbPath = path.join(dir, "data", "observations.db");
      expect(fs.existsSync(dbPath)).toBe(true);

      const { default: Database } = await import("better-sqlite3");
      const db = new Database(dbPath, { readonly: true });
      try {
        const cols = db.prepare(`PRAGMA table_info('observations')`).all() as Array<{ name: string }>;
        expect(cols.map((c) => c.name)).toContain("wake_id");

        const indexes = db.prepare(`PRAGMA index_list('observations')`).all() as Array<{ name: string }>;
        expect(indexes.map((i) => i.name)).toContain("idx_observations_workflow_step_reason");
      } finally {
        db.close();
      }
    },
    60_000,
  );
});
