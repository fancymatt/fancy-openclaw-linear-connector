/**
 * INF-219 — Failing tests for cron-backlog recovery stampede protection.
 *
 * The backlog controller does not exist yet. These tests intentionally import
 * src/cron/backlog-controller.ts and must stay RED until the implementation
 * provides bounded concurrency, per-ticket wake deduplication, recovery rate
 * guarding, and production bootstrap wiring.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { createApp } from "../index.js";
import {
  createBacklogController,
  type CronBacklogController,
  type CronBacklogControllerOptions,
  type CronJob,
  type DedupStats,
} from "./backlog-controller.js";

type BacklogControllerOptionsForTest = CronBacklogControllerOptions & {
  /** Recovery gap threshold; controller enters recovery when inactivity exceeds this. */
  intervalMs?: number;
  /** Injectable clock for deterministic rate-window assertions. */
  now?: () => number;
  /** Injectable logger so recovery-mode warnings can be asserted. */
  logger?: { warn: (...args: unknown[]) => void };
};

type BacklogStatsForTest = ReturnType<CronBacklogController["getStats"]> & {
  maxConcurrency: number;
  dedup: DedupStats & { skippedIds?: string[] };
  rate: {
    windowMs: number;
    normalDispatches: number;
    recoveryDispatches: number;
    allowedRecoveryDispatches: number;
    throttled: number;
  };
  recovery: {
    active: boolean;
    backlog: number;
    enteredAt: number | null;
    exitedAt: number | null;
  };
};

type TestableBacklogController = CronBacklogController & {
  getStats(): BacklogStatsForTest;
  recordActivity(atMs?: number): void;
  detectRecoveryGap(nowMs?: number): boolean;
  isRecovering(): boolean;
  drain(): Promise<void>;
};

type TimestampedCronJob = CronJob & {
  /** Logical wake-event timestamp used to pick the latest pending wake per ticket. */
  scheduledAt: number;
};

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

let controllers: TestableBacklogController[] = [];
let tmpDir: string | undefined;

beforeEach(() => {
  controllers = [];
});

afterEach(() => {
  for (const controller of controllers) {
    controller.shutdown();
  }
  controllers = [];
  jest.restoreAllMocks();
  delete process.env.AGENTS_FILE;
  delete process.env.CAPABILITY_POLICY_PATH;

  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeController(options: BacklogControllerOptionsForTest = {}): TestableBacklogController {
  const controller = createBacklogController(options) as TestableBacklogController;
  controllers.push(controller);
  return controller;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

function controlledJob(
  id: string,
  release: Deferred,
  onStart: () => void,
  ticketId?: string,
): CronJob {
  return {
    id,
    ticketId,
    execute: async () => {
      onStart();
      await release.promise;
    },
  };
}

function instantJob(id: string, fired: string[], ticketId?: string): CronJob {
  return {
    id,
    ticketId,
    execute: async () => {
      fired.push(id);
    },
  };
}

function timestampedJob(
  id: string,
  ticketId: string,
  scheduledAt: number,
  fired: string[],
): TimestampedCronJob {
  return {
    ...instantJob(id, fired, ticketId),
    scheduledAt,
  };
}

function prepareBootstrapEnv(): {
  bagDbPath: string;
  agentQueueDbPath: string;
  operationalEventsDbPath: string;
  observationsDbPath: string;
  managingStateDbPath: string;
  enrolledTicketsDbPath: string;
  mutationAuditDbPath: string;
  idempotencyDbPath: string;
  dispatchLeaseDbPath: string;
  proposalsDbPath: string;
} {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-bootstrap-test-"));
  const agentsFile = path.join(tmpDir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        {
          name: "sage",
          linearUserId: "user-sage",
          openclawAgent: "sage",
          clientId: "client-id",
          clientSecret: "client-secret",
          accessToken: "access-token",
          refreshToken: "refresh-token",
          host: "local",
        },
      ],
    }),
    "utf8",
  );

  const policyFile = path.join(tmpDir, "capability-policy.yaml");
  fs.writeFileSync(
    policyFile,
    `
capabilities:
  - id: linear:read
    description: read Linear tickets
  - id: linear:transition
    description: transition Linear tickets
containers:
  - id: steward
    grants: [linear:read, linear:transition]
roles:
  - id: steward
    requires: [linear:read, linear:transition]
bodies:
  - id: sage
    container: steward
    fills_roles: [steward]
`.trimStart(),
    "utf8",
  );

  process.env.AGENTS_FILE = agentsFile;
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  return {
    bagDbPath: path.join(tmpDir, "bag.db"),
    agentQueueDbPath: path.join(tmpDir, "agent-queue.db"),
    operationalEventsDbPath: path.join(tmpDir, "ops-events.db"),
    observationsDbPath: path.join(tmpDir, "observations.db"),
    managingStateDbPath: path.join(tmpDir, "managing-state.db"),
    enrolledTicketsDbPath: path.join(tmpDir, "enrolled-tickets.db"),
    mutationAuditDbPath: path.join(tmpDir, "mutation-audit.db"),
    idempotencyDbPath: path.join(tmpDir, "idempotency.db"),
    dispatchLeaseDbPath: path.join(tmpDir, "dispatch-lease.db"),
    proposalsDbPath: path.join(tmpDir, "proposals.db"),
  };
}

