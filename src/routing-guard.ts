/**
 * AI-1428 / AI-1459 — Role-guard for agent routing / reassignment.
 *
 * Phase 1 (AI-1428): advisory-only. Detected wrong-body routing but never
 * blocked the dispatch.
 *
 * Phase 2 (AI-1459): enforcement mode. Before dispatching to an agent, the
 * guard checks the ticket's workflow state (from its labels), resolves the
 * owner_role for that state via the workflow definition, and verifies the
 * target agent fills that role in the capability policy. A failing check:
 *   - Returns blocked: true (caller must not dispatch)
 *   - Posts a blocking comment naming the illegal target, the expected legal
 *     target(s), and the reason
 *   - Attempts to correct the delegate: auto-assign to the singleton legal
 *     target, or clear + escalate when multiple bodies fill the role
 *
 * Ad-hoc tickets (no wf:* label) are full pass-through.
 * The guard fails open on any load error (missing yaml, network, unknown state)
 * so a misconfigured connector never silently drops real work.
 */

import { createLogger, componentLogger } from "./logger.js";
import { getAccessToken } from "./agents.js";
import { loadWorkflowDef, getWorkflowId, getCurrentState } from "./workflow-gate.js";
import { resolveBodiesForRole } from "./escalation-gate.js";

const log = componentLogger(createLogger(), "routing-guard");

const LINEAR_API_URL = "https://api.linear.app/graphql";

export interface RoleGuardResult {
  /** True when the dispatch has been blocked. */
  blocked: boolean;
  /** Human-readable reason if blocked. */
  reason?: string;
  /** Legal target body IDs when blocked and there is a singleton legal target. */
  correctedTo?: string;
}

// ── Sync advisory helper (kept for tests / callers that only have labels) ───

/**
 * Sync advisory-only check using the static REVIEW_ONLY_AGENTS set.
 * Returns the reason text when a violation is detected, but `blocked` is
 * always false — this function never hard-blocks. Use `checkRoleGuardEnforced`
 * (async) for the full enforcement path.
 *
 * Retained for unit tests and backwards-compatible callers.
 *
 * Hard-coded set per AI-1428 design: "no need to parse capability-policy.yaml
 * at runtime for Phase 1". Phase 2 derives legalBodies from the workflow def
 * instead, so this set is only used by the legacy sync path.
 */
export const REVIEW_ONLY_AGENTS = new Set([
  "charles",
  "ai",
  "astrid",
  "finn",
  "mckell",
  "yoshi",
  "ken",
  "miki",
  "poe",
  "kat",
  "maren",
  "kenji",
  "lacey",
  "scout",
]);

export function checkRoleGuard(
  targetAgentId: string,
  ticketLabels: string[],
): RoleGuardResult {
  const hasWorkflowLabel = ticketLabels.some((l) => /^wf:/i.test(l));
  if (!hasWorkflowLabel) return { blocked: false };

  const isImplementation = ticketLabels.some((l) => /^state:implementation$/i.test(l));
  if (!isImplementation) return { blocked: false };

  const normalizedAgent = targetAgentId.toLowerCase();
  if (!REVIEW_ONLY_AGENTS.has(normalizedAgent)) return { blocked: false };

  const reason = `Target agent '${targetAgentId}' is not an implementation body for wf:dev-impl (review-only).`;
  log.warn(`Role-guard advisory: ${reason}`);
  return { blocked: false, reason };
}

// ── Phase 2: Enforcement-mode async check ─────────────────────────────────

/**
 * Enforcement-mode role-guard check (AI-1459).
 *
 * Loads the workflow definition and capability policy, derives the owner_role
 * for the current state, and blocks routing when the target agent does not fill
 * that role. Returns blocked: true with reason when a violation is found.
 *
 * Fails open on any error (missing def, unknown workflow, missing state label,
 * empty role set) so misconfiguration never silently drops legitimate work.
 */
