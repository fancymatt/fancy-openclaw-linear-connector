/**
 * INF-38: canonicalise the issue identifier before it is used as a routing key.
 *
 * Linear identifiers are MUTABLE. Moving an issue between teams retires its
 * identifier and mints a new one (`AI-2535` → `INF-27`), but the issue UUID is
 * stable for the life of the issue. Webhook payloads snapshot the identifier
 * that was live when the event was *emitted*, so a pre-move event and a
 * post-move event for one issue carry two different identifiers. Because the
 * session key is identifier-derived (`router.ts`, `linear-${identifier}`) and
 * the dispatch idempotency PK *is* that session key
 * (`webhook/index.ts`, `const ticketId = route.sessionKey`), those two events
 * fork one ticket into two concurrent sessions racing each other.
 *
 * Resolving the UUID to the identifier that is live *now* collapses both events
 * onto one key. Because `ticket_key == sessionKey`, canonicalising the key
 * canonicalises the idempotency PK for free — no table migration.
 *
 * Fail-open is a hard requirement: this sits on the routing hot path, and a
 * resolve failure must degrade to the enqueue-time identifier (the current
 * behaviour) rather than drop a dispatch. Every failure mode here returns
 * `null`, and every caller treats `null` as "use the captured identifier".
 */

import { createLogger, componentLogger } from "./logger.js";

const log = componentLogger(createLogger(), "canonical-identifier");

/** How long a resolved UUID→identifier mapping stays cached. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Bound the cache so a long-lived process cannot grow it without limit. */
const CACHE_MAX_ENTRIES = 1000;

/** Wall-clock bound on the resolve. The routing path must not hang on Linear. */
const RESOLVE_TIMEOUT_MS = 5000;

