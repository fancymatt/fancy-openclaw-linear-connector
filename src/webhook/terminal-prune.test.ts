import crypto from "crypto";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { PendingWorkBag } from "../bag/pending-work-bag.js";
import { SessionTracker } from "../bag/session-tracker.js";
import { createWebhookRouter } from "./index.js";

const SECRET = "test-terminal-prune-secret";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-prune-test-"));
  return path.join(dir, "test.db");
}

function createTestApp(bag: PendingWorkBag, sessionTracker: SessionTracker) {
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
  app.use("/", createWebhookRouter(undefined, undefined, undefined, bag, sessionTracker));
  return app;
}

describe("terminal issue dispatch pruning", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let dbPath: string;
  let bag: PendingWorkBag;
  let sessionTracker: SessionTracker;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv, LINEAR_WEBHOOK_SECRET: SECRET };
    dbPath = tempDb();
    bag = new PendingWorkBag(dbPath, 60_000);
    sessionTracker = new SessionTracker(30_000);
  });

  afterEach(() => {
    process.env = originalEnv;
    bag.close();
    sessionTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("Done issue update drops stale pending bag and queued signals before agent dispatch", async () => {
    bag.add("igor", "AI-501", "Issue");
    bag.add("charles", "AI-501", "Issue");
    bag.add("igor", "AI-597", "Issue");
    sessionTracker.startSession("igor", "linear-AI-500");
    sessionTracker.queueSignal("igor", ["linear-AI-501", "linear-AI-597"]);

    const body = JSON.stringify({
      type: "Issue",
      action: "update",
      createdAt: "2026-04-30T23:40:00.000Z",
      actor: { id: "reviewer", name: "Charles" },
      data: {
        id: "issue-501",
        identifier: "AI-501",
        title: "Already completed work",
        state: { id: "done", name: "Done", type: "completed" },
        priority: 0,
        priorityLabel: "No priority",
        team: { id: "team-ai", key: "AI" },
        labelIds: [],
        url: "https://linear.app/fancymatt/issue/AI-501",
        delegate: { id: "igor-id", name: "Igor" },
        createdAt: "2026-04-27T19:00:00.000Z",
        updatedAt: "2026-04-30T23:40:00.000Z",
      },
    });

    const res = await request(createTestApp(bag, sessionTracker))
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "terminal-ai-501")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(bag.getPendingTickets("igor").map((entry) => entry.ticketId)).toEqual(["linear-AI-597"]);
    expect(bag.getPendingTickets("charles")).toHaveLength(0);
    expect(sessionTracker.endSession("igor")).toEqual(["linear-AI-597"]);
    expect(bag.getStats().signalsSent).toBe(0);
  });
});