function closeCreatedResources(created: Record<string, unknown>): void {
  for (const value of Object.values(created)) {
    if (value && typeof value === "object" && "close" in value) {
      const close = (value as { close?: () => void }).close;
      close?.();
    }
  }
}

describe("CronBacklogController — AC1: bounded concurrency", () => {
  it("default maxConcurrency is 3", async () => {
    const controller = makeController();
    const releases = [deferred(), deferred(), deferred(), deferred()];
    const started: string[] = [];

    const submissions = releases.map((release, index) =>
      controller.submit(controlledJob(`job-${index}`, release, () => started.push(`job-${index}`))),
    );

    await waitFor(() => started.length === 3);

    expect(controller.getStats().maxConcurrency).toBe(3);
    expect(controller.getStats().running).toBe(3);
    expect(controller.getStats().queued).toBe(1);
    expect(started).toEqual(["job-0", "job-1", "job-2"]);

    for (const release of releases) release.resolve();
    await Promise.all(submissions);
  });

  it("limits concurrent job execution to maxConcurrency", async () => {
    const controller = makeController({ maxConcurrency: 2 });
    const releases = Array.from({ length: 6 }, () => deferred());
    let running = 0;
    let maxObserved = 0;

    const submissions = releases.map((release, index) =>
      controller.submit(
        controlledJob(`job-${index}`, release, () => {
          running += 1;
          maxObserved = Math.max(maxObserved, running);
          release.promise.finally(() => {
            running -= 1;
          });
        }),
      ),
    );

    await waitFor(() => controller.getStats().running === 2);
    expect(maxObserved).toBeLessThanOrEqual(2);

    releases.forEach((release) => release.resolve());
    await Promise.all(submissions);
  });

  it("queues surplus jobs when concurrency limit is reached", async () => {
    const controller = makeController({ maxConcurrency: 2 });
    const releases = [deferred(), deferred(), deferred(), deferred(), deferred()];
    const started: string[] = [];

    const submissions = releases.map((release, index) =>
      controller.submit(controlledJob(`job-${index}`, release, () => started.push(`job-${index}`))),
    );

    await waitFor(() => started.length === 2);

    expect(controller.getStats().running).toBe(2);
    expect(controller.getStats().queued).toBe(3);
    expect(started).toEqual(["job-0", "job-1"]);

    releases.forEach((release) => release.resolve());
    await Promise.all(submissions);
  });

  it("runs queued jobs as slots free up", async () => {
    const controller = makeController({ maxConcurrency: 2 });
    const releases = [deferred(), deferred(), deferred(), deferred()];
    const started: string[] = [];

    const submissions = releases.map((release, index) =>
      controller.submit(controlledJob(`job-${index}`, release, () => started.push(`job-${index}`))),
    );

    await waitFor(() => started.length === 2);
    releases[0].resolve();

    await waitFor(() => started.includes("job-2"));
    expect(controller.getStats().running).toBe(2);
    expect(controller.getStats().queued).toBe(1);

    releases.slice(1).forEach((release) => release.resolve());
    await Promise.all(submissions);
    expect(controller.getStats().completed).toBe(4);
  });

  it("accepts configurable maxConcurrency option", async () => {
    const controller = makeController({ maxConcurrency: 5 });
    const releases = Array.from({ length: 7 }, () => deferred());
    const started: string[] = [];

    const submissions = releases.map((release, index) =>
      controller.submit(controlledJob(`job-${index}`, release, () => started.push(`job-${index}`))),
    );

    await waitFor(() => started.length === 5);

    expect(controller.getStats().maxConcurrency).toBe(5);
    expect(controller.getStats().running).toBe(5);
    expect(controller.getStats().queued).toBe(2);

    releases.forEach((release) => release.resolve());
    await Promise.all(submissions);
  });

  it("maxConcurrency of 1 serializes all jobs", async () => {
    const controller = makeController({ maxConcurrency: 1 });
    const releases = [deferred(), deferred(), deferred()];
    const started: string[] = [];

    const submissions = releases.map((release, index) =>
      controller.submit(controlledJob(`job-${index}`, release, () => started.push(`job-${index}`))),
    );

    await waitFor(() => started.length === 1);
    expect(started).toEqual(["job-0"]);
    expect(controller.getStats().running).toBe(1);
    expect(controller.getStats().queued).toBe(2);

    releases[0].resolve();
    await waitFor(() => started.length === 2);
    expect(started).toEqual(["job-0", "job-1"]);

    releases[1].resolve();
    await waitFor(() => started.length === 3);
    expect(started).toEqual(["job-0", "job-1", "job-2"]);

    releases[2].resolve();
    await Promise.all(submissions);
  });

  it("rejects maxConcurrency of 0 or negative", () => {
    expect(() => makeController({ maxConcurrency: 0 })).toThrow(/maxConcurrency/i);
    expect(() => makeController({ maxConcurrency: -1 })).toThrow(/maxConcurrency/i);
  });
});

