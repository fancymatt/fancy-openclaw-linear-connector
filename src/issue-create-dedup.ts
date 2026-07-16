/**
 * AGI-3: idempotent `issueCreate` dedup guard.
 *
 * Background — the defect this closes is NOT what the ticket assumed. There is no
 * code-level "sprint spawner" and no at-least-once retry anywhere in the create
 * path (`src/client.ts` in the skill CLI issues a single un-retried `axios.post`).
 * GEN-145/146/147 were created by an *agent* (Astrid, `botActor: null`) invoking
 * `linear create` three times in 9 seconds. Why the agent fired three times is not
 * recoverable from the artifacts; a guard that only defends against a specific
 * retry mechanism would therefore defend against nothing.
 *
 * So the guard is deliberately agent-proof rather than mechanism-specific: it sits
 * at the proxy, which every agent's Linear traffic must traverse (the CLI routes
 * through `LINEAR_PROXY_URL`, and a proxy token is useless against api.linear.app
 * directly), and it keys on the *content* of the create rather than on any caller
 * declaration of intent.
 *
 * Semantics are idempotent-replay, not block. A duplicate create is answered with
 * the upstream response from the *first* create, so the caller receives the
 * original issue and observes success. Blocking would be worse: an agent that
 * retried because it believed the first attempt failed would see another failure,
 * which is an invitation to retry again.
 *
 * Scope note: the connector's own fan-out (`src/fanout.ts`) calls the Linear API
 * directly and never traverses the proxy, so it is unaffected by this guard. It
 * has its own dedup (AI-1994), keyed on parent + spec-entry-id markers, which is a
 * different path and does not cover agent-driven creates.
 */

import crypto from "node:crypto";

/**
 * How long an identical create is replayed rather than forwarded.
 *
 * The observed duplicate burst spanned 9s. 60s covers that with margin while
 * staying far below any interval at which a caller could legitimately want a
 * byte-identical ticket in the same team (sprint cycles are days apart).
 */
export const DEFAULT_DEDUP_TTL_MS = 60_000;

export interface IssueCreateInput {
  teamId?: string | null;
  title?: string | null;
  description?: string | null;
}

interface GraphQLBodyLike {
  query?: unknown;
  variables?: unknown;
}

/**
 * Returns the `issueCreate` input when `body` is an issueCreate mutation, else null.
 *
 * Matches on the mutation field name in the query text rather than on
 * `operationName`, which callers choose freely and may omit entirely.
 */
export function extractIssueCreateInput(body: unknown): IssueCreateInput | null {
  const b = body as GraphQLBodyLike | null;
  if (!b || typeof b.query !== "string") return null;
  if (!/\bmutation\b/.test(b.query)) return null;
  if (!/\bissueCreate\s*\(/.test(b.query)) return null;

  const vars = b.variables as Record<string, unknown> | undefined;
  const input = vars?.input as IssueCreateInput | undefined;
  if (!input || typeof input !== "object") return null;
  return input;
}

/**
 * Content fingerprint for an issueCreate.
 *
 * Keyed on agent + team + title + description. Agent is part of the key on
 * purpose: two *different* agents creating identical tickets is a rarer scenario
 * than one agent repeating itself, and silently answering agent B with agent A's
 * issue would be surprising and hard to diagnose. This guard targets the observed
 * failure — one agent, repeated identical creates.
 *
 * Fields are length-prefixed so that no combination of values can be rearranged
 * into the same digest.
 */
export function fingerprintIssueCreate(agentId: string, input: IssueCreateInput): string {
  const parts = [
    agentId,
    input.teamId ?? "",
    input.title ?? "",
    input.description ?? "",
  ];
  const canonical = parts.map((p) => `${p.length}:${p}`).join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * True only when `responseText` is an issueCreate that actually created an issue.
 *
 * Linear answers a rejected mutation with HTTP 200 carrying a GraphQL `errors`
 * array, and `issueCreate` additionally reports a `success` boolean. Caching
 * either kind of failure would replay it onto a legitimate retry, converting a
 * transient failure into a sticky one — so only a genuine success is remembered.
 */
export function isSuccessfulIssueCreate(responseText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return false;
  }
  const p = parsed as { errors?: unknown[]; data?: { issueCreate?: { success?: unknown; issue?: unknown } } };
  if (Array.isArray(p?.errors) && p.errors.length > 0) return false;
  const created = p?.data?.issueCreate;
  return created?.success === true && Boolean(created?.issue);
}

export type Claim =
  /** An identical create already succeeded inside the TTL — replay this response. */
  | { kind: "replay"; responseText: string }
  /** An identical create is in flight — await it, then replay its response. */
  | { kind: "await"; wait: Promise<string | null> }
  /**
   * Caller owns the forward. Exactly one of settle()/abandon() must be called, or
   * concurrent claimants will wait forever.
   */
  | { kind: "forward"; settle: (responseText: string) => void; abandon: () => void };

interface Entry {
  expiresAt: number;
  responseText?: string;
  pending?: Promise<string | null>;
  resolve?: (value: string | null) => void;
}

/**
 * TTL cache mapping a create fingerprint to the first successful upstream response.
 *
 * Process-local by design: the connector is a single process and this guard is a
 * mitigation for a burst of duplicate creates, not a distributed lock. A restart
 * mid-burst reopens the window; that is an accepted limit, not an oversight.
 */
export class IssueCreateDedupCache {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_DEDUP_TTL_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Claim the right to forward a create, or receive the prior result.
   *
   * Only successful creates are remembered. A create that fails upstream is
   * abandoned, so the caller is free to legitimately retry it.
   */
  claim(hash: string): Claim {
    this.evictExpired();

    const existing = this.entries.get(hash);
    if (existing) {
      if (existing.responseText !== undefined) {
        return { kind: "replay", responseText: existing.responseText };
      }
      if (existing.pending) {
        return { kind: "await", wait: existing.pending };
      }
    }

    let resolve!: (value: string | null) => void;
    const pending = new Promise<string | null>((r) => {
      resolve = r;
    });
    const entry: Entry = { expiresAt: this.now() + this.ttlMs, pending, resolve };
    this.entries.set(hash, entry);

    let done = false;
    return {
      kind: "forward",
      settle: (responseText: string) => {
        if (done) return;
        done = true;
        entry.responseText = responseText;
        entry.expiresAt = this.now() + this.ttlMs;
        entry.pending = undefined;
        entry.resolve = undefined;
        resolve(responseText);
      },
      abandon: () => {
        if (done) return;
        done = true;
        this.entries.delete(hash);
        resolve(null);
      },
    };
  }

  private evictExpired(): void {
    const t = this.now();
    for (const [hash, entry] of this.entries) {
      // An in-flight entry is never evicted: its awaiters still need the result.
      if (entry.pending === undefined && entry.expiresAt <= t) {
        this.entries.delete(hash);
      }
    }
  }

  /** Test seam. */
  size(): number {
    return this.entries.size;
  }
}
