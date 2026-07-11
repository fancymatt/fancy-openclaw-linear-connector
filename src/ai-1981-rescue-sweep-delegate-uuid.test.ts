/**
 * AI-1981 — rescue-sweep delegate-id resolution regression.
 *
 * The capability policy keys bodies by short name (e.g. "cra"), but the sweep compares
 * against `ticket.delegateId` (a Linear UUID) and passes candidates straight to
 * `setDelegate` (which requires a UUID). Before the fix, every role-constrained ticket
 * classified as "drifted" (a short name is never a UUID) and every corrective
 * `setDelegate` was rejected by Linear with `delegateId must be a UUID` → outcome "failed".
 *
 * These tests inject a body-id → Linear-UUID resolver (the production default is
 * `getLinearUserIdForAgent`) and assert:
 *   1. A correctly-delegated ticket (delegate = the body's Linear UUID) classifies healthy
 *      and is never touched — the false-positive "drifted" is gone.
 *   2. A genuinely dormant ticket is rescued with the body's UUID, not its short name.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { runRescueSweep } from "./rescue-sweep.js";

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai1981-rescue-"));
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

/**
 * Linear mock that records the exact `delegateId` value sent to `setDelegate`.
 * Returns a GraphQL-level error (HTTP 200 + errors[]) when a non-UUID delegateId is used,
 * exactly as the live Linear API does — so a regression to short-name mutations would fail.
 */
function makeMock(issues: Array<{ id: string; identifier: string; labels: string[]; delegateId: string | null }>) {
  const delegateIdsSet: string[] = [];
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
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: [] } } } }),
        { status: 200 },
      );
    }

    if (query.includes("issueUpdate") && query.includes("delegateId")) {
      const delegateId = String((parsed.variables ?? {})["delegateId"] ?? "");
      delegateIdsSet.push(delegateId);
      const isUuid = /^[0-9a-f-]{36}$/i.test(delegateId);
      if (!isUuid) {
        // Mirror Linear: reject non-UUID delegate ids at the GraphQL layer.
        return new Response(
          JSON.stringify({ errors: [{ message: "Argument Validation Error: delegateId must be a UUID" }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 });
    }

    throw new Error(`ai1981-test: unexpected query: ${query.slice(0, 80)}`);
  };
  return { mockFetch, delegateIdsSet };
}

describe("AI-1981 — rescue-sweep resolves body ids to Linear UUIDs", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("a ticket delegated to the body's Linear UUID classifies healthy — no false 'drifted'", async () => {
    // code-review state is filled by cra; the ticket is correctly delegated to cra's UUID.
    const { mockFetch, delegateIdsSet } = makeMock([
      { id: "uuid-t1", identifier: "AI-1953", labels: ["wf:dev-impl", "state:code-review"], delegateId: BODY_UUID.cra },
    ]);
    globalThis.fetch = mockFetch;

    const result = await runRescueSweep({
      authToken: "Bearer test",
      capabilityPolicyPath: policyPath,
      workflowRegistry: new Map([["dev-impl", WORKFLOW_DEF]]),
      bodyIdToLinearUserId: resolveBodyUuid,
    });

    expect(result.byClassification?.healthy ?? 0).toBe(1);
    expect(result.byClassification?.drifted ?? 0).toBe(0);
    expect(result.rescues).toHaveLength(0);
    expect(delegateIdsSet).toHaveLength(0); // never attempted a mutation
  });

  it("a dormant ticket is rescued by setting the body's UUID, not its short name", async () => {
    // write-tests is filled by tdd; the ticket has no delegate → dormant → rescue.
    const { mockFetch, delegateIdsSet } = makeMock([
      { id: "uuid-t2", identifier: "AI-2000", labels: ["wf:dev-impl", "state:write-tests"], delegateId: null },
    ]);
    globalThis.fetch = mockFetch;

    const result = await runRescueSweep({
      authToken: "Bearer test",
      capabilityPolicyPath: policyPath,
      workflowRegistry: new Map([["dev-impl", WORKFLOW_DEF]]),
      bodyIdToLinearUserId: resolveBodyUuid,
    });

    expect(delegateIdsSet).toEqual([BODY_UUID.tdd]); // the UUID, not "tdd"
    expect(result.rescued).toBe(1);
    expect(result.rescues[0]?.outcome).toBe("rescued");
  });
});
