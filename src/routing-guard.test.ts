/**
 * Unit tests for routing-guard module (AI-1428 / AI-1459).
 *
 * Phase 1 tests: sync `checkRoleGuard` advisory path (unchanged).
 * Phase 2 tests: async `checkRoleGuardEnforced` enforcement path (AI-1459).
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// ── ESM-compatible mocks (must be declared before dynamic imports) ─────────

const mockGetAccessToken = jest.fn<() => string | undefined>().mockReturnValue(undefined);
const mockGetAgents = jest.fn<() => { name: string; linearUserId: string }[]>().mockReturnValue([]);
const mockLoadWorkflowDef = jest.fn<() => Promise<unknown>>();
const mockResolveBodiesForRole = jest.fn<(role: string) => Promise<string[]>>();

jest.unstable_mockModule("./agents.js", () => ({
  getAccessToken: mockGetAccessToken,
  getAgents: mockGetAgents,
}));

// Real implementations of getWorkflowId/getCurrentState (they're pure functions).
const _getWorkflowId = (labels: string[]): string | null => {
  const label = labels.find((l: string) => /^wf:/i.test(l));
  return label ? label.slice(label.indexOf(":") + 1).toLowerCase() : null;
};
const _getCurrentState = (labels: string[]): string | null => {
  const label = labels.find((l: string) => /^state:/i.test(l));
  return label ? label.slice(label.indexOf(":") + 1).toLowerCase() : null;
};

jest.unstable_mockModule("./workflow-gate.js", () => ({
  loadWorkflowDef: mockLoadWorkflowDef,
  getWorkflowId: jest.fn().mockImplementation(_getWorkflowId),
  getCurrentState: jest.fn().mockImplementation(_getCurrentState),
}));

jest.unstable_mockModule("./escalation-gate.js", () => ({
  resolveBodiesForRole: mockResolveBodiesForRole,
}));

// Dynamic import after mocks are registered.
// guardOnLabelChange is the new AC4 function (does not exist yet → undefined).
const { checkRoleGuard, checkRoleGuardEnforced, checkRoleGuardAndBlock, guardOnLabelChange } =
  await import("./routing-guard.js") as {
    checkRoleGuard: (typeof import("./routing-guard.js"))["checkRoleGuard"];
    checkRoleGuardEnforced: (typeof import("./routing-guard.js"))["checkRoleGuardEnforced"];
    checkRoleGuardAndBlock: (typeof import("./routing-guard.js"))["checkRoleGuardAndBlock"];
    // AI-1575 / AC4: exported when the label-change guard path is wired.
    // Undefined until implemented — tests that call it fail with TypeError.
    guardOnLabelChange: ((opts: {
      issueIdentifier: string;
      newLabels: string[];
      authToken: string;
      delegateLinearUserIdResolver?: (name: string) => string | null;
    }) => Promise<{ fired: boolean; blocked: boolean; correctedTo?: string }>) | undefined;
  };

// ── Minimal workflow def stub for dev-impl ────────────────────────────────

const DEV_IMPL_DEF = {
  id: "dev-impl",
  states: [
    {
      id: "implementation",
      owner_role: "implementer",
      transitions: [{ command: "submit-for-review", to: "code-review" }],
    },
    {
      id: "code-review",
      owner_role: "reviewer",
      transitions: [{ command: "approve", to: "done" }],
    },
    {
      id: "done",
      kind: "terminal",
      transitions: [],
    },
    {
      id: "intake",
      owner_role: "steward",
      transitions: [{ command: "accept", to: "implementation" }],
    },
  ],
};

// Hard-coded copy of the review-only set for test verification.
// Must be kept in sync with routing-guard.ts REVIEW_ONLY_AGENTS.
const REVIEW_ONLY_FOR_TEST = [
  "charles", "ai", "astrid", "finn", "mckell", "yoshi", "ken", "miki",
  "poe", "kat", "maren", "kenji", "lacey", "scout",
];

// ── Phase 1: sync advisory tests (unchanged) ─────────────────────────────

describe("checkRoleGuard (Phase 1 advisory)", () => {
  it("passes through non-workflow tickets (no wf: label)", () => {
    const result = checkRoleGuard("charles", []);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("passes through non-workflow tickets with other labels", () => {
    const result = checkRoleGuard("charles", ["bug", "priority:high"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("passes through workflow tickets not in implementation state", () => {
    const result = checkRoleGuard("charles", ["wf:dev-impl", "state:intake"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("advisory-warns when implementation-state ticket routed to review-only agent (charles)", () => {
    const result = checkRoleGuard("charles", ["wf:dev-impl", "state:implementation"]);
    // Advisory mode: blocked is false but reason is set
    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("charles");
    expect(result.reason).toContain("review-only");
  });

  it("passes through when implementation-state ticket routed to implementer (igor)", () => {
    const result = checkRoleGuard("igor", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("is case-insensitive for agent ID", () => {
    const result = checkRoleGuard("Charles", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("review-only");
  });

  it("warns for all review-only agents in implementation state", () => {
    for (const agent of REVIEW_ONLY_FOR_TEST) {
      const result = checkRoleGuard(agent, ["wf:dev-impl", "state:implementation"]);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain(agent);
    }
  });

  it("passes through for non-review-only agents even in implementation state", () => {
    const result = checkRoleGuard("igor", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("handles mixed-case state labels", () => {
    const result = checkRoleGuard("charles", ["wf:dev-impl", "state:Implementation"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("passes for code-review state routed to review-only agent (advisory: only implementation state checked)", () => {
    const result = checkRoleGuard("charles", ["wf:dev-impl", "state:code-review"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});

// ── Phase 2: async enforcement tests (AI-1459) ────────────────────────────

describe("checkRoleGuardEnforced (Phase 2 enforcement)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadWorkflowDef.mockResolvedValue(DEV_IMPL_DEF as never);
  });

  it("passes through non-workflow tickets (no wf: label)", async () => {
    const result = await checkRoleGuardEnforced("charles", []);
    expect(result.blocked).toBe(false);
  });

  it("passes through when no state label is present", async () => {
    const result = await checkRoleGuardEnforced("charles", ["wf:dev-impl"]);
    expect(result.blocked).toBe(false);
  });

  it("fails open when workflow def cannot be loaded", async () => {
    mockLoadWorkflowDef.mockRejectedValue(new Error("ENOENT: file not found") as never);
    const result = await checkRoleGuardEnforced("charles", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
  });

  it("passes through for unknown workflow ID", async () => {
    const result = await checkRoleGuardEnforced("charles", ["wf:unknown-workflow", "state:implementation"]);
    expect(result.blocked).toBe(false);
  });

  it("passes through for unknown state", async () => {
    const result = await checkRoleGuardEnforced("charles", ["wf:dev-impl", "state:nonexistent"]);
    expect(result.blocked).toBe(false);
  });

  it("passes through for terminal state (no role constraint)", async () => {
    const result = await checkRoleGuardEnforced("charles", ["wf:dev-impl", "state:done"]);
    expect(result.blocked).toBe(false);
  });

  it("passes through when state has no owner_role", async () => {
    const defNoRole = {
      id: "dev-impl",
      states: [{ id: "implementation", transitions: [] }],
    };
    mockLoadWorkflowDef.mockResolvedValue(defNoRole as never);
    const result = await checkRoleGuardEnforced("charles", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
  });

  it("fails open when resolveBodiesForRole throws", async () => {
    mockResolveBodiesForRole.mockRejectedValue(new Error("policy load error") as never);
    const result = await checkRoleGuardEnforced("charles", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
  });

  it("fails open when no bodies registered for role", async () => {
    mockResolveBodiesForRole.mockResolvedValue([] as never);
    const result = await checkRoleGuardEnforced("charles", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
  });

  it("passes through when agent fills the required role", async () => {
    mockResolveBodiesForRole.mockResolvedValue(["igor", "felix"] as never);
    const result = await checkRoleGuardEnforced("igor", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("is case-insensitive when checking agent against legal bodies", async () => {
    mockResolveBodiesForRole.mockResolvedValue(["Igor"] as never);
    const result = await checkRoleGuardEnforced("igor", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
  });

  it("BLOCKS when agent does not fill the required role (singleton legal target)", async () => {
    mockResolveBodiesForRole.mockResolvedValue(["igor"] as never);
    const result = await checkRoleGuardEnforced("noah", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("noah");
    expect(result.reason).toContain("implementer");
    expect(result.reason).toContain("igor");
    expect(result.correctedTo).toBe("igor");
  });

  it("BLOCKS when agent does not fill the required role (multiple legal targets, no correctedTo)", async () => {
    mockResolveBodiesForRole.mockResolvedValue(["igor", "felix"] as never);
    const result = await checkRoleGuardEnforced("charles", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("charles");
    expect(result.correctedTo).toBeUndefined();
  });

  it("BLOCKS for code-review state when agent is not a reviewer", async () => {
    mockResolveBodiesForRole.mockImplementation(async (role: string) => {
      if (role === "reviewer") return ["charles"];
      return ["igor"];
    });
    const result = await checkRoleGuardEnforced("igor", ["wf:dev-impl", "state:code-review"]);
    expect(result.blocked).toBe(true);
    expect(result.correctedTo).toBe("charles");
  });

  it("ALLOWS charles in code-review state (reviewer role)", async () => {
    mockResolveBodiesForRole.mockImplementation(async (role: string) => {
      if (role === "reviewer") return ["charles"];
      return ["igor"];
    });
    const result = await checkRoleGuardEnforced("charles", ["wf:dev-impl", "state:code-review"]);
    expect(result.blocked).toBe(false);
  });

  it("reason includes workflow ID and legal targets list", async () => {
    mockResolveBodiesForRole.mockResolvedValue(["igor", "felix"] as never);
    const result = await checkRoleGuardEnforced("noah", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("wf:dev-impl");
    expect(result.reason).toContain("igor, felix");
  });
});

// ── checkRoleGuardAndBlock: integration (no-network) ─────────────────────

describe("checkRoleGuardAndBlock (enforcement + comment/correction, no network)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadWorkflowDef.mockResolvedValue(DEV_IMPL_DEF as never);
    // No token — skips comment/correction path.
    mockGetAccessToken.mockReturnValue(undefined);
  });

  it("returns not-blocked when agent fills role (no side effects)", async () => {
    mockResolveBodiesForRole.mockResolvedValue(["igor"] as never);
    const result = await checkRoleGuardAndBlock("igor", "AI-1234", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(false);
  });

  it("returns blocked when agent does not fill role (no token — skips comment/correction)", async () => {
    mockResolveBodiesForRole.mockResolvedValue(["igor"] as never);
    const result = await checkRoleGuardAndBlock("noah", "AI-1234", ["wf:dev-impl", "state:implementation"]);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("noah");
    expect(result.correctedTo).toBe("igor");
  });

  it("passes through non-workflow tickets without touching Linear", async () => {
    const result = await checkRoleGuardAndBlock("charles", "AI-1234", []);
    expect(result.blocked).toBe(false);
  });
});

// ── AI-1575 / AC4: guard fires on enrollment/label-change path ────────────
//
// AC4: checkRoleGuardEnforced must fire on the enrollment/label-change path and
// correct an illegal delegate to the state's legal owner.
//
// AI-1571 incident: enrollment via bare `linear label` (not atomic) added
// wf:dev-impl + state:intake labels but left a stale delegate (Hanzo, the
// deployment owner). The guard DID NOT fire on the label-change webhook because
// the webhook handler returned early when routeEvent produced no route — the
// guard check is only reached after a successful route.
//
// Fix (in-scope for AI-1575): the guard must also run on label-change events
// that make a ticket governed, even when no agent route is resolved from the
// event payload. These tests define the expected behavior; they will be RED
// until the webhook handler is updated to call the guard on the label-change path.

describe("checkRoleGuardEnforced — AI-1575 / AC4: intake-state guard logic", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadWorkflowDef.mockResolvedValue(DEV_IMPL_DEF as never);
  });

  it("blocks Hanzo (deployment role) on state:intake (owner_role=steward)", async () => {
    mockResolveBodiesForRole.mockImplementation(async (role: string) => {
      if (role === "steward") return ["astrid"] as never;
      if (role === "deployment") return ["hanzo"] as never;
      return [] as never;
    });

    const result = await checkRoleGuardEnforced("hanzo", ["wf:dev-impl", "state:intake"]);

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("intake");
    expect(result.correctedTo).toBe("astrid");
  });

  it("identifies the steward singleton as correctedTo so webhook can auto-correct", async () => {
    mockResolveBodiesForRole.mockResolvedValueOnce(["astrid"] as never);

    const result = await checkRoleGuardEnforced("hanzo", ["wf:dev-impl", "state:intake"]);

    // Must produce correctedTo so checkRoleGuardAndBlock can issue the delegate update.
    expect(result.correctedTo).toBeDefined();
    expect(typeof result.correctedTo).toBe("string");
  });

  it("passes Astrid (steward) through on state:intake — correct owner", async () => {
    mockResolveBodiesForRole.mockResolvedValueOnce(["astrid"] as never);

    const result = await checkRoleGuardEnforced("astrid", ["wf:dev-impl", "state:intake"]);

    expect(result.blocked).toBe(false);
  });
});

describe("checkRoleGuardAndBlock — AI-1575 / AC4: label-change path guard (AI-1571 regression)", () => {
  // These tests cover the NEW behavior required by AC4: the guard must fire and
  // correct the delegate when a wf:dev-impl + state:intake label-change event
  // arrives and the current delegate is Hanzo.
  //
  // The webhook handler currently skips the guard when routeEvent returns null
  // (no delegate/assignee in the event payload). These tests will be RED until
  // the handler is updated to run the guard on the label-change path.

  let savedFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ query: string; variables: Record<string, unknown> }>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadWorkflowDef.mockResolvedValue(DEV_IMPL_DEF as never);
    mockResolveBodiesForRole.mockImplementation(async (role: string) => {
      if (role === "steward") return ["astrid"] as never;
      if (role === "deployment") return ["hanzo"] as never;
      return [] as never;
    });
    // Token so checkRoleGuardAndBlock proceeds to comment + correction.
    mockGetAccessToken.mockReturnValue("Bearer test-token");

    fetchCalls = [];
    savedFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(body) as { query?: string; variables?: Record<string, unknown> };
      fetchCalls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });

      const q = parsed.query ?? "";
      if (q.includes("issue(")) {
        // Resolve issue UUID
        return new Response(
          JSON.stringify({ data: { issue: { id: "internal-issue-uuid" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c1" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("issueUpdate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: "internal-issue-uuid" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it("AI-1571 repro: checkRoleGuardAndBlock blocks Hanzo on intake and corrects delegate to steward", async () => {
    const astridLinearId = "astrid-linear-uuid";
    const resolver = (bodyName: string): string | null => {
      if (bodyName.toLowerCase() === "astrid") return astridLinearId;
      return null;
    };

    const result = await checkRoleGuardAndBlock(
      "hanzo",
      "AI-1571",
      ["wf:dev-impl", "state:intake"],
      resolver,
    );

    expect(result.blocked).toBe(true);
    expect(result.correctedTo).toBe("astrid");

    // The guard must have attempted to correct the delegate to the steward.
    const delegateCorrectionCalls = fetchCalls.filter(
      (c) => c.query.includes("issueUpdate") && c.variables.delegateId === astridLinearId,
    );
    expect(delegateCorrectionCalls).toHaveLength(1);
  });

  it("AC4 label-change path: guardOnLabelChange fires guard even when event payload has no delegate field", async () => {
    // This test asserts the NEW behavior required by AC4:
    // guardOnLabelChange is a new exported function in routing-guard.ts that the
    // webhook handler calls when a label-change event makes a ticket governed
    // (wf:dev-impl + state:intake added) and routeEvent returns null (no delegate
    // in the event payload). The function:
    //   1. Fetches the ticket's CURRENT delegate from Linear
    //   2. Runs checkRoleGuardEnforced against that delegate
    //   3. If blocked, posts a comment and corrects the delegate
    //
    // This function does NOT exist yet → calling it raises TypeError → test is RED.

    // Feed a fetch mock that returns Hanzo as the current delegate.
    globalThis.fetch = async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(body) as { query?: string; variables?: Record<string, unknown> };
      fetchCalls.push({ query: parsed.query ?? "", variables: parsed.variables ?? {} });
      const q = parsed.query ?? "";
      if (q.includes("IssueDelegateAndLabels") || q.includes("issue(")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "internal-issue-uuid",
                delegate: { id: "hanzo-linear-uuid", name: "Hanzo" },
                labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c1" } } } }),
          { status: 200 },
        );
      }
      if (q.includes("issueUpdate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: "internal-issue-uuid" } } } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };

    // guardOnLabelChange does not exist yet → TypeError: guardOnLabelChange is not a function.
    expect(typeof guardOnLabelChange).toBe("function"); // fails until implemented

    const result = await guardOnLabelChange!({
      issueIdentifier: "AI-1571",
      newLabels: ["wf:dev-impl", "state:intake"],
      authToken: "Bearer test-token",
      delegateLinearUserIdResolver: (name: string) =>
        name.toLowerCase() === "astrid" ? "astrid-linear-uuid" : null,
    });

    // Guard must have fired (not skipped).
    expect(result.fired).toBe(true);
    // Guard must have blocked Hanzo.
    expect(result.blocked).toBe(true);
    // Correction target is the steward.
    expect(result.correctedTo).toBe("astrid");

    // A delegate-correction issueUpdate was sent.
    const correctionCalls = fetchCalls.filter(
      (c) => c.query.includes("issueUpdate") && c.variables.delegateId === "astrid-linear-uuid",
    );
    expect(correctionCalls).toHaveLength(1);
  });
});
