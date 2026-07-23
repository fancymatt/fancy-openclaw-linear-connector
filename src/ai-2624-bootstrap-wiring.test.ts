/**
 * AI-2624 — Bootstrap wiring proof for ManagingPoller.
 *
 * AC6 — Bootstrap wiring (AI-1808, mandatory for background components):
 *   The ManagingPoller is registered at server bootstrap (reachable from the
 *   production entry point `src/index.ts`), proven by an integration test
 *   that boots the entry point and asserts the poller is scheduled/started.
 *   A module-level unit test does NOT satisfy this.
 *
 * AC7 — Liveness observable at ac-validate:
 *   Without waiting for a wake to fire, the poller's live state is observable
 *   via a /health field (e.g. a `managingPoller` block reporting `running: true`
 *   and the effective `cycleMs`), a startup log line, or a registry entry.
 *
 * Why a subprocess and not createApp(): the ManagingPoller.start() call lives
 * in the isEntryPoint bootstrap block of index.ts, not in createApp(). A
 * component that passes unit tests but whose `start()` call was never wired
 * at bootstrap is dead code in production — exactly the AI-1773/AI-1775
 * failure mode that AI-1808 mandates against.
 *
 * Requires a fresh `npm run build` before running (CI builds first).
 *
 * AC mapping:
 *   AC6 — ManagingPoller is armed at the production entry point.
 *   AC7 — /health or startup log line confirms the poller is running with
 *         the intended cadence.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");

const PORT = 4700 + (process.pid % 200);

const sampleAgent = {
  name: "astrid",
  linearUserId: "user-astrid-12345678",
  openclawAgent: "astrid",
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
      // Accept any status — we assert on fields, not the HTTP code.
      const json = (await res.json()) as Record<string, unknown>;
      if (json && typeof json === "object") return json;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
}

describe("AI-2624 AC6/AC7: ManagingPoller bootstrap wiring + /health liveness", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest (CI does; see ci.yml)`,
      );
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2624-bootstrap-"));
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
    "AC6: ManagingPoller is armed at production entry point (wired at bootstrap, not dead code)",
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

      // The ManagingPoller must be visible at /health — this is the AI-1808
      // dead-code-in-prod guard. If the field is missing, the poller was never
      // wired at the entry point despite passing all unit tests.
      //
      // Structure expected (implementer adds this):
      //   managingPoller: {
      //     running: true,
      //     cycleMs: 60000,
      //     defaultIntervalMs: 1800000,
      //   }
      expect(body.managingPoller).toBeDefined();
      expect(typeof body.managingPoller).toBe("object");

      const mp = body.managingPoller as Record<string, unknown>;

      // AC7: must report running: true (timer is armed)
      expect(mp.running).toBe(true);

      // AC7: must expose the effective cycleMs so ac-validate can confirm
      // the intended cadence without waiting for a wake (AI-1808).
      expect(typeof mp.cycleMs).toBe("number");
      expect(mp.cycleMs).toBeGreaterThan(0);

      // AC7: should also expose defaultIntervalMs for diagnostic completeness
      expect(typeof mp.defaultIntervalMs).toBe("number");
      expect(mp.defaultIntervalMs).toBeGreaterThan(0);
    },
    60_000,
  );
});
