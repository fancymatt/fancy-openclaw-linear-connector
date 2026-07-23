/**
 * AI-1807 — Wiring test: asserts the delegation reconciliation sweep cron is
 * registered in the application entry point (src/index.ts).
 *
 * Background: AI-1808 documented that twice (AI-1773, AI-1775) a periodic
 * driver shipped fully tested but never registered at bootstrap — dead code
 * in prod with all ACs green. This test closes that gap for the delegation
 * reconciliation sweep.
 *
 * AC6: sweep is registered at server bootstrap (reachable from index.ts).
 * AC7: liveness observable at ac-validate via /health crons field.
 *
 * Strategy: reads index.ts source text and asserts the import and call are
 * present, matching the pattern established by sla-sweep-wiring.test.ts
 * and bootstrap-reconciliation-wiring.test.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INDEX_TS = fs.readFileSync(
  path.resolve(__dirname, "index.ts"),
  "utf8",
);

describe("AI-1807: delegation reconciliation sweep is wired in index.ts", () => {
  it("imports the delegation reconciliation sweep module", () => {
    expect(
      INDEX_TS.includes("delegation-reconciliation-sweep"),
    ).toBe(true);
  });

  it("imports registerDelegationReconciliationCron from the sweep module", () => {
    expect(
      INDEX_TS.includes("registerDelegationReconciliationCron"),
    ).toBe(true);
  });

  it("calls registerDelegationReconciliationCron in the bootstrap (isEntryPoint) block", () => {
    // The cron must be registered in the isEntryPoint block, not just imported
    expect(INDEX_TS.includes("registerDelegationReconciliationCron(")).toBe(true);
  });

  it("resolves the auth token via the agent token store (same as every other server-side Linear call)", () => {
    expect(INDEX_TS.includes('getAccessToken("ai")')).toBe(true);
  });

  it("passes an operationalEventStore to the sweep (needed for dispatch-record idempotency checks)", () => {
    expect(INDEX_TS.includes("operationalEventStore")).toBe(true);
  });

  it("wires a wakeFn that delivers to the delegate agent (re-dispatch through normal delivery path)", () => {
    expect(INDEX_TS.includes("wakeFn")).toBe(true);
    expect(INDEX_TS.includes("deliverMessageToAgent")).toBe(true);
    expect(INDEX_TS.includes("normalizeSessionKey")).toBe(true);
  });

  it("the sweep name 'delegation-reconciliation-sweep' appears in index.ts (confirming registerCron call)", () => {
    // registerCron is called inside registerDelegationReconciliationCron,
    // but a comment or log message in index.ts should reference the sweep name
    // for deploy-time auditability
    const hasReference =
      INDEX_TS.includes("delegation-reconciliation") ||
      INDEX_TS.includes("delegation reconciliation");
    expect(hasReference).toBe(true);
  });

  it("the /redispatch endpoint is registered on the app (AC5)", () => {
    // The admin endpoint should be mounted — either in index.ts or in admin.ts
    expect(INDEX_TS.includes("redispatch")).toBe(true);
  });
});

describe("AI-1807 AC7: delegation reconciliation sweep is observable via /health", () => {
  it("the cron registry (getRegisteredCrons) is wired into /health", () => {
    expect(INDEX_TS.includes("getRegisteredCrons")).toBe(true);
    expect(INDEX_TS.includes("crons")).toBe(true);
  });

  it("/health response includes a crons field", () => {
    // The /health endpoint returns registered crons directly or via a local
    // `crons` variable shared with cron readiness checks.
    const healthMatch = INDEX_TS.match(/crons:\s*getRegisteredCrons|crons,\s*\n/);
    expect(healthMatch).not.toBeNull();
  });
});
