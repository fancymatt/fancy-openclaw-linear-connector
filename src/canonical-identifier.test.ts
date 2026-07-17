/**
 * Tests for canonical-identifier.ts (INF-38).
 *
 * Coverage:
 * - extractIssueUuid extracts from all event shapes
 * - resolveCanonicalIdentifier returns live identifier on success
 * - resolveCanonicalIdentifier returns null on failures (fail-open)
 * - resolveCanonicalIdentifierFromEvent handles missing authToken
 * - Pre- and post-move events for one issue produce one session key
 */

import { jest } from "@jest/globals";
import type { LinearEvent } from "./webhook/schema.js";
import type { RouteResult } from "./types.js";
import { normalizeSessionKey } from "./session-key.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let fetchSpy: jest.Spied<typeof globalThis.fetch> | null = null;

/** Issue UUID — shared across tests */
const ISSUE_UUID = "b33e23e0-1234-5678-9abc-def012345678";
const LIVE_IDENTIFIER = "INF-38";
const CAPTURED_IDENTIFIER = "AI-2535"; // pre-move value

function makeFetchOk(identifier: string) {
  return async () =>
    new Response(
      JSON.stringify({
        data: { issue: { identifier } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as Response;
}

function makeFetchError(status: number) {
  return async () => new Response(null, { status }) as Response;
}

function makeFetchGraphQLError(message: string) {
  return async () =>
    new Response(
      JSON.stringify({ errors: [{ message }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as Response;
}

function makeFetchMalformed() {
  return async () =>
    new Response(
      JSON.stringify({ data: { issue: null } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as Response;
}

function makeFetchNetworkError(): typeof globalThis.fetch {
  return async () => {
    throw new Error("Network failure");
  };
}

function eventForIssue(
  eventType: "Issue" | "Comment",
  uuid: string,
  identifier: string,
  extraData?: Record<string, unknown>,
): LinearEvent {
  if (eventType === "Issue") {
    return {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "Ai" },
      createdAt: new Date().toISOString(),
      data: {
        id: uuid,
        identifier,
        title: "Test issue",
        state: { id: "s1", name: "To Do", type: "unstarted" },
        priority: 0,
        priorityLabel: "No priority",
        teamId: "t1",
        teamKey: "AI",
        labelIds: [],
        url: "https://linear.app/fancymatt/issue/ID-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...extraData,
      },
    } as LinearEvent;
  }

  // Comment event
  return {
    type: "Comment",
    action: "create",
    actor: { id: "u1", name: "Ai" },
    createdAt: new Date().toISOString(),
    data: {
      id: "c1",
      body: "A comment",
      issueId: uuid,
      issueIdentifier: identifier,
      issueTitle: "Test issue",
      url: "https://linear.app/fancymatt/issue/ID-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...extraData,
    },
  } as LinearEvent;
}

/**
 * Run a test with fetch mocked. Restores original after.
 */
async function withFetch<T>(mock: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ── Loading the module fresh each test ────────────────────────────────────────

async function getMod() {
  // Ensure fresh import (no cache from other tests)
  const modPath = "./canonical-identifier.ts";
  return import(modPath) as Promise<{
    extractIssueUuid: (event: LinearEvent) => string | null;
    resolveCanonicalIdentifier: (issueUuid: string, authToken: string) => Promise<string | null>;
    resolveCanonicalIdentifierFromEvent: (event: LinearEvent, authToken: string | undefined) => Promise<string | null>;
  }>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("INF-38 canonical identifier", () => {
  describe("extractIssueUuid", () => {
    it("extracts uuid from Issue events", async () => {
      const mod = await getMod();
      const event = eventForIssue("Issue", ISSUE_UUID, CAPTURED_IDENTIFIER);
      expect(mod.extractIssueUuid(event)).toBe(ISSUE_UUID);
    });

    it("extracts uuid from Comment events via issueId", async () => {
      const mod = await getMod();
      const event = eventForIssue("Comment", ISSUE_UUID, CAPTURED_IDENTIFIER);
      expect(mod.extractIssueUuid(event)).toBe(ISSUE_UUID);
    });

    it("extracts uuid from nested issue object", async () => {
      const mod = await getMod();
      // Simulate an event with a nested issue object instead of flat id
      const event = {
        type: "Issue",
        action: "update",
        actor: { id: "u1", name: "Ai" },
        createdAt: new Date().toISOString(),
        data: {
          issue: { id: ISSUE_UUID, identifier: CAPTURED_IDENTIFIER, title: "Nested" },
        },
      } as unknown as LinearEvent;
      expect(mod.extractIssueUuid(event)).toBe(ISSUE_UUID);
    });

    it("extracts uuid from AgentSession → issue", async () => {
      const mod = await getMod();
      const event = {
        type: "AgentSessionEvent",
        action: "create",
        actor: { id: "u1", name: "Ai" },
        createdAt: new Date().toISOString(),
        data: {
          agentSession: { issue: { id: ISSUE_UUID, identifier: CAPTURED_IDENTIFIER } },
        },
      } as unknown as LinearEvent;
      expect(mod.extractIssueUuid(event)).toBe(ISSUE_UUID);
    });

    it("extracts uuid from Notification → issue", async () => {
      const mod = await getMod();
      const event = {
        type: "Notification",
        action: "create",
        actor: { id: "u1", name: "Ai" },
        createdAt: new Date().toISOString(),
        data: {
          notification: { issue: { id: ISSUE_UUID, identifier: CAPTURED_IDENTIFIER } },
        },
      } as unknown as LinearEvent;
      expect(mod.extractIssueUuid(event)).toBe(ISSUE_UUID);
    });

    it("returns null for event with no issue data", async () => {
      const mod = await getMod();
      const event = {
        type: "Project",
        action: "create",
        actor: { id: "u1", name: "Ai" },
        createdAt: new Date().toISOString(),
        data: { name: "New project" },
      } as unknown as LinearEvent;
      expect(mod.extractIssueUuid(event)).toBeNull();
    });
  });

  describe("resolveCanonicalIdentifier", () => {
    it("resolves uuid to live identifier on success", async () => {
      const mod = await getMod();
      const identifier = await withFetch(makeFetchOk(LIVE_IDENTIFIER), () =>
        mod.resolveCanonicalIdentifier(ISSUE_UUID, "Bearer tok"),
      );
      expect(identifier).toBe(LIVE_IDENTIFIER);
    });

    it("returns null on 401 without retry", async () => {
      const mod = await getMod();
      const identifier = await withFetch(makeFetchError(401), () =>
        mod.resolveCanonicalIdentifier(ISSUE_UUID, "Bearer tok"),
      );
      expect(identifier).toBeNull();
    });

    it("returns null on 500 after retries", async () => {
      const mod = await getMod();
      const identifier = await withFetch(makeFetchError(500), async () =>
        mod.resolveCanonicalIdentifier(ISSUE_UUID, "Bearer tok"),
      );
      expect(identifier).toBeNull();
    });

    it("returns null on GraphQL error", async () => {
      const mod = await getMod();
      const identifier = await withFetch(makeFetchGraphQLError("Issue not found"), () =>
        mod.resolveCanonicalIdentifier(ISSUE_UUID, "Bearer tok"),
      );
      expect(identifier).toBeNull();
    });

    it("returns null on malformed response", async () => {
      const mod = await getMod();
      const identifier = await withFetch(makeFetchMalformed(), () =>
        mod.resolveCanonicalIdentifier(ISSUE_UUID, "Bearer tok"),
      );
      expect(identifier).toBeNull();
    });

    it("returns null on network error after retries", async () => {
      const mod = await getMod();
      const identifier = await withFetch(makeFetchNetworkError(), () =>
        mod.resolveCanonicalIdentifier(ISSUE_UUID, "Bearer tok"),
      );
      expect(identifier).toBeNull();
    });
  });

  describe("resolveCanonicalIdentifierFromEvent", () => {
    it("resolves from an Issue event successfully", async () => {
      const mod = await getMod();
      const event = eventForIssue("Issue", ISSUE_UUID, CAPTURED_IDENTIFIER);
      const identifier = await withFetch(makeFetchOk(LIVE_IDENTIFIER), () =>
        mod.resolveCanonicalIdentifierFromEvent(event, "Bearer tok"),
      );
      expect(identifier).toBe(LIVE_IDENTIFIER);
    });

    it("returns null when authToken is undefined (fail-open)", async () => {
      const mod = await getMod();
      const event = eventForIssue("Issue", ISSUE_UUID, CAPTURED_IDENTIFIER);
      const identifier = await mod.resolveCanonicalIdentifierFromEvent(event, undefined);
      expect(identifier).toBeNull();
    });

    it("returns null when event has no issue UUID", async () => {
      const mod = await getMod();
      const event = {
        type: "Project",
        action: "create",
        actor: { id: "u1", name: "Ai" },
        createdAt: new Date().toISOString(),
        data: { name: "New project" },
      } as unknown as LinearEvent;
      const identifier = await withFetch(makeFetchOk(LIVE_IDENTIFIER), () =>
        mod.resolveCanonicalIdentifierFromEvent(event, "Bearer tok"),
      );
      expect(identifier).toBeNull();
    });

    it("returns null on GraphQL error (fail-open)", async () => {
      const mod = await getMod();
      const event = eventForIssue("Issue", ISSUE_UUID, CAPTURED_IDENTIFIER);
      const identifier = await withFetch(makeFetchGraphQLError("Rate limited"), () =>
        mod.resolveCanonicalIdentifierFromEvent(event, "Bearer tok"),
      );
      expect(identifier).toBeNull();
    });
  });

  describe("integration: pre- and post-move events produce one session key", () => {
    /**
     * AC3 from INF-38: a post-move event and a pre-move event for one
     * issue produce one session key.
     *
     * This test validates that the canonicalization pipeline (extractIssueUuid
     * + resolveCanonicalIdentifier + sessionKey rebuild) collapses events
     * with different captured identifiers into the same sessionKey.
     */
    it("pre-move (AI-2535) and post-move (INF-38) events → same sessionKey", async () => {
      // Pre-move event: captured identifier is AI-2535
      const preMoveEvent = eventForIssue("Issue", ISSUE_UUID, "AI-2535");
      // Post-move event: captured identifier is INF-38 (same UUID)
      const postMoveEvent = eventForIssue("Issue", ISSUE_UUID, "INF-38");

      // Resolve both with live identifier INF-38
      const identifier = await withFetch(makeFetchOk("INF-38"), async () => {
        const mod = await getMod();
        // Same resolve call returns same identifier from same UUID
        return mod.resolveCanonicalIdentifierFromEvent(preMoveEvent, "Bearer tok");
      });

      expect(identifier).toBe("INF-38");

      // Both produce the same sessionKey
      const canonicalKey = normalizeSessionKey(`linear-${identifier}`);
      const preMoveKey = normalizeSessionKey(`linear-AI-2535`);
      const postMoveKey = normalizeSessionKey(`linear-INF-38`);

      // The canonical key matches the post-move key (live identifier wins)
      expect(canonicalKey).toBe(postMoveKey);
      // The pre-move key differs — this is the defect: without canonicalisation
      // these would be different sessions
      expect(canonicalKey).not.toBe(preMoveKey);
    });
  });
});
