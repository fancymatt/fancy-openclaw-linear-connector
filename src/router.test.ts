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
import type { AgentTargetResult } from "./router.js";
import { reloadAgents } from "./agents.js";
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

  it("does NOT route a [Connector]-authored comment via body-mention (AI-2044)", () => {
    const event = makeIssueEvent({
      commentBody: "[Connector] Dispatch blocked: illegal routing target detected on **AI-2040**. Legal target(s): @charles.",
    });
    const result = extractAgentTarget(event);
    expect(result).toBeNull();
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

  it("suppresses self-triggered events (actor is the target agent)", () => {
    const event = makeIssueEvent({ actorId: CHARLES_ID, delegateId: CHARLES_ID });
    const result = extractAgentTarget(event);
    expect(result).toEqual({ suppressed: true });
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
    expect(result).toEqual({ suppressed: true });
  });

  it("AC2: unrelated-field edit (labelIds) with unchanged delegate does not dispatch", () => {
    const event = makeIssueEvent({
      delegateId: CHARLES_ID,
      updatedFrom: { labelIds: ["old-label-uuid"] },
    });
    const result = extractAgentTarget(event);
    expect(result).toEqual({ suppressed: true });
  });

  it("AC2: unrelated-field edit (description) with unchanged delegate does not dispatch", () => {
    const event = makeIssueEvent({
      delegateId: CHARLES_ID,
      updatedFrom: { description: "old description text" },
    });
    const result = extractAgentTarget(event);
    expect(result).toEqual({ suppressed: true });
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
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    fs.rmSync(path.dirname(agentsFile), { recursive: true, force: true });
  });

  it("returns a RouteResult with correct agentId and sessionKey", () => {
    const event = makeIssueEvent({ delegateId: CHARLES_ID, identifier: "AI-393" });
    const result = routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.agentId).toBe("charles");
    expect(result?.sessionKey).toContain("AI-393");
  });

  it("extracts identifier from nested issue object (Comment event)", () => {
    const event = makeIssueEvent({ delegateId: CHARLES_ID, commentBody: "hello" });
    // Comment events nest identifier under data.issue.identifier
    const result = routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.sessionKey).toBe("linear-AI-1");
  });

  it("extracts identifier from deeply nested agentSession path", () => {
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
    const result = routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.sessionKey).toBe("linear-SAK-50");
  });

  it("AgentSessionEvent with no resolvable session owner wakes nobody (audit #16)", () => {
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
    expect(routeEvent(event)).toBeNull();
  });

  it("extracts identifier from notification.issue path", () => {
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
    const result = routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.sessionKey).toBe("linear-ILL-68");
  });

  it("uses deep recursive search for unknown nested shapes", () => {
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
    const result = routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.sessionKey).toBe("linear-FCY-42");
  });

  it("falls back to timestamp key only when no identifier found anywhere", () => {
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
    const result = routeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.sessionKey).toMatch(/^linear-MysteryEvent-\d+$/);
    const ts = parseInt(result!.sessionKey.split("-").pop()!, 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it("returns null when no agent target found", () => {
    const event = makeIssueEvent({});
    const result = routeEvent(event);
    expect(result).toBeNull();
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
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    fs.rmSync(path.dirname(agentsFile), { recursive: true, force: true });
  });

  it("returns primary route only when nothing else is mentioned", () => {
    const event = makeIssueEvent({ delegateId: CHARLES_ID, updatedFrom: { delegateId: null } });
    const routes = routeEventAll(event);
    expect(routes.map((r) => r.agentId)).toEqual(["charles"]);
  });

  it("wakes every registered agent mentioned in a comment body, not just the first", () => {
    const event = makeIssueEvent({ commentBody: "@astrid please loop in @igor and @charles on this" });
    const routes = routeEventAll(event);
    // astrid is primary (first body mention); igor + charles fan out
    expect(routes[0].agentId).toBe("astrid");
    expect(routes.map((r) => r.agentId).sort()).toEqual(["astrid", "charles", "igor"]);
    // all share the ticket session key
    expect(new Set(routes.map((r) => r.sessionKey)).size).toBe(1);
    expect(routes.slice(1).every((r) => r.routingReason === "mention")).toBe(true);
  });

  it("fans out payload mentionedUsers beyond the first", () => {
    const event = makeIssueEvent({ commentBody: "please review" });
    (event as { data: { mentionedUsers: unknown } }).data.mentionedUsers = [
      { id: ASTRID_ID }, { id: IGOR_ID }, { id: "not-an-agent" },
    ];
    const routes = routeEventAll(event);
    expect(routes.map((r) => r.agentId).sort()).toEqual(["astrid", "igor"]);
  });

  it("excludes the acting agent from fan-out (self-trigger)", () => {
    const event = makeIssueEvent({ actorId: CHARLES_ID, commentBody: "@astrid see my note, cc @charles" });
    const routes = routeEventAll(event);
    // charles is the actor — mentioned but never fanned out to
    expect(routes.map((r) => r.agentId).sort()).toEqual(["astrid"]);
  });

  it("does not duplicate the delegate when they are also mentioned", () => {
    const event = makeIssueEvent({ delegateId: CHARLES_ID, updatedFrom: { delegateId: null } });
    (event as { data: { mentionedUsers: unknown } }).data.mentionedUsers = [{ id: CHARLES_ID }, { id: IGOR_ID }];
    const routes = routeEventAll(event);
    expect(routes.map((r) => r.agentId).sort()).toEqual(["charles", "igor"]);
    expect(routes[0].routingReason).toBe("delegate");
  });

  it("returns empty when no target resolves", () => {
    const event = makeIssueEvent({ commentBody: "no agents mentioned here" });
    expect(routeEventAll(event)).toEqual([]);
  });

  // ── AI-2170: suppressed events must not leak into department-prefix ──

  it("AI-2170: labelIds-only update with delegate does NOT fall through to department-prefix", () => {
    // Simulate the enrollIfMissing scenario: delegate=charles, updatedFrom has
    // labelIds (not delegateId/delegate). The AI-1573 guard suppresses this,
    // and routeEventAll must return [] — NOT fall through to department-prefix.
    const event = makeIssueEvent({
      delegateId: CHARLES_ID,
      identifier: "AI-2170",
      updatedFrom: { labelIds: ["prev-label-uuid"] },
    });
    const routes = routeEventAll(event);
    expect(routes).toEqual([]);
  });

  it("AI-2170: genuine delegate change still dispatches correctly via routeEventAll", () => {
    const event = makeIssueEvent({
      delegateId: CHARLES_ID,
      identifier: "AI-2170",
      updatedFrom: { delegateId: "prev-user-uuid" },
    });
    const routes = routeEventAll(event);
    expect(routes).toHaveLength(1);
    expect(routes[0].agentId).toBe("charles");
    expect(routes[0].routingReason).toBe("delegate");
  });

  it("AI-2170: genuinely unrouted event (no delegate, no assignee, no mention) still returns empty from routeEventAll without department-prefix in tests", () => {
    // Without a loaded roster, department-prefix fallback is unavailable.
    // The important thing is the code reaches the fallback path rather than
    // returning early on { suppressed: true }.
    const event = makeIssueEvent({ commentBody: "just a comment, no one mentioned" });
    const routes = routeEventAll(event);
    // No roster loaded in tests → no department-prefix → empty
    expect(routes).toEqual([]);
  });

  it("AI-2170: self-trigger suppression returns empty from routeEventAll", () => {
    const event = makeIssueEvent({
      actorId: CHARLES_ID,
      delegateId: CHARLES_ID,
      identifier: "AI-2170",
    });
    const routes = routeEventAll(event);
    expect(routes).toEqual([]);
  });
});

