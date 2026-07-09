/**
 * Tests for extractAgentTarget() and routeEvent().
 *
 * Uses a temp agents.json file via the AGENTS_FILE env var so tests are
 * hermetically isolated from any real agents.json on disk.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractAgentTarget, routeEvent, routeEventAll } from "./router.js";
import { reloadAgents } from "./agents.js";
import { resetRosterCache } from "./department-roster.js";
import type { LinearEvent } from "./webhook/schema.js";

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
  /** Top-level updatedFrom for Issue update events (AI-1573). */
  updatedFrom: Record<string, unknown>;
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
    updatedFrom,
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
        mentionedUsers: [],
        ...(delegateId ? { delegateId, delegate: { id: delegateId, name: delegateName ?? "Delegate" } } : {}),
        ...(assigneeId ? { assigneeId, assignee: { id: assigneeId, name: "Assignee" } } : {}),
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
    ...(updatedFrom !== undefined ? { updatedFrom } : {}),
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
    reloadAgents();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    fs.rmSync(path.dirname(agentsFile), { recursive: true, force: true });
  });

  it("routes via delegate field", () => {
    const event = makeIssueEvent({ delegateId: CHARLES_ID, delegateName: "Charles" });
    const result = extractAgentTarget(event);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("charles");
    expect(result?.reason).toBe("delegate");
  });

  it("falls back to assignee when no delegate", () => {
    const event = makeIssueEvent({ assigneeId: ASTRID_ID });
    const result = extractAgentTarget(event);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("astrid");
    expect(result?.reason).toBe("assignee");
  });

  it("prefers delegate over assignee when both present", () => {
    const event = makeIssueEvent({ delegateId: CHARLES_ID, assigneeId: ASTRID_ID });
    const result = extractAgentTarget(event);
    expect(result?.name).toBe("charles");
    expect(result?.reason).toBe("delegate");
  });

  it("routes via body mention in Comment event", () => {
    const event = makeIssueEvent({ commentBody: "Hey @charles can you look at this?" });
    const result = extractAgentTarget(event);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("charles");
    expect(result?.reason).toBe("body-mention");
  });

  it("returns null when no agents are configured", () => {
    const emptyFile = makeTempAgentsFile([]);
    process.env.AGENTS_FILE = emptyFile;
    reloadAgents();
    const event = makeIssueEvent({ delegateId: CHARLES_ID });
    const result = extractAgentTarget(event);
    expect(result).toBeNull();
    fs.rmSync(path.dirname(emptyFile), { recursive: true, force: true });
  });

  it("returns null when user ID does not match any agent", () => {
    const event = makeIssueEvent({ delegateId: "unknown-user-id" });
    const result = extractAgentTarget(event);
    expect(result).toBeNull();
  });

  it("returns the target even for self-triggered events (filtering moved to routeEvent)", () => {
    // AI-1479: extractAgentTarget no longer suppresses self-triggers.
    // Filtering is handled by the async routeEvent() after consulting the roster.
    const event = makeIssueEvent({ actorId: CHARLES_ID, delegateId: CHARLES_ID });
    const result = extractAgentTarget(event);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("charles");
  });

  it("allows agent-to-agent delegation (actor is agent A, target is agent B)", () => {
    const event = makeIssueEvent({ actorId: ASTRID_ID, delegateId: CHARLES_ID });
    const result = extractAgentTarget(event);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("charles");
  });

  // ── AI-1573: updatedFrom delegate-change guard ─────────────────────────────
  // Linear emits updatedFrom with the *previous* field values for changed fields.
  // For delegate changes the key may be "delegateId" (UUID string) or "delegate"
  // (object) — both encodings are tested. When updatedFrom is present but has
  // neither key, the delegate field was NOT part of this update.

  it("AC1: non-self same-value delegate write (updatedFrom missing delegate key) dispatches on state transition", () => {
    // Steward astrid writes delegate=charles when charles is already the delegate.
    // updatedFrom only records the field that changed; no delegateId/delegate key
    // means the delegate was unchanged in this update.
    // However, stateId changed — per AI-1573, state transitions always dispatch
    // even when the delegate is unchanged, because the agent is starting a new step.
    const event = makeIssueEvent({
      actorId: ASTRID_ID,
      delegateId: CHARLES_ID,
      updatedFrom: { stateId: "prev-state-id" },
    });
    const result = extractAgentTarget(event);
    expect(result).toEqual({ name: "charles", reason: "delegate" });
  });

  it("AC1 (empty updatedFrom): no fields changed at all does not dispatch", () => {
    const event = makeIssueEvent({ delegateId: CHARLES_ID, updatedFrom: {} });
    const result = extractAgentTarget(event);
    expect(result).toBeNull();
  });

  it("AC2: unrelated-field edit (labelIds) with unchanged delegate does not dispatch", () => {
    const event = makeIssueEvent({
      delegateId: CHARLES_ID,
      updatedFrom: { labelIds: ["old-label-uuid"] },
    });
    const result = extractAgentTarget(event);
    expect(result).toBeNull();
  });

  it("AC2: unrelated-field edit (description) with unchanged delegate does not dispatch", () => {
    const event = makeIssueEvent({
      delegateId: CHARLES_ID,
      updatedFrom: { description: "old description text" },
    });
    const result = extractAgentTarget(event);
    expect(result).toBeNull();
  });

  it("AC3: genuine delegate change (updatedFrom.delegateId present) dispatches correctly", () => {
    // delegateId encoding: Linear emits previous UUID as updatedFrom.delegateId
    const event = makeIssueEvent({
      delegateId: CHARLES_ID,
      updatedFrom: { delegateId: "prev-user-uuid" },
    });
    const result = extractAgentTarget(event);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("charles");
    expect(result?.reason).toBe("delegate");
  });

  it("AC3 (object encoding): genuine delegate change (updatedFrom.delegate present) dispatches correctly", () => {
    // delegate-object encoding: Linear emits previous delegate object as updatedFrom.delegate
    const event = makeIssueEvent({
      delegateId: CHARLES_ID,
      updatedFrom: { delegate: { id: "prev-user-uuid", name: "Previous Person" } },
    });
    const result = extractAgentTarget(event);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("charles");
    expect(result?.reason).toBe("delegate");
  });

  it("AC3 (absent updatedFrom): missing updatedFrom means we cannot confirm no-change — dispatch conservatively", () => {
    // No updatedFrom at all: treat as genuine delegation (safe default — miss a
    // no-op rather than suppress a real handoff).
    const event = makeIssueEvent({ delegateId: CHARLES_ID }); // no updatedFrom field
    const result = extractAgentTarget(event);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("charles");
  });

  it("AC3 (agent-to-agent delegation with updatedFrom.delegateId) dispatches correctly", () => {
    const event = makeIssueEvent({
      actorId: ASTRID_ID,
      delegateId: CHARLES_ID,
      updatedFrom: { delegateId: ASTRID_ID },
    });
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
    reloadAgents();
    // No roster loaded — tests use agent-map routing.
    delete process.env.DEPARTMENT_ROSTER_PATH;
    resetRosterCache();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    fs.rmSync(path.dirname(agentsFile), { recursive: true, force: true });
    resetRosterCache();
  });

  it("returns a RouteResult with correct agentId and sessionKey", async () => {
    const event = makeIssueEvent({ delegateId: CHARLES_ID, identifier: "AI-393" });
    const result = await routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.agentId).toBe("charles");
    expect(result?.sessionKey).toContain("AI-393");
  });

  it("extracts identifier from nested issue object (Comment event)", async () => {
    const event = makeIssueEvent({ delegateId: CHARLES_ID, commentBody: "hello" });
    // Comment events nest identifier under data.issue.identifier
    const result = await routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.sessionKey).toBe("linear-AI-1");
  });

  it("extracts identifier from deeply nested agentSession path", async () => {
    const event: LinearEvent = {
      type: "AgentSessionEvent",
      action: "create",
      actor: { id: "actor-1", name: "System" },
      createdAt: "2026-04-27T00:00:00.000Z",
      data: {
        agentSession: {
          issue: { identifier: "SAK-50", id: "issue-1" },
          appUser: { id: CHARLES_ID },
        },
        delegate: { id: CHARLES_ID, name: "Charles" },
      },
      raw: {},
    };
    const result = await routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.sessionKey).toBe("linear-SAK-50");
  });

  it("AgentSessionEvent with no resolvable session owner wakes nobody (audit #16)", async () => {
    const event: LinearEvent = {
      type: "AgentSessionEvent",
      action: "create",
      actor: { id: "actor-1", name: "System" },
      createdAt: "2026-04-27T00:00:00.000Z",
      data: {
        agentSession: {
          issue: { identifier: "SAK-51", id: "issue-2" },
          appUser: { id: "not-a-registered-agent" },
        },
      },
      raw: {},
    };
    expect(await routeEvent(event)).toBeNull();
  });

  it("extracts identifier from notification.issue path", async () => {
    const event: LinearEvent = {
      type: "IssueNotification",
      action: "mentioned",
      actor: { id: "actor-1", name: "System" },
      createdAt: "2026-04-27T00:00:00.000Z",
      data: {
        notification: {
          issue: { identifier: "ILL-68", id: "issue-1" },
        },
        mentionedUsers: [{ id: CHARLES_ID, name: "Charles" }],
      },
      raw: {},
    };
    const result = await routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.sessionKey).toBe("linear-ILL-68");
  });

  it("uses deep recursive search for unknown nested shapes", async () => {
    const event: LinearEvent = {
      type: "SomeNewEventType",
      action: "create",
      actor: { id: "actor-1", name: "System" },
      createdAt: "2026-04-27T00:00:00.000Z",
      data: {
        deeply: {
          nested: {
            thing: {
              identifier: "FCY-42",
            },
          },
        },
        delegate: { id: CHARLES_ID, name: "Charles" },
      },
      raw: {},
    };
    const result = await routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.sessionKey).toBe("linear-FCY-42");
  });

  it("falls back to timestamp key only when no identifier found anywhere", async () => {
    const before = Date.now();
    const event: LinearEvent = {
      type: "MysteryEvent",
      action: "create",
      actor: { id: "actor-1", name: "System" },
      createdAt: "2026-04-27T00:00:00.000Z",
      data: {
        delegate: { id: CHARLES_ID, name: "Charles" },
      },
      raw: {},
    };
    const result = await routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.sessionKey).toMatch(/^linear-MysteryEvent-\d+$/);
    const ts = parseInt(result!.sessionKey.split("-").pop()!, 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it("returns null when no agent target found (no roster: fail-open no-route)", async () => {
    const event = makeIssueEvent({});
    const result = await routeEvent(event);
    // AI-1479: steward escalation (AC2) is an ACTIVE-functionary behavior. When
    // no roster is loaded the functionary is inactive and routeEvent fails open
    // to the pre-AI-1479 agent-map behavior — an event that resolves to no agent
    // simply no-routes. (Escalation-to-steward when a roster IS loaded is covered
    // by the "department roster" describe block and department-roster.test.ts.)
    expect(result).toBeNull();
  });

  it("suppresses self-triggered events (actor is delegate, no roster)", async () => {
    const event = makeIssueEvent({ actorId: CHARLES_ID, delegateId: CHARLES_ID });
    const result = await routeEvent(event);
    // Actor is charles, delegate is charles — self-trigger, suppressed.
    expect(result).toBeNull();
  });

  it("suppresses self-triggered events when actor is agent with no target", async () => {
    const event = makeIssueEvent({ actorId: CHARLES_ID }); // no delegate/assignee/mention
    const result = await routeEvent(event);
    // Actor is an agent (charles), no mechanical target — self-trigger suppressed.
    expect(result).toBeNull();
  });

  it("allows agent-to-agent delegation through routeEvent", async () => {
    const event = makeIssueEvent({ actorId: ASTRID_ID, delegateId: CHARLES_ID });
    const result = await routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.agentId).toBe("charles");
  });
});

