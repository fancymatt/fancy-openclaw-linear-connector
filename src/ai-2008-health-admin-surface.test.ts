/**
 * AI-2008 — Dispatch delivery acknowledgment + retry — no fire-and-forget wakes.
 *
 * Integration surface: the exhaustion warning must be VISIBLE (AC3) and the
 * per-ticket delivery outcomes must be QUERYABLE (AC4). These go through the
 * real Express app (createApp) with supertest, exactly as /health and the
 * /admin console consume them — this also guards against the component being
 * built but never wired into the production entry point (AI-1808 dead-code-in-prod).
 *
 * AC mapping:
 *   AC1 — no fire-and-forget: the delivery-ack layer is wired and live at /health.
 *   AC3 — dispatch-undeliverable warning visible in /health warnings and /admin.
 *   AC4 — delivery outcomes queryable per ticket (dispatch timeline shows
 *         delivered/failed/retrying).
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";

const ADMIN_SECRET = "ai-2008-test-secret";

function tmpDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-2008-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

describe("AI-2008 — /health + /admin delivery-outcome surface", () => {
  let app: ReturnType<typeof createApp>;
  let eventsDbPath: string;
  let mirrorDbPath: string;

  beforeEach(() => {
    eventsDbPath = tmpDbPath("events");
    mirrorDbPath = tmpDbPath("mirror");
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    app = createApp({
      operationalEventsDbPath: eventsDbPath,
      enrolledTicketsDbPath: mirrorDbPath,
    });
  });

  afterEach(() => {
    delete process.env.ADMIN_SECRET;
    (app.operationalEventStore as unknown as { close?: () => void }).close?.();
    fs.rmSync(path.dirname(eventsDbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(mirrorDbPath), { recursive: true, force: true });
  });

  it("AC3: /health exposes a warnings array", async () => {
    const res = await request(app.app).get("/health");
    // Read the body regardless of 200/503 (503 when no agents are configured).
    expect(Array.isArray(res.body.warnings)).toBe(true);
  });

  it("AC1: /health exposes a well-formed dispatchDelivery liveness field", async () => {
    // Field-presence + shape check from createApp. The "scheduler is actually
    // armed at the production entry point" proof lives in the subprocess test
    // (ai-2008-bootstrap-wiring.test.ts), mirroring how universalCanon splits
    // field-presence (here) from bootstrap-armed (the dist/index.js boot).
    const res = await request(app.app).get("/health");
    expect(res.body.dispatchDelivery).toBeDefined();
    expect(typeof res.body.dispatchDelivery.schedulerActive).toBe("boolean");
    expect(typeof res.body.dispatchDelivery.pendingRetries).toBe("number");
  });

  it("AC3: an undeliverable dispatch surfaces as a /health warning naming ticket/state/delegate/gateway", async () => {
    app.operationalEventStore.append({
      outcome: "dispatch-undeliverable",
      agent: "igor",
      key: "linear-AI-9100",
      sessionKey: "linear-AI-9100",
      workflowState: "implementation",
      attemptCount: 3,
      detail: { ticket: "AI-9100", state: "implementation", delegate: "igor", gateway: "grover" },
    });

    const res = await request(app.app).get("/health");
    const warnings: Array<Record<string, unknown>> = res.body.warnings ?? [];
    const undeliverable = warnings.find(
      (w) => JSON.stringify(w).includes("AI-9100"),
    );
    expect(undeliverable).toBeDefined();
    const blob = JSON.stringify(undeliverable);
    expect(blob).toContain("AI-9100"); // ticket
    expect(blob).toContain("implementation"); // state
    expect(blob).toContain("igor"); // delegate
    expect(blob).toContain("grover"); // gateway
  });

  it("AC4: /admin per-ticket dispatch timeline shows delivered/failed/retrying", async () => {
    app.enrolledTicketsStore.enroll({
      ticketId: "AI-9200",
      workflow: "dev-impl",
      state: "implementation",
      delegate: "igor",
    });

    const key = "linear-AI-9200";
    const wakeId = "wake-9200-abc";
    app.operationalEventStore.append({ outcome: "delivery-failed", agent: "igor", key, sessionKey: key, wakeId, attemptCount: 1 });
    app.operationalEventStore.append({ outcome: "delivery-unconfirmed", agent: "igor", key, sessionKey: key, wakeId, attemptCount: 2 });
    app.operationalEventStore.append({ outcome: "delivered", agent: "igor", key, sessionKey: key, wakeId, attemptCount: 3 });

    const res = await request(app.app)
      .get("/admin/api/board/ticket/AI-9200")
      .set("x-admin-secret", ADMIN_SECRET);

    expect(res.status).toBe(200);
    // A first-class dispatch timeline (not just raw event summaries) with
    // normalized delivery statuses.
    expect(Array.isArray(res.body.dispatch_timeline)).toBe(true);
    const statuses = new Set(
      (res.body.dispatch_timeline as Array<{ status: string }>).map((d) => d.status),
    );
    expect(statuses.has("failed")).toBe(true);
    expect(statuses.has("retrying")).toBe(true);
    expect(statuses.has("delivered")).toBe(true);
  });
});
