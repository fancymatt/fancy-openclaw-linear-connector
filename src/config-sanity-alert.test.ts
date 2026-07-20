/**
 * AI-2619 — Config-sanity alert consumer: dedup key behavior + bootstrap wiring.
 *
 * Two test groups:
 *   1. Unit tests for dedupKeyForFinding() and processWatchdogOutput()
 *   2. Source-level wiring assertion on index.ts (AI-1808 criterion: module-level
 *      unit test does NOT satisfy AC4 — a process-level integration test in
 *      health-crons-integration.test.ts proves the production entry point
 *      registers it. But the source `import`/`call` check belongs here as the
 *      first line of defense.)
 */

import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";

import {
  dedupKeyForFinding,
  readWatchdogJson,
  processWatchdogOutput,
  runCycle,
  getConfigSanityAlertLiveness,
  _resetConfigSanityAlertForTests,
  WATCHDOG_JSON_PATH,
  type WatchdogFinding,
  type WatchdogOutput,
} from "./config-sanity-alert.js";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { resetCronRegistryForTest } from "./cron/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");

// ── Sample findings ─────────────────────────────────────────────────────

const gitRemoteLivenessPushDead: WatchdogFinding = {
  check: "git-remote-liveness",
  severity: "critical",
  message: "PUSH-DEAD: 12 repos with no push access (git-remote-liveness)",
};

const gitRemoteLivenessWarning: WatchdogFinding = {
  check: "git-remote-liveness",
  severity: "warning",
  message: "SSH-AUTH: 3 repos with SSH auth failures (git-remote-liveness)",
};

const configJsonCritical: WatchdogFinding = {
  check: "config-json",
  severity: "critical",
  message: "Host openclaw.json won't parse",
};

const connectorLivenessWarning: WatchdogFinding = {
  check: "connector-liveness",
  severity: "warning",
  message: "Connector health check non-200",
};

const qmdContainerInfo: WatchdogFinding = {
  check: "qmd-container",
  severity: "info",
  message: "Empty index for new agent foo",
};

// ── AC1–AC2: dedup key behavior ─────────────────────────────────────────

describe("dedupKeyForFinding (AI-2619 AC1–AC2)", () => {
  it("uses git-remote-liveness:critical:AI-2189 for git-remote-liveness critical", () => {
    expect(dedupKeyForFinding(gitRemoteLivenessPushDead)).toBe(
      "git-remote-liveness:critical:AI-2189"
    );
  });

  it("uses check:severity for git-remote-liveness non-critical (unaffected)", () => {
    expect(dedupKeyForFinding(gitRemoteLivenessWarning)).toBe(
      "git-remote-liveness:warning"
    );
  });

  it("uses check:severity for config-json critical (unaffected)", () => {
    expect(dedupKeyForFinding(configJsonCritical)).toBe(
      "config-json:critical"
    );
  });

  it("uses check:severity for connector-liveness warning (unaffected)", () => {
    expect(dedupKeyForFinding(connectorLivenessWarning)).toBe(
      "connector-liveness:warning"
    );
  });

  it("uses check:severity for info-level findings (unaffected)", () => {
    expect(dedupKeyForFinding(qmdContainerInfo)).toBe(
      "qmd-container:info"
    );
  });

  it("all git-remote-liveness critical findings produce the SAME dedup key", () => {
    const findingA: WatchdogFinding = {
      check: "git-remote-liveness",
      severity: "critical",
      message: "PUSH-DEAD: 12 repos",
    };
    const findingB: WatchdogFinding = {
      check: "git-remote-liveness",
      severity: "critical",
      message: "PUSH-DEAD: 15 repos (different repo set)",
    };
    expect(dedupKeyForFinding(findingA)).toBe(dedupKeyForFinding(findingB));
  });

  it("git-remote-liveness critical and warning produce different keys", () => {
    const crit: WatchdogFinding = {
      check: "git-remote-liveness",
      severity: "critical",
      message: "PUSH-DEAD",
    };
    const warn: WatchdogFinding = {
      check: "git-remote-liveness",
      severity: "warning",
      message: "SSH-AUTH",
    };
    expect(dedupKeyForFinding(crit)).not.toBe(dedupKeyForFinding(warn));
  });
});

