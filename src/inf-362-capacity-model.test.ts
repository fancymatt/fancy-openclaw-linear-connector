/**
 * INF-362 — Capacity model follows the real gateway constraint.
 *
 * AC1/AC4: The default per-agent cap must not falsely park work when the
 * fleet still has global capacity. An idle fleet that receives five tasks for
 * one agent should dispatch all five instead of classifying tasks 4/5 as
 * at-capacity.
 * AC2/AC4: The global concurrent-dispatch budget is the sole shared resource
 * gate for delivery handoff rate, not work concurrency; it is configurable and
 * queues delivery handoffs regardless of which agent owns them.
 * AC3: An explicit per-agent serialize/correctness knob is still honored.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { PendingWorkBag } from "./bag/pending-work-bag.js";
import { SessionTracker } from "./bag/session-tracker.js";
import { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import { NoActivityDetector } from "./bag/no-activity-detector.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { DeliveryThrottle } from "./delivery/throttle.js";
import type { WakeUpConfig } from "./bag/wake-up.js";

const wakeConfig: WakeUpConfig = {
  nodeBin: process.execPath,
  timeoutMs: 10,
  maxRetries: 0,
};

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-362-capacity-"));
}

function setupDeps(dir: string) {
  const bag = new PendingWorkBag(path.join(dir, "bag.db"), 60_000);
  const sessionTracker = new SessionTracker(30_000);
  const ackTracker = new DispatchAckTracker(path.join(dir, "acks.db"));
  const operationalEventStore = new OperationalEventStore(path.join(dir, "events.db"));
  return { bag, sessionTracker, ackTracker, operationalEventStore };
}

function closeDeps(deps: ReturnType<typeof setupDeps>): void {
  deps.bag.close();
  deps.sessionTracker.close();
  deps.ackTracker.close();
  deps.operationalEventStore.close();
}

async function expectStillPending<T>(promise: Promise<T>): Promise<void> {
  const marker = Symbol("pending");
  const result = await Promise.race([
    promise.then(() => "resolved"),
    new Promise<typeof marker>((resolve) => setTimeout(() => resolve(marker), 20)),
  ]);
  expect(result).toBe(marker);
}

describe("INF-362 capacity model", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.MAX_CONCURRENT_DISPATCHES;
  });

  test("AC1/AC4: idle fleet plus five tasks for one agent does not defer at the old default per-agent cap", async () => {
    const deps = setupDeps(dir);
    const dispatchedTickets: string[] = [];
    const detector = new NoActivityDetector(
      {
        ...deps,
        wakeConfig,
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => {
            dispatchedTickets.push(...ticketIds);
          },
        },
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000, deferredStaleMs: 3_600_000 },
    );

    for (let i = 1; i <= 5; i++) {
      const ticketId = `linear-INF-${3620 + i}`;
      deps.bag.add("igor", ticketId, "Issue");
      deps.sessionTracker.startSession("igor", ticketId);
      deps.ackTracker.recordDispatch("igor", ticketId);
    }

    const result = await detector.runCycle();

    expect(result.deferredAtCapacity).toBe(0);
    expect(deps.operationalEventStore.query({ outcome: "deferred-at-capacity" })).toHaveLength(0);
    expect(dispatchedTickets).toEqual([
      "linear-INF-3621",
      "linear-INF-3622",
      "linear-INF-3623",
      "linear-INF-3624",
      "linear-INF-3625",
    ]);

    detector.stop();
    closeDeps(deps);
  });

  test("AC2/AC4: global concurrency budget queues dispatches across agents, not per-agent", async () => {
    process.env.MAX_CONCURRENT_DISPATCHES = "2";
    const throttle = new DeliveryThrottle(0);

    const a1 = throttle.acquireSlot();
    const a2 = throttle.acquireSlot();
    await Promise.all([a1, a2]);

    const sameAgentWaiter = throttle.acquireSlot();
    const differentAgentWaiter = throttle.acquireSlot();

    await expectStillPending(sameAgentWaiter);
    await expectStillPending(differentAgentWaiter);

    throttle.releaseSlot();
    await sameAgentWaiter;
    await expectStillPending(differentAgentWaiter);

    throttle.releaseSlot();
    await differentAgentWaiter;

    throttle.releaseSlot();
    throttle.releaseSlot();
  });

  test("AC2: default global budget is documented as gateway lane delivery-rate config, not a work cap or unexplained 3", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/delivery/throttle.ts"),
      "utf8",
    );
    const configurationDoc = fs.readFileSync(
      path.join(process.cwd(), "docs/configuration.md"),
      "utf8",
    );

    expect(source).toContain("MAX_CONCURRENT_DISPATCHES");
    expect(source).toMatch(/gateway lane saturation/i);
    expect(source).toMatch(/delivery-rate throttle|delivery rate throttle/i);
    expect(source).not.toMatch(/work[- ]concurrency|concurrent work/i);
    expect(source).not.toMatch(/DEFAULT_MAX_CONCURRENT\s*=\s*3\b/);
    expect(configurationDoc).toMatch(/MAX_CONCURRENT_DISPATCHES/);
    expect(configurationDoc).toMatch(/gateway lane saturation/i);
    expect(configurationDoc).toMatch(/delivery-rate throttle|delivery rate throttle/i);
    expect(configurationDoc).not.toMatch(/work[- ]concurrency cap|concurrent work cap/i);
  });

  test("AC3: explicit per-agent serialize cap still defers correctness-only serialized agents", async () => {
    const deps = setupDeps(dir);
    const dispatchedTickets: string[] = [];
    const detector = new NoActivityDetector(
      {
        ...deps,
        wakeConfig,
        getAgentMaxConcurrent: (agentId) => (agentId === "serialized-agent" ? 1 : 0),
        resignalOptions: {
          isTicketActionable: () => true,
          sendWakeUp: async (_agentId, ticketIds) => {
            dispatchedTickets.push(...ticketIds);
          },
        },
      },
      { warnMs: 0, failMs: 0, pollMs: 60_000, deferredStaleMs: 3_600_000 },
    );

    deps.bag.add("serialized-agent", "linear-INF-3699", "Issue");
    deps.sessionTracker.startSession("serialized-agent", "linear-INF-3699");
    deps.ackTracker.recordDispatch("serialized-agent", "linear-INF-3699");

    const result = await detector.runCycle();

    expect(result.deferredAtCapacity).toBe(1);
    expect(dispatchedTickets).toHaveLength(0);
    expect(deps.operationalEventStore.query({ outcome: "deferred-at-capacity" })).toHaveLength(1);

    detector.stop();
    closeDeps(deps);
  });
});
