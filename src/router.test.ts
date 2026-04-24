/**
 * Tests for extractAgentTarget() and routeEvent().
 *
 * Uses a temp agents.json file via the AGENTS_FILE env var so tests are
 * hermetically isolated from any real agents.json on disk.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractAgentTarget, routeEvent } from "./router";
import type { LinearEvent } from "./webhook/schema";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempAgentsFile(agents: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-test-"));
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({ agents }));
  return file;
}

function makeIssueEvent(overrides: Partial<{
  actorId: string;
  actorName: string;
  assigneeId: string;
  delegateId: string;
  delegateName: string;
  identifier: string;
  title: string;
  commentBody: string;
}>): LinearEvent {
  const {
    actorId = "actor-human",
    actorName = "Matt Henry",
    assigneeId,
    delegateId,
    delegateName,
    identifier = "AI-1",
    title = "Test issue",
    commentBody,
  } = overrides;

  if (commentBody !== undefined) {
    return {
      type: "Comment",
      action: "create",
      actor: { id: actorId, name: actorName },
      createdAt: "2026-04-24T00:00:00.000Z",
      data: {
        id: "comment-1",
        body: commentBody,
        issueId: "issue-1",
        issue: { id: "issue-1", identifier, title },
        userId: actorId,
        createdAt: "2026-04-24T00:00:00.000Z",
        updatedAt: "2026-04-24T00:00:00.000Z",
      },
      raw: {},
    } as unknown as LinearEvent;
  }

  return {
    type: "Issue",
    action: "update",
    actor: { id: actorId, name: actorName },
    createdAt: "2026-04-24T00:00:00.000Z",
    data: {
      id: "issue-1",
      identifier,
      title,
      state: { id: "s1", name: "Todo", type: "unstarted" },
      priority: 0,
      priorityLabel: "No priority",
      teamId: "team-1",
      teamKey: "AI",
      labelIds: [],
      url: "https://linear.app/fancymatt/issue/AI-1",
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:00:00.000Z",
      ...(assigneeId ? { assigneeId, assignee: { id: assigneeId, name: "Assignee" } } : {}),
      ...(delegateId ? { delegateId, delegate: { id: delegateId, name: delegateName ?? "Delegate" } } : {}),
    },
    raw: {},
  } as unknown as LinearEvent;
}

const CHARLES_ID = "755df734-3557-463f-8404-9c30a0397855";
const ASTRID_ID  = "7a946365-bdf0-4e06-b31a-b90f0cc9fb22";

const BASE_AGENTS = [
  { name: "charles", linearUserId: CHARLES_ID, openclawAgent: "charles", clientId: "c1", clientSecret: "s1", accessToken: "tok1", refreshToken: "ref1" },
  { name: "astrid",  linearUserId: ASTRID_ID,  openclawAgent: "astrid",  clientId: "c2", clientSecret: "s2", accessToken: "tok2", refreshToken: "ref2" },
];

// ── extractAgentTarget ────────────────────────────────────────────────────────

describe("extractAgentTarget", () => {
  let agentsFile: string;

  beforeEach(() => {
    agentsFile = makeTempAgentsFile(BASE_AGENTS);
    process.env.AGENTS_FILE = agentsFile;
    // Force reload of the agents module cache
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    fs.rmSync(path.dirname(agentsFile), { recursive: true, force: true });
  });

  it("routes via delegate field", () => {
    const { extractAgentTarget } = require("./router");
    const event = makeIssueEvent({ delegateId: CHARLES_ID, delegateName: "Charles" });
    const result = extractAgentTarget(event);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("charles");
    expect(result?.reason).toBe("delegate");
  });

  it("falls back to assignee when no delegate", () => {
    const { extractAgentTarget } = require("./router");
    const event = makeIssueEvent({ assigneeId: ASTRID_ID });
    const result = extractAgentTarget(event);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("astrid");
    expect(result?.reason).toBe("assignee");
  });

  it("prefers delegate over assignee when both present", () => {
    const { extractAgentTarget } = require("./router");
    const event = makeIssueEvent({ delegateId: CHARLES_ID, assigneeId: ASTRID_ID });
    const result = extractAgentTarget(event);
    expect(result?.name).toBe("charles");
    expect(result?.reason).toBe("delegate");
  });

  it("routes via body mention in Comment event", () => {
    const { extractAgentTarget } = require("./router");
    const event = makeIssueEvent({ commentBody: "Hey @charles can you look at this?" });
    const result = extractAgentTarget(event);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("charles");
    expect(result?.reason).toBe("body-mention");
  });

  it("returns null when no agents are configured", () => {
    const emptyFile = makeTempAgentsFile([]);
    process.env.AGENTS_FILE = emptyFile;
    jest.resetModules();
    const { extractAgentTarget } = require("./router");
    const event = makeIssueEvent({ delegateId: CHARLES_ID });
    const result = extractAgentTarget(event);
    expect(result).toBeNull();
    fs.rmSync(path.dirname(emptyFile), { recursive: true, force: true });
  });

  it("returns null when user ID does not match any agent", () => {
    const { extractAgentTarget } = require("./router");
    const event = makeIssueEvent({ delegateId: "unknown-user-id" });
    const result = extractAgentTarget(event);
    expect(result).toBeNull();
  });

  it("suppresses self-triggered events (actor is the target agent)", () => {
    const { extractAgentTarget } = require("./router");
    // charles delegates to charles (actor = target — self-trigger)
    const event = makeIssueEvent({ actorId: CHARLES_ID, delegateId: CHARLES_ID });
    const result = extractAgentTarget(event);
    expect(result).toBeNull();
  });

  it("allows agent-to-agent delegation (actor is agent A, target is agent B)", () => {
    const { extractAgentTarget } = require("./router");
    // astrid delegates to charles
    const event = makeIssueEvent({ actorId: ASTRID_ID, delegateId: CHARLES_ID });
    const result = extractAgentTarget(event);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("charles");
  });
});

// ── routeEvent ────────────────────────────────────────────────────────────────

describe("routeEvent", () => {
  let agentsFile: string;

  beforeEach(() => {
    agentsFile = makeTempAgentsFile(BASE_AGENTS);
    process.env.AGENTS_FILE = agentsFile;
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    fs.rmSync(path.dirname(agentsFile), { recursive: true, force: true });
  });

  it("returns a RouteResult with correct agentId and sessionKey", () => {
    const { routeEvent } = require("./router");
    const event = makeIssueEvent({ delegateId: CHARLES_ID, identifier: "AI-393" });
    const result = routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.agentId).toBe("charles");
    expect(result?.sessionKey).toContain("AI-393");
  });

  it("returns null when no agent target found", () => {
    const { routeEvent } = require("./router");
    const event = makeIssueEvent({});
    const result = routeEvent(event);
    expect(result).toBeNull();
  });
});
