/**
 * INF-193 AC4 — Bootstrap-wiring + liveness proof for TTL cache invalidation
 * scheduler and cache-flush endpoint.
 *
 * Required by the steward's AI-1808 intake addendum: the TTL invalidation
 * scheduler and the cache-flush endpoint are background/periodic components
 * — exactly the class that twice shipped fully unit-tested but DEAD in prod
 * (AI-1773, AI-1775) because nothing at bootstrap registered the driver or
 * mounted the route. A module-level unit test does NOT satisfy this AC.
 *
 * This test boots the PRODUCTION entry point — the exact built artifact
 * systemd runs (`node dist/index.js`) — polls /health, and asserts:
 *   1. A cron "ttl-cache-invalidation" is registered in the cron registry
 *   2. A top-level /health.cache field exposes:
 *      - ttlSchedulerActive: true (the TTL purge timer is armed)
 *      - flushRouteMounted: true  (the POST /admin/api/cache/flush route is mounted)
 *      - defaultTtlMs: ≤ 300_000  (default TTL is bounded per AC1)
 *
 * Requires a fresh `npm run build` (CI builds before jest; see ci.yml).
 * Mirrors the harness in src/cron/health-crons-integration.test.ts and
 * src/ai-2008-bootstrap-wiring.test.ts.
 *
 * AC mapping (AI-1808 addendum):
 *   AC4a — TTL invalidation scheduler registered at bootstrap
 *   AC4b — cache-flush endpoint route mounted at bootstrap
 *   AC4  — liveness for both observable at /health without waiting for triggers
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");

const PORT = 4300 + (process.pid % 300);

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
      // Accept any body (healthy=200, degraded=503) — assert on fields,
      // not status.
      const json = (await res.json()) as Record<string, any>;
      if (json && typeof json === "object") return json;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
}

describe("INF-193 AC4: TTL cache invalidation & flush endpoint bootstrap wiring", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";
  let health: Record<string, any>;

  beforeAll(async () => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest (CI does; see ci.yml)`,
      );
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-193-bootstrap-"));
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

    try {
      health = await pollHealth(`http://127.0.0.1:${PORT}/health`, 30_000);
    } catch (err) {
      throw new Error(
        `entry point never responded on /health: ${err instanceof Error ? err.message : String(err)}\n` +
        `child stderr:\n${childStderr}`,
      );
    }
  }, 60_000);

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

  test("the TTL cache invalidation scheduler is registered as a cron", () => {
    const crons = health.crons as Array<{ name: string; schedule: string; registeredAt: string }>;
    expect(Array.isArray(crons)).toBe(true);

    const ttlCron = crons.find((c) => c.name === "ttl-cache-invalidation");
    expect(ttlCron).toBeDefined();
    expect(typeof ttlCron!.schedule).toBe("string");
    expect(ttlCron!.schedule.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(ttlCron!.registeredAt))).toBe(false);
  });

  test("the TTL cache invalidation cron carries a lastRunAt field for liveness", () => {
    const crons = health.crons as Array<Record<string, unknown>>;
    const ttlCron = crons.find((c) => c.name === "ttl-cache-invalidation");
    expect(ttlCron).toBeDefined();

    // Liveness, not intent. registeredAt proves the timer was armed;
    // lastRunAt may be null (never fired yet) but the field must exist so
    // ac-validate can observe that a run occurred after waiting for the interval.
    expect(ttlCron).toHaveProperty("lastRunAt");

    const lastRunAt = ttlCron!.lastRunAt;
    expect(lastRunAt === null || typeof lastRunAt === "string").toBe(true);
    if (typeof lastRunAt === "string") {
      expect(Number.isNaN(Date.parse(lastRunAt))).toBe(false);
    }
  });

  test("/health exposes a cache section with TTL scheduler active and flush route mounted", () => {
    // This field must exist at the production /health endpoint and carry
    // both liveness indicators. The test will fail until:
    //   (a) registerTtlInvalidationCron() is wired in index.ts
    //   (b) the cache-flush route is mounted in createApp()
    //   (c) the /health response builder emits body.cache via getCacheLiveness()
    expect(health.cache).toBeDefined();
    expect(health.cache.ttlSchedulerActive).toBe(true);
    expect(health.cache.flushRouteMounted).toBe(true);

    // AC1 bound: default TTL ≤ 5 min (300_000 ms)
    expect(typeof health.cache.defaultTtlMs).toBe("number");
    expect(health.cache.defaultTtlMs).toBeGreaterThan(0);
    expect(health.cache.defaultTtlMs).toBeLessThanOrEqual(300_000);

    // Entry count is a live metric, not an assertion target — just ensure it's
    // a number (0 is fine in the test env where no cache ops happen).
    expect(typeof health.cache.entries).toBe("number");
  });
});
