/**
 * AI-1775 — Wiring test: asserts the reconciliation sweep cron is registered
 * in the application entry point (src/index.ts).
 *
 * Background: the original AI-1775 PR exported
 * `registerBootstrapReconciliationCron` but never called it from index.ts.
 * The 13 unit tests passed because they invoke the module directly — the gap
 * between "code merged" and "deployed artifact satisfies AC" was invisible.
 *
 * This test reads the index.ts source and asserts the import and call are
 * present, closing that gap at CI time.
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

describe("AI-1775: bootstrap reconciliation cron is wired in index.ts", () => {
  it("imports registerBootstrapReconciliationCron from the sweep module", () => {
    expect(
      INDEX_TS.includes(
        'import { registerBootstrapReconciliationCron } from "./bootstrap-reconciliation-sweep.js"',
      ),
    ).toBe(true);
  });

  it("calls registerBootstrapReconciliationCron with an authToken resolved from the agent token store", () => {
    expect(INDEX_TS.includes("registerBootstrapReconciliationCron(")).toBe(true);
    expect(INDEX_TS.includes('getAccessToken("ai")')).toBe(true);
    expect(INDEX_TS.includes("LINEAR_OAUTH_TOKEN")).toBe(true);
    expect(INDEX_TS.includes("LINEAR_API_KEY")).toBe(true);
  });

  it("passes a wakeFn that uses buildWorkflowAwareDeliveryMessage + deliverMessageToAgent", () => {
    // AC1 round-2 fix: the cron entry point must forward a wakeFn so healed
    // tickets actually notify their delegate. String-matching index.ts is the
    // regression guard; the behavioral test in the sweep suite covers runtime.
    expect(INDEX_TS.includes("wakeFn")).toBe(true);
    expect(INDEX_TS.includes("buildWorkflowAwareDeliveryMessage")).toBe(true);
    expect(INDEX_TS.includes("deliverMessageToAgent")).toBe(true);
    expect(INDEX_TS.includes("normalizeSessionKey")).toBe(true);
  });
});
