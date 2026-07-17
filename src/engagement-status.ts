/**
 * Engagement-status overlay (AI-1510).
 *
 * In dev-impl, native Linear status is a NON-AUTHORITATIVE *engagement* signal:
 * it answers "is an agent touching this ticket right now," not which pipeline
 * stage it's in. The pipeline stage lives entirely in the `state:*` label; native
 * status cycles To Do → Thinking → Doing based on the delegate's session lifecycle.
 *
 *   - dispatch / agent reads the ticket  → thinking
 *   - agent authors its first activity    → doing   (monotonic: never downgrades)
 *   - session ends with no successor      → todo
 *
 * Each workflow state's `native_state` in dev-impl.yaml is the *resting* value
 * (todo for every active stage); a real transition writes that resting value, and
 * the next delegate's dispatch re-drives thinking → doing.
 *
 * These writes are connector-initiated (delegate's vaulted token), NOT routed
 * through the proxy's agent path — so the workflow gate does not (and should not)
 * gate them. They are free to move native status precisely because the redesign
 * demoted native status to non-authoritative (label + delegate are the truth).
 *
 * Fail-open everywhere: any fetch/resolve error is logged and swallowed. A missed
 * status flip is cosmetic; it must never block dispatch or session-end handling.
 */

import { createLogger, componentLogger } from "./logger.js";
import { resolveNativeStateId, loadWorkflowDefById, getWorkflowId, getCurrentState } from "./workflow-gate.js";

const log = componentLogger(createLogger(), "engagement-status");

// AI-2568: when enabled, applyEngagementStatus reads the ticket's workflow
// state's native_state declaration on "doing" semantics. Enabled at bootstrap
// by registerEngagementNativeStateOverlay().
let _nativeStateAware = false;

/**
 * Enable native_state-aware engagement overlay (AI-2568). Called from
 * createApp() at server bootstrap. Emits a startup log line (AC5).
 * Once enabled, "doing" semantics on a workflow ticket with a state that
 * declares native_state: todo will resolve to the "To Do" UUID.
 */
export function registerEngagementNativeStateOverlay(): void {
  _nativeStateAware = true;
  log.info("[engagement-status] native_state-aware overlay registered (AI-2568)");
}

const LINEAR_API_URL = "https://api.linear.app/graphql";

export type EngagementSemantic = "thinking" | "doing" | "todo";

/** Linear state names that mean "agent is actively working" — the monotonic floor. */
const DOING_NAMES = new Set(["doing", "developing"]);

/**
 * Terminal workflow-state labels. A ticket carrying one of these has been driven
 * to a resting end-state by the workflow gate (its native write is authoritative);
 * the engagement overlay must never move it — otherwise a delegate's final
 * agent-authored activity re-drives native back to "doing", un-completing a Done
 * ticket (AI-1540).
 */
const TERMINAL_LABELS = new Set(["state:done", "state:escape"]);

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

function asBearer(token: string): string {
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

interface IssueShape {
  id: string;
  teamId: string;
  stateName: string;
  stateId: string;
  labels: string[];
  /** Linear user ID of the current delegate, if set. */
  delegateLinearUserId?: string;
}

async function fetchIssue(identifier: string, authHeader: string): Promise<IssueShape | null> {
  const query = `
    query EngagementIssue($id: String!) {
      issue(id: $id) {
        id
        team { id }
        state { id name }
        labels { nodes { name } }
        delegate { id }
      }
    }`;
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ query, variables: { id: identifier } }),
  });
  type Resp = {
    data?: {
      issue?: {
        id: string;
        team?: { id: string } | null;
        state?: { id: string; name: string } | null;
        labels?: { nodes: Array<{ name: string }> } | null;
        delegate?: { id?: string } | null;
      } | null;
    };
  };
  const body = (await res.json()) as Resp;
  const issue = body.data?.issue;
  if (!issue || !issue.team?.id || !issue.state) return null;
  return {
    id: issue.id,
    teamId: issue.team.id,
    stateName: issue.state.name,
    stateId: issue.state.id,
    labels: (issue.labels?.nodes ?? []).map((l) => l.name),
    delegateLinearUserId: issue.delegate?.id ?? undefined,
  };
}

/**
 * Apply an engagement status to a workflow ticket. No-op for ad-hoc tickets
 * (no `wf:*` label) and for the monotonic thinking-after-doing case.
 *
 * @param ticketRef          `linear-AI-1292` or `AI-1292`
 * @param token              delegate's access token (raw or Bearer-prefixed)
 * @param agentLinearUserId  Linear user ID of the authoring agent; when provided,
 *                           the "doing" flip is skipped if the agent is not the
 *                           current delegate (AI-1660).
 */
