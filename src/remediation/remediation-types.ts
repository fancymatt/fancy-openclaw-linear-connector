/**
 * INF-320 — Remediation actor types.
 *
 * Discriminated union for failure_class, mapped remediation actions, context,
 * result, config, and health surfaces. Consumed by the remediation actor,
 * RemediationState store, and /health endpoint.
 *
 * The failure_class taxonomy is frozen in INF-315; every typed value here
 * has a corresponding AUTO or CONFIRM action in INF-315's action set.
 */

// ── FailureClass — discriminated union ─────────────────────────────────────

/** A "healthy" suppression carries a subtype describing the reason. */
export interface HealthySuppressedFailure {
  type: "healthy-suppressed";
  subtype: string;
}

/** verb-not-sent has a side-effect-evidence flag to gate auto-advance. */
export interface VerbNotSentFailure {
  type: "verb-not-sent";
  hasSideEffectEvidence: boolean;
}

/** All other failure classes carry only their type discriminator. */
export type SimpleFailureClass =
  | { type: "connector-didnt-fire" }
  | { type: "delivery-failed" }
  | { type: "wrong-target" }
  | { type: "behavioral-noop" }
  | { type: "stuck" }
  | { type: "delegate-nulled" }
  | { type: "agent-broken" }
  | { type: "agent-broke-mid-task" }
  | { type: "token-401" };

/**
 * Discriminated union of every known failure_class.
 * The classifier in INF-319 produces one of these values;
 * the remediation actor dispatches on `type`.
 */
export type FailureClass = SimpleFailureClass | VerbNotSentFailure | HealthySuppressedFailure;

// ── RemediationAction — mapped action kinds ────────────────────────────────

export type RemediationActionKind =
  | "re-fire-dispatch"
  | "retry-delivery-and-probe-gateway"
  | "re-resolve-session-key-and-redispatch"
  | "redispatch-with-stronger-prompt"
  | "re-wake-agent"
  | "re-seat-delegate-and-redispatch"
  | "auto-advance"
  | "nudge-for-verb"
  | "restart-session"
  | "refresh-token"
  | "no-action"
  | "escalate";

export interface RemediationAction {
  kind: RemediationActionKind;
}

// ── RemediationClass: AUTO vs CONFIRM ──────────────────────────────────────

export type RemediationClass = "AUTO" | "CONFIRM";

// ── Remediation outcome ────────────────────────────────────────────────────

export type RemediationOutcome =
  | "executed"
  | "escalated"
  | "confirm-required"
  | "no-action";

// ── Context — injected by the caller, carries retry state ──────────────────

export interface RemediationContext {
  /** Linear ticket identifier (e.g. "INF-320"). */
  ticketId: string;
  /** The agent that owns this ticket. */
  agentId: string;
  /** OpenClaw session key for redispatch. */
  sessionKey: string;
  /** Current attempt count (0-based). */
  attemptCount: number;
  /** Maximum retries before escalation (K). */
  maxRetries: number;
  /** Clock function — injectable for test determinism. */
  now: () => Date;
  /** Any additional context properties forwarded from the caller. */
  [key: string]: unknown;
}

// ── Result — returned by executeRemediation ────────────────────────────────

export interface RemediationResult {
  action: RemediationAction;
  actionClass: RemediationClass;
  outcome: RemediationOutcome;
  recordedAt: string;
  /** The string form of the failure_class type discriminator, for recording. */
  failureClass: string;
  /** The attemptCount at the time of execution, for recording. */
  attemptCount: number;
  context: Pick<RemediationContext, "ticketId" | "agentId">;
}

// ── Config — retry caps and classification ─────────────────────────────────

export interface RemediationConfig {
  maxRetries: number;
}

// ── Record — persisted observability entry ─────────────────────────────────

export interface RemediationRecord {
  actionKind: RemediationActionKind;
  actionClass: RemediationClass;
  failureClass: string;
  outcome: RemediationOutcome;
  timestamp: string;
  attemptCount: number;
  ticketId: string;
}

// ── Health — /health liveness surface ──────────────────────────────────────

export interface RemediationHealth {
  armed: boolean;
  totalActions: number;
  recentActions: RemediationRecord[];
}
