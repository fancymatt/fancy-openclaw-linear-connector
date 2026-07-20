/**
 * AI-1810 — Integration test: booting the PRODUCTION entry point yields the
 * expected cron registry entries in /health.
 *
 * Why a subprocess and not createApp(): the cron registrations live in the
 * isEntryPoint bootstrap block of index.ts, not in createApp(). Twice
 * (AI-1773, AI-1775) a driver shipped with green unit tests while that block
 * never invoked its registrar — the gap between "module works" and "deployed
 * artifact schedules it" was invisible. This test spawns `node dist/index.js`
 * (the exact artifact systemd runs), polls /health, and asserts the registry.
 *
 * AC4 semantics: EXPECTED_CRONS is an EXACT set.
 *  - A driver that calls registerCron() but is never invoked from the entry
 *    point will be missing from /health → this test fails.
 *  - A newly wired driver not yet listed here also fails → adding it to
 *    EXPECTED_CRONS is the conscious registration step the AI-1808 AC
 *    guidance requires.
 *
 * Requires a fresh `npm run build` — CI builds before jest (see ci.yml).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../../dist/index.js");

// Every driver the production bootstrap is expected to schedule.
const EXPECTED_CRONS = [
  "bootstrap-reconciliation-sweep",
  "config-sanity-alert", // AI-2619: config-sanity watchdog alert consumer
  "delegation-reconciliation-sweep",
  "dispatch-delivery-scheduler", // AI-2008: acknowledged dispatch delivery + retry driver
  "first-action-watchdog",
  "g20-canary",
"label-sync-audit", // AI-2554: periodic proxy-store vs Linear label divergence check
  "oob-reconcile-sweep",
  "p4-metrics-distillation",
  "registry-integrity-check", // AI-2359: periodic registry⇄policy integrity check (registered in createApp)
  "rescue-sweep",
  "sla-sweep",
  "transcript-redaction", // AI-2582: periodic .trajectory.jsonl credential redaction sweep
].sort();

const PORT = 4100 + (process.pid % 400);

const sampleAgent = {
  name: "sage",
  linearUserId: "user-sage-12345678",
  openclawAgent: "sage",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  host: "local" as const,
};

async function pollHealth(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error("never attempted");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return (await res.json()) as Record<string, unknown>;
      lastErr = new Error(`GET /health returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
}

describe("AI-1810: production entry point registers all crons in /health", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest (CI does; see ci.yml)`,
      );
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-crons-integration-"));
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
        // The G-20 canary only schedules when a ticket id is configured; give
        // it one so the full production cron set is exercised. It makes no
        // network calls until its first 15m tick — the test is long gone.
        G20_CANARY_TICKET_ID: "AI-0000",
        // The SLA sweep (AI-1773 wiring, landed on main via PR #150) only
        // registers when a Linear auth token resolves. Pin a dummy one so
        // registration is deterministic regardless of host/CI env; the sweep
        // makes no network calls until its first 5m tick — the test is long
        // gone by then.
        LINEAR_OAUTH_TOKEN: "test-linear-oauth-token",
        // Prevent inherited hook config from letting the boot path signal
        // real agents if any recovery/drain state were somehow present.
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
    "/health enumerates the exact expected driver set with name + schedule (AC1–AC4)",
    async () => {
      let body: Record<string, unknown>;
      try {
        body = await pollHealth(`http://127.0.0.1:${PORT}/health`, 30_000);
      } catch (err) {
        throw new Error(
          `entry point never became healthy: ${err instanceof Error ? err.message : String(err)}\n` +
          `child stderr:\n${childStderr}`,
        );
      }

      const crons = body.crons as Array<{ name: string; schedule: string; registeredAt: string }>;
      expect(Array.isArray(crons)).toBe(true);

      // AC2: the two historical dead-code incidents are present by name.
      const names = crons.map((c) => c.name).sort();
      expect(names).toContain("sla-sweep");
      expect(names).toContain("bootstrap-reconciliation-sweep");

      // AC1/AC4: exact-set match against the wired bootstrap.
      expect(names).toEqual(EXPECTED_CRONS);

      // AI-1848 (Pillar 2 D1): universal canon liveness field is present from
      // the production entry point (bootstrap registration proof). No canon
      // file is configured in this test env, so loaded=false is expected —
      // the assertion is that the field EXISTS and is well-formed.
      expect(body.universalCanon).toBeDefined();
      expect(typeof body.universalCanon.loaded).toBe("boolean");
      expect(body.universalCanon).toHaveProperty("version");
      expect(body.universalCanon).toHaveProperty("path");

      // AI-2619: config-sanity-alert liveness field is present from the
      // production entry point (bootstrap registration proof). The test env
      // has no watchdog JSON file, so scheduled=true.
      expect(body.configSanityAlert).toBeDefined();
      expect(body.configSanityAlert.scheduled).toBe(true);
      expect(body.configSanityAlert).toHaveProperty("lastReadAt");
      expect(body.configSanityAlert).toHaveProperty("lastFindingCount");
      expect(body.configSanityAlert).toHaveProperty("lastAlertAt");

      // AC1: every entry carries a human-readable schedule and a timestamp.
      for (const cron of crons) {
        expect(typeof cron.schedule).toBe("string");
        expect(cron.schedule.length).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(cron.registeredAt))).toBe(false);
      }
    },
    60_000,
  );
});
