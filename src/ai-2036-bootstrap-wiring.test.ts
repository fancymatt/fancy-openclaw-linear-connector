/**
 * AI-2036 — Bootstrap-wiring + liveness proof for the observation write path.
 *
 * Required by the steward's AI-1808 addendum on this ticket: "observationStore
 * wiring" was itself a suspected root cause (AC1.1b), i.e. exactly the
 * AI-1773/AI-1775 failure mode — a fully unit-tested component that is never
 * registered at the production entry point. A module-level unit test does NOT
 * satisfy AC1.5.
 *
 * This test boots the PRODUCTION entry point — the exact built artifact systemd
 * runs (`node dist/index.js`) — polls /health, and asserts the observation store
 * is wired and observable WITHOUT waiting for a feedback-required transition:
 *   observations: { registered: true, dbPath: <path>, rows: 0, skipped: 0, ... }
 *
 * Requires a fresh `npm run build` (CI builds before jest; see ci.yml). Mirrors
 * the harness in src/ai-2008-bootstrap-wiring.test.ts.
 *
 * AC mapping:
 *   AC1.5 — bootstrap registration, proven by booting the entry point.
 *   AC1.6 — liveness observable at ac-validate (a /health field AND a startup
 *           log line), with no transition required to make it appear.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";

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
  let dataDir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest (CI does; see ci.yml)`,
      );
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2036-bootstrap-"));
    dataDir = path.join(dir, "data");
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [sampleAgent] }), "utf8");

    child = spawn(process.execPath, [DIST_ENTRY], {
      cwd: dir,
      env: {
        ...process.env,
        AGENTS_FILE: agentsFile,
        DATA_DIR: dataDir,
        PORT: String(PORT),
        LOG_LEVEL: "info", // AC1.6: the startup log line must be observable
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

  it(
    "/health reports the observation store as registered, with live counters and a real db path",
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

      // AC1.5: the store must be registered by the production entry point — not
      // merely importable. `registered` is set only by registerObservationWriter().
      expect(body.observations).toBeDefined();
      expect(body.observations.registered).toBe(true);

      // AC1.6: liveness without waiting for a feedback-required transition.
      // `rows` and `dbPath` come from the live SQLite handle, so this cannot pass
      // against a hardcoded literal — the store must really exist and be open.
      expect(typeof body.observations.rows).toBe("number");
      expect(body.observations.dbPath).toBe(path.join(dataDir, "observations.db"));
      expect(fs.existsSync(body.observations.dbPath)).toBe(true);

      // AC1.3: the skip counters are part of the surfaced telemetry.
      expect(body.observations.appended).toBe(0);
      expect(body.observations.degraded).toBe(0);
      expect(body.observations.skipped).toBe(0);
      expect(body.observations.skipsByReason).toEqual({
        "store-unwired": 0,
        "from-body-unresolved": 0,
        "write-failed": 0,
      });
    },
    60_000,
  );

  it("logs an observation-write-path registration line at startup (AC1.6)", async () => {
    await pollHealth(`http://127.0.0.1:${PORT}/health`, 30_000);
    expect(childStderr).toContain("observation write path registered at bootstrap");
  }, 60_000);
});
