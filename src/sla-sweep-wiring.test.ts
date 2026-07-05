/**
 * AI-1773 — Wiring test: asserts the SLA evaluation sweep cron is registered
 * in the application entry point (src/index.ts).
 *
 * Background: the original AI-1773 PR shipped `registerSlaSweepCron` with full
 * module-level test coverage (27 tests) but never called it from index.ts. The
 * driver was dead code in the deployed connector — caught only at ac-validate
 * (same silent gap class as AI-1775). AI-1808 added a standard bootstrap-wiring
 * AC criterion; this test enforces it for this ticket.
 *
 * This test reads the index.ts source and asserts the import, the call, and
 * that the production options satisfy the AC constraints (persisted breach
 * store, alert-bus notify, steward wake, configurable cadence).
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

describe("AI-1773: SLA sweep cron is wired in index.ts", () => {
  it("imports registerSlaSweepCron from the sweep module", () => {
    expect(
      INDEX_TS.includes('import { registerSlaSweepCron } from "./sla-sweep.js"'),
    ).toBe(true);
  });

  it("calls registerSlaSweepCron in the bootstrap (isEntryPoint) block", () => {
    expect(INDEX_TS.includes("registerSlaSweepCron(")).toBe(true);
  });

  it("resolves the auth token via the agent token store (same as every other server-side Linear call)", () => {
    expect(INDEX_TS.includes('getAccessToken("ai")')).toBe(true);
    expect(INDEX_TS.includes("LINEAR_OAUTH_TOKEN")).toBe(true);
    expect(INDEX_TS.includes("LINEAR_API_KEY")).toBe(true);
  });

  it("wires notify to the alert-bus funnel (AC1: warning alert via notify())", () => {
    expect(INDEX_TS.includes("notify,")).toBe(true);
  });

  it("wires a persisted breach store (AC3: restart-resilient — not a tmp/in-memory path)", () => {
    // The breach store path must resolve under DATA_DIR (or cwd/data), matching
    // every other persisted SQLite store in the connector.
    expect(INDEX_TS.includes("sla-breaches.db")).toBe(true);
    expect(INDEX_TS.includes("DATA_DIR")).toBe(true);
  });

  it("makes sweep cadence configurable via env with a sane default", () => {
    expect(INDEX_TS.includes("SLA_SWEEP_CADENCE_MS")).toBe(true);
  });

  it("resolves the workflow def path from WORKFLOW_DEFS_DIR / WORKFLOW_DEF_PATH (dir-mode aware)", () => {
    expect(INDEX_TS.includes("WORKFLOW_DEFS_DIR")).toBe(true);
    expect(INDEX_TS.includes("WORKFLOW_DEF_PATH")).toBe(true);
    expect(INDEX_TS.includes("defaultWorkflowDefPath")).toBe(true);
  });

  it("wires a steward wakeFn that delivers to an agent (AC1: steward wake for the breached ticket)", () => {
    expect(INDEX_TS.includes("slaWakeAgent")).toBe(true);
    expect(INDEX_TS.includes("deliverMessageToAgent")).toBe(true);
    expect(INDEX_TS.includes("normalizeSessionKey")).toBe(true);
  });
});
