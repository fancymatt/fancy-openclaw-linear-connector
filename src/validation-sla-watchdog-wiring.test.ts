/**
 * INF-105 — Wiring test: asserts the validation SLA watchdog cron is
 * registered in the application entry point (src/index.ts).
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

describe("INF-105: validation watchdog cron is wired in index.ts", () => {
  it("imports registerValidationWatchdogCron from the watchdog module", () => {
    expect(
      INDEX_TS.includes(
        'import { registerValidationWatchdogCron } from "./validation-sla-watchdog.js"',
      ),
    ).toBe(true);
  });

  it("calls registerValidationWatchdogCron in the bootstrap block", () => {
    expect(INDEX_TS.includes("registerValidationWatchdogCron(")).toBe(true);
  });

  it("resolves the auth token via the agent token store", () => {
    expect(INDEX_TS.includes('getAccessToken("ai")')).toBe(true);
    expect(INDEX_TS.includes("LINEAR_OAUTH_TOKEN")).toBe(true);
    expect(INDEX_TS.includes("LINEAR_API_KEY")).toBe(true);
  });

  it("wires a persisted nudge store (not an in-memory path)", () => {
    expect(INDEX_TS.includes("validation-nudges.db")).toBe(true);
    expect(INDEX_TS.includes("DATA_DIR")).toBe(true);
  });

  it("makes the watchdog cadence configurable via env", () => {
    expect(INDEX_TS.includes("VALIDATION_WATCHDOG_CADENCE_MS")).toBe(true);
  });

  it("makes the threshold configurable via env", () => {
    expect(INDEX_TS.includes("VALIDATION_WATCHDOG_THRESHOLD_MS")).toBe(true);
  });

  it("makes the cooldown configurable via env", () => {
    expect(INDEX_TS.includes("VALIDATION_WATCHDOG_COOLDOWN_MS")).toBe(true);
  });

  it("resolves the validator agent ID via getLinearUserIdForAgent", () => {
    expect(INDEX_TS.includes("getLinearUserIdForAgent")).toBe(true);
  });

  it("wires a validator wakeFn that delivers to an agent", () => {
    expect(INDEX_TS.includes("validationWakeAgent")).toBe(true);
    expect(INDEX_TS.includes("deliverMessageToAgent")).toBe(true);
    expect(INDEX_TS.includes("normalizeSessionKey")).toBe(true);
  });
});
