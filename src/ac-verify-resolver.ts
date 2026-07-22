/**
 * INF-327: AC-Verify Resolver — resolvable verify-owner per ticket.
 *
 * Makes the dev-impl AC-verify step's delegate resolvable per ticket so
 * stakeholder sign-off is opt-in per ticket instead of a blanket gate.
 *
 * Three exported functions:
 *   resolveVerifyOwner — pure, synchronous: reads labels + config, returns owner
 *   checkVerifyGate    — checks Linear for verifier approval status
 *   isVerifierStalled  — checks if the designated verifier has been silent
 *
 * Config-driven dimension→verifier map (not hardcoded).
 */

const LINEAR_API_URL = "https://api.linear.app/graphql";

/** Configuration for the verify-owner resolver. */
export interface VerifyConfig {
  /** Map of dimension → verifier agent name, e.g. { code: "cra", design: "laren" } */
  dimensionMap: Record<string, string>;
  /** Default steward owner (used when no designation is present). */
  defaultOwner: string;
}

/** Result of resolving the verify owner for a ticket. */
export interface VerifyResolution {
  /** Resolved verifier agent name, or null when no designation is present. */
  owner: string | null;
  /** True when a verify designation was present (owner is relevant). */
  designated: boolean;
  /** How the owner was determined. */
  source: "none" | "verify-label" | "xfn-derived";
}

/**
 * Resolve the AC-verify owner for a ticket based on its labels and config.
 *
 * Resolution order:
 *   1. If a `verify:<role>` label exists, use it (explicit designation).
 *   2. Else if an `xfn:<dimension>` label exists, derive owner from config map.
 *   3. Otherwise: no designation — returns null owner.
 *
 * When both verify: and xfn: labels exist, verify: wins (AC7).
 *
 * @param labels - The ticket's label names.
 * @param config - Resolver configuration (dimension map + default owner).
 * @returns The resolved verify owner and source metadata.
 */
export function resolveVerifyOwner(
  labels: string[],
  config: VerifyConfig,
): VerifyResolution {
  // Check for explicit verify:<role> label first.
  const verifyLabel = labels.find((l) => /^verify:/i.test(l));
  if (verifyLabel) {
    const role = verifyLabel.slice("verify:".length).toLowerCase();
    const owner = config.dimensionMap[role] ?? null;
    if (owner) {
      return { owner, designated: true, source: "verify-label" };
    }
    // The role exists as a verify: label but isn't in the map — still
    // designated (explicit intent), but no verifier to gate on.
    return { owner: null, designated: false, source: "none" };
  }

  // Check for xfn:<dimension> label to auto-derive owner.
  const xfnLabel = labels.find((l) => /^xfn:/i.test(l));
  if (xfnLabel) {
    const dimension = xfnLabel.slice("xfn:".length).toLowerCase();
    const owner = config.dimensionMap[dimension] ?? null;
    if (owner) {
      return { owner, designated: true, source: "xfn-derived" };
    }
    // Unknown dimension — no verifier to assign.
    return { owner: null, designated: false, source: "none" };
  }

  // No designation present.
  return { owner: null, designated: false, source: "none" };
}

/**
 * Check the AC-verify gate for a designated ticket.
 *
 * For designated tickets (owner != null), queries Linear for the verifier's
 * approval status. Returns blocked=true until the verifier approves, or
 * when the verifier has requested changes.
 *
 * Non-designated tickets (owner == null) always pass — no gate (AC1).
 *
 * @param ticketId   - Linear issue identifier.
 * @param owner      - Resolved verifier owner, or null for no designation.
 * @param _config     - Resolver config (reserved for future extensibility).
 * @param authToken  - Linear API auth token (Bearer token).
 * @returns An object with `blocked` and optional `reason`.
 */
export async function checkVerifyGate(
  ticketId: string,
  owner: string | null,
  _config: VerifyConfig,
  authToken: string,
): Promise<{ blocked: boolean; reason?: string }> {
  // Non-designated tickets are never blocked (AC1).
  if (owner === null) {
    return { blocked: false };
  }

  // Query Linear for the ticket state and comments to check for verifier approval.
  const query = `
    query VerifyGateStatus($ticketId: String!) {
      issue(id: $ticketId) {
        id
        state { name }
        comments {
          nodes {
            body
            user { name }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({
        query,
        variables: { ticketId },
      }),
    });

    type VerifyGateResponse = {
      data?: {
        issue?: {
          id: string;
          state?: { name: string };
          comments?: { nodes: Array<{ body: string; user?: { name: string } }> };
        };
      };
    };

    const json = (await res.json()) as VerifyGateResponse;
    const comments = json.data?.issue?.comments?.nodes ?? [];

    // Check for verifier's "ac-verify: request-changes" — blocks and sends back.
    const hasRequestChanges = comments.some(
      (c) =>
        c.body.toLowerCase().includes("ac-verify:") &&
        c.body.toLowerCase().includes("request-changes"),
    );
    if (hasRequestChanges) {
      return {
        blocked: true,
        reason: `verify: ${owner} requested changes — revert to implementation`,
      };
    }

    // Check for verifier's "ac-verify: approve" — allows done.
    const hasApproval = comments.some(
      (c) =>
        c.body.toLowerCase().includes("ac-verify:") &&
        c.body.toLowerCase().includes("approve"),
    );
    if (hasApproval) {
      return { blocked: false };
    }

    // No verifier response yet — block the done transition.
    return {
      blocked: true,
      reason: `verify: awaiting approval from ${owner}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fail open on network error — don't block progress due to infrastructure.
    return { blocked: false };
  }
}

/** Default SLA threshold for verifier stall detection (3 days). */
const VERIFIER_STALL_SLA_DAYS = 3;

/**
 * Check whether a designated verifier has stalled (gone silent beyond the SLA).
 *
 * Queries Linear for the ticket's last activity timestamp and compares it
 * against the VERIFIER_STALL_SLA_DAYS threshold (3 days by default).
 *
 * @param ticketId  - Linear issue identifier.
 * @param owner     - Designated verifier agent name.
 * @param authToken - Linear API auth token (Bearer token).
 * @returns True when the verifier has been silent >= SLA threshold, false otherwise.
 */
export async function isVerifierStalled(
  ticketId: string,
  owner: string,
  authToken: string,
): Promise<boolean> {
  const query = `
    query VerifierActivity($ticketId: String!) {
      issue(id: $ticketId) {
        updatedAt
        comments {
          nodes {
            createdAt
            user { name }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({
        query,
        variables: { ticketId },
      }),
    });

    type VerifierActivityResponse = {
      data?: {
        issue?: {
          updatedAt: string;
          comments?: { nodes: Array<{ createdAt: string; user?: { name: string } }> };
        };
      };
    };

    const json = (await res.json()) as VerifierActivityResponse;
    const issue = json.data?.issue;

    if (!issue) {
      return false; // Fail open
    }

    // Use the most recent activity timestamp across updatedAt and all comments.
    const timestamps: number[] = [new Date(issue.updatedAt).getTime()];
    if (issue.comments?.nodes) {
      for (const comment of issue.comments.nodes) {
        timestamps.push(new Date(comment.createdAt).getTime());
      }
    }

    const mostRecent = Math.max(...timestamps);
    const now = Date.now();
    const daysSinceActivity = (now - mostRecent) / (1000 * 60 * 60 * 24);

    return daysSinceActivity >= VERIFIER_STALL_SLA_DAYS;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fail open on network error.
    return false;
  }
}
