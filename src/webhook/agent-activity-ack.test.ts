import crypto from "crypto";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { reloadAgents } from "../agents.js";
import { createWebhookRouter } from "./index.js";

const SECRET = "test-agent-activity-secret";
const ASTRID_ID = "7a946365-bdf0-4e06-b31a-b90f0cc9fb22";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function createTestApp(onAgentActivity: (agentId: string, ticketId: string) => void) {
  const app = express();
  app.use(
    express.raw({ type: "application/json", limit: "1mb" }),
    (req, _res, next) => {
      if (Buffer.isBuffer(req.body)) {
        (req as express.Request & { rawBody?: Buffer }).rawBody = req.body;
      }
      next();
    },
  );
  app.use(
    "/",
    createWebhookRouter(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onAgentActivity,
    ),
  );
  return app;
}

describe("agent-authored activity acknowledgments", () => {
  let dir: string;
  let agentsFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-activity-ack-test-"));
    agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          {
            name: "astrid",
            linearUserId: ASTRID_ID,
            openclawAgent: "astrid",
            clientId: "c1",
            clientSecret: "s1",
            accessToken: "tok1",
            refreshToken: "ref1",
          },
        ],
      }),
    );
    process.env.AGENTS_FILE = agentsFile;
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    reloadAgents();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.LINEAR_WEBHOOK_SECRET;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("acknowledges a dispatch when the target agent changes the issue", async () => {
    const acknowledgments: Array<{ agentId: string; ticketId: string }> = [];
    const app = createTestApp((agentId, ticketId) => {
      acknowledgments.push({ agentId, ticketId });
    });

    const body = JSON.stringify({
      type: "Issue",
      action: "update",
      createdAt: "2026-05-31T19:38:51.252Z",
      actor: { id: ASTRID_ID, name: "Astrid (CPO)" },
      data: {
        id: "issue-1",
        identifier: "AI-1276",
        title: "Launch Gen CDN performance sprint",
        state: { id: "state-thinking", name: "Thinking", type: "started" },
        priority: 0,
        priorityLabel: "No priority",
        teamId: "team-ai",
        teamKey: "AI",
        delegate: { id: ASTRID_ID, name: "Astrid (CPO)" },
        labelIds: [],
        url: "https://linear.app/fancymatt/issue/AI-1276",
        createdAt: "2026-05-31T19:26:42.940Z",
        updatedAt: "2026-05-31T19:38:51.252Z",
      },
    });

    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "agent-activity-1")
      .send(body);

    expect(res.status).toBe(200);
    expect(acknowledgments).toEqual([
      { agentId: "astrid", ticketId: "linear-AI-1276" },
    ]);
  });
});
