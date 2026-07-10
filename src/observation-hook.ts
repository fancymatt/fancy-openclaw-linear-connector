/**
 * AI-2036 — The transition-handler hook that writes one observation row per
 * feedback-required transition.
 *
 * Root cause it fixes (AC1.1)
 * ---------------------------
 * P4-1 (AI-1378) shipped the *reader* of two headers — `X-Openclaw-Feedback-
 * Category` and `X-Openclaw-From-Body` — but no client ever sent either one.
 * The proxy only built a `feedback` payload when the category header was
 * present, so `options.feedback` was always undefined, the whole observation
 * block short-circuited, and not even the `fromBody` warn inside it ever fired.
 * The store recorded 0 rows for its entire life, silently.
 *
 * The fix is to stop requiring a client to tell the connector what the connector
 * already knows. Both fields are now *derived* server-side, with the headers
 * kept as the highest-priority source so a future CLI that sends them wins:
 *
 *   from_body   ← header → resolved destination delegate → implementer store
 *   reason_code ← header → `Category:` directive in the comment → `unspecified`
 *
 * The destination delegate of a feedback transition IS the implementer: every
 * feedback-required transition in the canonical defs routes back to the worker
 * state. That derivation is exact, which retires the original author's reason
 * for skipping (`from_body == reviewer_body` producing useless data).
 *
 * Nothing here can block a transition. Every path — written, degraded, skipped —
 * is counted and mirrored to operational_events (AC1.3).
 */

import {
  DEGRADED_REASON_CODE,
  ObservationStore,
  REASON_CODES,
  type StoredReasonCode,
} from "./store/observation-store.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";
import {
  countObservationAppended,
  countObservationSkip,
  type ObservationSkipReason,
} from "./observation-wiring.js";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "observation-hook");

/**
 * Inline category directive a reviewer can put in the request-changes comment,
 * e.g. `Category: missing-tests` or `Reason: correctness`. Anchored to its own
 * line so prose that merely mentions a code cannot hijack the classification.
 */
const CATEGORY_DIRECTIVE = /^[ \t>*_-]*(?:category|reason[ _-]?code|reason)\s*:\s*([a-z][a-z-]*)\s*$/im;

/**
 * Extract a reviewer-declared category from a comment body.
 * Returns null when absent or not legal for this transition.
 */
export function parseReasonCodeFromComment(
  text: string | null | undefined,
  allowed: readonly string[],
): string | null {
  if (!text) return null;
  const match = CATEGORY_DIRECTIVE.exec(text);
  if (!match) return null;
  const candidate = match[1].toLowerCase();
  return allowed.includes(candidate) ? candidate : null;
}

export interface FeedbackObservationContext {
  /** Ticket identifier, e.g. "AI-2036". */
  issueId: string;
  /** Workflow ID, e.g. "dev-impl". */
  workflowId: string;
  /** The state the feedback was given FROM, e.g. "code-review". */
  step: string;
  /** The reviewer that issued the transition. */
  reviewerBody: string;
  /**
   * Categories legal for this transition, from the def's `feedback.category_enum`.
   * Falls back to the full REASON_CODES enum when the def omits it.
   */
  allowedCategories?: readonly string[];
  /** Reviewer-supplied category (X-Openclaw-Feedback-Category), if any. */
  rawReasonCode?: string | null;
  /** The comment body carrying the feedback. Also searched for a directive. */
  freeText?: string | null;
  /**
   * Implementer candidates in priority order; the first non-empty one wins.
   * Production order: header, resolved destination delegate, implementer store.
   */
  fromBodyCandidates: Array<string | null | undefined>;
  /** Dispatch-cycle correlation id, when known (AC1.4). */
  wakeId?: string | null;
  /** The registered store. Absent ⇒ a counted `store-unwired` skip. */
  observationStore?: ObservationStore;
  /** Telemetry sink. Absent ⇒ log-only (counters still increment). */
  operationalEventStore?: OperationalEventStore;
}

export type FeedbackObservationResult =
  | { written: true; id: number; reasonCode: StoredReasonCode; degraded: boolean; fromBody: string }
  | { written: false; skipReason: ObservationSkipReason };

