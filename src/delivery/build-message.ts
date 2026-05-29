import type { RouteResult } from "../types.js";

/**
 * Build a routing-reason-specific delivery message for an agent.
 *
 * Mentions: full [NEW TASK] push with commenter name and response options.
 * Delegate/assignee: full decision-tree nudge.
 *
 * When coalescedCount > 0, appends a note indicating how many events
 * were coalesced into this single delivery.
 */
export function buildDeliveryMessage(route: RouteResult): string {
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
    message = buildDelegationMessage(reason, identifier, title);
  }

  // Append coalescence note if events were suppressed
  if (route.coalescedCount && route.coalescedCount > 0) {
    message += `\n\n> ${route.coalescedCount} additional event(s) for this ticket were coalesced into this delivery. Check \`linear observe-issue ${identifier}\` for the latest state.\n`;
  }

  return message;
}

function buildDelegationMessage(reason: string, identifier: string, title: string): string {
  const actionText =
    reason === "delegate"
      ? `You were delegated ${identifier}`
      : `You were assigned ${identifier}`;

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
    `- If the ticket\u2019s acceptance criteria is met and you are NOT the implementer, run \`linear complete ${identifier} --comment [summary]\``,
    "",
    "\u26A0\uFE0F Important: do NOT hand off to Matt Henry for review, sign-off, or closure. Route reviews to the appropriate agent (Charles for code, Astrid for product, Laren for design). Only use \`needs-human\` for genuine blockers that require human action (credentials, access, approvals you cannot obtain yourself)."
  ].join("\n");
}

function buildMentionMessage(actorName: string, identifier: string, title: string): string {
  return [
    `You were mentioned on ${identifier}: ${title}`,
    "",
    `${actorName} mentioned you in a comment. Your input or awareness is requested \u2014 you are NOT expected to take ownership unless you choose to.`,
    "",
    `Run \`linear observe-issue ${identifier}\` to read the full context.`,
    "",
    "To respond:",
    `- To add your input without changing owner/status, run \`linear note ${identifier} --comment "[your response]"\``,
    `- Only if the issue is intentionally delegated/assigned to you, run \`linear consider-work ${identifier}\``,
    "- If this isn\u2019t relevant to you, no action is needed. Do not refuse/handoff a task that is not currently yours.",
  ].join("\n");
}
