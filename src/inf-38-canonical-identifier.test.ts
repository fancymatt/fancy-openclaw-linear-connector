/**
 * INF-38: dispatch routing must key off the stable issue UUID, not the mutable
 * identifier.
 *
 * A team move retires an issue's identifier (`AI-2535` → `INF-27`). Webhook
 * payloads snapshot the identifier live at emit time, so a pre-move and a
 * post-move event for one issue carried two different identifiers → two session
 * keys → two concurrent sessions racing one ticket.
 *
 * These tests drive the resolve and the routing COMPOSED, the way
 * `webhook/index.ts` does, with only `fetch` mocked. Handing a pre-computed
 * canonical identifier straight to `routeEventAll` would assert the plumbing
 * while mocking away the premise.
 *
 * The external property these rest on — that Linear's `issue(id:)` returns the
 * *live* identifier, and accepts a UUID — was verified live against the API
 * before this was written; a mocked suite cannot establish it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jest } from "@jest/globals";
import { routeEventAll } from "./router.js";
import {
  extractIssueUuid,
  resolveCanonicalIdentifier,
  __clearCanonicalIdentifierCache,
} from "./canonical-identifier.js";
import { buildDeliveryMessage } from "./delivery/build-message.js";
import { issueIdentifierFromEvent } from "./linear-actionable.js";
import { reloadAgents } from "./agents.js";
import type { LinearEvent } from "./webhook/schema.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The real moved issue this ticket was cut from: AI-2535 → INF-27. */
const ISSUE_UUID = "bed2ae71-4e08-4b69-9d41-c276ca637d63";
const RETIRED_IDENTIFIER = "AI-2535";
const LIVE_IDENTIFIER = "INF-27";

const IGOR_LINEAR_ID = "igor-linear-user-id";

function makeTempAgentsFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf38-test-"));
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [{ name: "igor", linearUserId: IGOR_LINEAR_ID, openclawAgent: "igor" }],
    }),
  );
  return file;
}

/**
 * An Issue delegate event carrying `identifier` as captured at emit time and the
 * stable `id` (UUID) that Linear puts on every issue payload.
 */
function makeIssueEvent(identifier: string): LinearEvent {
  return {
    type: "Issue",
    action: "update",
    actor: { id: "actor-human", name: "Matt Henry" },
    updatedFrom: { delegateId: "someone-else" },
    data: {
      id: ISSUE_UUID,
      identifier,
      title: "sprint-spawner: empty barrier auto-satisfies",
      delegate: { id: IGOR_LINEAR_ID, name: "Igor (Back End Dev)" },
      state: { id: "s1", name: "To Do", type: "unstarted" },
      updatedAt: "2026-07-17T00:00:00.000Z",
      team: { key: identifier.split("-")[0] },
    },
  } as unknown as LinearEvent;
}

/** Mock Linear returning the live identifier for the issue UUID. */
function mockResolveOk(liveIdentifier: string): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { issue: { id: ISSUE_UUID, identifier: liveIdentifier } } }),
  }));
  (globalThis as { fetch: unknown }).fetch = fn as unknown;
  return fn as unknown as jest.Mock;
}

/**
 * Route an event exactly as `webhook/index.ts` does: resolve the canonical
 * identifier from the event's UUID, then route on it.
 */
async function routeAsWebhookDoes(event: LinearEvent) {
  const canonical = await resolveCanonicalIdentifier(event, issueIdentifierFromEvent(event));
  return { canonical, routes: routeEventAll(event, canonical ?? undefined) };
}

// ── Setup ────────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let agentsFile: string;

beforeEach(() => {
  agentsFile = makeTempAgentsFile();
  process.env.AGENTS_FILE = agentsFile;
  process.env.LINEAR_OAUTH_TOKEN = "test-token";
  reloadAgents();
  __clearCanonicalIdentifierCache();
});

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete process.env.AGENTS_FILE;
  delete process.env.LINEAR_OAUTH_TOKEN;
  __clearCanonicalIdentifierCache();
});

// ── AC3: one issue, one session key, across a team move ──────────────────────

