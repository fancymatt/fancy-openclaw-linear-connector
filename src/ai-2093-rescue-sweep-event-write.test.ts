/**
 * AI-2093 — rescue-sweep operational-event write path.
 *
 * Split out from AI-1981. Two coupled defects were fixed together:
 *
 *   1. rescue-sweep-cron never passed an operationalEventStore into runRescueSweep,
 *      so every rescue:* event was silently dropped and the safety net's own
 *      outcomes were never queryable.
 *   2. The sweep called operationalEventStore.record(...), but the store only
 *      exposes .append(...), and .append threw on the unlisted rescue:* outcome
 *      types — so wiring the store in as-is would have thrown at runtime.
 *
 * These tests lock in the reconciled behaviour:
 *   A. The store accepts the rescue:* outcomes without throwing and they are queryable.
 *   B. A live sweep that rescues a ticket writes a queryable rescue:rescued event
 *      through the injected store (the end-to-end event-write path).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { runRescueSweep } from "./rescue-sweep.js";
import { OperationalEventStore } from "./store/operational-event-store.js";

// Body short name → fake but UUID-shaped Linear user id, mirroring the real fleet.
const BODY_UUID: Record<string, string> = {
  astrid: "5e96646d-0000-4000-8000-000000000001",
  tdd: "5e96646d-0000-4000-8000-000000000002",
  cra: "336fb582-0000-4000-8000-000000000003",
  igor: "4e4d6454-0000-4000-8000-000000000004",
};
const resolveBodyUuid = (bodyId: string): string | null => BODY_UUID[bodyId] ?? null;

const WORKFLOW_DEF = {
  id: "dev-impl",
  entry_state: "intake",
  states: [
    { id: "intake", owner_role: "steward" },
    { id: "write-tests", owner_role: "test-author" },
    { id: "implementation", owner_role: "dev" },
    { id: "code-review", owner_role: "code-review" },
    { id: "done" },
    { id: "escape" },
  ],
};

let tmpDir: string;
let policyPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai2093-rescue-"));
  policyPath = path.join(tmpDir, "capability-policy.yaml");
  fs.writeFileSync(
    policyPath,
    [
      "bodies:",
      "  - id: astrid",
      "    fills_roles: [steward]",
      "  - id: tdd",
      "    fills_roles: [test-author]",
      "  - id: cra",
      "    fills_roles: [code-review]",
      "  - id: igor",
      "    fills_roles: [dev]",
      "",
    ].join("\n"),
    "utf8",
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Linear mock mirroring the AI-1981 harness. Returns the given issues and accepts delegate mutations. */
function makeMock(issues: Array<{ id: string; identifier: string; labels: string[]; delegateId: string | null }>) {
  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(body) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";

    if (query.includes("WorkflowIssues") || query.includes("issues(")) {
      const nodes = issues.map((iss) => ({
        id: iss.id,
        identifier: iss.identifier,
        updatedAt: new Date(0).toISOString(),
        state: { name: "Doing" },
        labels: { nodes: iss.labels.map((name, i) => ({ id: `lbl-${i}`, name })) },
        delegate: iss.delegateId ? { id: iss.delegateId, name: iss.delegateId } : null,
        team: { id: "team-test" },
      }));
      return new Response(JSON.stringify({ data: { issues: { nodes } } }), { status: 200 });
    }

    if (query.includes("TeamLabels")) {
      return new Response(JSON.stringify({ data: { team: { labels: { nodes: [] } } } }), { status: 200 });
    }

    if (query.includes("issueUpdate") && query.includes("delegateId")) {
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 });
    }

    throw new Error(`ai2093-test: unexpected query: ${query.slice(0, 80)}`);
  };
  return { mockFetch };
}

describe("AI-2093 — rescue-sweep operational-event write path", () => {
  it("the store accepts rescue:* outcomes without throwing and they are queryable", () => {
    const store = new OperationalEventStore(":memory:");
    try {
      for (const outcome of ["rescue:rescued", "rescue:ambiguous", "rescue:failed"] as const) {
        expect(() =>
          store.append({ outcome, type: "rescue", detail: { identifier: "AI-9999" } }),
        ).not.toThrow();
      }
      expect(store.query({ outcome: "rescue:rescued" })).toHaveLength(1);
      expect(store.query({ outcome: "rescue:ambiguous" })).toHaveLength(1);
      expect(store.query({ outcome: "rescue:failed" })).toHaveLength(1);
      // The event carries the rescue type + detail, so it is queryable by the safety-net auditor.
      const [event] = store.query({ outcome: "rescue:rescued" });
      expect(event.type).toBe("rescue");
      expect(event.detail).toMatchObject({ identifier: "AI-9999" });
    } finally {
      store.close();
    }
  });

  describe("live sweep event-write path", () => {
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    it("a rescued ticket writes a queryable rescue:rescued event through the injected store", async () => {
      // write-tests is filled by tdd; the ticket has no delegate → dormant → rescued.
      const { mockFetch } = makeMock([
        { id: "uuid-t1", identifier: "AI-2100", labels: ["wf:dev-impl", "state:write-tests"], delegateId: null },
      ]);
      globalThis.fetch = mockFetch;

      const store = new OperationalEventStore(":memory:");
      try {
        const result = await runRescueSweep({
          authToken: "Bearer test",
          capabilityPolicyPath: policyPath,
          workflowRegistry: new Map([["dev-impl", WORKFLOW_DEF]]),
          bodyIdToLinearUserId: resolveBodyUuid,
          operationalEventStore: store,
        });

        expect(result.rescued).toBe(1);
        expect(result.rescues[0]?.outcome).toBe("rescued");

        // The safety net's own outcome reached operational-events.db and is queryable —
        // the AI-1981 pain point (having to reproduce evidence via an instrumented re-run).
        const events = store.query({ outcome: "rescue:rescued" });
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("rescue");
        expect(events[0].detail).toMatchObject({ identifier: "AI-2100", classification: "dormant" });
      } finally {
        store.close();
      }
    });
  });
});
