/**
 * Failure classifier (INF-319).
 *
 * Deterministic mapping from (HealthVerdict breach, LivenessSnapshot) → typed failure_class.
 *
 * Gate 1 (not picked up — verdict.gateId === "dispatched"):
 *   1. no dispatch record → connector-didnt-fire
 *   2. record but no ack → delivery-failed
 *   3. ack target-key ≠ resolved agent → wrong-target (INF-224 class)
 *   4. ack + session unhealthy → agent-broken
 *   5. ack + healthy + no pickup → behavioral-noop
 *   6. ack=queued → healthy-suppressed:queued (NOT a failure)
 *   7. state=Backlog → backlog-skipped
 *
 * Gate 2 (not completed — verdict.gateId === "picked-up"):
 *   8.  unhealthy session → agent-broke-mid-task
 *   9.  alive + no in-flight turn + incomplete → stuck (subagent-return-gap)
 *   10. working state + delegate=null → delegate-nulled (AI-1395)
 *   11. hard side-effect present + no verb → verb-not-sent
 *   12. active turn/subagent → healthy-suppressed:working (NOT a failure)
 *   13. explicit needs-human/gate/break-glass marker → healthy-suppressed:blocked (NOT a failure)
 *
 * Cross-cutting:
 *   14. Every classification carries the evidence used to reach it.
 *   15. The three healthy-suppressed cases are never emitted as failures.
 *   16. Pure/deterministic + unit tests covering every row above.
 */

import type { HealthVerdict } from "./health-types.js";
import type { LivenessSnapshot } from "../liveness-channel/index.js";

// ── Public types ────────────────────────────────────────────────────────────

export type FailureClass =
  | "connector-didnt-fire"
  | "delivery-failed"
  | "wrong-target"
  | "agent-broken"
  | "behavioral-noop"
  | "backlog-skipped"
  | "agent-broke-mid-task"
  | "stuck"
  | "delegate-nulled"
  | "verb-not-sent"
  | "healthy-suppressed-queued"
  | "healthy-suppressed-working"
  | "healthy-suppressed-blocked";

export interface FailureClassification {
  failureClass: FailureClass;
  isFailure: boolean;
  evidence: Record<string, unknown>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Failure classes that represent actual failures (isFailure = true). */
const FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  "connector-didnt-fire",
  "delivery-failed",
  "wrong-target",
  "agent-broken",
  "behavioral-noop",
  "backlog-skipped",
  "agent-broke-mid-task",
  "stuck",
  "delegate-nulled",
  "verb-not-sent",
]);

/** Valid blocking markers for AC 13. */
const BLOCKING_MARKERS: ReadonlySet<string> = new Set([
  "needs-human",
  "gate",
  "break-glass",
]);

/**
 * Safely parse `verdict.detail` as JSON, returning null if missing or unparsable.
 */
function parseDetail(detail?: string): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // detail is not valid JSON — not an error, just no structured data
  }
  return null;
}

// ── Gate 1: not picked up ───────────────────────────────────────────────────

function classifyGate1(
  verdict: HealthVerdict,
  snapshot: LivenessSnapshot,
): FailureClassification {
  const { dispatch, sessionHealth, turnLiveness } = snapshot;

  // AC 1: no dispatch record → connector-didnt-fire
  if (!dispatch.hasRecord) {
    return {
      failureClass: "connector-didnt-fire",
      isFailure: true,
      evidence: {
        hasRecord: false,
        sent: dispatch.sent,
        gateId: verdict.gateId,
        contractLabel: verdict.contractLabel,
      },
    };
  }

  // AC 7: state=Backlog → backlog-skipped
  // Backlog state is conveyed via sessionHealth.reason (the dispatch record has no "backlog" status).
  const isBacklog = sessionHealth.reason?.includes("Backlog") ?? false;
  if (isBacklog) {
    return {
      failureClass: "backlog-skipped",
      isFailure: true,
      evidence: {
        hasRecord: true,
        reason: sessionHealth.reason ?? "Backlog",
        dispatchStatus: dispatch.status,
        gateId: verdict.gateId,
      },
    };
  }

  // AC 2: record but no ack → delivery-failed
  if (!dispatch.acknowledged || dispatch.ack === null) {
    return {
      failureClass: "delivery-failed",
      isFailure: true,
      evidence: {
        hasRecord: true,
        acknowledged: dispatch.acknowledged,
        ack: dispatch.ack,
        dispatchId: dispatch.dispatchId,
        status: dispatch.status,
        gateId: verdict.gateId,
      },
    };
  }

  // AC 6: ack=queued → healthy-suppressed:queued (NOT a failure)
  if (dispatch.ack.status === "queued") {
    return {
      failureClass: "healthy-suppressed-queued",
      isFailure: false,
      evidence: {
        ackStatus: "queued",
        queueDepth: dispatch.ack.queue_depth,
        queueAge: dispatch.ack.queue_age,
        targetIdentity: dispatch.ack.target_identity,
        gateId: verdict.gateId,
      },
    };
  }

  // AC 3: ack target-key ≠ resolved agent → wrong-target (INF-224 class)
  // Distinguished from AC 10 (delegate-nulled) by non-empty `actual`.
  const wt = dispatch.wrongTarget;
  if (wt?.flagged === true && wt.actual !== "") {
    return {
      failureClass: "wrong-target",
      isFailure: true,
      evidence: {
        wrongTargetFlagged: true,
        expected: wt.expected,
        actual: wt.actual,
        reason: wt.reason,
        delegateAtDispatch: wt.delegateAtDispatch,
        gateId: verdict.gateId,
      },
    };
  }

  // AC 4: ack + session unhealthy → agent-broken
  if (!sessionHealth.healthy) {
    return {
      failureClass: "agent-broken",
      isFailure: true,
      evidence: {
        ackPresent: true,
        sessionHealthy: false,
        sessionReason: sessionHealth.reason,
        targetIdentity: dispatch.ack.target_identity,
        gateId: verdict.gateId,
      },
    };
  }

  // AC 5: ack + healthy + no pickup → behavioral-noop
  return {
    failureClass: "behavioral-noop",
    isFailure: true,
    evidence: {
      ackPresent: true,
      sessionHealthy: true,
      turnActive: turnLiveness.active,
      hasInFlightTurn: turnLiveness.hasInFlightTurn,
      hasRunningSubagent: turnLiveness.hasRunningSubagent,
      targetIdentity: dispatch.ack.target_identity,
      gateId: verdict.gateId,
    },
  };
}

