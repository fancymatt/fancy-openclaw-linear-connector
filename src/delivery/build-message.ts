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

import fs from "node:fs/promises";
import path from "node:path";
import type { RouteResult } from "../types.js";
import {
  loadWorkflowDefById,
  fetchWorkflowLabels,
  TransientLabelFetchError,
  getWorkflowId,
  getCurrentState,
  resolveTransitionTargets,
  resolveStakesLevel,
  type WorkflowDef,
  type StakesLevel,
} from "../workflow-gate.js";
import { getAcRecord } from "../ac-record-store.js";
import { getAppliedState } from "../store/applied-state-store.js";
import { componentLogger, createLogger } from "../logger.js";
import { defaultGuidanceDir } from "../instance-config.js";
import { loadUniversalCanon, formatCanonBlock } from "../policy/universal-canon.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "build-message");

/**
 * Root for instance-local step guidance files (C5 / AI-1381).
 * Files live at guidance/<workflowId>/<step>.md beside the workflow defs.
 * Override via WORKFLOW_GUIDANCE_DIR for tests.
 */
function guidanceDir(): string {
  return process.env.WORKFLOW_GUIDANCE_DIR ?? defaultGuidanceDir();
}

/**
 * AI-1708: Fetch workflow labels with exponential-backoff retry.
 *
 * Transient failures (network errors, 401, 5xx) cause up to `maxRetries`
 * retries with exponential backoff. If all retries are exhausted, the error
 * is re-thrown so the caller can decide whether to fall back to generic
 * (with a WARN) or fail the dispatch entirely.
 *
 * Non-transient errors (returned as [] by fetchWorkflowLabels) are not retried.
 */
