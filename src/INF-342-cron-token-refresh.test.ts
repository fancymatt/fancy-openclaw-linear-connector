/**
 * INF-342: connector crons must not capture the ai Linear OAuth token at startup.
 *
 * The token refresher revokes the previous access token shortly after startup,
 * so scheduled crons need a live token source resolved at execution time.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, jest } from "@jest/globals";
import { resolveAuthToken } from "./linear-auth.js";
import { runSlaSweep } from "./sla-sweep.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");

describe("INF-342 cron token refresh wiring", () => {
  it("keeps ai Linear auth behind one live resolver", () => {
    expect(INDEX_TS).toContain("function resolveAiLinearAuthToken()");
    expect(INDEX_TS).toContain('getAccessToken("ai")');
    expect(INDEX_TS).toContain("LINEAR_OAUTH_TOKEN");
    expect(INDEX_TS).toContain("LINEAR_API_KEY");
  });

  it("does not keep startup-captured auth token variables for cron drivers", () => {
    for (const capturedName of [
      "migrationAuthToken",
      "reconciliationAuthToken",
      "slaAuthToken",
      "validationAuthToken",
      "labelSyncAuthToken",
      "antiEntropyAuthToken",
    ]) {
      expect(INDEX_TS).not.toContain(capturedName);
    }
  });

  it("passes the live resolver into ai-token cron registrations", () => {
    for (const registration of [
      "registerDefStateMigrationRunner",
      "registerBootstrapReconciliationCron",
      "registerDelegationReconciliationCron",
      "registerStalePlainDelegateCron",
      "registerFirstActionWatchdogCron",
      "registerSlaSweepCron",
      "registerValidationWatchdogCron",
      "registerLabelSyncAuditCron",
      "registerAntiEntropyCron",
    ]) {
      const start = INDEX_TS.indexOf(`${registration}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      const snippet = INDEX_TS.slice(start, start + 500);
      expect(snippet).toContain("authToken: resolveAiLinearAuthToken");
    }
  });
});

describe("INF-342 auth helpers and GraphQL error handling", () => {
  it("resolves token providers lazily", () => {
    const tokens = ["Bearer first", "Bearer second"];
    const source = () => tokens.shift() ?? "Bearer fallback";

    expect(resolveAuthToken(source)).toBe("Bearer first");
    expect(resolveAuthToken(source)).toBe("Bearer second");
  });

  it("records Linear GraphQL auth errors instead of treating them as an empty SLA scan", async () => {
    const result = await runSlaSweep({
      authToken: "Bearer revoked",
      workflowDefPath: "/path/that/does/not/exist",
      notify: jest.fn(),
      wakeAgent: jest.fn(async () => {}),
      fetchFn: jest.fn(async () => new Response(JSON.stringify({
        errors: [{ message: "Authentication required, not authenticated" }],
      }))),
    });

    expect(result.scanned).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(String(result.errors[0])).toContain("Authentication required");
  });
});
