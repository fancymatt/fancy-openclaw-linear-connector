/**
 * Unit tests for the engagement-status overlay (AI-1510).
 *
 * Native Linear status is a non-authoritative *engagement* signal that the
 * connector cycles To Do → Thinking → Doing off the delegate's session
 * lifecycle. These tests pin the behavior of `applyEngagementStatus`:
 *   - flips Thinking on dispatch, Doing on first activity, To Do on session-end
 *   - monotonic floor: never downgrades a Doing ticket back to Thinking
 *   - idempotent: no write when already at the target
 *   - scoped to workflow tickets only (wf:* label) — ad-hoc tickets untouched
 *   - no-op without a token
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { applyEngagementStatus } from "./engagement-status.js";
import { resetNativeStateCache } from "./workflow-gate.js";

interface IssueFixture {
  id: string;
  teamId: string;
  stateName: string;
  stateId: string;
  labels: string[];
}

const SEMANTIC_TO_UUID: Record<string, string> = {
  "To Do": "state-todo-uuid",
  Thinking: "state-thinking-uuid",
  Doing: "state-doing-uuid",
  Done: "state-done-uuid",
  Invalid: "state-invalid-uuid",
};

/**
 * Build a fetch mock for one issue. Tracks the variables of every issueUpdate
 * mutation so tests can assert which (if any) state write was attempted, and
 * records the `id` variable used on the EngagementIssue query.
 */
function makeEngagementFetch(issue: IssueFixture): {
  fetch: typeof globalThis.fetch;
  updates: Array<{ id: string; stateId: string }>;
  issueQueryIds: string[];
} {
  const updates: Array<{ id: string; stateId: string }> = [];
  const issueQueryIds: string[] = [];

  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const q = parsed.query ?? "";
    const vars = parsed.variables ?? {};

    if (q.includes("EngagementIssue")) {
      issueQueryIds.push(String(vars.id));
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: issue.id,
              team: { id: issue.teamId },
              state: { id: issue.stateId, name: issue.stateName },
              labels: { nodes: issue.labels.map((name) => ({ name })) },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              states: {
                nodes: Object.entries(SEMANTIC_TO_UUID).map(([name, id]) => ({
                  id,
                  name,
                  type:
                    name === "Done" ? "completed" : name === "Invalid" ? "canceled" : "started",
                })),
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (q.includes("issueUpdate")) {
      updates.push({ id: String(vars.id), stateId: String(vars.stateId) });
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return { fetch, updates, issueQueryIds };
}

const WF_LABELS = ["wf:dev-impl", "state:implementation"];

describe("applyEngagementStatus (AI-1510)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetNativeStateCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("flips a To Do workflow ticket to Thinking on dispatch", async () => {
    const { fetch, updates } = makeEngagementFetch({
      id: "issue-uuid",
      teamId: "team-uuid",
      stateName: "To Do",
      stateId: SEMANTIC_TO_UUID["To Do"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    await applyEngagementStatus("AI-1", "thinking", "tok");

    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("issue-uuid");
    expect(updates[0].stateId).toBe(SEMANTIC_TO_UUID["Thinking"]);
  });

  it("flips a Thinking workflow ticket to Doing on first activity", async () => {
    const { fetch, updates } = makeEngagementFetch({
      id: "issue-uuid",
      teamId: "team-uuid",
      stateName: "Thinking",
      stateId: SEMANTIC_TO_UUID["Thinking"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    await applyEngagementStatus("AI-1", "doing", "tok");

    expect(updates).toHaveLength(1);
    expect(updates[0].stateId).toBe(SEMANTIC_TO_UUID["Doing"]);
  });

  it("resets a Doing workflow ticket to To Do on session-end", async () => {
    const { fetch, updates } = makeEngagementFetch({
      id: "issue-uuid",
      teamId: "team-uuid",
      stateName: "Doing",
      stateId: SEMANTIC_TO_UUID["Doing"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    await applyEngagementStatus("AI-1", "todo", "tok");

    expect(updates).toHaveLength(1);
    expect(updates[0].stateId).toBe(SEMANTIC_TO_UUID["To Do"]);
  });

  it("monotonic floor: never downgrades a Doing ticket back to Thinking", async () => {
    const { fetch, updates } = makeEngagementFetch({
      id: "issue-uuid",
      teamId: "team-uuid",
      stateName: "Doing",
      stateId: SEMANTIC_TO_UUID["Doing"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    await applyEngagementStatus("AI-1", "thinking", "tok");

    expect(updates).toHaveLength(0);
  });

  it("idempotent: no write when already at the target state", async () => {
    const { fetch, updates } = makeEngagementFetch({
      id: "issue-uuid",
      teamId: "team-uuid",
      stateName: "Thinking",
      stateId: SEMANTIC_TO_UUID["Thinking"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    await applyEngagementStatus("AI-1", "thinking", "tok");

    expect(updates).toHaveLength(0);
  });

  it("skips ad-hoc tickets (no wf:* label)", async () => {
    const { fetch, updates } = makeEngagementFetch({
      id: "issue-uuid",
      teamId: "team-uuid",
      stateName: "To Do",
      stateId: SEMANTIC_TO_UUID["To Do"],
      labels: ["bug", "priority:high"],
    });
    globalThis.fetch = fetch;

    await applyEngagementStatus("AI-1", "thinking", "tok");

    expect(updates).toHaveLength(0);
  });

  it("terminal state:done — no engagement write (workflow gate's native write is authoritative)", async () => {
    const { fetch, updates } = makeEngagementFetch({
      id: "issue-uuid",
      teamId: "team-uuid",
      stateName: "Done",
      stateId: SEMANTIC_TO_UUID["Done"],
      labels: ["wf:dev-impl", "state:done"],
    });
    globalThis.fetch = fetch;

    await applyEngagementStatus("AI-1", "doing", "tok");

    expect(updates).toHaveLength(0);
  });

  it("terminal state:escape — no engagement write", async () => {
    const { fetch, updates } = makeEngagementFetch({
      id: "issue-uuid",
      teamId: "team-uuid",
      stateName: "Done",
      stateId: SEMANTIC_TO_UUID["Done"],
      labels: ["wf:dev-impl", "state:escape"],
    });
    globalThis.fetch = fetch;

    await applyEngagementStatus("AI-1", "doing", "tok");

    expect(updates).toHaveLength(0);
  });

  it("no-op without a token (never touches the network)", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    await applyEngagementStatus("AI-1", "thinking", null);

    expect(called).toBe(false);
  });

  it("strips a linear- prefix from the ticket ref", async () => {
    const { fetch, issueQueryIds } = makeEngagementFetch({
      id: "issue-uuid",
      teamId: "team-uuid",
      stateName: "To Do",
      stateId: SEMANTIC_TO_UUID["To Do"],
      labels: WF_LABELS,
    });
    globalThis.fetch = fetch;

    await applyEngagementStatus("linear-AI-1", "thinking", "tok");

    expect(issueQueryIds).toContain("AI-1");
  });
});
