/**
 * AI-2038 (P4-C3) — AC3.6: bootstrap wiring + liveness for the generation cron.
 *
 * AC3.6: "If generation gets a cron trigger, the AC2.4 bootstrap-wiring +
 * liveness criterion applies to it identically (registered at production entry
 * point, integration-tested, last-run timestamp observable)."
 *
 * The antecedent is already satisfied in this codebase: `p4-metrics-distillation`
 * (src/cron/p4-metrics-distillation.ts) is a registered cron whose entire job is
 * to read threshold-crossing clusters and emit proposals. C3 replaces its
 * generation guts with the deterministic engine, which is exactly the "added or
 * extended" case AC2.4 names. So AC3.6 fires, and this test is not vacuous.
 *
 * Why a subprocess and not createApp(): the cron registrations live in the
 * entry-point bootstrap block of index.ts, NOT in createApp(). Twice (AI-1773,
 * AI-1775) a driver shipped with green unit tests while dead in prod. This test
 * spawns `node dist/index.js` — the exact artifact systemd runs — polls /health,
 * and asserts the registry. Mirrors src/cron/health-crons-integration.test.ts
 * and src/ai-2008-bootstrap-wiring.test.ts.
 *
 * ── Contract the implementer conforms to ────────────────────────────────────
 * Whichever cron triggers proposal generation — a new `proposal-generation`
 * driver, or the extended `p4-metrics-distillation` — must:
 *   1. be registered from the production entry point (present in /health.crons), and
 *   2. expose a last-run timestamp: `lastRunAt: string | null`
 *      (null before the first run; ISO-8601 after).
 *
 * ── STATUS: GREEN on current main — this is a REGRESSION GUARD, not a red test ─
 * The original C3 test authored this RED because CronRegistryEntry carried only
 * { name, schedule, registeredAt } — no last-run field on any driver. That gap
 * was closed by C1 (AI-2036), which landed `lastRunAt`, the `markCronRun()`
 * helper, and `/health.crons` liveness AND wired `p4-metrics-distillation` to
 * stamp its run. Verified empirically: all three assertions here PASS against
 * current main. AC3.6's antecedent obligations (registered / integration-tested
 * / last-run observable) are therefore already met by merged work.
 *
 * It is kept, per steward instruction, as a regression guard: if C3's work
 * touches the entry point or the generation cron's registration/liveness and
 * breaks it, this goes red. It does NOT prove new C3 code — see the handoff
 * note. If the steward decides C3 must migrate this cron from its current
 * skill_workshop output onto the deterministic proposal engine + store, that is
 * a scope addition needing an AC line, not something to smuggle into this test.
 *
 * If the implementer decides generation gets NO cron trigger at all, that means
 * deleting `p4-metrics-distillation` — a scope change. Escalate rather than
 * deleting this test.
 *
 * Requires a fresh `npm run build` — CI builds before jest (see ci.yml).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../../dist/index.js");

const PORT = 4900 + (process.pid % 200);

/** Either name satisfies AC3.6: a dedicated driver, or the extended distillation job. */
const GENERATION_CRON_NAMES = ["proposal-generation", "p4-metrics-distillation"];

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

interface CronEntry {
  name: string;
  schedule: string;
  registeredAt: string;
  lastRunAt?: string | null;
}

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

describe("AC3.6: the proposal-generation cron is wired at the production entry point and its liveness is observable", () => {
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2038-gen-cron-"));
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

  const generationCrons = (): CronEntry[] =>
    (health.crons as CronEntry[]).filter((c) => GENERATION_CRON_NAMES.includes(c.name));

  test("the deployed artifact registers a proposal-generation cron", () => {
    expect(Array.isArray(health.crons)).toBe(true);

    const found = generationCrons();
    expect(found.length).toBeGreaterThanOrEqual(1);
    // A driver that calls registerCron() but is never invoked from the entry
    // point is absent here — the dead-code-in-prod guard.
    expect(found[0].schedule).toEqual(expect.any(String));
    expect(found[0].registeredAt).toEqual(expect.any(String));
  });

  test("the generation cron exposes a last-run timestamp (null before first run)", () => {
    for (const cron of generationCrons()) {
      expect(cron).toHaveProperty("lastRunAt");

      const lastRunAt = cron.lastRunAt;
      const isNull = lastRunAt === null;
      const isIso = typeof lastRunAt === "string" && !Number.isNaN(Date.parse(lastRunAt));

      expect(isNull || isIso).toBe(true);
    }
  });

  test("last-run liveness is queryable without waiting for a generation run", () => {
    // AC2.4/AC3.6 intent: the steward curls /health at ac-validate and can tell
    // whether the driver has run — no log archaeology, no waiting for a trigger.
    const [cron] = generationCrons();
    expect(cron).toBeDefined();
    expect(Object.keys(cron)).toEqual(expect.arrayContaining(["name", "schedule", "registeredAt", "lastRunAt"]));
  });
});