async function fetchLabelsWithRetry(
  identifier: string,
  authToken: string,
  maxRetries = parseInt(process.env.LABEL_FETCH_MAX_RETRIES ?? "2", 10),
  baseDelayMs = parseInt(process.env.LABEL_FETCH_BASE_DELAY_MS ?? "500", 10),
): Promise<string[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchWorkflowLabels(identifier, authToken);
    } catch (err) {
      lastError = err;
      if (err instanceof TransientLabelFetchError && attempt < maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        log.warn(
          `build-message: label fetch attempt ${attempt + 1}/${maxRetries + 1} failed for ${identifier} (${err.message}) — retrying in ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

async function loadStepGuidance(workflowId: string, step: string): Promise<string | null> {
  const filePath = path.join(guidanceDir(), workflowId, `${step}.md`);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null; // Fail-open: missing file → no guidance section
  }
}

/**
 * AI-1848: Insert the canon block after the hook line (first paragraph),
 * before the body / per-step guidance. Returns the message unchanged when
 * no canon was loaded (fail-open).
 */
function withCanonBlock(message: string, canon: { text: string; version: string } | null): string {
  if (!canon) return message;
  const block = formatCanonBlock(canon.text, canon.version);
  if (!block) return message;
  const firstNewline = message.indexOf("\n");
  if (firstNewline === -1) {
    // Single-line message — append canon block.
    return `${message}${block}`;
  }
  // message = "hook\n\nbody..." → "hook\n{block}\n\nbody..."
  // block already starts with "\n---" and ends with "---".
  return message.slice(0, firstNewline + 1) + block + "\n" + message.slice(firstNewline + 1);
}

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

  // INF-38: prefer the sessionKey-derived identifier (canonicalised at delivery
  // time by deliverToAgent) over the event-captured identifier, which may be
  // stale after a team move.
  const identifier = route.sessionKey.replace("linear-", "");

  // Title is cosmetic display text only — captured from the event, fine to use
  // as-is (title doesn't change on team move).
  const data = (route.event.data ?? {}) as Record<string, unknown>;
  const sessionData = data.agentSession as Record<string, unknown> | undefined;
  const issueData = (data.issue ?? sessionData?.issue ?? data) as Record<string, unknown>;
  const title = String(
    issueData?.title ?? (data as Record<string, unknown>).issueTitle ?? "",
  );

  let message: string;

  // AI-1848 (Pillar 2 D1): load the universal canon once per dispatch and
  // inject it into every message path (workflow / ad-hoc / mention).
  // Fail-open: loadUniversalCanon returns null on missing/broken file.
  const canon = await loadUniversalCanon();

  if (reason === "mention" || reason === "body-mention") {
    message = buildMentionMessage(actorName, identifier, title);
  } else {
    message = await buildDelegationMessage(reason, identifier, title, authToken);
  }

  // Inject the canon block after the hook line (before per-step guidance).
  message = withCanonBlock(message, canon);

  // Append coalescence note if events were suppressed
  if (route.coalescedCount && route.coalescedCount > 0) {
    message += `\n\n> ${route.coalescedCount} additional event(s) for this ticket were coalesced into this delivery. Check \`linear observe-issue ${identifier}\` for the latest state.\n`;
  }

  return message;
}

/**
 * Build a workflow-aware per-step delivery message for a single ticket by identifier.
 * Fetches title and labels from Linear; returns null when the ticket is not a workflow
 * ticket. On transient fetch failure, returns a workflow-context-unavailable fallback
 * (AI-1708) instead of silently returning null.
 *
 * Used by the pending-bag wake-up path so agents get the same rich instruction block
 * that event-driven delegation produces.
 */
export async function buildWorkflowAwareDeliveryMessage(
  identifier: string,
  authToken: string,
  actionText = `You have a pending ticket: ${identifier}`,
): Promise<string | null> {
  const query = `query IssueTitle($id: String!) { issue(id: $id) { title labels { nodes { name } } } }`;
  let title = "";
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authToken },
      body: JSON.stringify({ query, variables: { id: identifier } }),
    });
    // AI-1708: treat 401/5xx as transient — don't silently return null.
    if (res.status === 401 || res.status >= 500) {
      log.warn(
        `build-message: title fetch for ${identifier} returned ${res.status} — proceeding with fallback`,
      );
    } else {
      const json = (await res.json()) as { data?: { issue?: { title?: string; labels?: { nodes: Array<{ name: string }> } } } };
      title = json.data?.issue?.title ?? "";
    }
  } catch (err) {
    // AI-1708: Network error on title fetch — don't silently return null.
    // Proceed to tryBuildWorkflowMessage which will retry labels and produce
    // a context-unavailable fallback if retries are exhausted.
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(
      `build-message: title fetch failed for ${identifier}: ${reason} — proceeding with fallback`,
    );
  }
  // AI-1848: load canon and inject into the workflow-aware message too.
  const canon = await loadUniversalCanon();
  const wfMessage = await tryBuildWorkflowMessage(actionText, identifier, title, authToken);
  return wfMessage !== null ? withCanonBlock(wfMessage, canon) : null;
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

/** Fetch the most recent comment on a ticket. Returns null on any failure. */
async function fetchLastComment(
  identifier: string,
  authToken: string,
): Promise<{ body: string; authorName: string } | null> {
  const query = `
    query LastComment($identifier: String!) {
      issue(id: $identifier) {
        comments(last: 1, orderBy: createdAt) {
          nodes { body user { name } }
        }
      }
    }
  `;
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authToken },
      body: JSON.stringify({ query, variables: { identifier } }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { issue?: { comments?: { nodes?: Array<{ body: string; user?: { name?: string } }> } } };
    };
    const node = json.data?.issue?.comments?.nodes?.[0];
    if (!node) return null;
    return { body: node.body, authorName: node.user?.name ?? "unknown" };
  } catch {
    return null;
  }
}

/**
 * Attempt to build a workflow-aware per-step instruction block.
 * Returns null to signal "fall back to generic" on any error or ad-hoc ticket.
 *
 * AI-1708: Label fetch now uses fetchLabelsWithRetry. If all retries are
 * exhausted, a WARN is logged with the failure reason before returning null.
 */
