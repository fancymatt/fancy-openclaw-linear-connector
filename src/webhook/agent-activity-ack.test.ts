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

  // AI-1564: Issue state/label updates by agents are connector facet writes and
  // must NOT trigger the Doing-flip (they were echoing back as activity signals,
  // clobbering the handoff To Do separator).
  test("does NOT acknowledge an Issue update by a known agent (prevents self-loop)", async () => {
    const acknowledgments: Array<{ agentId: string; ticketId: string }> = [];
    const app = createTestApp((agentId, ticketId) => {
      acknowledgments.push({ agentId, ticketId });
    });

    const body = JSON.stringify({
      type: "Issue",
      action: "update",
      createdAt: "2026-06-12T16:00:00.000Z",
      actor: { id: ASTRID_ID, name: "Astrid (CPO)" },
      data: {
        id: "issue-1",
        identifier: "AI-1276",
        title: "Launch Gen CDN performance sprint",
        state: { id: "state-todo", name: "To Do", type: "unstarted" },
        priority: 0,
        priorityLabel: "No priority",
        teamId: "team-ai",
        teamKey: "AI",
        delegate: { id: ASTRID_ID, name: "Astrid (CPO)" },
        labelIds: [],
        url: "https://linear.app/fancymatt/issue/AI-1276",
        createdAt: "2026-06-12T15:00:00.000Z",
        updatedAt: "2026-06-12T16:00:00.000Z",
      },
    });

    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "agent-activity-issue-update")
      .send(body);

    expect(res.status).toBe(200);
    expect(acknowledgments).toEqual([]);
  });

  // AI-1564: Comment-create by a known agent is genuine authored content and
  // MUST still trigger the Doing-flip (this is the legitimate signal we preserve).
  test("acknowledges a Comment-create by a known agent actor", async () => {
    const acknowledgments: Array<{ agentId: string; ticketId: string }> = [];
    const app = createTestApp((agentId, ticketId) => {
      acknowledgments.push({ agentId, ticketId });
    });

    const body = JSON.stringify({
      type: "Comment",
      action: "create",
      createdAt: "2026-06-12T16:01:00.000Z",
      actor: { id: ASTRID_ID, name: "Astrid (CPO)" },
      data: {
        id: "comment-1",
        body: "Reviewing the CDN performance sprint scope now.",
        issue: {
          id: "issue-1",
          identifier: "AI-1276",
        },
        createdAt: "2026-06-12T16:01:00.000Z",
        updatedAt: "2026-06-12T16:01:00.000Z",
      },
    });

    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "agent-activity-comment-create")
      .send(body);

    expect(res.status).toBe(200);
    expect(acknowledgments).toEqual([
      { agentId: "astrid", ticketId: "linear-AI-1276" },
    ]);
  });

  // AI-1564: The type guard must cover Issue-create, not just Issue-update.
  // A connector that creates an issue (e.g. during routing setup) would also echo
  // back as activity without this — same self-loop vector as Issue-update.
  test("does NOT acknowledge an Issue-create by a known agent (guard covers all Issue actions)", async () => {
    const acknowledgments: Array<{ agentId: string; ticketId: string }> = [];
    const app = createTestApp((agentId, ticketId) => {
      acknowledgments.push({ agentId, ticketId });
    });

    const body = JSON.stringify({
      type: "Issue",
      action: "create",
      createdAt: "2026-06-12T16:02:00.000Z",
      actor: { id: ASTRID_ID, name: "Astrid (CPO)" },
      data: {
        id: "issue-2",
        identifier: "AI-1277",
        title: "New ticket created by agent",
        state: { id: "state-todo", name: "To Do", type: "unstarted" },
        priority: 0,
        priorityLabel: "No priority",
        teamId: "team-ai",
        teamKey: "AI",
        delegate: { id: ASTRID_ID, name: "Astrid (CPO)" },
        labelIds: [],
        url: "https://linear.app/fancymatt/issue/AI-1277",
        createdAt: "2026-06-12T16:02:00.000Z",
        updatedAt: "2026-06-12T16:02:00.000Z",
      },
    });

    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "agent-activity-issue-create")
      .send(body);

    expect(res.status).toBe(200);
    expect(acknowledgments).toEqual([]);
  });

  // AI-1564: AgentSessionEvent is explicitly in the allowed list; it must still
  // fire the Doing-flip. This is the Linear UI widget session-creation signal.
  test("acknowledges an AgentSessionEvent by a known agent actor", async () => {
    const acknowledgments: Array<{ agentId: string; ticketId: string }> = [];
    const app = createTestApp((agentId, ticketId) => {
      acknowledgments.push({ agentId, ticketId });
    });

    const body = JSON.stringify({
      type: "AgentSessionEvent",
      action: "create",
      createdAt: "2026-06-12T16:03:00.000Z",
      actor: { id: ASTRID_ID, name: "Astrid (CPO)" },
      data: {
        id: "session-1",
        issueIdentifier: "AI-1276",
        status: "active",
        createdAt: "2026-06-12T16:03:00.000Z",
        updatedAt: "2026-06-12T16:03:00.000Z",
      },
    });

    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "agent-activity-session-event")
      .send(body);

    expect(res.status).toBe(200);
    expect(acknowledgments).toEqual([
      { agentId: "astrid", ticketId: "linear-AI-1276" },
    ]);
  });

  // AI-1564: Unrecognized event types (e.g. IssueLabel) authored by an agent
  // must NOT trigger the Doing-flip — any non-Comment/non-AgentSessionEvent is
  // a facet write or structural update, not genuine agent output.
  test("does NOT acknowledge an unknown event type (e.g. IssueLabel) by a known agent", async () => {
    const acknowledgments: Array<{ agentId: string; ticketId: string }> = [];
    const app = createTestApp((agentId, ticketId) => {
      acknowledgments.push({ agentId, ticketId });
    });

    const body = JSON.stringify({
      type: "IssueLabel",
      action: "create",
      createdAt: "2026-06-12T16:04:00.000Z",
      actor: { id: ASTRID_ID, name: "Astrid (CPO)" },
      data: {
        id: "label-event-1",
        identifier: "AI-1276",
        label: { id: "lbl-1", name: "wf:dev-impl", color: "#4EA7FC" },
        createdAt: "2026-06-12T16:04:00.000Z",
        updatedAt: "2026-06-12T16:04:00.000Z",
      },
    });

    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "agent-activity-label-event")
      .send(body);

    expect(res.status).toBe(200);
    expect(acknowledgments).toEqual([]);
  });

  // AI-1564: A Comment-create from a non-agent (human) actor must NOT trigger
  // the Doing-flip — the actor guard must still fire after the type guard passes.
  test("does NOT acknowledge a Comment-create by an unknown (non-agent) actor", async () => {
    const acknowledgments: Array<{ agentId: string; ticketId: string }> = [];
    const app = createTestApp((agentId, ticketId) => {
      acknowledgments.push({ agentId, ticketId });
    });

    const body = JSON.stringify({
      type: "Comment",
      action: "create",
      createdAt: "2026-06-12T16:05:00.000Z",
      actor: { id: "human-actor-id-not-in-agents", name: "Matt Henry" },
      data: {
        id: "comment-2",
        body: "This comment is from a human, not an agent.",
        issue: {
          id: "issue-1",
          identifier: "AI-1276",
        },
        createdAt: "2026-06-12T16:05:00.000Z",
        updatedAt: "2026-06-12T16:05:00.000Z",
      },
    });

    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .set("x-linear-signature", sign(body))
      .set("x-linear-delivery", "agent-activity-human-comment")
      .send(body);

    expect(res.status).toBe(200);
    expect(acknowledgments).toEqual([]);
  });
});
