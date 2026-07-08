/**
 * AI-1953 AC4 — Enriched stale-digest API fields.
 *
 * The GET /admin/api/stale-digest endpoint must return entries enriched with:
 *   - state       — current workflow state of the ticket
 *   - delegate    — current delegate of the ticket
 *   - age_seconds — seconds the ticket has been in its current state
 *   - threshold_ms — the SLA threshold (ms) that was breached
 *   - last_comment_at — ISO timestamp of last activity (may be null)
 *
 * These fields require cross-referencing the enrolled-tickets store and workflow
 * SLA map. The route handler in admin.ts must be enriched to supply them.
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-1953-test-"));
}

const ADMIN_SECRET = "test-secret-ai1953";

function adminGet(app: ReturnType<typeof createApp>["app"], route: string) {
  return request(app).get(route).set("x-admin-secret", ADMIN_SECRET);
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [{
      name: "tdd",
      linearUserId: "user-tdd-12345678",
      openclawAgent: "tdd",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      host: "local",
    }],
  }), "utf8");
  return file;
}

/** Write a minimal digest JSONL entry for a ticket into a temp forensics dir. */
function writeDigestEntry(forensicsDir: string, ticket: string, capturedAtMs: number): void {
  const digestDir = path.join(forensicsDir, "stale-sessions");
  fs.mkdirSync(digestDir, { recursive: true });
  const entry = {
    capturedAt: new Date(capturedAtMs).toISOString(),
    agent: "tdd",
    ticket,
    classification: "C3",
    classificationName: "Silent completion",
    totalDurationMs: 14400000,
    toolCallCount: 12,
    stopReason: "end_turn",
    errors: 0,
    diagnosticPath: path.join(digestDir, `${ticket}.json`),
  };
  const digestPath = path.join(digestDir, "digest.jsonl");
  fs.appendFileSync(digestPath, JSON.stringify(entry) + "\n", "utf8");
}

describe("AI-1953 AC4: enriched stale-digest API fields", () => {
  let dir: string;
  let forensicsDir: string;
  let webDist: string;
  let appState: ReturnType<typeof createApp>;
  let enrolledStore: EnrolledTicketsStore;

  beforeEach(() => {
    dir = tempDir();
    forensicsDir = path.join(dir, "forensics");
    webDist = path.join(dir, "web-dist");
    fs.mkdirSync(webDist, { recursive: true });
    fs.writeFileSync(
      path.join(webDist, "index.html"),
      "<!doctype html><title>Linear Connector Console</title><div id=\"root\"></div>",
      "utf8",
    );
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.ADMIN_WEB_DIST = webDist;
    reloadAgents();

    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled-tickets.db"),
      forensicsDiagnosticsDir: forensicsDir,
    });

    enrolledStore = new EnrolledTicketsStore(path.join(dir, "enrolled-tickets.db"));
  });

  afterEach(() => {
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    enrolledStore.close?.();
    delete process.env.AGENTS_FILE;
    delete process.env.ADMIN_SECRET;
    delete process.env.ADMIN_WEB_DIST;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns entries with state and delegate fields when ticket is enrolled", async () => {
    const stateEnteredAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    enrolledStore.enroll({
      ticketId: "AI-9001",
      workflow: "dev-impl",
      state: "write-tests",
      delegate: "tdd",
    });
    // Override entered_state_at to 2h ago so age_seconds is meaningful.
    // (The test just checks the field is present and non-null.)
    writeDigestEntry(forensicsDir, "AI-9001", Date.now() - 60 * 60 * 1000);

    const res = await adminGet(appState.app, "/admin/api/stale-digest");
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);

    const entry = res.body.entries[0];
    expect(entry.ticket).toBe("AI-9001");
    expect(entry.state).toBe("write-tests");
    expect(entry.delegate).toBe("tdd");
  });

  test("returns age_seconds as a non-negative number for enrolled tickets", async () => {
    enrolledStore.enroll({
      ticketId: "AI-9002",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "igor",
    });
    writeDigestEntry(forensicsDir, "AI-9002", Date.now() - 30 * 60 * 1000);

    const res = await adminGet(appState.app, "/admin/api/stale-digest");
    expect(res.status).toBe(200);
    const entry = res.body.entries.find((e: { ticket: string }) => e.ticket === "AI-9002");
    expect(entry).toBeDefined();
    expect(typeof entry.age_seconds).toBe("number");
    expect(entry.age_seconds).toBeGreaterThanOrEqual(0);
  });

  test("returns threshold_ms field (may be null when no SLA defined for state)", async () => {
    enrolledStore.enroll({
      ticketId: "AI-9003",
      workflow: "dev-impl",
      state: "intake",
      delegate: "astrid",
    });
    writeDigestEntry(forensicsDir, "AI-9003", Date.now() - 10 * 60 * 1000);

    const res = await adminGet(appState.app, "/admin/api/stale-digest");
    expect(res.status).toBe(200);
    const entry = res.body.entries.find((e: { ticket: string }) => e.ticket === "AI-9003");
    expect(entry).toBeDefined();
    // threshold_ms is present as a key (value may be null when SLA not configured for state)
    expect("threshold_ms" in entry).toBe(true);
  });

  test("returns null enriched fields gracefully when ticket is not in enrolled store", async () => {
    // Digest entry for a ticket that is NOT in the enrolled store
    writeDigestEntry(forensicsDir, "AI-9999", Date.now() - 5 * 60 * 1000);

    const res = await adminGet(appState.app, "/admin/api/stale-digest");
    expect(res.status).toBe(200);
    const entry = res.body.entries.find((e: { ticket: string }) => e.ticket === "AI-9999");
    expect(entry).toBeDefined();
    expect(entry.state).toBeNull();
    expect(entry.delegate).toBeNull();
    expect(entry.age_seconds).toBeNull();
    expect(entry.threshold_ms).toBeNull();
  });

  test("returns last_comment_at field on each entry", async () => {
    enrolledStore.enroll({
      ticketId: "AI-9004",
      workflow: "dev-impl",
      state: "write-tests",
      delegate: "tdd",
    });
    writeDigestEntry(forensicsDir, "AI-9004", Date.now() - 45 * 60 * 1000);

    const res = await adminGet(appState.app, "/admin/api/stale-digest");
    expect(res.status).toBe(200);
    const entry = res.body.entries.find((e: { ticket: string }) => e.ticket === "AI-9004");
    expect(entry).toBeDefined();
    // last_comment_at is present (value may be null or an ISO string)
    expect("last_comment_at" in entry).toBe(true);
  });

  test("returns empty entries array when digest file is missing (clean empty state)", async () => {
    // No digest JSONL written
    const res = await adminGet(appState.app, "/admin/api/stale-digest");
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });
});