describe("INF-38 AC3: a pre-move and a post-move event produce one session key", () => {
  it("collapses the fork — both events route to the live identifier's key", async () => {
    mockResolveOk(LIVE_IDENTIFIER);

    // Enqueued before the move: the payload says AI-2535.
    const preMove = await routeAsWebhookDoes(makeIssueEvent(RETIRED_IDENTIFIER));
    // Emitted after the move: the payload says INF-27.
    const postMove = await routeAsWebhookDoes(makeIssueEvent(LIVE_IDENTIFIER));

    expect(preMove.routes).toHaveLength(1);
    expect(postMove.routes).toHaveLength(1);

    // The defect: these were `linear-AI-2535` and `linear-INF-27`.
    expect(preMove.routes[0].sessionKey).toBe(`linear-${LIVE_IDENTIFIER}`);
    expect(postMove.routes[0].sessionKey).toBe(`linear-${LIVE_IDENTIFIER}`);
    expect(preMove.routes[0].sessionKey).toBe(postMove.routes[0].sessionKey);
  });

  it("canonicalises the idempotency PK for free — ticket_key == sessionKey", async () => {
    mockResolveOk(LIVE_IDENTIFIER);

    const preMove = await routeAsWebhookDoes(makeIssueEvent(RETIRED_IDENTIFIER));
    const postMove = await routeAsWebhookDoes(makeIssueEvent(LIVE_IDENTIFIER));

    // webhook/index.ts: `const ticketId = route.sessionKey`. One key ⇒ one PK
    // row for (ticket_key, workflow_state, agent) ⇒ no migration needed.
    const preTicketId = preMove.routes[0].sessionKey;
    const postTicketId = postMove.routes[0].sessionKey;
    expect(preTicketId).toBe(postTicketId);
  });
});

// ── Grover's AC: renamed-team tickets must be a strict no-op ─────────────────

describe("INF-38: renamed team keeps its identifier — canonicalisation is a no-op", () => {
  it("routes a still-in-team-AI ticket to its unchanged key", async () => {
    // Renaming a team ("AI" → "OLD AI Systems") preserves identifiers, so the
    // resolve returns the same string it was given. ~120 live AI sessions depend
    // on this being a no-op.
    mockResolveOk("AI-2545");

    const { routes } = await routeAsWebhookDoes(makeIssueEvent("AI-2545"));

    expect(routes[0].sessionKey).toBe("linear-AI-2545");
  });
});

// ── The hard AC: fail-open. A resolve failure must never drop a dispatch. ────

describe("INF-38: fail-open — a resolve failure falls back, never drops", () => {
  const failures: Array<[string, () => void]> = [
    ["HTTP error", () => {
      (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false, status: 500, json: async () => ({}),
      })) as unknown;
    }],
    ["GraphQL errors (how Linear reports not-found)", () => {
      (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: "Entity not found: Issue" }], data: null }),
      })) as unknown;
    }],
    ["network throw", () => {
      (globalThis as { fetch: unknown }).fetch = jest.fn(async () => {
        throw new Error("ECONNRESET");
      }) as unknown;
    }],
    ["response without an identifier", () => {
      (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: true, status: 200, json: async () => ({ data: { issue: { id: ISSUE_UUID } } }),
      })) as unknown;
    }],
    ["no token configured", () => {
      delete process.env.LINEAR_OAUTH_TOKEN;
      delete process.env.LINEAR_API_KEY;
      (globalThis as { fetch: unknown }).fetch = jest.fn(async () => {
        throw new Error("fetch must not be called without a token");
      }) as unknown;
    }],
  ];

  for (const [label, arrange] of failures) {
    it(`${label}: still dispatches, on the captured identifier`, async () => {
      arrange();

      const { canonical, routes } = await routeAsWebhookDoes(makeIssueEvent(RETIRED_IDENTIFIER));

      expect(canonical).toBeNull();
      // The dispatch survives — this is the whole point of fail-open.
      expect(routes).toHaveLength(1);
      expect(routes[0].sessionKey).toBe(`linear-${RETIRED_IDENTIFIER}`);
      expect(routes[0].canonicalIdentifier).toBeUndefined();
    });
  }

  it("an event with no issue UUID routes on the capture without calling Linear", async () => {
    const fetchMock = mockResolveOk(LIVE_IDENTIFIER);
    const event = makeIssueEvent(RETIRED_IDENTIFIER);
    delete (event.data as Record<string, unknown>).id;

    const { canonical, routes } = await routeAsWebhookDoes(event);

    expect(canonical).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routes[0].sessionKey).toBe(`linear-${RETIRED_IDENTIFIER}`);
  });
});

// ── AC2: the rendered identifier is the live one ─────────────────────────────

