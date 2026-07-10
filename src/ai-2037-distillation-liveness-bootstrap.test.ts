/**
 * AI-2037 / P4-C2 — AC2.4 bootstrap-wiring + liveness proof.
 *
 * AC2.4: "Clustering is on-demand via API. If a scheduled distillation job is
 * added or extended: it is registered at the production entry point, proven by
 * an integration test, and liveness is observable (last-run timestamp exposed)
 * — standard bootstrap-wiring criterion."
 *
 * The conditional fires. `p4-metrics-distillation` is a pre-existing scheduled
 * job (registered at src/index.ts:1102) whose only data source is
 * `ObservationStore.metrics()` — the very method AC2.1 extends to carry
 * contributing ticket ids. Extending metrics() extends the job, so AC2.4's
 * bootstrap-wiring criterion applies to it.
 *
 * Registration is already satisfied today; the LIVENESS half is not. The cron
 * registry (src/cron/registry.ts) records only {name, schedule, registeredAt},
 * so /health can prove the job was *scheduled* but not that it has ever *run*.
 * The `lastRunAt` assertion below is therefore the RED one.
 *
 * Why a subprocess and not createApp(): registerDistillationCron() is invoked
 * from the isEntryPoint bootstrap block of index.ts, not from createApp(). A
 * unit test that calls the registrar directly does not cover this AC (AI-1808).
 * This spawns `node dist/index.js` — the exact artifact systemd runs. Mirrors
 * the harness in src/cron/health-crons-integration.test.ts.
 *
 * Requires a fresh `npm run build` (CI builds before jest; see ci.yml).
 *
 * AC mapping:
 *   AC2.4 — distillation job registered at the production entry point
 *   AC2.4 — liveness observable: last-run timestamp exposed on /health
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");

const DISTILLATION_CRON = "p4-metrics-distillation";

const PORT = 4900 + (process.pid % 200);

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
      // Accept any body (healthy=200, degraded=503) — assert on fields, not status.
      const json = (await res.json()) as Record<string, any>;
      if (json && typeof json === "object") return json;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
}

describe("AI-2037 AC2.4: distillation job is entry-point registered and liveness-observable", () => {
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2037-bootstrap-"));
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

  test("the production entry point registers the distillation cron", () => {
    const crons = health.crons as Array<{ name: string; schedule: string }>;
    expect(Array.isArray(crons)).toBe(true);

    const distillation = crons.find((c) => c.name === DISTILLATION_CRON);
    expect(distillation).toBeDefined();
    expect(typeof distillation!.schedule).toBe("string");
    expect(distillation!.schedule.length).toBeGreaterThan(0);
  });

  test("/health exposes a last-run timestamp for the distillation cron", () => {
    const crons = health.crons as Array<Record<string, unknown>>;
    const distillation = crons.find((c) => c.name === DISTILLATION_CRON);
    expect(distillation).toBeDefined();

    // Liveness, not intent. `registeredAt` proves the timer was armed; it says
    // nothing about whether the job has ever fired. A null lastRunAt (never run
    // yet, interval is 1h) is a legitimate value — the field must simply exist
    // and be a timestamp once the job has run.
    expect(distillation).toHaveProperty("lastRunAt");

    const lastRunAt = distillation!.lastRunAt;
    expect(lastRunAt === null || typeof lastRunAt === "string").toBe(true);
    if (typeof lastRunAt === "string") {
      expect(Number.isNaN(Date.parse(lastRunAt))).toBe(false);
    }
  });
});