// ── processWatchdogOutput ───────────────────────────────────────────────

describe("processWatchdogOutput (AI-2619 AC1–AC3)", () => {
  beforeEach(() => _resetConfigSanityAlertForTests());
  afterEach(() => _resetConfigSanityAlertForTests());

  it("updates liveness state after processing", () => {
    const output: WatchdogOutput = {
      ok: false,
      findings: [gitRemoteLivenessPushDead, configJsonCritical],
      timestamp: "2026-07-20T01:00:00Z",
    };
    processWatchdogOutput(output);

    const liveness = getConfigSanityAlertLiveness();
    expect(liveness.lastFindingCount).toBe(2);
    expect(liveness.lastReadAt).not.toBeNull();
    expect(liveness.lastAlertAt).not.toBeNull();
  });

  it("handles empty findings gracefully", () => {
    const output: WatchdogOutput = { ok: true, findings: [] };
    processWatchdogOutput(output);

    const liveness = getConfigSanityAlertLiveness();
    expect(liveness.lastFindingCount).toBe(0);
  });

  it("handles missing findings field gracefully", () => {
    const output = { ok: true } as WatchdogOutput;
    processWatchdogOutput(output);

    const liveness = getConfigSanityAlertLiveness();
    expect(liveness.lastFindingCount).toBe(0);
  });
});

// ── readWatchdogJson ────────────────────────────────────────────────────

describe("readWatchdogJson (AI-2619 AC3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-sanity-alert-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", () => {
    const result = readWatchdogJson(path.join(dir, "nonexistent.json"));
    expect(result).toBeNull();
  });

  it("parses valid JSON output with findings", () => {
    const data: WatchdogOutput = {
      ok: false,
      timestamp: "2026-07-20T01:00:00Z",
      findings: [gitRemoteLivenessPushDead, configJsonCritical],
      checks_run: ["git-remote-liveness", "config-json"],
    };
    const filePath = path.join(dir, "config-sanity-watchdog.json");
    fs.writeFileSync(filePath, JSON.stringify(data), "utf8");

    const result = readWatchdogJson(filePath);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect(result!.findings).toHaveLength(2);
  });

  it("handles malformed JSON without throwing", () => {
    const filePath = path.join(dir, "config-sanity-watchdog.json");
    fs.writeFileSync(filePath, "not valid json", "utf8");

    const result = readWatchdogJson(filePath);
    expect(result).toBeNull();
  });
});

// ── runCycle ────────────────────────────────────────────────────────────

describe("runCycle (AI-2619 AC1–AC3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-sanity-alert-cycle-"));
    _resetConfigSanityAlertForTests();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    _resetConfigSanityAlertForTests();
  });

  it("returns 0 when file does not exist", () => {
    const count = runCycle(path.join(dir, "nonexistent.json"));
    expect(count).toBe(0);
  });

  it("returns finding count and updates liveness when file exists", () => {
    const data: WatchdogOutput = {
      ok: false,
      findings: [gitRemoteLivenessPushDead],
    };
    const filePath = path.join(dir, "config-sanity-watchdog.json");
    fs.writeFileSync(filePath, JSON.stringify(data), "utf8");

    const count = runCycle(filePath);
    expect(count).toBe(1);

    const liveness = getConfigSanityAlertLiveness();
    expect(liveness.lastFindingCount).toBe(1);
    expect(liveness.lastReadAt).not.toBeNull();
  });
});

// ── AC4: Source-level wiring check ──────────────────────────────────────

describe("AC4: config-sanity-alert is wired in index.ts", () => {
  it("imports registerConfigSanityAlertCron from the module", () => {
    expect(
      INDEX_TS.includes(
        'import { registerConfigSanityAlertCron } from "./config-sanity-alert.js"'
      ) ||
      INDEX_TS.includes(
        'registerConfigSanityAlertCron, getConfigSanityAlertLiveness'
      )
    ).toBe(true);
  });

  it("calls registerConfigSanityAlertCron from the entry point", () => {
    expect(INDEX_TS.includes("registerConfigSanityAlertCron(")).toBe(true);
  });
});