// ── routeEventAll — multi-mention fan-out (audit #3) ─────────────────────────

describe("routeEventAll", () => {
  const IGOR_ID = "11111111-2222-3333-4444-555555555555";
  let agentsFile: string;

  beforeEach(() => {
    agentsFile = makeTempAgentsFile([
      ...BASE_AGENTS,
      { name: "igor", linearUserId: IGOR_ID, openclawAgent: "igor", clientId: "c3", clientSecret: "s3", accessToken: "tok3", refreshToken: "ref3" },
    ]);
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
    // No roster loaded — fan-out tests exercise mechanical (agent-map) routing.
    delete process.env.DEPARTMENT_ROSTER_PATH;
    resetRosterCache();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    resetRosterCache();
    fs.rmSync(path.dirname(agentsFile), { recursive: true, force: true });
  });

  it("returns primary route only when nothing else is mentioned", async () => {
    const event = makeIssueEvent({ delegateId: CHARLES_ID, updatedFrom: { delegateId: null } });
    const routes = await routeEventAll(event);
    expect(routes.map((r) => r.agentId)).toEqual(["charles"]);
  });

  it("wakes every registered agent mentioned in a comment body, not just the first", async () => {
    const event = makeIssueEvent({ commentBody: "@astrid please loop in @igor and @charles on this" });
    const routes = await routeEventAll(event);
    // astrid is primary (first body mention); igor + charles fan out
    expect(routes[0].agentId).toBe("astrid");
    expect(routes.map((r) => r.agentId).sort()).toEqual(["astrid", "charles", "igor"]);
    // all share the ticket session key
    expect(new Set(routes.map((r) => r.sessionKey)).size).toBe(1);
    expect(routes.slice(1).every((r) => r.routingReason === "mention")).toBe(true);
  });

  it("fans out payload mentionedUsers beyond the first", async () => {
    const event = makeIssueEvent({ commentBody: "please review" });
    (event as { data: { mentionedUsers: unknown } }).data.mentionedUsers = [
      { id: ASTRID_ID }, { id: IGOR_ID }, { id: "not-an-agent" },
    ];
    const routes = await routeEventAll(event);
    expect(routes.map((r) => r.agentId).sort()).toEqual(["astrid", "igor"]);
  });

  it("excludes the acting agent from fan-out (self-trigger)", async () => {
    const event = makeIssueEvent({ actorId: CHARLES_ID, commentBody: "@astrid see my note, cc @charles" });
    const routes = await routeEventAll(event);
    // charles is the actor — mentioned but never fanned out to
    expect(routes.map((r) => r.agentId).sort()).toEqual(["astrid"]);
  });

  it("does not duplicate the delegate when they are also mentioned", async () => {
    const event = makeIssueEvent({ delegateId: CHARLES_ID, updatedFrom: { delegateId: null } });
    (event as { data: { mentionedUsers: unknown } }).data.mentionedUsers = [{ id: CHARLES_ID }, { id: IGOR_ID }];
    const routes = await routeEventAll(event);
    expect(routes.map((r) => r.agentId).sort()).toEqual(["charles", "igor"]);
    expect(routes[0].routingReason).toBe("delegate");
  });

  it("returns empty when no target resolves", async () => {
    const event = makeIssueEvent({ commentBody: "no agents mentioned here" });
    expect(await routeEventAll(event)).toEqual([]);
  });
});

