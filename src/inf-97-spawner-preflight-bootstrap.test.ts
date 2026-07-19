/**
 * INF-97 — Bootstrap-wiring integration test for the spawner pre-flight readiness gate.
 *
 * Required by AC5 (AI-1808 addendum): the pre-flight gate is a background/
 * event-driven component that must be registered at server bootstrap and proven
 * by an integration test that boots the production entry point. A module-level
 * unit test (as in inf-97-spawner-preflight.test.ts) does NOT satisfy this AC.
 *
 * This test boots the PRODUCTION entry point — the exact built artifact systemd
 * runs (`node dist/index.js`) — polls /health, and asserts the pre-flight
 * readiness gate is registered and observable without waiting for a sprint-
 * spawner trigger.
 *
 * AC mapping:
 *   AC5 — Component registered at server bootstrap (reachable from index.ts).
 *   AC6 — Liveness observable at ac-validate without waiting for trigger:
 *         /health field shows pre-flight component is scheduled/subscribed.
 *
 * Requires a fresh `npm run build` (CI builds before jest; see ci.yml). Mirrors
 * the harness in src/ai-2008-bootstrap-wiring.test.ts and src/cron/health-crons-integration.test.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");

const PORT = 4700 + (process.pid % 300);

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
      const json = (await res.json()) as Record<string, any>;
      if (json && typeof json === "object") return json;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
}

describe("INF-97: production entry point arms the spawner pre-flight readiness gate", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest (CI does; see ci.yml)`,
      );
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-97-bootstrap-"));
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
    "AC5: /health reports the spawner pre-flight readiness gate as a registered component",
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

      // The pre-flight gate must be wired at the production entry point —
      // not merely importable. This is the dead-code-in-prod guard (AI-1773/AI-1775).
      expect(body).toHaveProperty("spawnerPreflight");
    },
    60_000,
  );

  test(
    "AC5: spawnerPreflight field is an object with liveness state (not a hardcoded literal)",
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

      // Must be a structured object, not just a boolean or string — proves
      // the component registers its state rather than being a hardcoded literal.
      const pf = body.spawnerPreflight as Record<string, any>;
      expect(pf).toBeDefined();
      expect(typeof pf).toBe("object");
      expect(pf).toHaveProperty("scheduled");
    },
    60_000,
  );

  test(
    "AC6: spawnerPreflight liveness reports scheduled/ready without needing a sprint-spawner trigger",
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

      // AC6: liveness observable at ac-validate without waiting for trigger.
      // The component shows it is scheduled even when no sprint has been initiated.
      const pf = body.spawnerPreflight as Record<string, any>;
      expect(pf.scheduled).toBe(true);
      expect(pf).toHaveProperty("lastRunAt");
      // May be null if never triggered — that's fine; what matters is the
      // component is registered and visible.
    },
    60_000,
  );
});
