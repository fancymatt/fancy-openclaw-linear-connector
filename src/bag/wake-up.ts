/**
 * Wake-up signal delivery.
 *
 * Sends a thin "you have N pending tickets" message to an agent when the bag
 * has work for them and they're not in an active session. The agent then uses
 * `linear consider-work <ID>` (single ticket) or `linear queue --next` /
 * `linear queue` (multiple tickets) to fetch and process work in priority order.
 *
 * NOTE: The session key uses the ticket's `linear-<IDENTIFIER>` format (e.g.
 * `linear-ILL-148`) so that the wake-up session shares context with any
 * subsequent webhook events for the same ticket. For multi-ticket wake-ups,
 * the first ticket's identifier is used as the key.
 */

import { deliverMessageToAgent, type DeliveryConfig, type DeliveryResult } from "../delivery/index.js";
import { buildWorkflowAwareDeliveryMessage } from "../delivery/build-message.js";
import { loadUniversalCanon, formatCanonBlock, getActiveCanonVersion, type CanonLoadResult } from "../policy/universal-canon.js";
import { normalizeSessionKey } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";
import { randomUUID } from "node:crypto";

const log = componentLogger(createLogger(), "wakeup");

/**
 * AI-2008: minimal structural interface for the acknowledged-delivery front door
 * (DispatchDeliveryScheduler). Declared here rather than imported to keep
 * wake-up delivery free of a hard dependency on the scheduler module.
 */
export interface WakeDeliveryScheduler {
  dispatch(params: {
    agentId: string;
    ticketId: string;
    workflowState?: string;
    gateway?: string;
    dispatchId: string;
    deliver: (ctx: { attempt: number; dispatchId: string }) => Promise<DeliveryResult>;
    maxRetries?: number;
    backoffMs?: (attempt: number) => number;
  }): Promise<{ status: "delivered" | "delivered-pending-ack" | "undeliverable"; attempts: number; dispatchId: string }>;
}

export interface WakeUpConfig extends DeliveryConfig {
  /** Signal message template. {count} and {tickets} are replaced. */
  signalTemplate?: string;
  /**
   * Linear auth token for the agent receiving the wake-up.
   * When provided and ticketIds.length === 1, the wake-up message is replaced
   * with the same rich per-step workflow instruction block that event-driven
   * delegation produces — so agents get full context upfront instead of a thin
   * "run consider-work" prompt that is blocked on workflow tickets.
   */
  linearAuthToken?: string;
  /**
   * AI-2008: when present, the wake is delivered through the acknowledged
   * retry/loud-failure layer instead of a single fire-and-forget attempt.
   * Every dispatch then records a delivery outcome, retries on failure, and
   * emits a `dispatch-undeliverable` warning on exhaustion. Injected by the
   * production bootstrap (createApp); absent in isolated unit tests, which keep
   * the legacy single-attempt path.
   */
  deliveryScheduler?: WakeDeliveryScheduler;
  /** AI-2008: gateway/host the delegate runs on, named in the undeliverable warning. */
  gateway?: string;
  /** AI-2008: workflow state at dispatch time, recorded on delivery outcomes. */
  workflowState?: string;
}

export const SINGLE_TICKET_TEMPLATE =
  "You have 1 pending ticket: {tickets}. Run `linear consider-work {tickets}` to begin.";

export const MULTI_TICKET_TEMPLATE =
  "You have {count} pending ticket(s) waiting: {tickets}. Run `linear queue --next` to pick up the highest-priority one, or `linear queue` to see all.";

// Used when the trigger is a mention/body-mention rather than a delegation.
// Agents should observe (not own) mention-triggered tickets.
export const MENTION_TICKET_TEMPLATE =
  "You have been @mentioned on ticket: {tickets}. Run `linear observe-issue {tickets}` to review.";

/**
 * Context from the prior delegate's handoff comment, bundled into the wake-up
 * message so the next agent sees it even if the comment hasn't landed in Linear
 * yet (fixes the same-second dispatch race documented in AI-1673).
 */
export interface HandoffContext {
  /** Display name of the agent who handed off the ticket. */
  delegateName: string;
  /** The handoff comment body. */
  comment: string;
  /** Age of the comment in milliseconds at dispatch time (0 = same-second race). */
  ageMs: number;
}

