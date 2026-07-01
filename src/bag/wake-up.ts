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
import { normalizeSessionKey } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";
import { fetchWorkflowLabels, loadWorkflowDefById, type WorkflowDef } from "../workflow-gate.js";

const log = componentLogger(createLogger(), "wakeup");

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

/**
 * Workflow context for a governed single-ticket wake-up (AI-1669).
 * When provided to buildWakeUpMessage, the delivery message includes the
 * current workflow state and the legal command set for that state.
 */
export interface WorkflowTicketContext {
  workflowId: string;
  state: string;
  legalVerbs: string[];
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

/** Strip the `linear-` session-key prefix so the CLI gets plain identifiers (e.g. FCY-502). */
const STRIP_LINEAR_PREFIX = /^linear-/i;

/**
 * Collect the legal command verbs for a given state in a workflow definition.
 * Returns the state's transition commands plus the break_glass verb.
 * Falls back to just the break_glass verb for unknown or terminal states.
 */
export function getLegalVerbsForState(def: WorkflowDef, stateId: string): string[] {
  const state = def.states.find((s) => s.id === stateId);
  const verbs: string[] = (state?.transitions ?? []).map((t) => t.command);
  if (def.break_glass?.command && !verbs.includes(def.break_glass.command)) {
    verbs.push(def.break_glass.command);
  }
  return verbs;
}

/**
 * Build the wake-up message text for a set of pending ticket IDs.
 * Exported for unit testing; delivery callers use sendWakeUpSignal.
 *
 * When a WorkflowTicketContext is provided as the second argument, the message
 * includes the workflow state name and legal command set (governed ticket path).
 * When handoffCtx is provided, the prior delegate's comment is prepended so
 * the next agent has full context even if the comment hasn't landed in Linear.
 */
export function buildWakeUpMessage(
  ticketIds: string[],
  signalTemplateOrCtx?: string | WorkflowTicketContext,
  handoffCtx?: HandoffContext | null,
): string {
  const count = ticketIds.length;
  // Ticket IDs stored in the pending bag are in session-key format (linear-FCY-502).
  // The CLI expects plain identifiers (FCY-502), so strip the prefix.
  const plainIds = ticketIds.map(id => id.replace(STRIP_LINEAR_PREFIX, ""));
  const tickets = plainIds.join(", ");

  // Governed ticket path: second argument is a WorkflowTicketContext object.
  if (
    signalTemplateOrCtx !== null &&
    typeof signalTemplateOrCtx === "object" &&
    "workflowId" in signalTemplateOrCtx
  ) {
    const ctx = signalTemplateOrCtx as WorkflowTicketContext;
    const ticketId = plainIds[0] ?? tickets;
    return (
      `You have 1 pending ticket: ${ticketId} (workflow: ${ctx.workflowId}, state: ${ctx.state}). ` +
      `This is a governed workflow step — only the following commands are available: ${ctx.legalVerbs.join(", ")}. ` +
      `Run \`linear consider-work ${ticketId}\` to begin.`
    );
  }

  const signalTemplate = typeof signalTemplateOrCtx === "string" ? signalTemplateOrCtx : undefined;
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
 * Build a wake-up message that includes workflow context when the ticket is governed.
 *
 * For a single governed ticket (has wf:* and state:* labels), fetches the ticket's
 * labels, resolves the workflow def and current state, collects the legal verb set,
 * and injects all of that into the delivery message. All other cases (multi-ticket,
 * no auth token, ad-hoc ticket, fetch error, unknown state) fall back to the
 * generic buildWakeUpMessage output unchanged.
 */
export async function buildWorkflowAwareWakeUpMessage(
  ticketIds: string[],
  authToken?: string,
): Promise<string> {
  if (ticketIds.length !== 1 || !authToken) {
    return buildWakeUpMessage(ticketIds);
  }

  const plainId = ticketIds[0].replace(STRIP_LINEAR_PREFIX, "");

  try {
    const labels = await fetchWorkflowLabels(plainId, authToken);

    const wfLabel = labels.find((l) => l.startsWith("wf:"));
    const stateLabel = labels.find((l) => l.startsWith("state:"));

    if (!wfLabel || !stateLabel) {
      return buildWakeUpMessage(ticketIds);
    }

    const workflowId = wfLabel.slice(3);
    const stateId = stateLabel.slice(6);

    const def = await loadWorkflowDefById(workflowId);
    if (!def) {
      return buildWakeUpMessage(ticketIds);
    }

    const state = def.states.find((s) => s.id === stateId);
    if (!state) {
      return buildWakeUpMessage(ticketIds);
    }

    const legalVerbs = getLegalVerbsForState(def, stateId);

    return buildWakeUpMessage([plainId], { workflowId, state: stateId, legalVerbs });
  } catch {
    return buildWakeUpMessage(ticketIds);
  }
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
): Promise<{ runId?: string } | void> {
  let message: string;

  if (ticketIds.length === 1 && config.linearAuthToken) {
    const plainId = ticketIds[0].replace(/^linear-/i, "");
    const rich = await buildWorkflowAwareDeliveryMessage(plainId, config.linearAuthToken);
    if (rich) {
      message = rich;
      log.info(`Rich workflow delivery for ${agentId} [${plainId}]`);
    } else {
      message = buildWakeUpMessage(ticketIds, config.signalTemplate);
    }
  } else {
    message = buildWakeUpMessage(ticketIds, config.signalTemplate);
  }

  // Normalize to strip any legacy prefixes and enforce uppercase.
  // Result is always exactly `linear-<TEAM>-<NUMBER>`.
  const sessionKey = normalizeSessionKey(ticketIds[0]);

  log.info(`Sending wake-up signal to ${agentId}: ${ticketIds.length} ticket(s) [${ticketIds.join(", ")}]`);

  try {
    const result: DeliveryResult = await deliverMessageToAgent(agentId, sessionKey, message, config);
    if (!result.dispatched) {
      throw new Error(result.hookErrorSummary ?? "wake-up delivery was not accepted");
    }
    return result.runId ? { runId: result.runId } : undefined;
  } catch (err) {
    log.error(
      `Wake-up signal failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`
    );
    throw err;
  }
}
