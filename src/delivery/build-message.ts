/**
 * Phase 3 / B3 — Outbound per-step instruction injection (AI-1354).
 *
 * For workflow tickets (wf:* label), replaces the generic delegation decision-tree
 * with a per-step instruction block listing exactly the legal command(s) for the
 * ticket's current state (derived from dev-impl.yaml). Ad-hoc tickets (no wf:*) get
 * the byte-identical generic message — §4.6 mode switch.
 *
 * Fail-open: any label-fetch failure, YAML load error, or missing state falls back
 * to the generic message. An agent always gets actionable instructions.
 *
 * Design: design.md §4.6 (outbound direction), §11 Phase 3.
 */

import type { RouteResult } from "../types.js";
import {
  loadWorkflowDef,
  fetchWorkflowLabels,
  getWorkflowId,
  getCurrentState,
  type WorkflowDef,
} from "../workflow-gate.js";
import { componentLogger, createLogger } from "../logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "build-message");

/**
 * Build a routing-reason-specific delivery message for an agent.
 *
 * Workflow tickets: per-step instruction block for the current state (B3).
 * Ad-hoc / mentions: generic message, byte-identical to pre-B3 output.
 *
 * authToken is required for workflow label resolution; without it (or on any
 * error) the function falls back to the generic message.
 *
 * When coalescedCount > 0, appends a coalescing note regardless of path.
 */
export async function buildDeliveryMessage(route: RouteResult, authToken?: string): Promise<string> {
  const reason = route.routingReason ?? "assignee";
  const actor = route.event.actor;
  const actorName = actor?.name ?? "Someone";

  // Extract issue identifier from various event shapes
  const data = (route.event.data ?? {}) as Record<string, unknown>;
  const sessionData = data.agentSession as Record<string, unknown> | undefined;
  const issueData = (data.issue ?? sessionData?.issue ?? data) as Record<string, unknown>;
  const identifier = String(
    issueData?.identifier ??
      (data as Record<string, unknown>).issueIdentifier ??
      route.sessionKey.replace("linear-", ""),
  );
  const title = String(
    issueData?.title ?? (data as Record<string, unknown>).issueTitle ?? "",
  );

  let message: string;

  if (reason === "mention" || reason === "body-mention") {
    message = buildMentionMessage(actorName, identifier, title);
  } else {
    message = await buildDelegationMessage(reason, identifier, title, authToken);
  }

  // Append coalescence note if events were suppressed
  if (route.coalescedCount && route.coalescedCount > 0) {
    message += `\n\n> ${route.coalescedCount} additional event(s) for this ticket were coalesced into this delivery. Check \`linear observe-issue ${identifier}\` for the latest state.\n`;
  }

  return message;
}

async function buildDelegationMessage(
  reason: string,
  identifier: string,
  title: string,
  authToken: string | undefined,
): Promise<string> {
  const actionText =
    reason === "delegate"
      ? `You were delegated ${identifier}`
      : `You were assigned ${identifier}`;

  // §4.6 mode switch: attempt workflow-aware per-step injection for delegation events.
  if (authToken) {
    const workflowMessage = await tryBuildWorkflowMessage(
      actionText,
      identifier,
      title,
      authToken,
    );
    if (workflowMessage !== null) return workflowMessage;
  }

  return buildGenericDelegationMessage(actionText, identifier, title);
}

/**
 * Attempt to build a workflow-aware per-step instruction block.
 * Returns null to signal "fall back to generic" on any error or ad-hoc ticket.
 */
