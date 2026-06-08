/**
 * Unit tests for routing-guard module (AI-1428 / AI-1459).
 *
 * Phase 1 tests: sync `checkRoleGuard` advisory path (unchanged).
 * Phase 2 tests: async `checkRoleGuardEnforced` enforcement path (AI-1459).
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

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
const { checkRoleGuard, checkRoleGuardEnforced, checkRoleGuardAndBlock } =
  await import("./routing-guard.js");

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