export async function tryBuildWorkflowMessage(
  actionText: string,
  identifier: string,
  title: string,
  authToken: string,
): Promise<string | null> {
  let labels: string[];
  try {
    labels = await fetchLabelsWithRetry(identifier, authToken);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(
      `build-message: workflow label fetch exhausted retries for ${identifier} — delivering workflow-context-unavailable fallback. Failure reason: ${reason}`,
    );
    // AI-1708: Return the context-unavailable fallback instead of null so the
    // caller never silently delivers a bare generic message. The fallback
    // includes a prominent notice and instructs the agent to query its state.
    return buildWorkflowContextUnavailableMessage(actionText, identifier, title);
  }

  const workflowId = getWorkflowId(labels);
  if (!workflowId) return null; // ad-hoc ticket — fall through to generic

  const def = await loadWorkflowDefById(workflowId);
  if (!def) {
    log.warn(`build-message: no workflow def in registry for wf:${workflowId} — falling back to generic`);
    return null;
  }

  // AI-1534: prefer the connector's just-applied destination state over the live
  // label read. Linear reads are eventually consistent, so right after a
  // transition (e.g. accept: intake → write-tests that also reassigns the
  // delegate) the read above can still return the PRE-transition state, which
  // would tell the new delegate to run the previous state's verb. The proxy is
  // the sole writer of transitions, so its recorded post-transition state is
  // authoritative while fresh.
  const liveState = getCurrentState(labels);
  const appliedState = getAppliedState(identifier);
  const currentState = appliedState ?? liveState;
  if (appliedState && appliedState !== liveState) {
    log.info(
      `build-message: preferring just-applied state '${appliedState}' over live read '${liveState ?? "none"}' for ${identifier} (read-after-write lag guard, AI-1534)`,
    );
  }
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

  const [stepLines, guidance, lastComment] = await Promise.all([
    Promise.all(transitions.map(async (t) => {
      const { bodies, mode } = await resolveTransitionTargets(t, def);

      // Use the generic command name when available (Matt's directive: guidance always
      // uses generic transitions so agents don't need workflow-specific command names).
      const commandName = t.generic === 'continue'
        ? 'continue-workflow'
        : t.generic === 'revision'
          ? 'request-revision'
          : t.command;

      let cmd = `linear ${commandName} ${identifier}`;
      if (mode === 'required') {
        cmd += ` <${bodies.join('|')}>`;
      }
      if (t.requires_comment || t.feedback?.required) {
        cmd += ` --comment-file <path>`;
      }
      const arrow = ` (→ ${t.to})`;

      let note = '';
      if (mode === 'auto' && bodies.length === 1) {
        note = ` [auto-assigns to ${bodies[0]}]`;
      } else if (mode === 'required' && t.assign?.constraint === 'not-implementer') {
        note = ` [reviewer required; must not be you]`;
      } else if (t.assign?.default === 'prior-implementer') {
        note = ` [defaults to prior implementer; overridable with --target]`;
      }

      return `- Run \`${cmd}\`${arrow}${note}`;
    })),
    loadStepGuidance(def.id, currentState),
    stateNode.deliverLastComment ? fetchLastComment(identifier, authToken) : Promise.resolve(null),
  ]);


  const guidanceBlock: string[] = guidance
    ? ["", "---", "**Step guidance (accumulated lessons for this state):**", "", guidance.trim(), "---"]
    : [];

  // deliverLastComment: inject the most recent ticket comment inline (e.g. brief for generating state).
  const lastCommentBlock: string[] = lastComment
    ? [
        "",
        "---",
        `**Most recent comment (from ${lastComment.authorName} — your context for this step):**`,
        "",
        lastComment.body,
        "---",
      ]
    : [];

  // Phase 6.5 / H-7 (AI-1482): Include verbatim AC record if captured.
  const acRecordBlock: string[] = [];
  const acRecord = await getAcRecord(identifier);
  if (acRecord) {
    acRecordBlock.push(
      "",
      "---",
      "**Verbatim Acceptance Criteria (AC of record):**",
      "",
      acRecord.verbatimAc,
      "",
      `_(Captured at intake by ${acRecord.capturedBy} on ${acRecord.capturedAt}. Sign-off is judged against this verbatim AC, not any restatement.)_`,
      "---",
    );
  }

  // Phase 6.5 / H-7 (AI-1482): Include stakes level if configured.
  const stakesBlock: string[] = [];
  if (def.stakes) {
    const ticketStakesLevel = resolveStakesLevel(labels, def.stakes);
    if (ticketStakesLevel >= def.stakes.threshold) {
      stakesBlock.push(
        "",
        `⚠️ **Elevated stakes (level ${ticketStakesLevel}):** This ticket requires human (Matt) sign-off at deploy. AI agents cannot self-sign-off.`,
      );
    }
  }

  const resourcesBlock: string[] = stateNode.resources?.length
    ? [
        "",
        "**Reference documents for this step (read these before acting):**",
        ...stateNode.resources.map(r =>
          r.description
            ? `- \`${r.path}\` — ${r.description}`
            : `- \`${r.path}\`${r.label ? ` (${r.label})` : ""}`
        ),
      ]
    : [];

  return [
    `${actionText}: ${title}`,
    "",
    `This is a [${def.id}] workflow ticket in state: **${currentState}**`,
    ...stakesBlock,
    ...lastCommentBlock,
    "",
    "Your legal action(s) for this state:",
    ...stepLines,
    ...resourcesBlock,
    ...guidanceBlock,
    ...acRecordBlock,
    "",
    "📝 Comment discipline: post one substantive comment — your actual findings or result. Do NOT post a comment that only restates what is already on the ticket or narrates that you have handed it back. If you have no new information to add, do not comment at all — just transition state.",
  ].join("\n");
}