function formatHandoffAge(ageMs: number): string {
  if (ageMs < 1000) return "just now";
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

/**
 * Build the wake-up message text for a set of pending ticket IDs.
 * Exported for unit testing; delivery callers use sendWakeUpSignal.
 *
 * When handoffCtx is provided, the prior delegate's comment is prepended so
 * the next agent has full context even if the comment hasn't landed in Linear.
 */
/** Strip the `linear-` session-key prefix so the CLI gets plain identifiers (e.g. FCY-502). */
const STRIP_LINEAR_PREFIX = /^linear-/i;

export function buildWakeUpMessage(
  ticketIds: string[],
  signalTemplate?: string,
  handoffCtx?: HandoffContext | null,
): string {
  const count = ticketIds.length;
  // Ticket IDs stored in the pending bag are in session-key format (linear-FCY-502).
  // The CLI expects plain identifiers (FCY-502), so strip the prefix.
  const plainIds = ticketIds.map(id => id.replace(STRIP_LINEAR_PREFIX, ""));
  const tickets = plainIds.join(", ");
  const defaultTemplate = count === 1 ? SINGLE_TICKET_TEMPLATE : MULTI_TICKET_TEMPLATE;
  const base = (signalTemplate ?? defaultTemplate)
    .replace(/\{count\}/g, String(count))
    .replace(/\{tickets\}/g, tickets);

  if (!handoffCtx) return base;

  const age = formatHandoffAge(handoffCtx.ageMs);
  const preamble = `Latest from previous delegate (${handoffCtx.delegateName}, ${age}): "${handoffCtx.comment}"`;
  return `${preamble}\n\n${base}`;
}

/**
 * Send a wake-up signal to an agent.
 *
 * For single-ticket workflow dispatches where a linearAuthToken is available,
 * the message is upgraded to the same rich per-step instruction block that
 * event-driven delegation produces. For multi-ticket dispatches or ad-hoc tickets,
 * falls back to the thin template.
 */
export async function sendWakeUpSignal(
  agentId: string,
  ticketIds: string[],
  config: WakeUpConfig,
): Promise<{ runId?: string; canonVersion?: string } | void> {
  let message: string;
  let canonVersion: string | null = null;

  if (ticketIds.length === 1 && config.linearAuthToken) {
    const plainId = ticketIds[0].replace(/^linear-/i, "");
    const rich = await buildWorkflowAwareDeliveryMessage(plainId, config.linearAuthToken);
    if (rich) {
      // buildWorkflowAwareDeliveryMessage already injects the canon via withCanonBlock.
      message = rich;
      canonVersion = getActiveCanonVersion();
      log.info(`Rich workflow delivery for ${agentId} [${plainId}]`);
    } else {
      message = buildWakeUpMessage(ticketIds, config.signalTemplate);
    }
  } else {
    message = buildWakeUpMessage(ticketIds, config.signalTemplate);
  }

  // AI-1848 fix: inject canon into thin-template wake messages (multi-ticket,
  // ad-hoc, mention). buildWorkflowAwareDeliveryMessage already handles canon
  // for the rich workflow path above.
  if (!canonVersion) {
    const canon = await loadUniversalCanon();
    if (canon) {
      const block = formatCanonBlock(canon.text, canon.version);
      if (block) {
        message = message + block;
        canonVersion = canon.version;
      }
    }
  }

  // Normalize to strip any legacy prefixes and enforce uppercase.
  // Result is always exactly `linear-<TEAM>-<NUMBER>`.
  const sessionKey = normalizeSessionKey(ticketIds[0]);

  log.info(`Sending wake-up signal to ${agentId}: ${ticketIds.length} ticket(s) [${ticketIds.join(", ")}]`);

  try {
    const deliverOnce = (): Promise<DeliveryResult> =>
      deliverMessageToAgent(agentId, sessionKey, message, config);

    // AI-2008: on the production path a scheduler is injected, so the wake goes
    // through the acknowledged retry/loud-failure layer — no fire-and-forget.
    if (config.deliveryScheduler) {
      const outcome = await config.deliveryScheduler.dispatch({
        agentId,
        ticketId: sessionKey,
        workflowState: config.workflowState,
        gateway: config.gateway,
        dispatchId: `wake-${sessionKey}-${randomUUID()}`,
        deliver: deliverOnce,
        // Honor the delivery config's retry bound so the test env (maxRetries: 0)
        // keeps single-attempt semantics; production leaves it undefined so the
        // scheduler applies its bounded backoff default.
        maxRetries: config.maxRetries,
      });
      if (outcome.status === "undeliverable") {
        throw new Error(
          `wake-up delivery undeliverable after ${outcome.attempts} attempt(s)`,
        );
      }
      return { canonVersion: canonVersion ?? undefined };
    }

    const result: DeliveryResult = await deliverOnce();
    if (!result.dispatched) {
      throw new Error(result.hookErrorSummary ?? "wake-up delivery was not accepted");
    }
    return { runId: result.runId, canonVersion: canonVersion ?? undefined };
  } catch (err) {
    log.error(
      `Wake-up signal failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`
    );
    throw err;
  }
}
