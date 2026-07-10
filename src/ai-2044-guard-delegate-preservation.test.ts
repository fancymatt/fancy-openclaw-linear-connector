/**
 * AI-2044 — Regression tests for the routing-guard delegate-eviction defect
 * observed on AI-2040 (2026-07-10).
 *
 * Incident shape: Sage (legal `dev` body) held `state:implementation` on a
 * governed ticket. A third-party comment @-mentioned the test-author (tdd),
 * body-mention routing dispatched to tdd, the role-guard blocked it, and —
 * because the `dev` role has multiple bodies — `checkRoleGuardAndBlock`
 * called `clearDelegate` unconditionally, evicting the legal in-flight
 * delegate under tdd's OAuth token (false audit trail).
 *
 * AC of record (AI-2044):
 *   - A blocked dispatch never mutates delegate/assignee when the current
 *     delegate fills the state's owner_role (reproduces the AI-2040 sequence).
 *   - Guard writes are not attributed to the blocked target agent.
 *   - A governed ticket left with no delegate in a working state raises a
 *     loud alert instead of failing silently.
 *
 * (The companion router change — "[Connector]" comments never route via
 * body-mention — is tested in router.test.ts, which uses the real agents
 * module this file mocks.)
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// ── ESM-compatible mocks (must be declared before dynamic imports) ─────────

const mockGetAccessToken = jest.fn<(agentId: string) => string | undefined>().mockReturnValue(undefined);
const mockGetAgents = jest.fn<() => { name: string; linearUserId: string }[]>().mockReturnValue([]);
const mockLoadWorkflowDefById = jest.fn<(id: string) => Promise<unknown>>();
const mockResolveBodiesForRole = jest.fn<(role: string) => Promise<string[]>>();
const mockNotify = jest.fn();

jest.unstable_mockModule("./agents.js", () => ({
  getAccessToken: mockGetAccessToken,
  getAgents: mockGetAgents,
}));

const _getWorkflowId = (labels: string[]): string | null => {
  const label = labels.find((l: string) => /^wf:/i.test(l));
  return label ? label.slice(label.indexOf(":") + 1).toLowerCase() : null;
};
const _getCurrentState = (labels: string[]): string | null => {
  const label = labels.find((l: string) => /^state:/i.test(l));
  return label ? label.slice(label.indexOf(":") + 1).toLowerCase() : null;
};

jest.unstable_mockModule("./workflow-gate.js", () => ({
  loadWorkflowDefById: mockLoadWorkflowDefById,
  getWorkflowId: jest.fn().mockImplementation(_getWorkflowId),
  getCurrentState: jest.fn().mockImplementation(_getCurrentState),
}));

jest.unstable_mockModule("./escalation-gate.js", () => ({
  resolveBodiesForRole: mockResolveBodiesForRole,
}));

jest.unstable_mockModule("./alerts/alert-bus.js", () => ({
  notify: mockNotify,
}));

const { checkRoleGuardAndBlock } = await import("./routing-guard.js");

// ── Workflow def mirroring canonical dev-impl at state:implementation ──────

const DEV_IMPL_DEF = {
  id: "dev-impl",
  states: [
    {
      id: "implementation",
      owner_role: "dev",
      transitions: [{ command: "submit", to: "code-review" }],
    },
  ],
};

const LABELS = ["wf:dev-impl", "state:implementation"];

// Linear user IDs for the four dev bodies + the steward + tdd.
const LINEAR_IDS: Record<string, string> = {
  felix: "lin-felix",
  noah: "lin-noah",
  sage: "lin-sage",
  igor: "lin-igor",
  astrid: "lin-astrid",
  tdd: "lin-tdd",
};
const resolver = (bodyName: string): string | null => LINEAR_IDS[bodyName.toLowerCase()] ?? null;

// ── fetch mock: scripted Linear API ─────────────────────────────────────────

interface FetchCall {
  query: string;
  variables: Record<string, unknown>;
  authorization: string;
}

const fetchCalls: FetchCall[] = [];
let currentDelegateResponse: { ok: boolean; delegateId: string | null } = { ok: true, delegateId: null };

const realFetch = global.fetch;

function installFetchMock(): void {
  global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as { query?: string; variables?: Record<string, unknown> };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const query = body.query ?? "";
    fetchCalls.push({
      query,
      variables: body.variables ?? {},
      authorization: headers.authorization ?? headers.Authorization ?? "",
    });

    let data: unknown = {};
    if (query.includes("CurrentDelegate")) {
      data = currentDelegateResponse.ok
        ? { issue: { delegate: currentDelegateResponse.delegateId ? { id: currentDelegateResponse.delegateId } : null } }
        : { issue: null };
    } else if (query.includes("issue(id:") && query.includes("{ id }")) {
      data = { issue: { id: "internal-uuid-2040" } };
    } else if (query.includes("commentCreate")) {
      data = { commentCreate: { success: true, comment: { id: "c-1" } } };
    } else if (query.includes("issueUpdate")) {
      data = { issueUpdate: { success: true, issue: { id: "internal-uuid-2040" } } };
    }
    return { json: async () => ({ data }), status: 200 } as Response;
  }) as unknown as typeof fetch;
}

function mutationCalls(): FetchCall[] {
  return fetchCalls.filter((c) => c.query.includes("issueUpdate") || c.query.includes("commentCreate"));
}

function delegateWrites(): FetchCall[] {
  return fetchCalls.filter((c) => c.query.includes("issueUpdate") && "delegateId" in (c.variables ?? {}) || c.query.includes("delegateId: null"));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("AI-2044: role-guard never evicts a legal in-flight delegate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchCalls.length = 0;
    installFetchMock();
    mockLoadWorkflowDefById.mockResolvedValue(DEV_IMPL_DEF as never);
    mockResolveBodiesForRole.mockResolvedValue(["felix", "noah", "sage", "igor"] as never);
    process.env.LINEAR_OAUTH_TOKEN = "service-token";
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.LINEAR_OAUTH_TOKEN;
  });

  it("reproduces the AI-2040 sequence: blocked dispatch to tdd leaves legal delegate (sage) untouched, posts nothing", async () => {
    currentDelegateResponse = { ok: true, delegateId: LINEAR_IDS.sage };

    const result = await checkRoleGuardAndBlock("tdd", "AI-2040", LABELS, resolver);

    expect(result.blocked).toBe(true);
    expect(result.delegatePreserved).toBe(true);
    // No comment, no delegate mutation of any kind.
    expect(mutationCalls()).toHaveLength(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("preserves the delegate when it is the singleton legal body", async () => {
    mockResolveBodiesForRole.mockResolvedValue(["igor"] as never);
    currentDelegateResponse = { ok: true, delegateId: LINEAR_IDS.igor };

    const result = await checkRoleGuardAndBlock("tdd", "AI-2040", LABELS, resolver);

    expect(result.blocked).toBe(true);
    expect(result.delegatePreserved).toBe(true);
    expect(mutationCalls()).toHaveLength(0);
  });

  it("preserves the delegate when the delegate read fails (fail-safe: block only)", async () => {
    currentDelegateResponse = { ok: false, delegateId: null };

    const result = await checkRoleGuardAndBlock("tdd", "AI-2040", LABELS, resolver);

    expect(result.blocked).toBe(true);
    expect(result.delegatePreserved).toBe(true);
    expect(mutationCalls()).toHaveLength(0);
  });

  it("preserves the delegate when no resolver is available to verify legality", async () => {
    currentDelegateResponse = { ok: true, delegateId: LINEAR_IDS.sage };

    const result = await checkRoleGuardAndBlock("tdd", "AI-2040", LABELS, undefined);

    expect(result.blocked).toBe(true);
    expect(result.delegatePreserved).toBe(true);
    expect(mutationCalls()).toHaveLength(0);
  });

  it("still clears a verifiably illegal delegate (multi-body role) and raises a loud alert", async () => {
    // astrid does not fill `dev`.
    currentDelegateResponse = { ok: true, delegateId: LINEAR_IDS.astrid };

    const result = await checkRoleGuardAndBlock("tdd", "AI-2040", LABELS, resolver);

    expect(result.blocked).toBe(true);
    expect(result.delegatePreserved).toBeUndefined();
    const clears = fetchCalls.filter((c) => c.query.includes("ClearDelegate"));
    expect(clears).toHaveLength(1);
    const comments = fetchCalls.filter((c) => c.query.includes("commentCreate"));
    expect(comments).toHaveLength(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toMatchObject({ severity: "warning", source: "routing-guard", ticket: "AI-2040" });
  });

  it("still corrects to the singleton legal body when the delegate is illegal", async () => {
    mockResolveBodiesForRole.mockResolvedValue(["sage"] as never);
    currentDelegateResponse = { ok: true, delegateId: LINEAR_IDS.astrid };

    const result = await checkRoleGuardAndBlock("tdd", "AI-2040", LABELS, resolver);

    expect(result.blocked).toBe(true);
    expect(result.correctedTo).toBe("sage");
    const updates = fetchCalls.filter((c) => c.query.includes("UpdateDelegate"));
    expect(updates).toHaveLength(1);
    expect(updates[0].variables).toMatchObject({ delegateId: LINEAR_IDS.sage });
  });

  it("raises a loud alert (and performs no delegate write) for a null-delegate governed ticket in a working state", async () => {
    currentDelegateResponse = { ok: true, delegateId: null };

    const result = await checkRoleGuardAndBlock("tdd", "AI-2040", LABELS, resolver);

    expect(result.blocked).toBe(true);
    // Comment is posted for visibility, but there is no delegate to clear.
    expect(delegateWrites()).toHaveLength(0);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(String((mockNotify.mock.calls[0][0] as { title: string }).title)).toContain("no delegate");
  });

  it("authenticates guard writes with the service token, not the blocked target's token", async () => {
    mockGetAccessToken.mockReturnValue("tdd-agent-token");
    currentDelegateResponse = { ok: true, delegateId: LINEAR_IDS.astrid };

    await checkRoleGuardAndBlock("tdd", "AI-2040", LABELS, resolver);

    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const call of fetchCalls) {
      expect(call.authorization).toBe("Bearer service-token");
    }
  });
});
