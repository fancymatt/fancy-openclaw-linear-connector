/**
 * INF-314 AC8/AC9 — Bootstrap wiring + /health liveness for stall detection.
 *
 * AC8 — Bootstrap wiring (AI-1808, mandatory for background components):
 *   The liveness tracker, stall classifier, and auto-recovery component are
 *   registered at server bootstrap (reachable from the production entry point
 *   `src/index.ts`), proven by an integration test that boots the entry point
 *   and asserts the components are scheduled/registered. A module-level unit
 *   test does NOT satisfy this.
 *
 * AC9 — Liveness observable at ac-validate:
 *   Without waiting for a stall to occur, the liveness/state of each component
 *   is observable via a /health field (e.g. a `stallDetection` block reporting
 *   `active: true` and the effective threshold values), a startup log line, or
 *   a registry entry.
 *
 * Why a subprocess and not createApp(): the stall-detection component's
 * registration lives in the isEntryPoint bootstrap block of index.ts, not
 * in createApp(). A component that passes unit tests but whose registration
 * was never wired at bootstrap is dead code in production — exactly the
 * AI-1773/AI-1775 failure mode that AI-1808 mandates against.
 *
 * Requires a fresh `npm run build` before running (CI builds first).
 *
 * AC mapping:
 *   AC8 — stall detection components are armed at the production entry point.
 *   AC9 — /health or registry entry confirms the components are active with
 *         the intended threshold values.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");

const PORT = 4800 + (process.pid % 200);

const sampleAgent = {
  name: "igor",
  linearUserId: "user-igor-stall-1234",
  openclawAgent: "igor",
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
      const json = (await res.json()) as Record<string, unknown>;
      if (json && typeof json === "object") return json;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
}

describe("INF-314 AC8/AC9: stall detection bootstrap wiring + /health liveness", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest (CI does; see ci.yml)`,
      );
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-314-bootstrap-"));
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
    "AC8: stall detection components are armed at the production entry point (wired at bootstrap, not dead code)",
    async () => {
      let body: Record<string, unknown>;
      try {
        body = await pollHealth(`http://127.0.0.1:${PORT}/health`, 30_000);
      } catch (err) {
        throw new Error(
          `entry point never responded on /health: ${err instanceof Error ? err.message : String(err)}\n` +
          `child stderr:\n${childStderr}`,
        );
      }

      // The stall detection liveness block must be present at /health — this is
      // the AI-1808 dead-code-in-prod guard. If the field is missing, the stall
      // detection components were never wired at the entry point despite passing
      // all unit tests.
      //
      // Expected structure (implementer adds this):
      //   stallDetection: {
      //     active: true,
      //     ackTimeoutMs: 180000,
      //     progressTimeoutMs: 720000,
      //     cronsRegistered: ["stall-liveness-sweep"],
      //   }
      expect(body.stallDetection).toBeDefined();
      expect(typeof body.stallDetection).toBe("object");

      const sd = body.stallDetection as Record<string, unknown>;

      // AC8: must report active: true (liveness tracker is live)
      expect(sd.active).toBe(true);

      // AC8: must expose the configured ACK_TIMEOUT so ac-validate can confirm
      // the intended threshold without waiting for a stall to occur.
      expect(typeof sd.ackTimeoutMs).toBe("number");
      expect((sd.ackTimeoutMs as number)).toBeGreaterThan(0);

      // AC8: must expose the configured PROGRESS_TIMEOUT.
      expect(typeof sd.progressTimeoutMs).toBe("number");
      expect((sd.progressTimeoutMs as number)).toBeGreaterThan(0);
    },
    60_000,
  );

  test(
    "AC9: stall detection components are observable in the cron registry",
    async () => {
      let body: Record<string, unknown>;
      try {
        body = await pollHealth(`http://127.0.0.1:${PORT}/health`, 30_000);
      } catch (err) {
        throw new Error(
          `entry point never responded on /health: ${err instanceof Error ? err.message : String(err)}\n` +
          `child stderr:\n${childStderr}`,
        );
      }

      // AC9: crons registry must include the stall-liveness sweep cron (or
      // similar registered name). The getRegisteredCrons() output is available
      // at /health.crons as an array of { id, schedule } entries.
      expect(body.crons).toBeDefined();
      const crons = body.crons as Array<{ id?: string; schedule?: string }>;

      if (Array.isArray(crons)) {
        const stallSweep = crons.find((c) =>
          typeof c.id === "string" && c.id.includes("stall"),
        );
        // The cron registry entry is the secondary liveness signal (AC9):
        // present even if the /health.stallDetection field hasn't been added yet.
        expect(stallSweep).toBeDefined();
      }
    },
    60_000,
  );
});
