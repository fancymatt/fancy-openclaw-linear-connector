import type { RouteResult } from "../types.js";

/**
 * Build a routing-reason-specific delivery message for an agent.
 *
 * Mentions: full [NEW TASK] push with commenter name and response options.
 * Delegate/assignee: full decision-tree nudge.
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

  if (reason === "mention" || reason === "body-mention") {
    return [
      `You were mentioned on ${identifier}: ${title}`,
      "",
      `${actorName} mentioned you in a comment. Your input or awareness is requested \u2014 you are NOT expected to take ownership unless you choose to.`,
      "",
      `Run \`linear observe-issue ${identifier}\` to read the full context.`,
      "",
      "To respond:",
      `- To add your input, run \`linear handoff-work ${identifier} [delegate] --comment "[your response]"\``,
      `- If you want to take ownership, run \`linear consider-work ${identifier}\``,
      "- If this isn\u2019t relevant to you, no action is needed.",
    ].join("\n");
  }

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
    `  - and need a human to help, run \`linear needs-human ${identifier} [human] --comment [reason]\``,
    "",
    "When you complete the work...",
    `- To have an agent review your work, run \`linear handoff-work ${identifier} [delegate] --comment [note]\``,
    `- To have a human review your work, run \`linear needs-human ${identifier} [human] --comment [note]\``,
    `- If the ticket\u2019s acceptance criteria is met, run \`linear complete ${identifier} --comment [summary]\``,
  ].join("\n");
}