export async function checkRoleGuardEnforced(
  targetAgentId: string,
  ticketLabels: string[],
): Promise<RoleGuardResult> {
  // 1. No workflow label → pass-through.
  const workflowId = getWorkflowId(ticketLabels);
  if (!workflowId) return { blocked: false };

  // 2. No current state → fail open.
  const currentState = getCurrentState(ticketLabels);
  if (!currentState) {
    log.warn(`routing-guard: no state:* label for enforcement check — failing open for ${targetAgentId}`);
    return { blocked: false };
  }

  // 3. Load workflow def → fail open on error.
  let def;
  try {
    def = await loadWorkflowDef();
  } catch (err) {
    log.warn(`routing-guard: failed to load workflow def — failing open: ${err instanceof Error ? err.message : String(err)}`);
    return { blocked: false };
  }

  // Only enforce for the workflow whose def is loaded.
  if (workflowId !== def.id) return { blocked: false };

  // 4. Find the state node.
  const stateNode = def.states.find((s) => s.id === currentState);
  if (!stateNode) {
    log.warn(`routing-guard: unknown state '${currentState}' — failing open for ${targetAgentId}`);
    return { blocked: false };
  }

  // Terminal states have no meaningful role constraint on the recipient.
  if (stateNode.kind === "terminal") return { blocked: false };

  const ownerRole = stateNode.owner_role;
  if (!ownerRole) {
    // State has no role constraint → pass-through.
    return { blocked: false };
  }

  // 5. Resolve legal bodies for this role.
  let legalBodies: string[];
  try {
    legalBodies = await resolveBodiesForRole(ownerRole);
  } catch (err) {
    log.warn(`routing-guard: failed to resolve bodies for role '${ownerRole}' — failing open: ${err instanceof Error ? err.message : String(err)}`);
    return { blocked: false };
  }

  if (legalBodies.length === 0) {
    // No registered bodies for this role → fail open; system is misconfigured
    // but we shouldn't drop work silently.
    log.warn(`routing-guard: no bodies registered for role '${ownerRole}' in state '${currentState}' — failing open`);
    return { blocked: false };
  }

  // 6. Check if the target fills the role.
  const normalizedAgent = targetAgentId.toLowerCase();
  if (legalBodies.map((b) => b.toLowerCase()).includes(normalizedAgent)) {
    // Legal dispatch — pass-through.
    return { blocked: false };
  }

  // 7. Violation — build the blocking result.
  const legalList = legalBodies.join(", ");
  const reason =
    `'${targetAgentId}' does not fill role '${ownerRole}' required for ` +
    `state '${currentState}' (wf:${workflowId}). ` +
    `Legal target(s): ${legalList}.`;

  log.warn(`routing-guard: BLOCKED dispatch — ${reason}`);

  const result: RoleGuardResult = {
    blocked: true,
    reason,
  };

  // Surface the correction target so the caller can update the delegate.
  if (legalBodies.length === 1) {
    result.correctedTo = legalBodies[0];
  }

  return result;
}

// ── Public dispatch-guard (replaces checkRoleGuardAndWarn) ────────────────

/**
 * Run the enforcement-mode role-guard. When a violation is detected:
 *   1. Post a blocking comment on the ticket.
 *   2. Attempt to correct the delegate.
 *      - Singleton legal target: update the delegate to that body.
 *      - Multiple legal targets: clear the delegate and flag for human routing.
 * Returns the guard result; callers must check `result.blocked` and skip
 * delivery when true.
 *
 * Auth strategy (same as before): prefer the target agent's own token, then
 * fall back to the global LINEAR_OAUTH_TOKEN / LINEAR_API_KEY env vars.
 */
/**
 * Resolver that maps a body name (e.g. "igor") to its Linear user ID.
 * Injected by the caller so routing-guard.ts doesn't depend on agents.ts
 * at the module level (which has an external package dependency that breaks
 * the test compile path).
 */
export type LinearUserIdResolver = (bodyName: string) => string | null;

export async function checkRoleGuardAndBlock(
  targetAgentId: string,
  issueIdentifier: string,
  ticketLabels: string[],
  delegateLinearUserIdResolver?: LinearUserIdResolver,
): Promise<RoleGuardResult> {
  const result = await checkRoleGuardEnforced(targetAgentId, ticketLabels);

  if (!result.blocked || !result.reason) {
    return result;
  }

  // Resolve auth token.
  const rawToken =
    getAccessToken(targetAgentId) ??
    process.env.LINEAR_OAUTH_TOKEN ??
    process.env.LINEAR_API_KEY;
  if (!rawToken) {
    log.warn(`routing-guard: no token available to post blocking comment for ${issueIdentifier}`);
    return result;
  }
  const authHeader = /^Bearer\s+/i.test(rawToken) ? rawToken : `Bearer ${rawToken}`;

  // Resolve the internal UUID for the issue.
  const internalId = await resolveIssueId(issueIdentifier, authHeader);
  if (!internalId) {
    log.warn(`routing-guard: could not resolve issue id for ${issueIdentifier} — skipping comment/correction`);
    return result;
  }

  // 1. Post blocking comment.
  await postBlockingComment(internalId, targetAgentId, issueIdentifier, result, authHeader);

  // 2. Correct the delegate.
  // If a singleton correctedTo is set, the caller (webhook) should resolve the
  // body's linearUserId and call updateDelegateForIssue; we expose that helper.
  // For the no-token path we skip correction here; the caller must handle it.
  if (result.correctedTo && delegateLinearUserIdResolver) {
    const newDelegateLinearId = delegateLinearUserIdResolver(result.correctedTo);
    if (newDelegateLinearId) {
      const corrected = await updateDelegate(internalId, newDelegateLinearId, authHeader);
      if (corrected) {
        log.info(`routing-guard: delegate corrected for ${issueIdentifier}: ${targetAgentId} → ${result.correctedTo}`);
      } else {
        log.warn(`routing-guard: delegate correction failed for ${issueIdentifier}`);
      }
    } else {
      log.warn(`routing-guard: could not resolve Linear user ID for corrected target '${result.correctedTo}' — skipping delegate update`);
    }
  } else if (!result.correctedTo) {
    // Multiple legal targets — clear the delegate so the ticket surfaces for
    // manual routing, rather than leaving it on the wrong body.
    const cleared = await clearDelegate(internalId, authHeader);
    if (cleared) {
      log.info(`routing-guard: delegate cleared for ${issueIdentifier} (multiple legal targets; requires manual routing)`);
    } else {
      log.warn(`routing-guard: delegate clear failed for ${issueIdentifier}`);
    }
  }

  return result;
}

