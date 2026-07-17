/**
 * INF-38: Canonical identifier resolver.
 *
 * Resolves the issue UUID (immutable) to the live Linear identifier
 * (mutable — changes on team move). This ensures that dispatches for
 * the same issue pre- and post-move share one sessionKey.
 *
 * Fail-open: returns null on any error, so the caller falls back to
 * the enqueue-time captured identifier.
 */

import type { LinearEvent } from "./webhook/schema.js";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(), "canonical-identifier");

const RESOLVE_QUERY = `query ResolveIdentifier($id: String!) {
  issue(id: $id) {
    identifier
  }
}`;

/** Max 3 retries, exponential backoff from 200ms base. */
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;

/**
 * Extract the issue UUID from a LinearEvent — the one stable identifier
 * that survives team moves.
 *
 * Returns null when the event shape is not recognised or carries no issue
 * reference (e.g. a pure non-issue event).
 */
export function extractIssueUuid(event: LinearEvent): string | null {
  const d = (event.data ?? {}) as Record<string, unknown>;
  const eventType = event.type;

  // For Issue events: data.id is the issue UUID
  if (eventType === "Issue") {
    if (typeof d.id === "string" && d.id) return d.id;
  }

  // For Comment events: data.issueId is the issue UUID (data.id is the comment UUID)
  if (eventType === "Comment") {
    if (typeof d.issueId === "string" && d.issueId) return d.issueId;
  }

  // For unknown event types: try both paths
  if (eventType !== "Issue" && eventType !== "Comment") {
    if (typeof d.id === "string" && d.id) return d.id;
    if (typeof d.issueId === "string" && d.issueId) return d.issueId;
  }

  // Nested issue object (any event type)
  const issue = d.issue as Record<string, unknown> | undefined;
  if (issue && typeof issue.id === "string" && issue.id) return issue.id;

  // AgentSession → issue
  const session = d.agentSession as Record<string, unknown> | undefined;
  const sessionIssue = session?.issue as Record<string, unknown> | undefined;
  if (sessionIssue && typeof sessionIssue.id === "string" && sessionIssue.id) return sessionIssue.id;

  // Notification → issue
  const notification = d.notification as Record<string, unknown> | undefined;
  const notifIssue = notification?.issue as Record<string, unknown> | undefined;
  if (notifIssue && typeof notifIssue.id === "string" && notifIssue.id) return notifIssue.id;

  return null;
}

/**
 * Resolve a Linear issue UUID to its current live identifier via GraphQL.
 *
 * This is the core of the canonicalization: if the issue moved teams
 * post-enqueue, the returned identifier is the *current* one.
 *
 * Returns null on any error (network failure, timeout, malformed response,
 * issue not found) so the caller can fall back to the captured identifier.
 * This is fail-open by design — a resolve failure must never drop a dispatch.
 */
export async function resolveCanonicalIdentifier(
  issueUuid: string,
  authToken: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: authToken,
        },
        body: JSON.stringify({
          query: RESOLVE_QUERY,
          variables: { id: issueUuid },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        // 401 is permanent (bad token) — don't retry
        if (res.status === 401) {
          log.warn(`resolveCanonicalIdentifier: 401 on ${issueUuid} — permanent, not retrying`);
          return null;
        }
        // 429 or 5xx might be transient
        if (res.status === 429 || res.status >= 500) {
          if (attempt < MAX_RETRIES - 1) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt);
            log.warn(
              `resolveCanonicalIdentifier: HTTP ${res.status} on ${issueUuid}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          log.warn(
            `resolveCanonicalIdentifier: HTTP ${res.status} on ${issueUuid}, exhausted retries — falling back`,
          );
          return null;
        }
        // Other status codes (e.g. 400) — fail open immediately
        return null;
      }

      const json = (await res.json()) as {
        data?: { issue?: { identifier?: string } };
        errors?: Array<{ message: string }>;
      };

      if (json.errors && json.errors.length > 0) {
        // GraphQL error — issue not found (moved team and old UUID is gone),
        // no access, etc. Fail open.
        log.warn(
          `resolveCanonicalIdentifier: GraphQL errors for ${issueUuid}: ${json.errors.map((e) => e.message).join("; ")}`,
        );
        return null;
      }

      const liveIdentifier = json.data?.issue?.identifier ?? null;
      if (!liveIdentifier) {
        // Issue returned but with no identifier — shouldn't happen, but fail open
        log.warn(`resolveCanonicalIdentifier: no identifier in response for ${issueUuid}`);
        return null;
      }

      return liveIdentifier;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        log.warn(
          `resolveCanonicalIdentifier: error for ${issueUuid}: ${reason}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        log.warn(
          `resolveCanonicalIdentifier: error for ${issueUuid}: ${reason}, exhausted retries — falling back`,
        );
      }
    }
  }

  return null;
}

/**
 * Resolve the canonical identifier for a Linear event.
 * Returns null when the event has no resolvable UUID, authToken is missing,
 * or the GraphQL call fails (fail-open).
 */
export async function resolveCanonicalIdentifierFromEvent(
  event: LinearEvent,
  authToken: string | undefined,
): Promise<string | null> {
  if (!authToken) return null;

  const issueUuid = extractIssueUuid(event);
  if (!issueUuid) return null;

  return resolveCanonicalIdentifier(issueUuid, authToken);
}