describe("INF-38 AC2: the dispatch message renders the live identifier", () => {
  it("renders INF-27, not the retired AI-2535 the payload captured", async () => {
    mockResolveOk(LIVE_IDENTIFIER);

    const { routes } = await routeAsWebhookDoes(makeIssueEvent(RETIRED_IDENTIFIER));
    const message = await buildDeliveryMessage(routes[0]);

    // An agent told to work AI-2535 would be handed a retired identifier.
    expect(message).toContain(LIVE_IDENTIFIER);
    expect(message).not.toContain(RETIRED_IDENTIFIER);
  });

  it("falls back to the captured identifier when the resolve failed", async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown;

    const { routes } = await routeAsWebhookDoes(makeIssueEvent(RETIRED_IDENTIFIER));
    const message = await buildDeliveryMessage(routes[0]);

    expect(message).toContain(RETIRED_IDENTIFIER);
  });
});

// ── UUID extraction: the resolve is only as good as the UUID it is given ─────

describe("INF-38 extractIssueUuid", () => {
  it("reads the issue UUID from an Issue event", () => {
    expect(extractIssueUuid(makeIssueEvent(LIVE_IDENTIFIER))).toBe(ISSUE_UUID);
  });

  it("reads the nested issue UUID from a Comment event — NOT the comment's own id", () => {
    // The trap: `data.id` on a Comment event is the comment's UUID. Resolving it
    // would look up the wrong entity, or silently fail-open forever.
    const event = {
      type: "Comment",
      action: "create",
      actor: { id: "actor-human", name: "Matt Henry" },
      data: {
        id: "11111111-2222-3333-4444-555555555555", // comment UUID
        body: "a comment",
        issue: { id: ISSUE_UUID, identifier: LIVE_IDENTIFIER },
      },
    } as unknown as LinearEvent;

    expect(extractIssueUuid(event)).toBe(ISSUE_UUID);
  });

  it("reads the issue UUID from an AgentSessionEvent", () => {
    const event = {
      type: "AgentSessionEvent",
      action: "created",
      actor: { id: "actor-human", name: "Matt Henry" },
      data: { agentSession: { issue: { id: ISSUE_UUID, identifier: LIVE_IDENTIFIER } } },
    } as unknown as LinearEvent;

    expect(extractIssueUuid(event)).toBe(ISSUE_UUID);
  });

  it("rejects a non-UUID id rather than resolving garbage", () => {
    const event = {
      type: "Issue",
      action: "update",
      data: { id: "AI-2535", identifier: "AI-2535" },
    } as unknown as LinearEvent;

    expect(extractIssueUuid(event)).toBeNull();
  });
});

// ── Observability: the moved-mid-flight signal Grover asked for ──────────────

describe("INF-38: resolve is cached per issue UUID", () => {
  it("does not re-query Linear when the event agrees with the cache", async () => {
    const fetchMock = mockResolveOk(LIVE_IDENTIFIER);

    // Two events both stamped INF-27 — the cache is corroborated, serve it.
    await routeAsWebhookDoes(makeIssueEvent(LIVE_IDENTIFIER));
    await routeAsWebhookDoes(makeIssueEvent(LIVE_IDENTIFIER));

    // Routing is a hot path; the steady-state case must cost one round-trip.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT serve a stale identifier when the issue moves inside the TTL", async () => {
    // A TTL cache over a mutable key re-opens the fork on a delay: cache AI-2535
    // at T=0, move at T=1min, and every event until T=5min routes to the retired
    // key — then the key flips underneath the ticket when the entry expires.
    const fetchMock = mockResolveOk(RETIRED_IDENTIFIER);
    const before = await routeAsWebhookDoes(makeIssueEvent(RETIRED_IDENTIFIER));
    expect(before.routes[0].sessionKey).toBe(`linear-${RETIRED_IDENTIFIER}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The issue moves. Linear now stamps INF-27 on events and resolves to INF-27.
    mockResolveOk(LIVE_IDENTIFIER);
    const after = await routeAsWebhookDoes(makeIssueEvent(LIVE_IDENTIFIER));

    // The event disagreed with the cache, so the cache was not trusted.
    expect(after.routes[0].sessionKey).toBe(`linear-${LIVE_IDENTIFIER}`);
  });

  it("re-resolves when a late pre-move event disagrees with a fresh cache", async () => {
    mockResolveOk(LIVE_IDENTIFIER);
    await routeAsWebhookDoes(makeIssueEvent(LIVE_IDENTIFIER));

    // A pre-move event arrives late, still stamped AI-2535. It disagrees with the
    // cache, so it re-resolves — and lands on the same live key, not a fork.
    const fetchMock = mockResolveOk(LIVE_IDENTIFIER);
    const late = await routeAsWebhookDoes(makeIssueEvent(RETIRED_IDENTIFIER));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(late.routes[0].sessionKey).toBe(`linear-${LIVE_IDENTIFIER}`);
  });
});