/**
 * Write one observation row for a feedback-required transition.
 *
 * Never throws — a failed observation must never block a state transition.
 */
export function recordFeedbackObservation(
  ctx: FeedbackObservationContext,
): FeedbackObservationResult {
  const allowed = ctx.allowedCategories?.length ? ctx.allowedCategories : REASON_CODES;

  const skip = (skipReason: ObservationSkipReason, detail: Record<string, unknown>): FeedbackObservationResult => {
    countObservationSkip(skipReason);
    log.warn(
      `observation skipped for ${ctx.issueId} (${ctx.workflowId}/${ctx.step}): ${skipReason}`,
    );
    emit(ctx, "observation-skipped", { skipReason, ...detail });
    return { written: false, skipReason };
  };

  if (!ctx.observationStore) {
    // The AI-1773/AI-1775 failure mode, now loud: the write path exists but
    // nothing at bootstrap handed it a store.
    return skip("store-unwired", {});
  }

  // ── from_body ────────────────────────────────────────────────────────
  const fromBody = ctx.fromBodyCandidates.find((c) => typeof c === "string" && c.length > 0);
  if (!fromBody) {
    return skip("from-body-unresolved", { reviewerBody: ctx.reviewerBody });
  }

  // ── reason_code ──────────────────────────────────────────────────────
  // An illegal reviewer-supplied category degrades rather than drops the row:
  // (ticket, workflow, step, from_body) is worth keeping even when the category
  // is unusable, and the degraded write is counted so the gap stays visible.
  let reasonCode: StoredReasonCode = DEGRADED_REASON_CODE;
  let degraded = true;
  let rejectedReasonCode: string | null = null;

  const raw = ctx.rawReasonCode?.trim().toLowerCase() || null;
  if (raw && allowed.includes(raw)) {
    reasonCode = raw as StoredReasonCode;
    degraded = false;
  } else {
    if (raw) rejectedReasonCode = raw;
    const fromComment = parseReasonCodeFromComment(ctx.freeText, allowed);
    if (fromComment) {
      reasonCode = fromComment as StoredReasonCode;
      degraded = false;
    }
  }

  // ── append ───────────────────────────────────────────────────────────
  let id: number;
  try {
    id = ctx.observationStore.append({
      ticket: ctx.issueId,
      workflow: ctx.workflowId,
      step: ctx.step,
      fromBody,
      reviewerBody: ctx.reviewerBody,
      reasonCode,
      freeText: ctx.freeText ?? null,
      wakeId: ctx.wakeId ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return skip("write-failed", { error: msg });
  }

  countObservationAppended(degraded);
  log.info(
    `observation recorded id=${id} ticket=${ctx.issueId} workflow=${ctx.workflowId} ` +
    `step=${ctx.step} reason=${reasonCode} from=${fromBody}${degraded ? " (degraded)" : ""}`,
  );

  if (degraded) {
    // Counted and visible: the row landed, but no reviewer category reached us.
    log.warn(
      `observation degraded for ${ctx.issueId}: no legal category supplied ` +
      `(reason_code=${DEGRADED_REASON_CODE})${rejectedReasonCode ? `, rejected='${rejectedReasonCode}'` : ""}`,
    );
    emit(ctx, "observation-degraded", { id, reasonCode, rejectedReasonCode, fromBody });
  } else {
    emit(ctx, "observation-written", { id, reasonCode, fromBody });
  }

  return { written: true, id, reasonCode, degraded, fromBody };
}

function emit(
  ctx: FeedbackObservationContext,
  outcome: "observation-written" | "observation-degraded" | "observation-skipped",
  detail: Record<string, unknown>,
): void {
  if (!ctx.operationalEventStore) return;
  try {
    ctx.operationalEventStore.append({
      outcome,
      type: "observation",
      agent: ctx.reviewerBody,
      key: ctx.issueId,
      workflowState: ctx.step,
      plane: "connector",
      wakeId: ctx.wakeId ?? null,
      detail: { workflow: ctx.workflowId, ...detail },
    });
  } catch (err) {
    // Telemetry must never break the write path it is observing.
    log.warn(
      `failed to emit ${outcome} event for ${ctx.issueId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
