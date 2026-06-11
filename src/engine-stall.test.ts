/**
 * Tests for Phase 6.5 / H-3 (AI-1478) — Engine stall detection + agent response.
 *
 * Tests the engine-stall.ts facade layer by mocking globalThis.fetch
 * (same pattern as barrier.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  triggerStallDetection,
  registerDeferral,
  unregisterDeferral,
} from "./engine-stall.js";
import {
  deferralAccountant,
  buildStallEvent,
  type StalledChild,
} from "./barrier.js";

// ── triggerStallDetection (integration via mocked fetch) ────────────────

describe("triggerStallDetection", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    deferralAccountant.clearAll();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    deferralAccountant.clearAll();
  });

  it("detects a stalled child and returns events", async () => {
    const now = Date.now();
    const staleTime = new Date(now - 45 * 60 * 1000).toISOString();

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };

      if ((parsed.query ?? "").includes("ParentChildren")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: [
                    { identifier: "AI-2001", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] } },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("ChildActivity")) {
        return new Response(
          JSON.stringify({ data: { issue: { updatedAt: staleTime } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("resolveInternalId") || (parsed.query ?? "").includes("issue(id: $id) { id }")) {
        return new Response(
          JSON.stringify({ data: { issue: { id: "parent-internal-id" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected query: ${(parsed.query ?? "").slice(0, 80)}`);
    };

    const result = await triggerStallDetection("AI-1439", "Bearer tok");

    expect(result.eventsEmitted).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].childIdentifier).toBe("AI-2001");
  });

  it("returns empty when no children are stalled", async () => {
    const now = Date.now();
    const recentTime = new Date(now - 5 * 60 * 1000).toISOString();

    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string };

      if ((parsed.query ?? "").includes("ParentChildren")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: [
                    { identifier: "AI-2001", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] } },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if ((parsed.query ?? "").includes("ChildActivity")) {
        return new Response(
          JSON.stringify({ data: { issue: { updatedAt: recentTime } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`unexpected query: ${(parsed.query ?? "").slice(0, 80)}`);
    };

    const result = await triggerStallDetection("AI-1439", "Bearer tok");

    expect(result.eventsEmitted).toBe(0);
    expect(result.events).toHaveLength(0);
    expect(result.atCapacitySkipped).toBe(0);
  });
});

// ── registerDeferral / unregisterDeferral ────────────────────────────────

describe("registerDeferral / unregisterDeferral", () => {
  beforeEach(() => {
    deferralAccountant.clearAll();
  });

  it("registers a deferral and the accountant tracks it", () => {
    registerDeferral("AI-2001");
    expect(deferralAccountant.isDeferring("AI-2001")).toBe(true);
  });

  it("unregisters a deferral and clears it from the accountant", () => {
    registerDeferral("AI-2001");
    expect(deferralAccountant.isDeferring("AI-2001")).toBe(true);

    unregisterDeferral("AI-2001");
    expect(deferralAccountant.isDeferring("AI-2001")).toBe(false);
  });

  it("does not throw when unregistering a non-existent deferral", () => {
    expect(() => unregisterDeferral("AI-9999")).not.toThrow();
  });
});

// ── Re-exports ──────────────────────────────────────────────────────────

describe("re-exports from barrier.ts", () => {
  it("re-exports buildStallEvent as a function", () => {
    expect(typeof buildStallEvent).toBe("function");
  });

  it("re-exports deferralAccountant singleton", () => {
    expect(deferralAccountant).toBeDefined();
    expect(typeof deferralAccountant.startDeferral).toBe("function");
    expect(typeof deferralAccountant.stopDeferral).toBe("function");
    expect(typeof deferralAccountant.getDeferralMs).toBe("function");
  });
});
