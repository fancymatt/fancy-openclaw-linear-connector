/**
 * INF-320 — Remediation actor.
 *
 * Given a typed failure_class, resolves the mapped remediation action,
 * honors the AUTO-vs-CONFIRM policy, applies retry caps, and returns a
 * structured result for recording and observability.
 *
 * Design:
 *  - Pure policy logic: action side-effects (re-fire dispatch, retry delivery,
 *    probe gateway, etc.) are NOT executed here. The caller (or a downstream
 *    handler) interprets the returned RemediationAction and invokes the real
 *    I/O. This keeps the actor testable without mocking the entire connector.
 *  - Retry cap applies to AUTO actions only. CONFIRM-class actions always
 *    surface as `confirm-required` regardless of attemptCount.
 *  - `healthy-suppressed:*` is exempt from everything — always no-action.
 */

import { createLogger, componentLogger } from "../logger.js";
import type {
  FailureClass,
  RemediationAction,
  RemediationActionKind,
  RemediationClass,
  RemediationConfig,
  RemediationContext,
  RemediationOutcome,
  RemediationResult,
} from "./remediation-types.js";

const log = componentLogger(createLogger(), "remediation-actor");

// ── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;

// ── Failure-to-action mappings ─────────────────────────────────────────────

/**
 * Resolve the mapped action kind and action class for a given failure_class.
 * Returns null for healthy-suppressed (which gets special treatment).
 */
function resolveActionMapping(
  fc: FailureClass,
): { actionKind: RemediationActionKind; actionClass: RemediationClass } | null {
  switch (fc.type) {
    case "connector-didnt-fire":
      return { actionKind: "re-fire-dispatch", actionClass: "AUTO" };
    case "delivery-failed":
      return { actionKind: "retry-delivery-and-probe-gateway", actionClass: "AUTO" };
    case "wrong-target":
      return { actionKind: "re-resolve-session-key-and-redispatch", actionClass: "AUTO" };
    case "behavioral-noop":
      return { actionKind: "redispatch-with-stronger-prompt", actionClass: "AUTO" };
    case "stuck":
      return { actionKind: "re-wake-agent", actionClass: "AUTO" };
    case "delegate-nulled":
      return { actionKind: "re-seat-delegate-and-redispatch", actionClass: "AUTO" };
    case "verb-not-sent":
      if (fc.hasSideEffectEvidence) {
        return { actionKind: "auto-advance", actionClass: "AUTO" };
      }
      return { actionKind: "nudge-for-verb", actionClass: "CONFIRM" };
    case "agent-broken":
    case "agent-broke-mid-task":
      return { actionKind: "restart-session", actionClass: "CONFIRM" };
    case "token-401":
      return { actionKind: "refresh-token", actionClass: "AUTO" };
    case "healthy-suppressed":
      // healthy-suppressed is exempt from all policy; special-handled in executeRemediation.
      return null;
    default:
      // Defensive: unknown failure class — treat as no-action.
      return { actionKind: "no-action", actionClass: "AUTO" };
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Execute the remediation policy for a given failure_class.
 *
 * @param failureClass - The typed failure classification.
 * @param context - Remediation context including retry state.
 * @returns A RemediationResult with the resolved action, outcome, and metadata.
 */
export async function executeRemediation(
  failureClass: FailureClass,
  context: RemediationContext,
): Promise<RemediationResult> {
  const now = context.now?.() ?? new Date();
  const recordedAt = now.toISOString();
  const { ticketId, agentId, attemptCount, maxRetries } = context;

  // ── Special case: healthy-suppressed is always no-action, exempt from all policy ──
  if (failureClass.type === "healthy-suppressed") {
    const action: RemediationAction = { kind: "no-action" };
    return {
      action,
      actionClass: "AUTO",
      outcome: "no-action",
      recordedAt,
      failureClass: failureClass.type,
      attemptCount,
      context: { ticketId, agentId },
    };
  }

  // ── Resolve the action mapping ──────────────────────────────────────────────
  const mapping = resolveActionMapping(failureClass);
  if (!mapping) {
    // Unreachable for typed FailureClass (healthy-suppressed handled above),
    // but defensive fallback.
    const action: RemediationAction = { kind: "no-action" };
    return {
      action,
      actionClass: "AUTO",
      outcome: "no-action",
      recordedAt,
      failureClass: "unknown",
      attemptCount,
      context: { ticketId, agentId },
    };
  }

  const { actionKind, actionClass } = mapping;
  const action: RemediationAction = { kind: actionKind };

  // ── CONFIRM-class actions: never auto-executed, immune to retry caps ───
  if (actionClass === "CONFIRM") {
    return {
      action,
      actionClass,
      outcome: "confirm-required",
      recordedAt,
      failureClass: failureClass.type,
      attemptCount,
      context: { ticketId, agentId },
    };
  }

  // ── AUTO-class actions: retry-cap check ───────────────────────────────
  const cap = maxRetries ?? DEFAULT_MAX_RETRIES;
  if (attemptCount >= cap) {
    const escalateAction: RemediationAction = { kind: "escalate" };
    return {
      action: escalateAction,
      actionClass,
      outcome: "escalated",
      recordedAt,
      failureClass: failureClass.type,
      attemptCount,
      context: { ticketId, agentId },
    };
  }

  // ── AUTO action with room to retry ───────────────────────────────────
  return {
    action,
    actionClass,
    outcome: "executed",
    recordedAt,
    failureClass: failureClass.type,
    attemptCount,
    context: { ticketId, agentId },
  };
}

/**
 * Returns the current remediation configuration (retry cap, etc.).
 */
export function getRemediationConfig(): RemediationConfig {
  return {
    maxRetries: DEFAULT_MAX_RETRIES,
  };
}
