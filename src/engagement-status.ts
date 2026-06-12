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
import { resolveNativeStateId } from "./workflow-gate.js";

const log = componentLogger(createLogger(), "engagement-status");

const LINEAR_API_URL = "https://api.linear.app/graphql";

export type EngagementSemantic = "thinking" | "doing" | "todo";

/** Linear state names that mean "agent is actively working" — the monotonic floor. */
const DOING_NAMES = new Set(["doing", "developing"]);

/**
 * Terminal workflow-state labels. A ticket the spine has driven to a terminal
 * state is owned by the workflow gate's native write; the engagement overlay
 * must never touch it (otherwise a clean `done` gets un-completed back to Doing).
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
}

async function fetchIssue(identifier: string, authHeader: string): Promise<IssueShape | null> {
  const query = `
    query EngagementIssue($id: String!) {
      issue(id: $id) {
        id
        team { id }
        state { id name }
        labels { nodes { name } }
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
  };
}

/**
 * Apply an engagement status to a workflow ticket. No-op for ad-hoc tickets
 * (no `wf:*` label) and for the monotonic thinking-after-doing case.
 *
 * @param ticketRef  `linear-AI-1292` or `AI-1292`
 * @param token      delegate's access token (raw or Bearer-prefixed)
 */
export async function applyEngagementStatus(
  ticketRef: string,
  semantic: EngagementSemantic,
  token: string | null | undefined,
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

    // Terminal states are owned by the workflow gate's native write. Once a ticket
    // carries state:done / state:escape, the overlay must not move native status
    // (a trailing "doing" webhook would otherwise un-complete a finished ticket).
    if (issue.labels.some((l) => TERMINAL_LABELS.has(l.toLowerCase()))) return;

    // Monotonic floor: never downgrade an actively-working ticket back to Thinking.
    if (semantic === "thinking" && DOING_NAMES.has(normalizeName(issue.stateName))) {
      return;
    }

    const targetStateId = await resolveNativeStateId(issue.teamId, semantic, authHeader);
    if (!targetStateId) return; // resolver already logged
    if (targetStateId === issue.stateId) return; // idempotent — already there

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
      log.info(`engagement: ${identifier} → ${semantic} (from "${issue.stateName}")`);
    } else {
      log.warn(`engagement: ${identifier} → ${semantic} write returned success=false`);
    }
  } catch (err) {
    log.warn(`engagement: ${identifier} → ${semantic} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
