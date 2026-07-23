/**
 * INF-320 — Bootstrap-wiring proof for the remediation actor.
 *
 * Required by the AI-1808 intake addendum: the remediation actor is a
 * background/event-driven component — exactly the class that has shipped
 * fully unit-tested but DEAD in prod (AI-1773, AI-1775) because nothing at
 * bootstrap registered it. A module-level unit test does NOT satisfy this AC.
 *
 * This test boots the PRODUCTION entry point — createApp() from index.ts —
 * and asserts the remediation actor is registered and observable via
 * /health WITHOUT waiting for a real failure_class event:
 *   /health.remediationActor: { armed: true, totalActions: 0 }
 *
 * AC mapping:
 *   AC4 — every action is recorded; the liveness field proves the recording
 *         surface is wired at the production entry point, not just importable.
 *   AI-1808 addendum — bootstrap wiring + /health liveness of the actor.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../../dist/index.js");

const PORT = 4700 + (process.pid % 300);

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "astrid",
          linearUserId: "u-astrid",
          openclawAgent: "astrid",
          accessToken: "tok-astrid",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

describe("INF-320 AI-1808: remediation actor bootstrap wiring", () => {
  let server: ChildProcess | null = null;
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-320-boot-"));
    process.env.AGENTS_FILE = writeAgents(dir);
  });

  afterAll(() => {
    if (server) {
      server.kill("SIGTERM");
    }
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.AGENTS_FILE;
  });

  it("dist/index.js boots and /health exposes remediationActor liveness (armed + totalActions)", async () => {
    // Skip if dist/ hasn't been built — same guard as ai-2008-bootstrap-wiring.test.ts.
    if (!fs.existsSync(DIST_ENTRY)) {
      console.warn(`SKIP: ${DIST_ENTRY} not found — run 'npm run build' before this test.`);
      return;
    }

    const env = {
      ...process.env,
      PORT: String(PORT),
      ADMIN_SECRET: "inf-320-test",
      DATA_DIR: dir,
      NODE_ENV: "production",
    };

    server = spawn(process.execPath, [DIST_ENTRY], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: path.resolve(__dirname, "../.."),
    });

    // Poll /health until the server responds (max ~10s).
    let body: Record<string, unknown> | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/health`);
        if (res.ok) {
          body = (await res.json()) as Record<string, unknown>;
          break;
        }
      } catch {
        // Server not ready yet — retry.
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(body).not.toBeNull();

    // The remediation actor must be wired at bootstrap — visible in /health
    // without triggering a failure_class event. This is the AI-1808 dead-code
    // guard: if the actor is registered in createApp(), its liveness surfaces here.
    expect(body!.remediationActor).toBeDefined();
    const live = body!.remediationActor as Record<string, unknown>;
    expect(live.armed).toBe(true);
    expect(live.totalActions).toBe(0);
  }, 15_000);
});