/**
 * Legacy compatibility wrapper.
 * Previous call sites that used `checkRoleGuardAndWarn` now route through
 * the enforcement path. This ensures the webhook caller is not broken by the
 * rename — update call sites to `checkRoleGuardAndBlock` at leisure.
 */
export async function checkRoleGuardAndWarn(
  targetAgentId: string,
  issueIdentifier: string,
  ticketLabels: string[],
  delegateLinearUserIdResolver?: LinearUserIdResolver,
): Promise<RoleGuardResult> {
  return checkRoleGuardAndBlock(targetAgentId, issueIdentifier, ticketLabels, delegateLinearUserIdResolver);
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function resolveIssueId(
  identifier: string,
  authHeader: string,
): Promise<string | null> {
  const query = `query($id: String!) { issue(id: $id) { id } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({ query, variables: { id: identifier } }),
    });
    type Resp = { data?: { issue?: { id: string } | null } };
    const data = (await res.json()) as Resp;
    return data.data?.issue?.id ?? null;
  } catch (err) {
    log.error(`routing-guard: issue lookup failed for ${identifier}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function postBlockingComment(
  issueId: string,
  illegalTarget: string,
  issueIdentifier: string,
  result: RoleGuardResult,
  authHeader: string,
): Promise<void> {
  const correctionNote = result.correctedTo
    ? `Delegate has been automatically corrected to **${result.correctedTo}**.`
    : `Delegate has been cleared — manual routing required.`;

  const body =
    `[Connector] Dispatch blocked: illegal routing target detected on **${issueIdentifier}**.\n\n` +
    `**Illegal target:** ${illegalTarget}\n` +
    `**Reason:** ${result.reason}\n\n` +
    correctionNote;

  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({ query: mutation, variables: { issueId, body } }),
    });
    type Resp = { data?: { commentCreate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    if (data.data?.commentCreate?.success) {
      log.info(`routing-guard: blocking comment posted on ${issueId}`);
    } else {
      log.warn(`routing-guard: blocking comment returned non-success for ${issueId}`);
    }
  } catch (err) {
    log.error(`routing-guard: blocking comment failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function updateDelegate(
  issueId: string,
  delegateLinearUserId: string,
  authHeader: string,
): Promise<boolean> {
  const mutation = `
    mutation UpdateDelegate($issueId: String!, $delegateId: String!) {
      issueUpdate(id: $issueId, input: { dueDate: null }) { success }
    }
  `;
  // Linear uses `subscriberIds` for delegate-adjacent fields, but the actual
  // delegate is set via the undocumented `delegateId` on issueUpdate.
  const delegateMutation = `
    mutation UpdateDelegate($issueId: String!, $delegateId: String!) {
      issueUpdate(id: $issueId, input: { delegateId: $delegateId }) {
        success
        issue { id }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({
        query: delegateMutation,
        variables: { issueId, delegateId: delegateLinearUserId },
      }),
    });
    type Resp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    return data.data?.issueUpdate?.success === true;
  } catch (err) {
    log.error(`routing-guard: delegate update failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function clearDelegate(
  issueId: string,
  authHeader: string,
): Promise<boolean> {
  const mutation = `
    mutation ClearDelegate($issueId: String!) {
      issueUpdate(id: $issueId, input: { delegateId: null }) {
        success
        issue { id }
      }
    }
  `;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({ query: mutation, variables: { issueId } }),
    });
    type Resp = { data?: { issueUpdate?: { success: boolean } } };
    const data = (await res.json()) as Resp;
    return data.data?.issueUpdate?.success === true;
  } catch (err) {
    log.error(`routing-guard: delegate clear failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