describe("CronBacklogController — AC2: dedup of stale intermediate states", () => {
  it("deduplicates multiple wake events for the same ticket — only latest fires", async () => {
    const controller = makeController({ maxConcurrency: 1, dedupWindowMs: 60_000 });
    const blockerRelease = deferred();
    const fired: string[] = [];

    const blocker = controller.submit(controlledJob("blocker", blockerRelease, () => {}, "INF-219"));
    await waitFor(() => controller.getStats().running === 1);

    const older = controller.submit(timestampedJob("wake-old", "INF-1", 1_000, fired));
    const latest = controller.submit(timestampedJob("wake-latest", "INF-1", 2_000, fired));

    await waitFor(() => controller.getStats().dedup.skipped === 1);
    expect(controller.getStats().queued).toBe(1);

    blockerRelease.resolve();
    await Promise.all([blocker, older, latest]);

    expect(fired).toEqual(["wake-latest"]);
    expect(controller.getStats().dedup).toMatchObject({ total: 2, skipped: 1, fired: 1 });
  });

  it("preserves different ticket IDs as separate events", async () => {
    const controller = makeController({ maxConcurrency: 1, dedupWindowMs: 60_000 });
    const blockerRelease = deferred();
    const fired: string[] = [];

    const blocker = controller.submit(controlledJob("blocker", blockerRelease, () => {}, "INF-219"));
    await waitFor(() => controller.getStats().running === 1);

    const a = controller.submit(timestampedJob("wake-inf-1", "INF-1", 1_000, fired));
    const b = controller.submit(timestampedJob("wake-inf-2", "INF-2", 1_001, fired));

    blockerRelease.resolve();
    await Promise.all([blocker, a, b]);

    expect(fired).toEqual(["wake-inf-1", "wake-inf-2"]);
    expect(controller.getStats().dedup).toMatchObject({ total: 2, skipped: 0, fired: 2 });
  });

  it("marks stale intermediate checks as skipped", async () => {
    const controller = makeController({ maxConcurrency: 1, dedupWindowMs: 60_000 });
    const blockerRelease = deferred();
    const fired: string[] = [];

    const blocker = controller.submit(controlledJob("blocker", blockerRelease, () => {}, "INF-219"));
    await waitFor(() => controller.getStats().running === 1);

    const stale1 = controller.submit(timestampedJob("wake-1", "INF-1", 1_000, fired));
    const stale2 = controller.submit(timestampedJob("wake-2", "INF-1", 2_000, fired));
    const latest = controller.submit(timestampedJob("wake-3", "INF-1", 3_000, fired));

    await waitFor(() => controller.getStats().dedup.skipped === 2);
    expect(controller.getStats().dedup.skippedIds).toEqual(["wake-1", "wake-2"]);

    blockerRelease.resolve();
    await Promise.all([blocker, stale1, stale2, latest]);
    expect(fired).toEqual(["wake-3"]);
  });

  it("tracks dedup stats (total, skipped, fired)", async () => {
    const controller = makeController({ maxConcurrency: 1, dedupWindowMs: 60_000 });
    const blockerRelease = deferred();
    const fired: string[] = [];

    const blocker = controller.submit(controlledJob("blocker", blockerRelease, () => {}, "INF-219"));
    await waitFor(() => controller.getStats().running === 1);

    const jobs = [
      controller.submit(timestampedJob("wake-1-old", "INF-1", 1_000, fired)),
      controller.submit(timestampedJob("wake-1-new", "INF-1", 2_000, fired)),
      controller.submit(timestampedJob("wake-2", "INF-2", 1_500, fired)),
    ];

    await waitFor(() => controller.getStats().dedup.skipped === 1);
    blockerRelease.resolve();
    await Promise.all([blocker, ...jobs]);

    expect(fired).toEqual(["wake-1-new", "wake-2"]);
    expect(controller.getStats().dedup).toEqual(
      expect.objectContaining({
        total: 3,
        skipped: 1,
        fired: 2,
      }),
    );
  });
});

