/**
 * Shared types for health verdicts — consumed by contract engine (INF-317),
 * failure classifier (INF-318), remediation actor (INF-319), and web UI (INF-320).
 *
 * Child of INF-315 (Dispatch Lifecycle Health Model).
 */

/** Identifies a specific lifecycle gate. */
export type GateId = "dispatched" | "picked-up" | "in-progress" | "done";

/** The health status of a lifecycle edge. */
export type HealthStatus =
  | "healthy"
  | "healthy-suppressed-queued"
  | "healthy-suppressed-working"
  | "healthy-suppressed-blocked"
  | "unhealthy-breach";

/** Signal from liveness infrastructure (INF-316). */
export interface LivenessSignal {
  type: "dispatch-ack" | "session-health" | "turn-liveness";
  timestamp: number;
  detail?: Record<string, unknown>;
}

/** Structured health verdict for one gate. */
export interface HealthVerdict {
  gateId: GateId;
  status: HealthStatus;
  contractLabel: string;
  expectedSignal: string;
  deadlineMs: number;
  actualElapsedMs: number | null;
  breached: boolean;
  suppressed?: boolean;
  suppressionReason?: "queued" | "working" | "blocked";
  detail?: string;
}

/** Shape of the expected signal type on a lifecycle edge. */
export type SignalType =
  | "consider-work"
  | "Thinking"
  | "verb"
  | "comment"
  | "turn-active"
  | "subagent-active";