export async function applyEngagementStatus(
  ticketRef: string,
  semantic: EngagementSemantic,
  token: string | null | undefined,
  agentLinearUserId?: string | null,
): Promise<void> {
  if (!token) return;
  const identifier = ticketRef.replace(/^linear-/i, "");
  const authHeader = asBearer(token);

  try {
    const issue = await fetchIssue(identifier, authHeader);
    if (!issue) return;

    // Overlay applies only to workflow tickets. Ad-hoc tickets keep their status.
    const isWorkflow = issue.labels.some((l) => /^wf:/i.test(l));
    if (!isWorkflow) return;

    // Terminal-state immunity: never overlay a ticket the workflow has driven to a
    // resting end-state (state:done / state:escape). The gate's native write wins;
    // a late agent-authored-activity webhook must not re-drive it to "doing" (AI-1540).
    if (issue.labels.some((l) => TERMINAL_LABELS.has(l.toLowerCase()))) return;

    // AI-1660: delegate guard — only the current delegate may flip to "doing".
    // A prior-step agent posting a handoff comment must not drive the next agent's
    // engagement status before that agent has even seen the ticket.
    if (semantic === "doing" && agentLinearUserId && issue.delegateLinearUserId) {
      if (agentLinearUserId !== issue.delegateLinearUserId) {
        log.info(
          `engagement: ${identifier} → doing skipped — authoring agent (${agentLinearUserId}) is not the delegate (${issue.delegateLinearUserId})`,
        );
        return;
      }
    }

    // Monotonic floor: never downgrade an actively-working ticket back to Thinking.
    if (semantic === "thinking" && DOING_NAMES.has(normalizeName(issue.stateName))) {
      return;
    }

    // AI-2568 (Option B): when native_state awareness is active and we're about
    // to write "doing" on a workflow ticket, check if the current workflow state
    // declares a different native_state (e.g. "todo"). If so, use that instead.
    let effectiveSemantic = semantic;
    if (_nativeStateAware && semantic === "doing") {
      try {
        const workflowId = getWorkflowId(issue.labels);
        if (workflowId) {
          const def = await loadWorkflowDefById(workflowId);
          if (def) {
            const stateId = getCurrentState(issue.labels, def);
            if (stateId) {
              const state = def.states.find((s) => s.id === stateId);
              if (state?.native_state) {
                effectiveSemantic = state.native_state as EngagementSemantic;
                log.info(
                  `engagement: ${identifier} → effective semantic "${effectiveSemantic}" ` +
                    `(resolved from workflow state "${stateId}" native_state) instead of "${semantic}"`,
                );
              }
            }
          }
        }
      } catch (err) {
        // Fail-open: if the registry isn't loaded (ad-hoc env, test without
        // bootstrap), fall back to the original semantic. Native_state awareness
        // is an optimization — a missed projection is cosmetic.
        log.warn(
          `engagement: ${identifier} → native_state resolution failed: ` +
            `${err instanceof Error ? err.message : String(err)}. Falling back to "${semantic}".`,
        );
      }
    }

    const targetStateId = await resolveNativeStateId(issue.teamId, effectiveSemantic, authHeader);
    if (!targetStateId) return; // resolver already logged
    // "todo" is a session-end reset — always write to reliably clear the engagement
    // signal even if Linear already shows To Do (prior flip may have been skipped).
    // effectiveSemantic ensures the idempotent guard uses the resolved native_state
    // (e.g. "todo") rather than the raw "doing" semantic.
    if (effectiveSemantic !== "todo" && targetStateId === issue.stateId) return;

    // AC2/AI-1548: pre-write re-check. B2 may have written state:done between the
    // initial fetch (above) and this issueUpdate. Re-read to ensure the overlay
    // does not overwrite the authoritative terminal native write.
    const freshIssue = await fetchIssue(identifier, authHeader);
    if (!freshIssue || freshIssue.labels.some((l) => TERMINAL_LABELS.has(l.toLowerCase()))) return;

    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({
        query: `mutation($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) { success }
        }`,
        variables: { id: issue.id, stateId: targetStateId },
      }),
    });
    type UpdResp = { data?: { issueUpdate?: { success?: boolean } } };
    const ok = ((await res.json()) as UpdResp).data?.issueUpdate?.success ?? false;
    if (ok) {
      log.info(`engagement: ${identifier} → ${effectiveSemantic} (from "${issue.stateName}")`);
    } else {
      log.warn(`engagement: ${identifier} → ${effectiveSemantic} write returned success=false`);
    }
  } catch (err) {
    log.warn(`engagement: ${identifier} → ${semantic} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
