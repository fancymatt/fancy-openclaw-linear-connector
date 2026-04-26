/**
 * Tests for nudge deduplication in webhook delivery.
 *
 * Verifies that multiple events for the same agent+ticket within the
 * dedup window are collapsed to a single delivery.
 */

import crypto from "crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import express from "express";
import { NudgeStore } from "../store/nudge-store.js";
import { createWebhookRouter } from "./index.js";

const SECRET = "test-nudge-dedup-secret";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function makeIssuePayload(identifier: string, delegateId: string) {
  return JSON.stringify({
    type: "Issue",
    action: "update",
    createdAt: "2026-04-25T12:00:00.000Z",
    actor: { id: "a1", name: "Alice" },
    data: {
      id: "issue-1",
      identifier,
      title: "Test issue",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      priority: 0,
      priorityLabel: "No priority",
      team: { id: "t1", key: "AI" },
      labelIds: [],
      url: `https://linear.app/test/issue/${identifier}`,
      assignee: { id: "u1", name: "Test User" },
      delegate: { id: delegateId, name: "Charles (CTO)" },
      createdAt: "2026-04-25T12:00:00.000Z",
      updatedAt: "2026-04-25T12:00:00.000Z",
    },
  });
}

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nudge-dedup-test-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function createTestApp(nudgeStore: NudgeStore) {
  const app = express();
  app.use(
    express.raw({ type: "application/json", limit: "1mb" }),
    (req, _res, next) => {
      if (Buffer.isBuffer(req.body)) {
        (req as any).rawBody = req.body;
      }
      next();
    },
  );
  app.use("/", createWebhookRouter(undefined, nudgeStore));
  return app;
}

describe("nudge deduplication", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    // Set a short dedup window for testing
    process.env.NUDGE_DEDUP_WINDOW_MS = "5000";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("delivers the first event for a given agent+ticket", async () => {
    const { dir, cleanup } = makeTempDir();
    const nudgeStore = new NudgeStore(path.join(dir, "nudges.db"));
    const app = createTestApp(nudgeStore);

    const body = makeIssuePayload("AI-431", "charles-id");
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "unique-delivery-1")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    nudgeStore.close();
    cleanup();
  });

  it("suppresses duplicate event within the dedup window", async () => {
    const { dir, cleanup } = makeTempDir();
    const nudgeStore = new NudgeStore(path.join(dir, "nudges.db"));
    const app = createTestApp(nudgeStore);

    // First delivery
    const body1 = makeIssuePayload("AI-431", "charles-id");
    await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body1))
      .set("x-linear-delivery", "unique-delivery-1")
      .send(body1);

    // Second delivery for same ticket — should be deduped
    const body2 = makeIssuePayload("AI-431", "charles-id");
    const res2 = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body2))
      .set("x-linear-delivery", "unique-delivery-2")
      .send(body2);

    expect(res2.status).toBe(200);
    expect(res2.body.ok).toBe(true);

    nudgeStore.close();
    cleanup();
  });

  it("allows different tickets through even within the window", async () => {
    const { dir, cleanup } = makeTempDir();
    const nudgeStore = new NudgeStore(path.join(dir, "nudges.db"));
    const app = createTestApp(nudgeStore);

    // First ticket
    const body1 = makeIssuePayload("AI-431", "charles-id");
    await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body1))
      .set("x-linear-delivery", "unique-delivery-1")
      .send(body1);

    // Different ticket — should go through
    const body2 = makeIssuePayload("AI-432", "charles-id");
    const res2 = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body2))
      .set("x-linear-delivery", "unique-delivery-2")
      .send(body2);

    expect(res2.status).toBe(200);
    expect(res2.body.ok).toBe(true);

    nudgeStore.close();
    cleanup();
  });

  it("respects NUDGE_DEDUP_WINDOW_MS=0 to disable dedup", async () => {
    process.env.NUDGE_DEDUP_WINDOW_MS = "0";
    const { dir, cleanup } = makeTempDir();
    const nudgeStore = new NudgeStore(path.join(dir, "nudges.db"));
    const app = createTestApp(nudgeStore);

    const body = makeIssuePayload("AI-431", "charles-id");
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "unique-delivery-1")
      .send(body);

    expect(res.status).toBe(200);

    nudgeStore.close();
    cleanup();
  });
});