/**
 * AI-1708: Build a fallback delivery message when workflow context cannot be
 * fetched due to transient label-fetch failures.
 *
 * This is NOT the bare generic message — it includes a prominent notice that
 * workflow context is unavailable and instructs the agent to query its current
 * state before acting. This satisfies AC2 (WARN at dispatch site) and AC3
 * (agent has sufficient context to identify its workflow step).
 */
function buildWorkflowContextUnavailableMessage(
  actionText: string,
  identifier: string,
  title: string,
): string {
  return [
    `${actionText}: ${title}`,
    "",
    "⚠️ **Workflow context unavailable:** The connector could not fetch workflow labels from Linear after retrying. You may be in a managed workflow (e.g. dev-impl) but the current step could not be determined.",
    "",
    `**Before acting, run \`linear observe-issue ${identifier}\` to read the current ticket state, then check the ticket's workflow labels (wf:* and state:*) to identify your current workflow step and legal commands.** Do not guess your workflow state from memory.`,
    "",
    "📝 Comment discipline: post one substantive comment — your actual findings or result. Do NOT post a comment that only restates what is already on the ticket.",
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
    "When the work is done, hand it off to be checked — you do NOT pick a reviewer yourself:",
    `- Default: hand off to Ai — run \`linear handoff-work ${identifier} Ai --comment [summary]\`. Ai validates the work, answers easy questions, and brings in the requesting human only when their action is actually needed. A second set of eyes catches simple mistakes before the task is called done, and keeps humans from becoming a blocker.`,
    "- If another AGENT requested this work (you are collaborating with them on the ticket), hand it back to that agent instead.",
    "- Hand finished work off to be checked even if you did the work yourself — there is no \"only if you are not the implementer\" rule here. Do not silently leave a completed task sitting in your own column.",
    "",
    "📝 Comment discipline: post one substantive comment — your actual findings or result. Do NOT post a comment that only restates what is already on the ticket or narrates that you have handed it back. If a dispatch wakes you and you have no new information to add, do not comment at all — just transition state (or take no action).",
    "",
    "⚠️ Important: agents do not decide reviewers. Hand finished work to Ai for validation (or back to the requesting agent), rather than choosing a domain reviewer yourself. Use \`needs-human\` only for genuine blockers that require human action (credentials, access, approvals you cannot obtain yourself) — not as a way to mark work complete."
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