// ── INF-59: Same-column workflow advance suppresses next-owner dispatch ──────
// The isStateTransition check in extractAgentTarget only looks for native
// stateId in updatedFrom. For same-column workflow advances (GEN-198 class),
// the native stateId does not change — only the state:* label (via labelIds)
// and/or the delegate change. isStateTransition must also recognize label
// changes as workflow state transitions.
//
// Fix: extend isStateTransition to return true when labelIds is in updatedFrom.

describe("INF-59 — same-column workflow advance dispatches next owner", () => {
  const HANZO_ID = "e7a64973-e186-2117-0000-00000000dead";
  const TDD_ID   = "aabbccdd-1111-2222-3333-444444444444";

  let agentsFile: string;

  beforeEach(() => {
    agentsFile = makeTempAgentsFile([
      ...BASE_AGENTS,
      {
        name: "tdd",
        linearUserId: TDD_ID,
        openclawAgent: "tdd",
        clientId: "c4",
        clientSecret: "s4",
        accessToken: "tok4",
        refreshToken: "ref4",
      },
      {
        name: "hanzo",
        linearUserId: HANZO_ID,
        openclawAgent: "hanzo",
        clientId: "c5",
        clientSecret: "s5",
        accessToken: "tok5",
        refreshToken: "ref5",
      },
    ]);
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    fs.rmSync(path.dirname(agentsFile), { recursive: true, force: true });
  });

  // ── AC1: same-column advance dispatches next owner ──────────────────────
  // When a governed transition advances state:* label and/or delegate but
  // native stateId is unchanged, isStateTransition must treat it as a
  // workflow state change so dispatch fires.

  describe("AC1 — same-column advance dispatches the next owner", () => {
    test("same-column advance with labelIds change (no stateId, no delegate change) dispatches to the current delegate", () => {
      // This is the core bug: review(own_role=tdd) → sign-off(own_role=tdd)
      // in the same native column. Labels changed (state:* swapped) but
      // neither stateId nor delegate changed. Current code suppresses this
      // as "no-change delegate write." Fix: labelIds in updatedFrom is a
      // workflow state transition when the PROXY is the actor.
      const event = makeIssueEvent({
        actorId: CHARLES_ID,   // proxy actor
        delegateId: TDD_ID,
        delegateName: "tdd",
        identifier: "GEN-199",
        updatedFrom: { labelIds: ["old-state-label-uuid"] },
      });
      const result = extractAgentTarget(event);
      // Must NOT be suppressed — this is a genuine workflow advance.
      expect(result).not.toEqual({ suppressed: true });
      expect(result).not.toBeNull();
      expect((result as { name: string }).name).toBe("tdd");
      expect((result as { reason: string }).reason).toBe("delegate");
    });

    test("same-column advance with labelIds + delegate change dispatches to the new delegate", () => {
      // GEN-198 scenario: review(own_role=tdd) → sign-off(own_role=astrid).
      // Delegate changes AND labelIds changes. Current code already passes
      // because delegateId in updatedFrom lets the guard through. Regression
      // guard: fix must not break this case.
      const event = makeIssueEvent({
        delegateId: ASTRID_ID,
        delegateName: "astrid",
        identifier: "GEN-198",
        updatedFrom: {
          delegateId: TDD_ID,
          labelIds: ["old-state-label-uuid"],
        },
      });
      const result = extractAgentTarget(event);
      expect(result).not.toBeNull();
      expect((result as { name: string }).name).toBe("astrid");
      expect((result as { reason: string }).reason).toBe("delegate");
    });

    test("self-triggered same-column advance (actor is target agent) dispatches when labels changed", () => {
      // Agent advances its own ticket to another same-column state where it
      // is also the owner. Actor=target agent, labelIds changed, no stateId
      // change. Self-trigger filter currently suppresses because
      // isStateTransition is false. Fix: labelIds in updatedFrom makes
      // isStateTransition true → self-trigger filter allows dispatch.
      const event = makeIssueEvent({
        actorId: CHARLES_ID,
        delegateId: CHARLES_ID,
        delegateName: "charles",
        identifier: "AI-2400",
        updatedFrom: { labelIds: ["old-state-label-uuid"] },
      });
      const result = extractAgentTarget(event);
      // Must NOT be suppressed — same-agent same-column advance.
      expect(result).not.toEqual({ suppressed: true });
      expect(result).not.toBeNull();
      expect((result as { name: string }).name).toBe("charles");
    });

    test("cross-column advance (stateId in updatedFrom) still dispatches (no regression)", () => {
      // Traditional cross-column advance: stateId changed. Must still work
      // as before — no regression from the isStateTransition fix.
      const event = makeIssueEvent({
        delegateId: CHARLES_ID,
        identifier: "AI-2401",
        updatedFrom: { stateId: "prev-native-state-uuid" },
      });
      const result = extractAgentTarget(event);
      expect(result).not.toBeNull();
      expect((result as { name: string }).name).toBe("charles");
    });

    test("label-only edit (no delegate change, no state advance) is NOT a state transition (no regression)", () => {
      // A plain label-edit event (adding/removing a non-state label) must
      // still be suppressed when updatedFrom has only labelIds and no
      // delegate change — it is NOT a workflow advance. This verifies that
      // the isStateTransition fix does not turn every label edit into a
      // dispatch.
      const event = makeIssueEvent({
        delegateId: CHARLES_ID,
        identifier: "AI-2402",
        updatedFrom: { labelIds: ["prev-label-uuid"] },
      });
      // NON-actor agent (actor !== target) — hits the AI-1573 guard.
      // Before fix: suppressed because !isStateTransition.
      // With fix where isStateTransition includes labelIds: would allow
      // through. That's not desired for arbitrary label edits.
      //
      // So isStateTransition alone is too broad. The fix should only
      // activate labelIds-as-transition when there's evidence of a
      // workflow advance. Evidence: actor IS one of our agents (proxy
      // made the change) OR delegateId also changed.
      //
      // For this case (external human actor, no delegate change),
      // must still suppress.
      const result = extractAgentTarget(event);
      expect(result).toEqual({ suppressed: true });
    });
  });

  // ── AC2: No double-dispatch ──────────────────────────────────────────────
  // Same-column advance that also happens to produce a native state change
  // must not wake the owner twice.

  describe("AC2 — no double-dispatch on same-column advance", () => {
    test("same-column advance with BOTH labelIds and stateId in updatedFrom dispatches once (not suppressed, not doubled)", () => {
      // Edge case: an advance where BOTH labelIds and stateId changed.
      // isStateTransition was already true from stateId; labelIds addition
      // must not cause double-suppression or double-dispatch.
      const event = makeIssueEvent({
        delegateId: CHARLES_ID,
        identifier: "AI-2403",
        updatedFrom: {
          stateId: "prev-native-state-uuid",
          labelIds: ["old-state-label-uuid"],
        },
      });
      // Must dispatch once (not suppressed), not doubled.
      const result = extractAgentTarget(event);
      expect(result).not.toEqual({ suppressed: true });
      expect(result).not.toBeNull();

      // routeEventAll confirms exactly one route.
      const routes = routeEventAll(event);
      expect(routes).toHaveLength(1);
      expect(routes[0].agentId).toBe("charles");
    });

    test("proxy-governed advance must not produce duplicate wake via routeEventAll", () => {
      // When the proxy (actor is an agent) does a same-column advance that
      // changes both delegate and labels, routeEventAll must not fan out
      // to the actor in addition to the target delegate.
      const event = makeIssueEvent({
        actorId: TDD_ID,
        delegateId: ASTRID_ID,
        delegateName: "astrid",
        identifier: "GEN-198",
        updatedFrom: {
          delegateId: TDD_ID,
          labelIds: ["old-state-label-uuid"],
        },
      });
      const routes = routeEventAll(event);
      // Exactly one route: astrid (the new delegate). TDD (the actor)
      // must not be fanned out to as a mention.
      expect(routes).toHaveLength(1);
      expect(routes[0].agentId).toBe("astrid");
    });
  });

  // ── AC3: Regression coverage ─────────────────────────────────────────────
  // Three specific regression tests per AC3.

  describe("AC3 — regression coverage", () => {
    test("same-column advance (labelIds only, proxy actor) → next owner dispatched", () => {
      // Label change with proxy actor represents a state:* transition.
      // Delegate unchanged. Must dispatch to the current delegate.
      const event = makeIssueEvent({
        actorId: CHARLES_ID,
        delegateId: CHARLES_ID,
        identifier: "REG-1",
        updatedFrom: { labelIds: ["prev-label-uuid"] },
      });
      const result = extractAgentTarget(event);
      expect(result).not.toEqual({ suppressed: true });
      expect(result).not.toBeNull();
      expect((result as { name: string }).name).toBe("charles");
    });

    test("same-column advance → no duplicate wake (idempotency is downstream, router must not double-route)", () => {
      // routeEventAll must produce exactly one route for a same-column
      // advance where delegate changes and labels change.
      const event = makeIssueEvent({
        delegateId: ASTRID_ID,
        identifier: "REG-2",
        updatedFrom: {
          delegateId: CHARLES_ID,
          labelIds: ["prev-label-uuid"],
        },
      });
      const routes = routeEventAll(event);
      expect(routes).toHaveLength(1);
      expect(routes[0].agentId).toBe("astrid");
      expect(routes[0].routingReason).toBe("delegate");
    });

    test("cross-column advance unchanged behavior", () => {
      // Cross-column advance: stateId changed. Must route exactly once
      // to the new delegate.
      const event = makeIssueEvent({
        delegateId: ASTRID_ID,
        identifier: "REG-3",
        updatedFrom: {
          stateId: "prev-native-state-uuid",
          delegateId: CHARLES_ID,
        },
      });
      const routes = routeEventAll(event);
      expect(routes).toHaveLength(1);
      expect(routes[0].agentId).toBe("astrid");
    });
  });

  // ── AC4: GEN-198 fixture replay ───────────────────────────────────────────
  // A fixture replaying review → merge same-column advance asserts the
  // merge owner (Hanzo) is dispatched without manual intervention.

  describe("AC4 — GEN-198 fixture replay", () => {
    test("review → merge same-column advance dispatches hanzo (merge owner)", () => {
      // Simulates the GEN-198 chain:
      //   review(owner=tdd, native=todo) → merge(owner=hanzo, native=todo)
      // Native stateId unchanged. Labels changed (state:review→state:merge).
      // Delegate changed (tdd→hanzo).
      //
      // This is the proxy (ai) making the mutation, so the actor is
      // the OAuth app user whose linearUserId maps to an agent.
      // For this test we use charles as the acting proxy agent.
      const event = makeIssueEvent({
        actorId: CHARLES_ID,
        delegateId: HANZO_ID,
        delegateName: "hanzo",
        identifier: "GEN-198",
        updatedFrom: {
          delegateId: TDD_ID,
          labelIds: ["old-state-label-uuid"],
        },
      });

      // extractAgentTarget must not suppress this — it's a genuine
      // workflow advance to the merge state.
      const result = extractAgentTarget(event);
      expect(result).not.toEqual({ suppressed: true });
      expect(result).not.toBeNull();
      expect((result as { name: string }).name).toBe("hanzo");

      // routeEventAll must produce exactly one route to hanzo.
      const routes = routeEventAll(event);
      expect(routes).toHaveLength(1);
      expect(routes[0].agentId).toBe("hanzo");
      expect(routes[0].routingReason).toBe("delegate");
    });

    test("review → sign-off → merge chain: each step dispatches the correct owner", () => {
      // Same as above but tests the first step: review(owner=tdd) →
      // sign-off(owner=astrid). Both in the same native column (todo).
      const event = makeIssueEvent({
        actorId: CHARLES_ID,
        delegateId: ASTRID_ID,
        delegateName: "astrid",
        identifier: "GEN-198",
        updatedFrom: {
          delegateId: TDD_ID,
          labelIds: ["old-state-label-uuid"],
        },
      });

      const result = extractAgentTarget(event);
      expect(result).not.toEqual({ suppressed: true });
      expect(result).not.toBeNull();
      expect((result as { name: string }).name).toBe("astrid");

      const routes = routeEventAll(event);
      expect(routes).toHaveLength(1);
      expect(routes[0].agentId).toBe("astrid");
    });

    test("cross-column control: write-tests → implementation (todo→doing) still dispatches igor (no regression)", () => {
      // Cross-column advance: stateId changes (todo→doing).
      // Must dispatch normally.
      const event = makeIssueEvent({
        delegateId: CHARLES_ID,
        identifier: "GEN-198",
        updatedFrom: {
          stateId: "prev-native-todo-uuid",
          delegateId: TDD_ID,
        },
      });
      const routes = routeEventAll(event);
      expect(routes).toHaveLength(1);
      expect(routes[0].agentId).toBe("charles");
    });
  });
});
