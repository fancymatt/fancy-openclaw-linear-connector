/**
 * Stewardship wake-up signal for Managing-state tickets.
 *
 * Bundles all due Managing tickets for an agent into a single wake message
 * so an agent with several stewardship tickets doesn't get woken once per
 * ticket. Uses the first ticket's `linear-<ID>` session key as the bundle
 * session, consistent with how multi-ticket bag wakes already work.
 *
 * The agent receives a prompt that lists each ticket plus a short checklist
 * of stewardship duties (subtask state, delegate sanity, ownership drift).
 */

import { deliverMessageToAgent, type DeliveryConfig, type DeliveryResult } from "../delivery/index.js";
import { normalizeSessionKey } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";

const log = componentLogger(createLogger(), "managing-wake");

export interface ManagingWakeTicket {
  identifier: string;
  title: string;
  /** Epoch ms of last stewardship wake for this ticket, or null if first time. */
  lastDispatchedAt: number | null;
  /** Linear issue labels (e.g. "wf:sprint-spawner"). Empty if unavailable. */
  labels?: string[];
  /** Current Linear state name (lowercase), e.g. "managing". Empty if unavailable. */
  stateName?: string;
}

/**
 * Workflow labels that should be observe-only when in steward-owned states.
 * ManagingPoller sessions must NOT drive product decisions for these tickets.
 */
export const OBSERVER_WORKFLOW_LABELS = new Set([
  "wf:sprint-spawner",
  "wf:dev-sprint",
]);

/**
 * Steward-owned states within spawner/dev-sprint workflows.
 * In these states the main-session steward is driving — the managing-poller
 * wake is observe-only for these tickets.
 */
export const STEWARD_OWNED_STATES = new Set([
  "evaluating",
  "scanning",
  "determining-scope",
  "scoping",
  "launching",
  "managing",
  "releasing",
  "retrospecting",
  "product-definition",
  "ac-definition",
]);

const OBSERVER_CAVEAT = [
  "",
  "⚠️  OBSERVE-ONLY: One or more tickets above is a spawner loop or dev-sprint",
  "    in a steward-owned state. For these tickets:",
  "    - You may surface stalled children and report gaps.",
  "    - Do NOT author briefs, pick themes, fire fanout, set scope,",
  "      make product decisions, or drive loop state transitions.",
  "    - The main-session steward is driving these deliberately.",
  "    Surface findings via a note; hand decisions back.",
  "",
].join("\n");

export function isObserverTicket(ticket: ManagingWakeTicket): boolean {
  if (!ticket.labels?.length || !ticket.stateName) return false;
  const hasWorkflowLabel = ticket.labels.some((l) => OBSERVER_WORKFLOW_LABELS.has(l));
  const isStewardState = STEWARD_OWNED_STATES.has(ticket.stateName.toLowerCase());
  return hasWorkflowLabel && isStewardState;
}

const STEWARDSHIP_INSTRUCTIONS = [
  "For each ticket above:",
  "1. Check subtask state. If a child resolved since your last review, decide whether the parent moves forward.",
  "2. Look for stalled children — anything in Backlog that should be To Do? Anything assigned to the wrong person?",
  "3. Verify assignee + delegate on each child match the current owner.",
  "4. If something material changed, post a delta-only note on the parent: what changed since the last stewardship comment, and where the current blocker/owner is now.",
  "5. Do not restate unchanged child status, old blockers, or the whole project summary. If the only update would be a recap, post nothing.",
  "",
  "Move tickets out of Managing when they're complete, abandoned, or actively workable.",
].join("\n");

function formatRelative(nowMs: number, atMs: number | null): string {
  if (atMs === null) return "first review";
  const diffMs = Math.max(0, nowMs - atMs);
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function buildManagingWakeMessage(
  tickets: ManagingWakeTicket[],
  now: number = Date.now(),
): string {
  if (tickets.length === 0) {
    throw new Error("buildManagingWakeMessage requires at least one ticket");
  }
  const lines: string[] = ["You are managing these tickets:"];
  const hasObserverTicket = tickets.some(isObserverTicket);
  for (const t of tickets) {
    const stamp = formatRelative(now, t.lastDispatchedAt);
    const tag = isObserverTicket(t) ? " [observe-only]" : "";
    lines.push(`- ${t.identifier}: ${t.title} (last reviewed: ${stamp})${tag}`);
  }
  lines.push("", STEWARDSHIP_INSTRUCTIONS);
  if (hasObserverTicket) {
    lines.push("");
    lines.push(OBSERVER_CAVEAT);
  }
  return lines.join("\n");
}

/**
 * Deliver a stewardship wake to an agent for one or more due Managing tickets.
 * Uses the first ticket's `linear-<ID>` session key as the bundle session.
 */
export async function sendManagingWakeSignal(
  agentId: string,
  tickets: ManagingWakeTicket[],
  config: DeliveryConfig,
): Promise<{ runId?: string } | void> {
  if (tickets.length === 0) return;
  const message = buildManagingWakeMessage(tickets);
  const sessionKey = normalizeSessionKey(tickets[0].identifier);
  log.info(
    `Managing wake → ${agentId} [${sessionKey}] bundling ${tickets.length} ticket(s): ${tickets.map((t) => t.identifier).join(", ")}`,
  );
  try {
    const result: DeliveryResult = await deliverMessageToAgent(agentId, sessionKey, message, config);
    if (!result.dispatched) {
      throw new Error(result.hookErrorSummary ?? "managing wake delivery was not accepted");
    }
    return result.runId ? { runId: result.runId } : undefined;
  } catch (err) {
    log.error(
      `Managing wake delivery failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