describe("CronBacklogController — AC3: dispatch rate guard on recovery", () => {
  it("tracks normal operating dispatch rate in a sliding window", async () => {
    let now = 0;
    const fired: string[] = [];
    const controller = makeController({
      maxConcurrency: 10,
      rateWindowMs: 1_000,
      now: () => now,
    });

    await Promise.all([
      controller.submit(instantJob("normal-1", fired)),
      controller.submit(instantJob("normal-2", fired)),
      controller.submit(instantJob("normal-3", fired)),
    ]);

    expect(controller.getStats().rate.normalDispatches).toBe(3);
    expect(controller.getStats().rate.allowedRecoveryDispatches).toBe(6);

    now = 1_200;
    await controller.submit(instantJob("normal-4", fired));

    expect(controller.getStats().rate.windowMs).toBe(1_000);
    expect(controller.getStats().rate.normalDispatches).toBe(1);
    expect(controller.getStats().rate.allowedRecoveryDispatches).toBe(2);
  });

  it("enters recovery mode when gap > interval is detected", () => {
    const controller = makeController({ intervalMs: 1_000, now: () => 0 });

    controller.recordActivity(0);

    expect(controller.detectRecoveryGap(1_000)).toBe(false);
    expect(controller.isRecovering()).toBe(false);

    expect(controller.detectRecoveryGap(1_001)).toBe(true);
    expect(controller.isRecovering()).toBe(true);
    expect(controller.getStats().recovery).toEqual(
      expect.objectContaining({
        active: true,
        enteredAt: 1_001,
      }),
    );
  });

  it("throttles dispatch when recovery volume exceeds 2x normal rate", async () => {
    let now = 0;
    const fired: string[] = [];
    const controller = makeController({
      maxConcurrency: 10,
      intervalMs: 1_000,
      rateWindowMs: 1_000,
      rateLimitMultiplier: 2,
      now: () => now,
    });

    await Promise.all([
      controller.submit(instantJob("normal-1", fired)),
      controller.submit(instantJob("normal-2", fired)),
    ]);

    controller.recordActivity(0);
    now = 2_000;
    expect(controller.detectRecoveryGap(now)).toBe(true);

    const recoverySubmissions = Array.from({ length: 6 }, (_, index) =>
      controller.submit(instantJob(`recovery-${index + 1}`, fired)),
    );

    await waitFor(() => fired.filter((id) => id.startsWith("recovery-")).length === 4);

    expect(fired.filter((id) => id.startsWith("recovery-"))).toEqual([
      "recovery-1",
      "recovery-2",
      "recovery-3",
      "recovery-4",
    ]);
    expect(controller.getStats().rate).toEqual(
      expect.objectContaining({
        recoveryDispatches: 4,
        allowedRecoveryDispatches: 4,
        throttled: 2,
      }),
    );
    expect(controller.getStats().queued).toBe(2);

    now = 3_100;
    await controller.drain();
    await Promise.all(recoverySubmissions);
  });

  it("exits recovery mode when backlog clears and rate normalizes", async () => {
    let now = 0;
    const fired: string[] = [];
    const controller = makeController({
      maxConcurrency: 2,
      intervalMs: 1_000,
      rateWindowMs: 1_000,
      now: () => now,
    });

    await controller.submit(instantJob("normal-1", fired));
    controller.recordActivity(0);
    now = 1_500;
    controller.detectRecoveryGap(now);
    expect(controller.isRecovering()).toBe(true);

    await Promise.all([
      controller.submit(instantJob("recovery-1", fired)),
      controller.submit(instantJob("recovery-2", fired)),
    ]);
    now = 2_600;
    await controller.drain();

    expect(controller.getStats().queued).toBe(0);
    expect(controller.getStats().running).toBe(0);
    expect(controller.isRecovering()).toBe(false);
    expect(controller.getStats().recovery).toEqual(
      expect.objectContaining({
        active: false,
        backlog: 0,
        exitedAt: 2_600,
      }),
    );
  });

  it("logs a warning when entering/exiting recovery mode", async () => {
    let now = 0;
    const warn = jest.fn();
    const controller = makeController({
      maxConcurrency: 2,
      intervalMs: 1_000,
      rateWindowMs: 1_000,
      now: () => now,
      logger: { warn },
    });

    controller.recordActivity(0);
    now = 1_001;
    controller.detectRecoveryGap(now);

    await controller.submit(instantJob("recovery-1", []));
    now = 2_100;
    await controller.drain();

    const warnings = warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(warnings).toEqual(expect.stringMatching(/enter/i));
    expect(warnings).toEqual(expect.stringMatching(/exit/i));
    expect(warnings).toEqual(expect.stringMatching(/recovery/i));
  });
});

describe("Background-component integration — bootstrap wiring", () => {
  it("boots production entry point and registers the backlog controller", () => {
    const created = createApp(prepareBootstrapEnv());

    try {
      expect(created).toHaveProperty("app");
      // AI-1808: the backlog controller must be registered during bootstrap,
      // not just constructed in isolation. The createApp() return includes
      // a backlogController property when the cron infrastructure is wired.
      expect(created).toHaveProperty("backlogController");
    } finally {
      closeCreatedResources(created as Record<string, unknown>);
    }
  });
});