async function tryBuildWorkflowMessage(
  actionText: string,
  identifier: string,
  title: string,
  authToken: string,
): Promise<string | null> {
  let labels: string[];
  try {
    labels = await fetchWorkflowLabels(identifier, authToken);
  } catch {
    return null;
  }

  const workflowId = getWorkflowId(labels);
  if (!workflowId) return null; // ad-hoc ticket — fall through to generic

  let def: WorkflowDef;
  try {
    def = await loadWorkflowDef();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`build-message: failed to load workflow def: ${msg} — falling back to generic`);
    return null;
  }

  if (workflowId !== def.id) return null; // unknown workflow — fall back

  const currentState = getCurrentState(labels);
  if (!currentState) {
    log.warn(`build-message: no state:* label on ${identifier} — falling back to generic`);
    return null;
  }

  const stateNode = def.states.find((s) => s.id === currentState);
  if (!stateNode) {
    log.warn(`build-message: unknown state '${currentState}' on ${identifier} — falling back to generic`);
    return null;
  }

  const breakGlassCommand = def.break_glass?.command ?? "escape";
  const transitions = stateNode.transitions ?? [];

  const stepLines = transitions.map((t) => {
    let cmd = `linear ${t.command} ${identifier}`;
    if (t.feedback?.required && t.feedback.category_enum?.length) {
      cmd += ` --category <${t.feedback.category_enum.join("|")}>`;
    }
    const arrow = ` (→ ${t.to})`;
    return `- Run \`${cmd}\`${arrow}`;
  });

  // Always-available break-glass escape (§4.4)
  stepLines.push(`- Run \`linear ${breakGlassCommand} ${identifier}\` to break glass and hand to steward (→ ${def.break_glass?.to ?? "escape"}, legal from any state)`);

  return [
    `${actionText}: ${title}`,
    "",
    `This is a [${def.id}] workflow ticket in state: **${currentState}**`,
    "",
    "Your legal action(s) for this state:",
    ...stepLines,
    "",
    `Run \`linear consider-work ${identifier}\` NOW if you haven't already to review the issue.`,
    "",
    "📝 Comment discipline: post one substantive comment — your actual findings or result. Do NOT post a comment that only restates what is already on the ticket or narrates that you have handed it back. If you have no new information to add, do not comment at all — just transition state.",
    "",
    "⚠️ Important: do NOT hand off to Matt Henry for review, sign-off, or closure. Use the workflow commands above. Only use break-glass (\`escape\`) for genuine unresolvable blockers that require steward intervention.",
  ].join("\n");
}

function buildGenericDelegationMessage(actionText: string, identifier: string, title: string): string {
  return [
    `${actionText}: ${title}`,
    "",
    "This task has been delegated to you and you are expected to take the next action on it.",
    "",
    `Run \`linear consider-work ${identifier}\` NOW to review the issue and understand the request.`,
    "",
    "Next Steps:",
    `- If you need to do some work, run \`linear begin-work ${identifier}\``,
    "- If you cannot do the work...",
    `  - and need an agent to act instead, run \`linear refuse-work ${identifier} [delegate] --comment [reason]\``,
    `  - and need a human to help (e.g. credentials, access, infra provision), run \`linear needs-human ${identifier} [human] --comment [reason]\``,
    "",
    "When you complete the work...",
    `- To hand off for review, run \`linear handoff-work ${identifier} [delegate] --comment [note]\` (use an agent delegate like Charles for code, Astrid for product)`,
    `- If the ticket’s acceptance criteria is met and you are NOT the implementer, run \`linear complete ${identifier} --comment [summary]\``,
    "",
    "📝 Comment discipline: post one substantive comment — your actual findings or result. Do NOT post a comment that only restates what is already on the ticket or narrates that you have handed it back. If a dispatch wakes you and you have no new information to add, do not comment at all — just transition state (or take no action).",
    "",
    "⚠️ Important: do NOT hand off to Matt Henry for review, sign-off, or closure. Route reviews to the appropriate agent (Charles for code, Astrid for product, Laren for design). Only use \`needs-human\` for genuine blockers that require human action (credentials, access, approvals you cannot obtain yourself)."
  ].join("\n");
}

function buildMentionMessage(actorName: string, identifier: string, title: string): string {
  return [
    `You were mentioned on ${identifier}: ${title}`,
    "",
    `${actorName} mentioned you in a comment. Your input or awareness is requested — you are NOT expected to take ownership unless you choose to.`,
    "",
    `Run \`linear observe-issue ${identifier}\` to read the full context.`,
    "",
    "To respond:",
    `- To add your input without changing owner/status, run \`linear note ${identifier} --comment "[your response]"\``,
    `- Only if the issue is intentionally delegated/assigned to you, run \`linear consider-work ${identifier}\``,
    "- If this isn’t relevant to you, no action is needed. Do not refuse/handoff a task that is not currently yours.",
  ].join("\n");
}
