/**
 * Health classifier — maps gate actuals against contract definitions.
 *
 * Child of INF-317 (Contract Engine).
 */

import type { GateId, HealthStatus, HealthVerdict, LivenessSignal } from "./health-types.js";
import type { LifecycleContract, SuppressionRule } from "./contract-definitions.js";

export interface SignalInput {
  gateEnteredAt: number;
  signals: LivenessSignal[];
  queueDepth?: number;
  hasActiveTurn?: boolean;
  isBlocked?: boolean;
}

export interface ClassifyResult {
  gateId: GateId;
  verdict: HealthVerdict;
}

/**
 * Check whether the expected signal was received within the contract's deadline.
 */
function hasExpectedSignal(
  contract: LifecycleContract,
  signals: LivenessSignal[],
  gateEnteredAt: number,
  deadlineMs: number,
): boolean {
  const deadline = gateEnteredAt + deadlineMs;
  for (const signal of signals) {
    if (signal.timestamp <= deadline) {
      // For dispatched gate, look for "Thinking" signal type in session-health
      if (contract.gateId === "dispatched") {
        if (
          signal.type === "session-health" &&
          signal.detail?.signalType === "Thinking"
        ) {
          return true;
        }
        continue;
      }
      // For picked-up gate, any session-health or turn-liveness within deadline
      // counts as activity (verb/comment)
      if (contract.gateId === "picked-up") {
        if (
          signal.type === "session-health" ||
          signal.type === "turn-liveness"
        ) {
          return true;
        }
        continue;
      }
      // Generic match: signal type matches expected signal
      if (signal.detail?.signalType === contract.expectedSignal) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if any suppression rule applies and return the suppression reason.
 * Rules are evaluated in order; the first matching rule wins.
 *
 * Returns null if no suppression applies.
 */
function checkSuppression(
  rules: SuppressionRule[],
  elapsedMs: number,
  input: SignalInput,
): { status: HealthStatus; reason: "queued" | "working" | "blocked" } | null {
  for (const rule of rules) {
    if (rule.condition === "queued") {
      const queueDepth = input.queueDepth ?? 0;
      if (queueDepth === 0) continue; // Not queued

      const maxDepth = rule.maxDepth ?? Infinity;
      if (queueDepth > maxDepth) continue; // Depth exceeds limit

      const maxAgeMs = rule.maxAgeMs;
      if (maxAgeMs !== undefined && elapsedMs > maxAgeMs) continue; // Age exceeds limit

      // All constraints satisfied
      return { status: "healthy-suppressed-queued", reason: "queued" };
    }

    if (rule.condition === "working") {
      if (input.hasActiveTurn === true) {
        return { status: "healthy-suppressed-working", reason: "working" };
      }
    }

    if (rule.condition === "blocked") {
      if (input.isBlocked === true) {
        return { status: "healthy-suppressed-blocked", reason: "blocked" };
      }
    }
  }

  return null;
}

/**
 * Classify the health of a lifecycle gate based on the contract and observed signals.
 */
export function classifyGateHealth(
  contract: LifecycleContract,
  input: SignalInput,
): ClassifyResult {
  const now = Date.now();
  const elapsedMs = now - input.gateEnteredAt;

  // Check if expected signal was received within deadline
  const signalReceived = hasExpectedSignal(contract, input.signals, input.gateEnteredAt, contract.deadlineMs);

  // If expected signal present within deadline, always healthy (even if we're past deadline)
  if (signalReceived) {
    const verdict: HealthVerdict = {
      gateId: contract.gateId,
      status: "healthy",
      contractLabel: contract.label,
      expectedSignal: contract.expectedSignal,
      deadlineMs: contract.deadlineMs,
      actualElapsedMs: elapsedMs,
      breached: false,
    };
    return { gateId: contract.gateId, verdict };
  }

  // Not yet past deadline — healthy (no breach, no suppression needed)
  if (elapsedMs <= contract.deadlineMs) {
    const verdict: HealthVerdict = {
      gateId: contract.gateId,
      status: "healthy",
      contractLabel: contract.label,
      expectedSignal: contract.expectedSignal,
      deadlineMs: contract.deadlineMs,
      actualElapsedMs: elapsedMs,
      breached: false,
    };
    return { gateId: contract.gateId, verdict };
  }

  // Past deadline without expected signal — check suppression rules in order
  if (contract.suppression.length > 0) {
    const suppression = checkSuppression(contract.suppression, elapsedMs, input);
    if (suppression !== null) {
      const verdict: HealthVerdict = {
        gateId: contract.gateId,
        status: suppression.status,
        contractLabel: contract.label,
        expectedSignal: contract.expectedSignal,
        deadlineMs: contract.deadlineMs,
        actualElapsedMs: elapsedMs,
        breached: true,
        suppressed: true,
        suppressionReason: suppression.reason,
        detail: `Suppressed by ${suppression.reason} condition`,
      };
      return { gateId: contract.gateId, verdict };
    }
  }

  // Unhealthy breach — no suppression applies
  const verdict: HealthVerdict = {
    gateId: contract.gateId,
    status: "unhealthy-breach",
    contractLabel: contract.label,
    expectedSignal: contract.expectedSignal,
    deadlineMs: contract.deadlineMs,
    actualElapsedMs: elapsedMs,
    breached: true,
  };
  return { gateId: contract.gateId, verdict };
}
