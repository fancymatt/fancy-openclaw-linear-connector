/**
 * INF-192 — Matrix-based human approval advancing workflow gates.
 *
 * Provides:
 *   - registerMatrixApprovalGate(): bootstrap registrar (calls registerCron)
 *   - getMatrixApprovalGateLiveness(): /health observable status
 *   - processMatrixApproval(): core gate logic — pattern match + designated
 *     approver check + dual audit trail (Linear comment + Matrix event)
 *
 * AC mapping:
 *   AC1 — processMatrixApproval is the defined mechanism
 *   AC2 — audit trail in both Linear (comment) and Matrix (event record)
 *   AC3 — only designated approvers with matching capability can trigger
 *   AC4 — registered at bootstrap via registerMatrixApprovalGate()
 *   AC5 — liveness observable via getMatrixApprovalGateLiveness()
 */

import { registerCron, getRegisteredCrons } from "./cron/registry.js";

// ── Types ───────────────────────────────────────────────────────────

export interface DesignatedApprover {
  matrixId: string;
  linearUserId: string;
  capability: string;
}

export interface MatrixApprovalConfig {
  approvalPatterns: string[];
  linearToken?: string;
  matrixEventStore?: Record<string, unknown>;
  designatedApprovers?: DesignatedApprover[];
}

export interface ApprovalRequest {
  matrixEventId: string;
  approverId: string;
  ticketId: string;
  transition: string;
  targetAgent: string;
}

export interface ApprovalResult {
  approved: boolean;
  linearCommentId: string | null;
  matrixRecordId: string | null;
  error?: string;
}

export interface ApprovalDeps {
  postLinearComment: (issueId: string, body: string) => Promise<string | null>;
  recordMatrixEvent: (roomIdOrKey: string, eventData: Record<string, unknown>) => Promise<string | null>;
}

// ── Module-level state ──────────────────────────────────────────────

let activeConfig: MatrixApprovalConfig | null = null;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize a string for pattern matching: lowercase + remove all whitespace.
 * This lets "sign off" match "signoff" and "I approve" match "approve".
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

/**
 * Check if any approval pattern matches the transition name.
 * Match is bidirectional substring after normalization: either the pattern
 * contains the transition or the transition contains the pattern.
 */
function matchesApprovalPattern(transition: string, patterns: string[]): boolean {
  const normalizedTransition = normalize(transition);
  if (!normalizedTransition) return false;
  return patterns.some((p) => {
    const np = normalize(p);
    if (!np) return false;
    return np.includes(normalizedTransition) || normalizedTransition.includes(np);
  });
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Register the Matrix approval gate component. Stores config in module-level
 * state and records a cron registry entry so /health can confirm the component
 * is armed at bootstrap (AI-1808 dead-code-in-prod guard).
 */
export function registerMatrixApprovalGate(config: MatrixApprovalConfig): void {
  activeConfig = config;
  registerCron("matrix-approval-gate", "on-demand");
}

/**
 * Return liveness info for /health. Before registerMatrixApprovalGate is
 * called (or after the cron registry is reset for tests), reports inactive.
 */
export function getMatrixApprovalGateLiveness(): { active: boolean; approvers: number; patterns: number } {
  // Check the cron registry so that resetCronRegistryForTest() properly
  // resets liveness between test cases.
  const registered = getRegisteredCrons().some((c) => c.name === "matrix-approval-gate");
  if (!registered || !activeConfig) {
    return { active: false, approvers: 0, patterns: 0 };
  }
  return {
    active: true,
    approvers: activeConfig.designatedApprovers?.length ?? 0,
    patterns: activeConfig.approvalPatterns.length,
  };
}

/**
 * Core gate logic.
 *
 * Two modes:
 *   - Designated-approver mode (designatedApprovers non-empty): the approver
 *     must be in the list and hold a capability matching the transition.
 *     Patterns are not checked — the capability check is the gate.
 *   - Pattern-only mode (no designatedApprovers): any approval pattern that
 *     matches the transition name grants approval.
 *
 * On success, writes dual audit trail (Linear comment + Matrix event).
 * Either audit failure causes the whole approval to fail safe.
 */
export async function processMatrixApproval(
  request: ApprovalRequest,
  config: MatrixApprovalConfig,
  deps: ApprovalDeps,
): Promise<ApprovalResult> {
  const { transition, approverId, ticketId, targetAgent, matrixEventId } = request;
  const approvers = config.designatedApprovers ?? [];

  // ── Designated-approver mode ───────────────────────────────────────
  if (approvers.length > 0) {
    // Check approver identity
    const approver = approvers.find((a) => a.matrixId === approverId);
    if (!approver) {
      return {
        approved: false,
        linearCommentId: null,
        matrixRecordId: null,
        error: `approver ${approverId} is unauthorized — not designated (not in designated approvers list)`,
      };
    }

    // Check capability matches transition
    const normalizedTransition = normalize(transition);
    const normalizedCapability = normalize(approver.capability);
    if (!normalizedCapability.includes(normalizedTransition)) {
      return {
        approved: false,
        linearCommentId: null,
        matrixRecordId: null,
        error: `approver ${approverId} has capability "${approver.capability}" which does not match transition "${transition}" — capability not authorized`,
      };
    }

    // Dual audit trail
    const linearBody = `Matrix approval gate: ${approver.linearUserId} approved transition "${transition}" for ${targetAgent} (Matrix event ${matrixEventId})`;
    const linearCommentId = await deps.postLinearComment(ticketId, linearBody);
    if (!linearCommentId) {
      return {
        approved: false,
                        linearCommentId: null,
        matrixRecordId: null,
        error: "failed to post Linear audit comment",
      };
    }

    const matrixEventData: Record<string, unknown> = {
      type: "approval",
      ticketId,
      transition,
      targetAgent,
      approverLinearId: approver.linearUserId,
      matrixEventId,
    };
    const matrixRecordId = await deps.recordMatrixEvent(ticketId, matrixEventData);
    if (!matrixRecordId) {
      return {
        approved: false,
        linearCommentId: null,
        matrixRecordId: null,
        error: "failed to record Matrix audit event",
      };
    }

    return { approved: true, linearCommentId, matrixRecordId };
  }

  // ── Pattern-only mode ──────────────────────────────────────────────
  const patternMatched = matchesApprovalPattern(transition, config.approvalPatterns);
  if (!patternMatched) {
    return {
      approved: false,
      linearCommentId: null,
      matrixRecordId: null,
      error: `transition "${transition}" did not match any approval pattern`,
    };
  }

  // Dual audit trail
  const linearBody = `Matrix approval gate: approved transition "${transition}" for ${targetAgent} (Matrix event ${matrixEventId})`;
  const linearCommentId = await deps.postLinearComment(ticketId, linearBody);
  if (!linearCommentId) {
    return {
      approved: false,
      linearCommentId: null,
      matrixRecordId: null,
      error: "failed to post Linear audit comment",
    };
  }

  const matrixEventData: Record<string, unknown> = {
    type: "approval",
    ticketId,
    transition,
    targetAgent,
    matrixEventId,
  };
  const matrixRecordId = await deps.recordMatrixEvent(ticketId, matrixEventData);
  if (!matrixRecordId) {
    return {
      approved: false,
      linearCommentId: null,
      matrixRecordId: null,
      error: "failed to record Matrix audit event",
    };
  }

  return { approved: true, linearCommentId, matrixRecordId };
}
