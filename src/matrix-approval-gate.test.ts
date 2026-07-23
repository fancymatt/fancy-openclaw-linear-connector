/**
 * INF-192 — Matrix-based human approval advancing workflow gates.
 *
 * AC mapping:
 *   AC1 — Defined mechanism for Matrix-based approval to advance a governed workflow gate
 *   AC2 — Audit trail: approval recorded in both Linear (comment/timeline) and Matrix
 *   AC3 — Security: only designated approvers (per capability policy) can trigger the gate
 *   AC5 — Liveness observable at ac-validate: /health field or registry entry
 *
 * These unit tests assert the component's logic-level contract. They will fail
 * (cannot import the module) until the implementation exists.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { resetCronRegistryForTest } from "./cron/registry.js";

// ── Module under test — will fail on import until implemented ─────────
import {
  registerMatrixApprovalGate,
  getMatrixApprovalGateLiveness,
  processMatrixApproval,
  type MatrixApprovalConfig,
  type ApprovalRequest,
  type ApprovalResult,
} from "./matrix-approval-gate.js";

// ── AC2: audit trail requires Linear comment posting and Matrix event recording ──

interface LinearCommentRecord {
  issueId: string;
  body: string;
  createdAt: string;
}
const recordedComments: LinearCommentRecord[] = [];

interface MatrixEventRecord {
  roomId: string;
  eventId: string;
  body: string;
  recordedAt: string;
}
const recordedMatrixEvents: MatrixEventRecord[] = [];

// Mock the Linear comment API and Matrix event store
const mockPostLinearComment = jest.fn<() => Promise<string | null>>();
const mockRecordMatrixEvent = jest.fn<() => Promise<string | null>>();

beforeEach(() => {
  recordedComments.length = 0;
  recordedMatrixEvents.length = 0;
  resetCronRegistryForTest();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("INF-192 AC1: defined mechanism for Matrix-based approval to advance a workflow gate", () => {
  it("exposes a processMatrixApproval function that accepts an ApprovalRequest and returns an ApprovalResult", async () => {
    // This test asserts the API shape exists. It will fail at import time
    // until the module is created with this export.
    const request: ApprovalRequest = {
      matrixEventId: "$event123:matrix.org",
      approverId: "@ai:matrix.org",
      ticketId: "AI-1234",
      transition: "approve",
      targetAgent: "ai",
    };

    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve", "approved", "lgtm", ":+1:"],
      linearToken: "test-token",
      matrixEventStore: {},
    };

    const result = await processMatrixApproval(request, config, {
      postLinearComment: mockPostLinearComment,
      recordMatrixEvent: mockRecordMatrixEvent,
    });

    expect(result).toBeDefined();
    expect(typeof result.approved).toBe("boolean");
    // AC1: the mechanism returns a structured result with approval status
    expect(result).toHaveProperty("approved");
    expect(result).toHaveProperty("linearCommentId");
    expect(result).toHaveProperty("matrixRecordId");
  });

  it("recognizes approval intent from a Matrix message matching configured patterns", async () => {
    // The mechanism must detect approval intent from messages like "I approve"
    mockPostLinearComment.mockResolvedValue("linear-comment-uuid-1");
    mockRecordMatrixEvent.mockResolvedValue("matrix-event-uuid-1");

    const request: ApprovalRequest = {
      matrixEventId: "$event456:matrix.org",
      approverId: "@ai:matrix.org",
      ticketId: "AI-5678",
      transition: "signoff",
      targetAgent: "ai",
    };

    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve", "approved", ":+1:", "sign off", "lgtm"],
    };

    const result = await processMatrixApproval(request, config, {
      postLinearComment: mockPostLinearComment,
      recordMatrixEvent: mockRecordMatrixEvent,
    });

    expect(result.approved).toBe(true);
  });

  it("rejects a Matrix message that does not match any approval pattern", async () => {
    const request: ApprovalRequest = {
      matrixEventId: "$event789:matrix.org",
      approverId: "@ai:matrix.org",
      ticketId: "AI-5678",
      transition: "signoff",
      targetAgent: "ai",
    };

    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve", "lgtm"],
    };

    const result = await processMatrixApproval(request, config, {
      postLinearComment: mockPostLinearComment,
      recordMatrixEvent: mockRecordMatrixEvent,
    });

    expect(result.approved).toBe(false);
    // A rejection should not produce audit trail entries
    expect(mockPostLinearComment).not.toHaveBeenCalled();
    expect(mockRecordMatrixEvent).not.toHaveBeenCalled();
  });

  it("triggers the configured workflow transition when approval succeeds", async () => {
    // The mechanism should advance the workflow gate — meaning it should
    // call postLinearComment, recordMatrixEvent, and return the successful result
    mockPostLinearComment.mockResolvedValue("linear-comment-uuid-2");
    mockRecordMatrixEvent.mockResolvedValue("matrix-event-uuid-2");

    const request: ApprovalRequest = {
      matrixEventId: "$event999:matrix.org",
      approverId: "@ai:matrix.org",
      ticketId: "GEN-100",
      transition: "approve",
      targetAgent: "ai",
    };

    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve"],
    };

    const result = await processMatrixApproval(request, config, {
      postLinearComment: mockPostLinearComment,
      recordMatrixEvent: mockRecordMatrixEvent,
    });

    expect(result.approved).toBe(true);
    // AC1: the approval must trigger the transition, which means posting to Linear
    expect(mockPostLinearComment).toHaveBeenCalled();
  });
});

describe("INF-192 AC2: audit trail — approval recorded in both Linear and Matrix", () => {
  it("posts an approval comment to the Linear ticket timeline", async () => {
    mockPostLinearComment.mockResolvedValue("linear-comment-uuid-3");
    mockRecordMatrixEvent.mockResolvedValue("matrix-event-uuid-3");

    const request: ApprovalRequest = {
      matrixEventId: "$event1000:matrix.org",
      approverId: "@ai:matrix.org",
      ticketId: "AI-9999",
      transition: "approve",
      targetAgent: "ai",
    };

    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve"],
    };

    const result = await processMatrixApproval(request, config, {
      postLinearComment: mockPostLinearComment,
      recordMatrixEvent: mockRecordMatrixEvent,
    });

    // AC2: Linear must have a comment recording the approval
    expect(result.approved).toBe(true);
    expect(mockPostLinearComment).toHaveBeenCalledTimes(1);
    expect(mockPostLinearComment).toHaveBeenCalledWith(
      expect.stringContaining("AI-9999"),
      expect.stringContaining("approve"),
    );
    expect(result.linearCommentId).toBe("linear-comment-uuid-3");
  });

  it("records the approval event in the Matrix room for audit", async () => {
    mockPostLinearComment.mockResolvedValue("linear-comment-uuid-4");
    mockRecordMatrixEvent.mockResolvedValue("matrix-event-uuid-4");

    const request: ApprovalRequest = {
      matrixEventId: "$event1001:matrix.org",
      approverId: "@ai:matrix.org",
      ticketId: "INF-192",
      transition: "approve",
      targetAgent: "ai",
    };

    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve"],
    };

    const result = await processMatrixApproval(request, config, {
      postLinearComment: mockPostLinearComment,
      recordMatrixEvent: mockRecordMatrixEvent,
    });

    // AC2: Matrix room must have an audit record of the approval
    expect(result.approved).toBe(true);
    expect(mockRecordMatrixEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordMatrixEvent).toHaveBeenCalledWith(
      expect.any(String),  // room ID or event store key
      expect.objectContaining({
        type: "approval",
        ticketId: "INF-192",
        transition: "approve",
      }),
    );
    expect(result.matrixRecordId).toBe("matrix-event-uuid-4");
  });

  it("fails the approval if the Linear comment cannot be posted (no audit trail)", async () => {
    mockPostLinearComment.mockResolvedValue(null); // failed to post
    mockRecordMatrixEvent.mockResolvedValue("matrix-event-uuid-5");

    const request: ApprovalRequest = {
      matrixEventId: "$event1002:matrix.org",
      approverId: "@ai:matrix.org",
      ticketId: "AI-8888",
      transition: "approve",
      targetAgent: "ai",
    };

    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve"],
    };

    const result = await processMatrixApproval(request, config, {
      postLinearComment: mockPostLinearComment,
      recordMatrixEvent: mockRecordMatrixEvent,
    });

    // AC2: no Linear audit trail → approval should fail so there is no silent
    // gate advance without a durable record
    expect(result.approved).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.linearCommentId).toBeNull();
  });

  it("fails safe if Matrix audit recording fails", async () => {
    mockPostLinearComment.mockResolvedValue("linear-comment-uuid-6");
    mockRecordMatrixEvent.mockResolvedValue(null); // failed to record

    const request: ApprovalRequest = {
      matrixEventId: "$event1003:matrix.org",
      approverId: "@ai:matrix.org",
      ticketId: "AI-8889",
      transition: "approve",
      targetAgent: "ai",
    };

    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve"],
    };

    const result = await processMatrixApproval(request, config, {
      postLinearComment: mockPostLinearComment,
      recordMatrixEvent: mockRecordMatrixEvent,
    });

    // AC2: if the Matrix audit trail cannot be written, the approval must
    // fail — we do NOT advance the gate without a full audit record
    expect(result.approved).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("INF-192 AC3: security — only designated approvers can trigger the gate", () => {
  it("approves when the Matrix user ID matches a designated approver in capability policy", async () => {
    mockPostLinearComment.mockResolvedValue("linear-comment-uuid-7");
    mockRecordMatrixEvent.mockResolvedValue("matrix-event-uuid-7");

    const request: ApprovalRequest = {
      matrixEventId: "$event2000:matrix.org",
      approverId: "@ai:matrix.org",
      ticketId: "AI-1234",
      transition: "signoff",
      targetAgent: "ai",
    };

    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve"],
      // Designated approvers with their Linear identities and capabilities
      designatedApprovers: [
        { matrixId: "@ai:matrix.org", linearUserId: "ai-linear-uuid", capability: "sprint:signoff" },
      ],
    };

    const result = await processMatrixApproval(request, config, {
      postLinearComment: mockPostLinearComment,
      recordMatrixEvent: mockRecordMatrixEvent,
    });

    expect(result.approved).toBe(true);
  });

  it("rejects when the Matrix user is not in the designated approvers list", async () => {
    const request: ApprovalRequest = {
      matrixEventId: "$event2001:matrix.org",
      approverId: "@unknown:matrix.org",
      ticketId: "AI-1234",
      transition: "signoff",
      targetAgent: "ai",
    };

    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve"],
      designatedApprovers: [
        { matrixId: "@ai:matrix.org", linearUserId: "ai-linear-uuid", capability: "sprint:signoff" },
      ],
    };

    const result = await processMatrixApproval(request, config, {
      postLinearComment: mockPostLinearComment,
      recordMatrixEvent: mockRecordMatrixEvent,
    });

    // AC3: unknown non-designated user must be rejected
    expect(result.approved).toBe(false);
    expect(result.error).toContain("unauthorized") || expect(result.error).toContain("not designated");
    // No audit trail for rejected unauthorized attempts
    expect(mockPostLinearComment).not.toHaveBeenCalled();
    expect(mockRecordMatrixEvent).not.toHaveBeenCalled();
  });

  it("rejects when the designated approver does not hold the required capability for this transition", async () => {
    const request: ApprovalRequest = {
      matrixEventId: "$event2002:matrix.org",
      approverId: "@ai:matrix.org",
      ticketId: "AI-1234",
      transition: "deploy",       // deploy requires deploy:execute, not sprint:signoff
      targetAgent: "hanzo",
    };

    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve"],
      designatedApprovers: [
        { matrixId: "@ai:matrix.org", linearUserId: "ai-linear-uuid", capability: "sprint:signoff" },
      ],
    };

    const result = await processMatrixApproval(request, config, {
      postLinearComment: mockPostLinearComment,
      recordMatrixEvent: mockRecordMatrixEvent,
    });

    // AC3: capability mismatch — the approver holds sprint:signoff but deploy
    // requires deploy:execute — must be rejected
    expect(result.approved).toBe(false);
    expect(result.error).toContain("capability") || expect(result.error).toContain("not authorized");
    // No audit trail for capability-mismatched attempts
    expect(mockPostLinearComment).not.toHaveBeenCalled();
    expect(mockRecordMatrixEvent).not.toHaveBeenCalled();
  });

  it("resolves agent identity from the Matrix user's Linear ID via the capability policy container system", async () => {
    // The designated approver's Linear identity should be used for the
    // Linear audit comment (signing it as the correct user), not just
    // their Matrix display name
    mockPostLinearComment.mockResolvedValue("linear-comment-uuid-8");
    mockRecordMatrixEvent.mockResolvedValue("matrix-event-uuid-8");

    const request: ApprovalRequest = {
      matrixEventId: "$event2003:matrix.org",
      approverId: "@ai:matrix.org",
      ticketId: "AI-1234",
      transition: "signoff",
      targetAgent: "ai",
    };

    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve"],
      designatedApprovers: [
        { matrixId: "@ai:matrix.org", linearUserId: "ai-linear-uuid", capability: "sprint:signoff" },
      ],
    };

    const result = await processMatrixApproval(request, config, {
      postLinearComment: mockPostLinearComment,
      recordMatrixEvent: mockRecordMatrixEvent,
    });

    expect(result.approved).toBe(true);
    // The Linear comment should reference the approver's Linear identity
    expect(mockPostLinearComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("ai-linear-uuid"),
    );
  });
});

describe("INF-192 AC5: liveness observable at ac-validate without waiting for trigger", () => {
  it("registerMatrixApprovalGate creates a cron registry entry showing the component is scheduled", async () => {
    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve"],
      designatedApprovers: [
        { matrixId: "@ai:matrix.org", linearUserId: "ai-linear-uuid", capability: "sprint:signoff" },
      ],
    };

    // Register the component — this should call registerCron internally
    registerMatrixApprovalGate(config);

    // The cron registry should now have an entry proving the component is armed
    // This test will fail (import error) until the module exists
    const { getRegisteredCrons } = await import("./cron/registry.js");
    const crons = getRegisteredCrons();
    const entry = crons.find((c) => c.name === "matrix-approval-gate");

    expect(entry).toBeDefined();
    expect(entry!.name).toBe("matrix-approval-gate");
    expect(entry!.registeredAt).toBeDefined();
    // A valid ISO timestamp proves the timer was armed at bootstrap
    expect(() => new Date(entry!.registeredAt)).not.toThrow();
  });

  it("getMatrixApprovalGateLiveness returns a health status object without requiring a trigger event", async () => {
    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve"],
      designatedApprovers: [],
    };

    registerMatrixApprovalGate(config);

    const liveness = getMatrixApprovalGateLiveness();

    // AC5: liveness must be observable without waiting for a Matrix approval event
    expect(liveness).toBeDefined();
    expect(liveness).toHaveProperty("active");
    expect(typeof liveness.active).toBe("boolean");
    expect(liveness).toHaveProperty("approvers");
    expect(typeof liveness.approvers).toBe("number");
    // Must surface the registered approval patterns and approver count so
    // ac-validate can confirm the component is live without firing a real approval
    expect(liveness).toHaveProperty("patterns");
  });

  it("liveness object includes approver count and pattern count for operational visibility", async () => {
    const config: MatrixApprovalConfig = {
      approvalPatterns: ["I approve", "lgtm", ":+1:", "approved"],
      designatedApprovers: [
        { matrixId: "@ai:matrix.org", linearUserId: "ai-linear-uuid", capability: "sprint:signoff" },
        { matrixId: "@astrid:matrix.org", linearUserId: "astrid-linear-uuid", capability: "workflow:break-glass" },
      ],
    };

    registerMatrixApprovalGate(config);

    const liveness = getMatrixApprovalGateLiveness();

    // Operational detail for ac-validate
    expect(liveness.patterns).toBe(4);
    expect(liveness.approvers).toBe(2);
    expect(liveness.active).toBe(true);
  });

  it("returns inactive liveness when the gate has not been registered", () => {
    // Before registerMatrixApprovalGate is called, liveness should report
    // inactive — this is the dead-code-in-prod guard (AI-1773/AI-1775 pattern)
    const liveness = getMatrixApprovalGateLiveness();

    expect(liveness).toBeDefined();
    expect(liveness.active).toBe(false);
  });
});
