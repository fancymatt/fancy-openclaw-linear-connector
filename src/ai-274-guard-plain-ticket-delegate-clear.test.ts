/**
 * INF-274 — Tests for guardPlainTicketDelegateClear (raw-path delegate=null
 * guard for plain non-workflow tickets).
 *
 * Pattern after ai-2044-guard-delegate-preservation.test.ts: direct function
 * test with mocked module dependencies.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// ── Mock ALL of proxy.ts's module dependencies ─────────────────────────────

const mockFetchWorkflowLabels = jest.fn<(issueId: string, authToken: string) => Promise<string[]>>();
const mockGetWorkflowId = jest.fn<(labels: string[]) => string | null>();

jest.unstable_mockModule("./logger.js", () => ({
  componentLogger: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  createLogger: jest.fn().mockReturnValue({}),
}));

jest.unstable_mockModule("./escalation-gate.js", () => ({
  checkEnforcementRules: jest.fn(),
  bodyHasCapability: jest.fn(),
}));

jest.unstable_mockModule("./proxy-cas-check.js", () => ({
  checkStaleSnapshotForTerminal: jest.fn(),
}));

jest.unstable_mockModule("./workflow-gate.js", () => ({
  checkWorkflowRules: jest.fn(),
  checkRawMutationInterception: jest.fn(),
  applyStateTransition: jest.fn(),
  buildStateTransitionReminder: jest.fn(),
  fetchWorkflowLabels: mockFetchWorkflowLabels,
  fetchTeamStateLabelIds: jest.fn(),
  getCurrentState: jest.fn(),
  getWorkflowId: mockGetWorkflowId,
  loadWorkflowDef: jest.fn(),
  loadWorkflowDefById: jest.fn(),
  reloadWorkflowDefs: jest.fn(),
  resolveMetaIntent: jest.fn(),
  resolveTransitionDelegate: jest.fn(),
  setStateAtomic: jest.fn(),
  verifyCommentSatisfiedBy: jest.fn(),
  fetchTicketVerification: jest.fn(),
}));

jest.unstable_mockModule("./barrier.js", () => ({
  isTerminalState: jest.fn(),
}));

jest.unstable_mockModule("./transition-audit.js", () => ({
  buildTransitionAuditRecord: jest.fn(),
  emitTransitionAuditRecord: jest.fn(),
  verifyPostTransition: jest.fn(),
}));

jest.unstable_mockModule("./agents.js", () => ({
  getAgent: jest.fn(),
  getAgentByProxyToken: jest.fn(),
}));

jest.unstable_mockModule("./session-key.js", () => ({
  tryNormalizeSessionKey: jest.fn(),
}));

jest.unstable_mockModule("./artifact-disclosure.js", () => ({
  checkArtifactDisclosure: jest.fn(),
  TICKET_TYPES: ["time", "material", "expense"],
}));

jest.unstable_mockModule("./issue-create-dedup.js", () => ({
  IssueCreateDedupCache: jest.fn().mockImplementation(() => ({
    claim: jest.fn().mockReturnValue({ kind: "forward", wait: null }),
  })),
  extractIssueCreateInput: jest.fn(),
  fingerprintIssueCreate: jest.fn(),
  isSuccessfulIssueCreate: jest.fn(),
  DEFAULT_DEDUP_TTL_MS: 0,
}));

// ── Import the function under test ─────────────────────────────────────────

const { guardPlainTicketDelegateClear } = await import("./proxy.js");

// ── Test helpers ───────────────────────────────────────────────────────────

const ISSUE_ID = "internal-uuid";
const AUTH = "Bearer test-token";

function makeIssueUpdateBody(delegateId: unknown): Record<string, unknown> {
  const vars: Record<string, unknown> = { input: { id: ISSUE_ID } };
  if (delegateId !== undefined) {
    vars.input = { ...vars.input as Record<string, unknown>, delegateId };
  }
  return {
    query: `mutation IssueUpdate { issueUpdate(id: "test") { success } }`,
    variables: vars,
  };
}

function makeNonMutationBody(): Record<string, unknown> {
  return { query: `query GetIssue { issue(id: "test") { id } }`, variables: {} };
}

function makeNoDelegateFieldBody(): Record<string, unknown> {
  return {
    query: `mutation IssueUpdate { issueUpdate(id: "test") { success } }`,
    variables: { input: { id: ISSUE_ID, assigneeId: "some-user" } },
  };
}

function makeCommentCreateBody(): Record<string, unknown> {
  return {
    query: `mutation CommentCreate { commentCreate(id: "test") { success } }`,
    variables: { input: { body: "hello", issueId: ISSUE_ID } },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("guardPlainTicketDelegateClear", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Blocked cases ──────────────────────────────────────────────────────────

  it("blocks raw-path delegate=null on a plain ticket (no labels)", async () => {
    mockFetchWorkflowLabels.mockResolvedValue([]);
    mockGetWorkflowId.mockReturnValue(null);

    const result = await guardPlainTicketDelegateClear(
      makeIssueUpdateBody(null) as never, ISSUE_ID, AUTH,
    );

    expect(result).toBeTruthy();
    expect(result).toContain("delegate=null");
    expect(result).toContain("plain (non-workflow)");
    expect(mockFetchWorkflowLabels).toHaveBeenCalledWith(ISSUE_ID, AUTH);
    expect(mockGetWorkflowId).toHaveBeenCalled();
  });

  it("blocks delegate=null when labels are non-wf (plain ticket with other labels)", async () => {
    mockFetchWorkflowLabels.mockResolvedValue(["bug", "priority-high"]);
    mockGetWorkflowId.mockReturnValue(null);

    const result = await guardPlainTicketDelegateClear(
      makeIssueUpdateBody(null) as never, ISSUE_ID, AUTH,
    );

    expect(result).toBeTruthy();
    expect(result).toContain("plain (non-workflow)");
  });

  // ── Allowed cases ──────────────────────────────────────────────────────────

  it("allows delegate=null on a workflow ticket (deferred to checkRawMutationInterception)", async () => {
    mockFetchWorkflowLabels.mockResolvedValue(["wf:dev-impl", "state:implementation"]);
    mockGetWorkflowId.mockReturnValue("dev-impl");

    const result = await guardPlainTicketDelegateClear(
      makeIssueUpdateBody(null) as never, ISSUE_ID, AUTH,
    );

    expect(result).toBeNull();
    expect(mockFetchWorkflowLabels).toHaveBeenCalledWith(ISSUE_ID, AUTH);
  });

  it("allows delegate=non-null on a plain ticket", async () => {
    const result = await guardPlainTicketDelegateClear(
      makeIssueUpdateBody("some-agent-uuid") as never, ISSUE_ID, AUTH,
    );

    expect(result).toBeNull();
    expect(mockFetchWorkflowLabels).not.toHaveBeenCalled();
  });

  it("allows when delegateId is absent from the mutation", async () => {
    const result = await guardPlainTicketDelegateClear(
      makeNoDelegateFieldBody() as never, ISSUE_ID, AUTH,
    );

    expect(result).toBeNull();
    expect(mockFetchWorkflowLabels).not.toHaveBeenCalled();
  });

  it("allows when there is no issueId (cannot verify ticket type)", async () => {
    const result = await guardPlainTicketDelegateClear(
      makeIssueUpdateBody(null) as never, null, AUTH,
    );

    expect(result).toBeNull();
    expect(mockFetchWorkflowLabels).not.toHaveBeenCalled();
  });

  it("allows a non-issueUpdate mutation (e.g. commentCreate)", async () => {
    const result = await guardPlainTicketDelegateClear(
      makeCommentCreateBody() as never, ISSUE_ID, AUTH,
    );

    expect(result).toBeNull();
    expect(mockFetchWorkflowLabels).not.toHaveBeenCalled();
  });

  it("allows a read (non-mutation) query", async () => {
    const result = await guardPlainTicketDelegateClear(
      makeNonMutationBody() as never, ISSUE_ID, AUTH,
    );

    expect(result).toBeNull();
    expect(mockFetchWorkflowLabels).not.toHaveBeenCalled();
  });

  it("fail-open: allows when label fetch throws", async () => {
    mockFetchWorkflowLabels.mockRejectedValue(new Error("API unreachable"));

    const result = await guardPlainTicketDelegateClear(
      makeIssueUpdateBody(null) as never, ISSUE_ID, AUTH,
    );

    expect(result).toBeNull();
  });
});