// ── Gate 2: not completed ───────────────────────────────────────────────────

function classifyGate2(
  verdict: HealthVerdict,
  snapshot: LivenessSnapshot,
): FailureClassification {
  const { dispatch, sessionHealth, turnLiveness } = snapshot;

  // AC 8: unhealthy session → agent-broke-mid-task
  if (!sessionHealth.healthy) {
    return {
      failureClass: "agent-broke-mid-task",
      isFailure: true,
      evidence: {
        sessionHealthy: false,
        sessionReason: sessionHealth.reason,
        gateId: verdict.gateId,
        expectedSignal: verdict.expectedSignal,
      },
    };
  }

  // AC 12: active turn/subagent → healthy-suppressed:working (NOT a failure)
  if (
    turnLiveness.active ||
    turnLiveness.hasInFlightTurn ||
    turnLiveness.hasRunningSubagent
  ) {
    return {
      failureClass: "healthy-suppressed-working",
      isFailure: false,
      evidence: {
        turnActive: turnLiveness.active,
        hasInFlightTurn: turnLiveness.hasInFlightTurn,
        hasRunningSubagent: turnLiveness.hasRunningSubagent,
        sessionKey: turnLiveness.sessionKey,
        gateId: verdict.gateId,
      },
    };
  }

  // AC 10: working state + delegate=null → delegate-nulled (AI-1395)
  // Distinguished from AC 3 (wrong-target) by empty `actual` field.
  const wt = dispatch.wrongTarget;
  if (wt?.flagged === true && wt.actual === "") {
    return {
      failureClass: "delegate-nulled",
      isFailure: true,
      evidence: {
        wrongTargetFlagged: true,
        expected: wt.expected,
        actual: wt.actual,
        reason: wt.reason,
        delegateAtDispatch: wt.delegateAtDispatch,
        gateId: verdict.gateId,
      },
    };
  }

  // Parse verdict.detail once for AC 13 and AC 11 checks
  const detail = parseDetail(verdict.detail);

  // AC 13: explicit needs-human/gate/break-glass marker → healthy-suppressed:blocked (NOT a failure)
  if (detail) {
    const marker = detail["marker"];
    if (typeof marker === "string" && BLOCKING_MARKERS.has(marker)) {
      return {
        failureClass: "healthy-suppressed-blocked",
        isFailure: false,
        evidence: {
          marker,
          detail: verdict.detail,
          gateId: verdict.gateId,
        },
      };
    }
  }

  // AC 11: hard side-effect present (merged PR/pushed branch) + no verb → verb-not-sent
  if (detail && (detail["mergedPR"] !== undefined || detail["pushedBranch"] !== undefined)) {
    return {
      failureClass: "verb-not-sent",
      isFailure: true,
      evidence: {
        mergedPR: detail["mergedPR"],
        pushedBranch: detail["pushedBranch"],
        detail: verdict.detail,
        gateId: verdict.gateId,
      },
    };
  }

  // AC 9: alive + no in-flight turn + incomplete → stuck (subagent-return-gap)
  return {
    failureClass: "stuck",
    isFailure: true,
    evidence: {
      sessionHealthy: true,
      turnActive: turnLiveness.active,
      hasInFlightTurn: turnLiveness.hasInFlightTurn,
      hasRunningSubagent: turnLiveness.hasRunningSubagent,
      gateId: verdict.gateId,
      expectedSignal: verdict.expectedSignal,
    },
  };
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Classify a contract-breach failure from a health verdict and liveness snapshot.
 *
 * Pure and deterministic: the same inputs always produce the same output.
 * Does not mutate inputs or produce side effects.
 */
export function classifyFailure(
  verdict: HealthVerdict,
  snapshot: LivenessSnapshot,
): FailureClassification {
  if (verdict.gateId === "dispatched") {
    return classifyGate1(verdict, snapshot);
  }
  if (verdict.gateId === "picked-up") {
    return classifyGate2(verdict, snapshot);
  }

  // Unhandled gate — return a generic stuck classification.
  // Current tests only cover Gate 1 ("dispatched") and Gate 2 ("picked-up").
  return {
    failureClass: "stuck",
    isFailure: true,
    evidence: {
      gateId: verdict.gateId,
      reason: "unhandled-gate",
      contractLabel: verdict.contractLabel,
    },
  };
}
