/**
 * AI-1428 — Role-guard for agent routing / reassignment.
 *
 * Advisory-mode (Phase 1): when an implementation-state ticket would be
 * routed to a review-only agent, emit a warning comment on the ticket rather
 * than hard-blocking the delegation. Hard-blocking is a follow-up once the
 * liveness path is validated.
 *
 * The review-only set is hard-coded as a constant (Charles's design notes
 * say: "no need to parse capability-policy.yaml at runtime — that's a future
 * hardening step. The set must include charles at minimum.").
 */

import { createLogger, componentLogger } from "./logger.js";
import { getAccessToken } from "./agents.js";
import { emitDelegateUnavailable } from "./escalation.js";

const log = componentLogger(createLogger(), "routing-guard");

const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * Review-only bodies: agents whose fills_roles is empty in the capability
 * policy. They cannot author implementation for wf:dev-impl tickets.
 *
 * This set includes all non-implementer bodies per the design doc.
 * Hard-coded per AI-1428 design — future: derive from capability-policy.yaml.
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

export interface RoleGuardResult {
  /** Whether the routing is blocked (advisory: false = pass-through, true = warning emitted). */
  blocked: boolean;
  /** Human-readable reason if blocked. */
  reason?: string;
}

/**
 * Check whether routing an agent to a workflow ticket is legal.
 *
 * Logic:
 * 1. If ticket has no wf:* label → pass-through (non-workflow ticket).
 * 2. If ticket has state:implementation label AND target is review-only →
 *    emit a warning comment (advisory mode).
 * 3. Otherwise → pass.
 *
 * Advisory mode means: `blocked` is always false in Phase 1. The function
 * returns the reason when it detects a violation, so callers can log/audit.
 */
export function checkRoleGuard(
  targetAgentId: string,
  ticketLabels: string[],
): RoleGuardResult {
  // 1. No workflow label → pass-through.
  const hasWorkflowLabel = ticketLabels.some((l) => /^wf:/i.test(l));
  if (!hasWorkflowLabel) {
    return { blocked: false };
  }

  // 2. Check implementation state + review-only target.
  const isImplementation = ticketLabels.some((l) => /^state:implementation$/i.test(l));
  if (!isImplementation) {
    return { blocked: false };
  }

  // Normalize agent ID to lowercase for set lookup.
  const normalizedAgent = targetAgentId.toLowerCase();
  if (!REVIEW_ONLY_AGENTS.has(normalizedAgent)) {
    return { blocked: false };
  }

  // Advisory mode: emit a warning but don't block.
  const reason = `Target agent '${targetAgentId}' is not an implementation body for wf:dev-impl (review-only).`;
  log.warn(`Role-guard advisory: ${reason}`);
  return { blocked: false, reason };
}

/**
 * Perform the role-guard check and, if a violation is detected, post a
 * warning comment on the ticket. Returns the guard result for the caller
 * to log/audit.
 *
 * In advisory mode, the routing is NOT blocked — the comment is the audit trail.
 */
export async function checkRoleGuardAndWarn(
  targetAgentId: string,
  issueIdentifier: string,
  ticketLabels: string[],
): Promise<RoleGuardResult> {
  const result = checkRoleGuard(targetAgentId, ticketLabels);

  if (result.reason) {
    // Post advisory warning comment.
    const token =
      getAccessToken(targetAgentId) ??
      process.env.LINEAR_OAUTH_TOKEN ??
      process.env.LINEAR_API_KEY;

    const authHeader = token && !/^Bearer\s+/i.test(token) ? `Bearer ${token}` : token;

    if (authHeader) {
      const internalId = await resolveIssueId(issueIdentifier, authHeader);
      if (internalId) {
        await postRoutingWarning(
          internalId,
          targetAgentId,
          result.reason,
          authHeader,
        );
      }
    }
  }

  return result;
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

async function postRoutingWarning(
  issueId: string,
  agentId: string,
  reason: string,
  authHeader: string,
): Promise<void> {
  const body = `[Connector] Routing advisory: ${reason}`;
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
      log.info(`routing-guard: advisory comment posted on ${issueId}`);
    } else {
      log.warn(`routing-guard: advisory comment post returned non-success for ${issueId}`);
    }
  } catch (err) {
    log.error(`routing-guard: advisory comment failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
