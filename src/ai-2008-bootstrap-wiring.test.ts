/**
 * AI-2008 — Bootstrap-wiring proof for the dispatch retry / ack-timeout scheduler.
 *
 * Required by the steward's AI-1808 intake addendum (2026-07-09): the retry-with-
 * backoff scheduler and ack-timeout tracker are timer/event-driven components —
 * exactly the class that twice shipped fully unit-tested but DEAD in prod
 * (AI-1773, AI-1775) because nothing at bootstrap registered the driver. A
 * module-level unit test does NOT satisfy this AC.
 *
 * This test boots the PRODUCTION entry point — the exact built artifact systemd
 * runs (`node dist/index.js`) — polls /health, and asserts the retry/ack
 * scheduler is armed and observable WITHOUT waiting for a failed dispatch:
 *   dispatchDelivery: { schedulerActive: true, pendingRetries: <number> }
 *
 * Requires a fresh `npm run build` (CI builds before jest; see ci.yml). Mirrors
 * the harness in src/cron/health-crons-integration.test.ts.
 *
 * AC mapping:
 *   AC1 — no fire-and-forget path remains: the delivery-ack/retry machinery is
 *         alive in the deployed artifact, not just importable in tests.
 *   AI-1808 addendum — bootstrap wiring + /health liveness of the scheduler.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");

const PORT = 4600 + (process.pid % 300);

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

describe("AI-2008: production entry point arms the dispatch retry/ack scheduler", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest (CI does; see ci.yml)`,
      );
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2008-bootstrap-"));
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
    "/health reports the dispatch retry/ack scheduler as armed (schedulerActive) with pendingRetries count",
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

      // The scheduler must be armed at the production entry point — not merely
      // importable. This is the dead-code-in-prod guard (AI-1773/AI-1775).
      expect(body.dispatchDelivery).toBeDefined();
      expect(body.dispatchDelivery.schedulerActive).toBe(true);
      expect(typeof body.dispatchDelivery.pendingRetries).toBe("number");
    },
    60_000,
  );
});
