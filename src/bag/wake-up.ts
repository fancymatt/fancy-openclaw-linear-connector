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
 *
 * AI-1659: For single-ticket wake-ups of governed workflow tickets, a preamble
 * listing the current state and legal verb set is prepended to the thin message.
 * This ensures agents start with workflow context before running consider-work.
 */

import { deliverMessageToAgent, type DeliveryConfig, type DeliveryResult } from "../delivery/index.js";
import { normalizeSessionKey } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";
import {
  fetchWorkflowLabels,
  getWorkflowId,
  loadWorkflowDefById,
  getCurrentState,
  resolveTransitionTargets,
} from "../workflow-gate.js";

const log = componentLogger(createLogger(), "wakeup");

export interface WakeUpConfig extends DeliveryConfig {
  /** Signal message template. {count} and {tickets} are replaced. */
  signalTemplate?: string;
  /**
   * AI-1659: Linear OAuth token for the agent receiving the wake-up.
   * When provided for a single-ticket wake-up, the connector fetches workflow
   * context and prepends a state + legal-verb preamble to the thin message.
   * Format: "Bearer <token>" or raw token (normalized internally).
   * Omit to send the thin template unchanged (non-workflow or no-auth case).
   */
  authToken?: string;
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
 * Build the wake-up message text for a set of pending ticket IDs.
 * Exported for unit testing; delivery callers use sendWakeUpSignal.
 */
/** Strip the `linear-` session-key prefix so the CLI gets plain identifiers (e.g. FCY-502). */
const STRIP_LINEAR_PREFIX = /^linear-/i;

export function buildWakeUpMessage(ticketIds: string[], signalTemplate?: string): string {
  const count = ticketIds.length;
  // Ticket IDs stored in the pending bag are in session-key format (linear-FCY-502).
  // The CLI expects plain identifiers (FCY-502), so strip the prefix.
  const plainIds = ticketIds.map(id => id.replace(STRIP_LINEAR_PREFIX, ""));
  const tickets = plainIds.join(", ");
  const defaultTemplate = count === 1 ? SINGLE_TICKET_TEMPLATE : MULTI_TICKET_TEMPLATE;
  return (signalTemplate ?? defaultTemplate)
    .replace(/\{count\}/g, String(count))
    .replace(/\{tickets\}/g, tickets);
}

/**
 * AI-1659: Build a workflow preamble for a single governed ticket.
 *
 * Returns a block listing the current workflow state and legal verb set, or
 * null when the ticket is ad-hoc, has no state label, or any fetch fails
 * (fail-open — callers fall back to the thin template).
 *
 * The verb list is derived from the same workflow YAML that proxy enforcement
 * uses, so the two stay in sync automatically.
 */
export async function buildWorkflowPreamble(
  identifier: string,
  authToken: string,
): Promise<string | null> {
  let labels: string[];
  try {
    labels = await fetchWorkflowLabels(identifier, authToken);
  } catch {
    return null;
  }

  const workflowId = getWorkflowId(labels);
  if (!workflowId) return null;

  const def = await loadWorkflowDefById(workflowId);
  if (!def) return null;

  const currentState = getCurrentState(labels);
  if (!currentState) return null;

  const stateNode = def.states.find((s) => s.id === currentState);
  if (!stateNode) return null;

  const transitions = stateNode.transitions ?? [];
  if (transitions.length === 0 && stateNode.kind === "terminal") return null;

  const breakGlassCommand = def.break_glass?.command ?? "escape";

  const stepLines = await Promise.all(
    transitions.map(async (t) => {
      const { bodies, mode } = await resolveTransitionTargets(t, def);
      let cmd = `linear ${t.command} ${identifier}`;
      if (mode === "required") {
        cmd += ` <${bodies.join("|")}>`;
      }
      if (t.feedback?.required) {
        cmd += ` --comment "<feedback>"`;
      }
      return `- \`${cmd}\` (→ ${t.to})`;
    }),
  );
  stepLines.push(
    `- \`linear ${breakGlassCommand} ${identifier}\` (break glass, legal from any state)`,
  );

  return [
    `⚠️ This is a [${def.id}] governed workflow ticket. Normal Linear CLI commands are restricted.`,
    `Current state: **${currentState}**. Legal action(s) for this state:`,
    ...stepLines,
    "",
  ].join("\n");
}

/**
 * Send a wake-up signal to an agent.
 *
 * The signal is intentionally thin — just tells the agent how many tickets
 * are pending and their IDs. The agent re-queries Linear for full details.
 *
 * AI-1659: For single-ticket wake-ups with authToken set, a workflow preamble
 * is prepended when the ticket is a governed workflow ticket.
 */
export async function sendWakeUpSignal(
  agentId: string,
  ticketIds: string[],
  config: WakeUpConfig,
): Promise<{ runId?: string } | void> {
  let message: string;

  if (ticketIds.length === 1 && config.authToken) {
    const plainId = ticketIds[0].replace(STRIP_LINEAR_PREFIX, "");
    const normalizedToken = /^Bearer\s+/i.test(config.authToken)
      ? config.authToken
      : `Bearer ${config.authToken}`;
    const preamble = await buildWorkflowPreamble(plainId, normalizedToken).catch(() => null);
    const base = buildWakeUpMessage(ticketIds, config.signalTemplate);
    message = preamble ? `${preamble}\n${base}` : base;
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
