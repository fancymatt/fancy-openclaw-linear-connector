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
import {
  _resetAlertBusForTests,
  initAlertBus,
} from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";
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

// ── AI-2620: suppression window override for git-remote-liveness critical ──

describe("AI-2620: git-remote-liveness critical suppression window override", () => {
  /**
   * AC3: Unit test — two processWatchdogOutput calls 30 minutes apart with
   * an identical git-remote-liveness critical finding produce only one push.
   *
   * The per-dedupKey suppression window override (6h) must absorb the 30min
   * cycle gap that would otherwise escape the 15min severity-based window.
   */
  it("AC3: two identical git-remote-liveness critical findings 30min apart produce one push", async () => {
    // Setup a controlled AlertBus with push tracking
    _resetAlertBusForTests();
    _resetConfigSanityAlertForTests();

    const store = new AlertStore(":memory:");
    const pushes: string[] = [];
    const pushFn = jest.fn(async (message: string) => {
      pushes.push(message);
    });

    // Base time
    const t0 = new Date("2026-07-20T00:00:00.000Z");
    let nowMs = t0.getTime();

    initAlertBus({
      store,
      pushFn,
      pushEnabled: true,
      pushMinSeverity: "critical",
      now: () => new Date(nowMs),
    });

    // First cycle at T+0
    const findings: WatchdogFinding[] = [
      {
        check: "git-remote-liveness",
        severity: "critical",
        message: "PUSH-DEAD: 12 repos with no push access (git-remote-liveness)",
      },
    ];
    processWatchdogOutput({ ok: false, findings }, new Date(nowMs));

    // Advance 30 minutes (= one cron cycle, well within a 6h window)
    nowMs += 30 * 60_000;
    processWatchdogOutput({ ok: false, findings }, new Date(nowMs));

    // Flush pending push promises
    await new Promise((r) => setImmediate(r));

    // Only one push — the second call folded into the existing burst
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("[git-remote-liveness] PUSH-DEAD: 12 repos");

    // Also verify store reflects a single burst with count=2 (folded)
    const stored = store.query();
    expect(stored).toHaveLength(1);
    expect(stored[0].count).toBe(2);

    _resetAlertBusForTests();
    _resetConfigSanityAlertForTests();
  });

  /**
   * AC4: Regression test — a non-git-remote-liveness critical finding
   * still fires separate pushes when called 30 minutes apart because its
   * severity-based suppression window (15min for critical) is narrower than
   * the cron cadence.
   *
   * This is the exact failure mode this ticket fixes for git-remote-liveness,
   * but other dedup keys must remain on severity-based windows.
   */
  it("AC4: non-git-remote-liveness critical findings 30min apart produce two pushes (regression)", async () => {
    _resetAlertBusForTests();
    _resetConfigSanityAlertForTests();

    const store = new AlertStore(":memory:");
    const pushes: string[] = [];
    const pushFn = jest.fn(async (message: string) => {
      pushes.push(message);
    });

    const t0 = new Date("2026-07-20T00:00:00.000Z");
    let nowMs = t0.getTime();

    initAlertBus({
      store,
      pushFn,
      pushEnabled: true,
      pushMinSeverity: "critical",
      now: () => new Date(nowMs),
    });

    // Use a non-git-remote-liveness critical finding
    const findings: WatchdogFinding[] = [
      {
        check: "config-json",
        severity: "critical",
        message: "Host openclaw.json won't parse",
      },
    ];

    // First cycle at T+0
    processWatchdogOutput({ ok: false, findings }, new Date(nowMs));

    // Advance 30 minutes (= one cron cycle, well beyond the 15min critical window)
    nowMs += 30 * 60_000;
    processWatchdogOutput({ ok: false, findings }, new Date(nowMs));

    await new Promise((r) => setImmediate(r));

    // Two pushes — the second call creates a new burst because 15min < 30min
    expect(pushes).toHaveLength(2);

    // Also verify store reflects two separate bursts
    const stored = store.query({ severity: "critical" });
    expect(stored).toHaveLength(2);

    _resetAlertBusForTests();
    _resetConfigSanityAlertForTests();
  });

  /**
   * AC1—AC2 cross-check: a git-remote-liveness warning finding (non-critical)
   * still uses severity-based suppression. Two warning findings 30min apart
   * fold into one burst (1h window), but a second burst after 90min fires
   * a new push.
   */
  it("AC2: non-critical git-remote-liveness findings still use severity-based suppress window", async () => {
    _resetAlertBusForTests();
    _resetConfigSanityAlertForTests();

    const store = new AlertStore(":memory:");
    const pushes: string[] = [];
    const pushFn = jest.fn(async (message: string) => {
      pushes.push(message);
    });

    const t0 = new Date("2026-07-20T00:00:00.000Z");
    let nowMs = t0.getTime();

    initAlertBus({
      store,
      pushFn,
      pushEnabled: true,
      pushMinSeverity: "warning",
      now: () => new Date(nowMs),
    });

    const findings: WatchdogFinding[] = [
      {
        check: "git-remote-liveness",
        severity: "warning",
        message: "SSH-AUTH: 3 repos with SSH auth failures",
      },
    ];

    // First cycle at T+0
    processWatchdogOutput({ ok: false, findings }, new Date(nowMs));

    // Advance 30 minutes — still within the 1h warning window → fold
    nowMs += 30 * 60_000;
    processWatchdogOutput({ ok: false, findings }, new Date(nowMs));

    await new Promise((r) => setImmediate(r));

    // Only one push — folded within warning's 1h window
    expect(pushes).toHaveLength(1);

    // Advance another 61 minutes — beyond 1h window → new burst
    nowMs += 61 * 60_000;
    processWatchdogOutput({ ok: false, findings }, new Date(nowMs));

    await new Promise((r) => setImmediate(r));

    expect(pushes).toHaveLength(2);

    _resetAlertBusForTests();
    _resetConfigSanityAlertForTests();
  });

  /**
   * AC1 edge case: after a very long window (e.g. 7h), a git-remote-liveness
   * critical finding should start a new burst.
   */
  it("AC1: git-remote-liveness critical findings beyond the 6h window start a new burst", async () => {
    _resetAlertBusForTests();
    _resetConfigSanityAlertForTests();

    const store = new AlertStore(":memory:");
    const pushes: string[] = [];
    const pushFn = jest.fn(async (message: string) => {
      pushes.push(message);
    });

    const t0 = new Date("2026-07-20T00:00:00.000Z");
    let nowMs = t0.getTime();

    initAlertBus({
      store,
      pushFn,
      pushEnabled: true,
      pushMinSeverity: "critical",
      now: () => new Date(nowMs),
    });

    const findings: WatchdogFinding[] = [
      {
        check: "git-remote-liveness",
        severity: "critical",
        message: "PUSH-DEAD: 12 repos",
      },
    ];

    processWatchdogOutput({ ok: false, findings }, new Date(nowMs));

    // Beyond the 6h override window (7 hours)
    nowMs += 7 * 60 * 60_000;
    processWatchdogOutput({ ok: false, findings }, new Date(nowMs));

    await new Promise((r) => setImmediate(r));

    // Two pushes — second call is beyond the 6h window
    expect(pushes).toHaveLength(2);

    const stored = store.query();
    expect(stored).toHaveLength(2);

    _resetAlertBusForTests();
    _resetConfigSanityAlertForTests();
  });
});