// ── routeEvent + department roster integration ───────────────────────────────

describe("routeEvent with department roster — self-trigger suppression", () => {
  let agentsFile: string;
  let rosterFile: string;

  // Roster: AI → charles, ILL → astrid, steward → astrid
  const ROSTER_YAML = `
version: 1
steward: astrid
departments:
  AI:
    name: AI Team
    defaultTarget: charles
  ILL:
    name: ILL Team
    defaultTarget: astrid
`;

  beforeEach(() => {
    agentsFile = makeTempAgentsFile(BASE_AGENTS);
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    const dir = path.dirname(agentsFile);
    rosterFile = path.join(dir, "department-roster.yaml");
    fs.writeFileSync(rosterFile, ROSTER_YAML);
    process.env.DEPARTMENT_ROSTER_PATH = rosterFile;
    resetRosterCache();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.DEPARTMENT_ROSTER_PATH;
    fs.rmSync(path.dirname(agentsFile), { recursive: true, force: true });
    resetRosterCache();
  });

  it("agent actor with no mechanical target routes via department prefix (not suppressed)", async () => {
    // Charles comments on ILL-42. No delegate/assignee/mention. Roster routes
    // ILL → astrid. This should NOT be suppressed — astrid != charles (the actor).
    const event = makeIssueEvent({
      actorId: CHARLES_ID,
      identifier: "ILL-42",
      commentBody: "some comment",
    });
    const result = await routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.agentId).toBe("astrid");
    expect(result?.routingReason).toBe("department-prefix");
  });

  it("agent actor with no mechanical target still suppressed when no department match", async () => {
    // Charles comments on XYZ-99. No department for XYZ, no mechanical target.
    // Should suppress (self-trigger, nowhere to route that isn't the actor).
    const event = makeIssueEvent({
      actorId: CHARLES_ID,
      identifier: "XYZ-99",
      commentBody: "some comment",
    });
    const result = await routeEvent(event);
    expect(result).toBeNull();
  });

  it("agent actor on own-department issue with no mechanical target is suppressed", async () => {
    // Charles comments on AI-100. Roster routes AI → charles. Charles IS the actor.
    // This should suppress — department target is the actor itself.
    const event = makeIssueEvent({
      actorId: CHARLES_ID,
      identifier: "AI-100",
      commentBody: "some comment",
    });
    const result = await routeEvent(event);
    // The !mechanicalTarget branch checks roster. AI → charles, actor is charles.
    // department match but target == actor → still suppressed.
    expect(result).toBeNull();
  });

  it("mechanical target self-trigger still routes via department when target differs", async () => {
    // Charles is both actor and delegate on ILL-42.
    // The mechanicalTarget branch runs first, finds self-trigger,
    // but the roster routes ILL → astrid (not charles) → dispatch.
    const event = makeIssueEvent({
      actorId: CHARLES_ID,
      delegateId: CHARLES_ID,
      identifier: "ILL-42",
    });
    const result = await routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.agentId).toBe("astrid");
    expect(result?.routingReason).toBe("department-prefix");
  });
});