interface CacheEntry {
  identifier: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Linear issue UUID shape. Guards against feeding an identifier to the UUID path. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isIssueUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Pull the issue UUID out of an event.
 *
 * Mirrors the shapes `extractIssueIdentifier` (router.ts) walks, but reads `id`
 * instead of `identifier`. The normalizer already surfaces the UUID on typed
 * output (`webhook/normalize.ts`, `id: String(data.id ?? "")`).
 *
 * Only returns values that look like UUIDs: on a Comment event `data.id` is the
 * *comment's* UUID, not the issue's, so an unvalidated read would resolve the
 * wrong entity. Nested `issue.id` is therefore checked before the top-level
 * `data.id`, and the `Issue`-typed top-level read is gated on the event type.
 */
export function extractIssueUuid(event: {
  type?: string;
  data?: unknown;
}): string | null {
  const d = (event.data ?? {}) as Record<string, unknown>;

  // Nested issue object (Comment events, notifications) — checked FIRST because
  // on those events the top-level `id` belongs to the comment/notification.
  const issue = d.issue as Record<string, unknown> | undefined;
  if (issue && isIssueUuid(issue.id)) return issue.id;

  // AgentSession → issue
  const session = d.agentSession as Record<string, unknown> | undefined;
  const sessionIssue = session?.issue as Record<string, unknown> | undefined;
  if (sessionIssue && isIssueUuid(sessionIssue.id)) return sessionIssue.id;

  // Notification → issue
  const notification = d.notification as Record<string, unknown> | undefined;
  const notifIssue = notification?.issue as Record<string, unknown> | undefined;
  if (notifIssue && isIssueUuid(notifIssue.id)) return notifIssue.id;

  // Explicit issue-UUID field, whatever the event type.
  if (isIssueUuid(d.issueId)) return d.issueId;

  // Top-level `id` is the issue's own UUID only on Issue events.
  if (event.type === "Issue" && isIssueUuid(d.id)) return d.id;

  return null;
}

function tokenFromEnv(): string | undefined {
  return process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
}

function linearAuthorizationHeader(token: string): string {
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

/**
 * Read the cache, but only trust it when the event agrees with it.
 *
 * A TTL alone is not sound here: the thing being cached is exactly the thing
 * that mutates. If an issue moves inside the TTL, a cached entry keeps serving
 * the retired identifier until it expires — and then the key changes underneath
 * the ticket, which is the fork this ticket exists to close, merely delayed.
 *
 * The event carries a free freshness signal: the identifier Linear stamped on it
 * at emit time. When that agrees with the cached value, the cache is corroborated
 * by an independent observation and is served. Any disagreement means one of the
 * two is stale and we cannot tell which from here — so re-resolve and let Linear
 * settle it. In steady state (~98% of events, per the INF-38 measurement) the two
 * agree and the resolve costs nothing; a move costs one extra query, once.
 */
function cacheGet(uuid: string, capturedIdentifier: string | null): string | null {
  const hit = cache.get(uuid);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(uuid);
    return null;
  }
  if (capturedIdentifier && capturedIdentifier !== hit.identifier) {
    // The event disagrees with the cache — treat the cache as suspect, not the
    // event. Re-resolving is the only way to learn which one Linear agrees with.
    cache.delete(uuid);
    return null;
  }
  return hit.identifier;
}

function cacheSet(uuid: string, identifier: string): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Cheap bound: drop the oldest insertion. Map preserves insertion order.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(uuid, { identifier, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Test seam. */
export function __clearCanonicalIdentifierCache(): void {
  cache.clear();
}

/**
 * Resolve an issue UUID to the identifier that is live right now.
 *
 * Returns `null` on every failure — no token, not a UUID, network error, HTTP
 * error, GraphQL error, timeout, or a response without an identifier. Callers
 * MUST treat `null` as "fall back to the enqueue-time identifier".
 */
export async function resolveIdentifierByUuid(
  uuid: string,
  capturedIdentifier: string | null,
  token?: string,
): Promise<string | null> {
  if (!isIssueUuid(uuid)) return null;

  const cached = cacheGet(uuid, capturedIdentifier);
  if (cached) return cached;

  const authToken = token ?? tokenFromEnv();
  if (!authToken) {
    log.warn(`canonical-identifier: no Linear token available; falling back to captured identifier for ${uuid}`);
    return null;
  }

  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: linearAuthorizationHeader(authToken),
      },
      body: JSON.stringify({
        query: `query CanonicalIdentifier($id: String!) {
          issue(id: $id) { id identifier }
        }`,
        variables: { id: uuid },
      }),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn(`canonical-identifier: resolve failed for ${uuid}: HTTP ${response.status} — falling back`);
      return null;
    }

    const body = (await response.json()) as {
      data?: { issue?: { id?: string; identifier?: string } | null };
      errors?: Array<{ message?: string }>;
    };

    // A not-found issue arrives as `errors[] + data:null`, not `data.issue:null`
    // (verified live against Linear). Either way this is a fall-back, never a
    // drop — deciding a dispatch is a phantom is not this function's job.
    if (body.errors?.length) {
      log.warn(
        `canonical-identifier: resolve errored for ${uuid}: ` +
        `${body.errors.map((e) => e.message).join("; ")} — falling back`,
      );
      return null;
    }

    const identifier = body.data?.issue?.identifier;
    if (typeof identifier !== "string" || !identifier) {
      log.warn(`canonical-identifier: resolve returned no identifier for ${uuid} — falling back`);
      return null;
    }

    cacheSet(uuid, identifier);
    return identifier;
  } catch (err) {
    log.warn(
      `canonical-identifier: resolve threw for ${uuid}: ` +
      `${err instanceof Error ? err.message : String(err)} — falling back`,
    );
    return null;
  }
}

/**
 * Resolve the live identifier for the issue an event refers to.
 *
 * Returns `null` when the event carries no issue UUID or the resolve fails; the
 * caller then keeps using the enqueue-time identifier.
 *
 * Logs when the resolved identifier differs from the one captured in the
 * payload — that is the moved-mid-flight signal, and the only direct
 * measurement of how often this fires in production.
 */
export async function resolveCanonicalIdentifier(
  event: { type?: string; data?: unknown },
  capturedIdentifier: string | null,
  token?: string,
): Promise<string | null> {
  const uuid = extractIssueUuid(event);
  if (!uuid) return null;

  const canonical = await resolveIdentifierByUuid(uuid, capturedIdentifier, token);
  if (!canonical) return null;

  if (capturedIdentifier && canonical !== capturedIdentifier) {
    log.warn(
      `canonical-identifier: identifier moved — event captured ${capturedIdentifier}, ` +
      `live is ${canonical} (issue ${uuid}); routing on ${canonical}`,
    );
  }

  return canonical;
}
