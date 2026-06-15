/**
 * AI-1545 — Per-state SLAs + liveness-probe-at-breach + stall-storm throttle.
 *
 * These tests are INTENTIONALLY FAILING. They define the contract the implementation
 * must satisfy. Run `npm test -- engine-stall-ai1545` to confirm all are red.
 *
 * AC mapping:
 *   AC1 — each working state has an SLA; clock past it fires a stall event
 *   AC2 — stall signal carries dead-vs-slow classification from a liveness probe
 *   AC3 — steward signaled once per breach, not per tick (dedup proven)
 *   AC4 — rollout staged/throttled so day-one does not flood
 */

import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";

// ── Shared constants ─────────────────────────────────────────────────────────

const FIXTURE_PATH = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");

/**
 * Working states in dev-impl v8 that must carry per-state SLAs (G-5).
 * code-review already has 24h; all others are the gap being closed.
 */
const DEV_IMPL_WORK_STATES = [
  "write-tests",
  "implementation",
  "deployment",
  "host-deploy",
  "ac-validate",
  "code-review",
];

function loadDevImplDef() {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  return yamlLoad(raw) as {
    states: Array<{ id: string; kind?: string; sla?: string }>;
  };
}

/**
 * Parse an SLA duration string into hours.
 * Accepts "Xh", "Xd", "Xm" (minutes), bare ms numbers.
 */
function parseSlaHours(sla: string): number {
  const m = /^(\d+(?:\.\d+)?)(h|d|m)?$/i.exec(sla.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch ((m[2] ?? "ms").toLowerCase()) {
    case "d": return n * 24;
    case "h": return n;
    case "m": return n / 60;
    default: return n / 3_600_000; // bare ms → hours
  }
}

// ── AC1: Per-state SLAs defined in canonical-dev-impl.yaml ──────────────────

describe("AC1 — per-state SLAs in canonical-dev-impl.yaml", () => {
  it("every working state declares an sla field", () => {
    const def = loadDevImplDef();
    const stateMap = new Map(def.states.map((s) => [s.id, s]));

    for (const stateId of DEV_IMPL_WORK_STATES) {
      const state = stateMap.get(stateId);
      expect(state).toBeDefined();
      // Each state must have a non-empty sla string
      expect(typeof state?.sla).toBe("string");
      expect((state?.sla ?? "").length).toBeGreaterThan(0);
    }
  });

  it("implementation SLA is longer than code-review SLA (days of work vs 24h review cap)", () => {
    const def = loadDevImplDef();
    const stateMap = new Map(def.states.map((s) => [s.id, s]));
    const implSla = stateMap.get("implementation")?.sla ?? "";
    const reviewSla = stateMap.get("code-review")?.sla ?? "";
    // code-review = 24h; implementation legitimately takes days → must be strictly longer
    expect(parseSlaHours(implSla)).toBeGreaterThan(parseSlaHours(reviewSla));
  });

  it("SLA values differ across states (not a copy-paste value applied everywhere)", () => {
    const def = loadDevImplDef();
    const stateMap = new Map(def.states.map((s) => [s.id, s]));
    const slas = DEV_IMPL_WORK_STATES
      .map((id) => stateMap.get(id)?.sla)
      .filter(Boolean) as string[];

    // Must have at least 2 distinct values: implementation ≠ code-review at minimum
    expect(new Set(slas).size).toBeGreaterThanOrEqual(2);
  });

  it("write-tests SLA is set (was missing before G-5)", () => {
    const def = loadDevImplDef();
    const writeTests = def.states.find((s) => s.id === "write-tests");
    expect(writeTests?.sla).toBeDefined();
    expect(parseSlaHours(writeTests?.sla ?? "")).toBeGreaterThan(0);
  });

  it("host-deploy SLA is set (was missing before G-5)", () => {
    const def = loadDevImplDef();
    const hostDeploy = def.states.find((s) => s.id === "host-deploy");
    expect(hostDeploy?.sla).toBeDefined();
    expect(parseSlaHours(hostDeploy?.sla ?? "")).toBeGreaterThan(0);
  });

  it("ac-validate SLA is set (was missing before G-5)", () => {
    const def = loadDevImplDef();
    const acValidate = def.states.find((s) => s.id === "ac-validate");
    expect(acValidate?.sla).toBeDefined();
    expect(parseSlaHours(acValidate?.sla ?? "")).toBeGreaterThan(0);
  });
});

// ── AC1: Stall event fires when clock passes per-state SLA ───────────────────

describe("AC1 — stall event fires when time-in-state exceeds per-state SLA", () => {
  let origFetch: typeof globalThis.fetch;
  let origWorkflowPath: string | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    origWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    // Point workflow def loading at the fixture so SLAs are read
    process.env.WORKFLOW_DEF_PATH = FIXTURE_PATH;
    // Reset the workflow registry cache so the new env is picked up
    jest.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origWorkflowPath === undefined) delete process.env.WORKFLOW_DEF_PATH;
    else process.env.WORKFLOW_DEF_PATH = origWorkflowPath;
  });

  /**
   * Build a mock fetch that handles the barrier's Linear queries for one child.
   * Uses 14-day staleness so the child is clearly past any reasonable SLA.
   */
  function makeStallMock(opts: {
    childId: string;
    parentId: string;
    stateLabel: string; // e.g. "write-tests"
    idleDays?: number;
  }) {
    const now = Date.now();
    const idleMs = (opts.idleDays ?? 14) * 24 * 60 * 60 * 1000;
    const lastActivity = new Date(now - idleMs).toISOString();
    const stateLabel = `state:${opts.stateLabel}`;

    return async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string };
      const q = body.query ?? "";

      if (q.includes("ParentChildren")) {
        return new Response(JSON.stringify({
          data: { issue: { children: { nodes: [
            { identifier: opts.childId, labels: { nodes: [
              { name: "wf:dev-impl" }, { name: stateLabel },
            ] } },
          ] } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (q.includes("ChildActivity")) {
        return new Response(JSON.stringify({
          data: { issue: { updatedAt: lastActivity } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (q.includes("ChildStateHistory")) {
        // Return matching IssueLabelPayload history so stateEnteredAt is resolved
        return new Response(JSON.stringify({
          data: { issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: stateLabel }] },
            history: { nodes: [
              { __typename: "IssueLabelPayload", createdAt: lastActivity, toLabel: { name: stateLabel } },
            ] },
          } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
  }

  it("detectStalledChildrenWithSLA emits a StallEvent for a write-tests child 14 days past its SLA", async () => {
    globalThis.fetch = makeStallMock({ childId: "AI-9001", parentId: "AI-9000", stateLabel: "write-tests" }) as typeof fetch;

    const { detectStalledChildrenWithSLA } = await import("./engine-stall.js");
    // Pass empty slas — after G-5 implementation the function must derive SLAs from
    // the workflow def (WORKFLOW_DEF_PATH fixture), not the caller-supplied array.
    const events = await detectStalledChildrenWithSLA("AI-9000", "tok", []);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].currentState).toBe("write-tests");
  });

  it("detectStalledChildrenWithSLA emits a StallEvent for a host-deploy child 14 days past its SLA", async () => {
    globalThis.fetch = makeStallMock({ childId: "AI-9002", parentId: "AI-9000", stateLabel: "host-deploy" }) as typeof fetch;

    const { detectStalledChildrenWithSLA } = await import("./engine-stall.js");
    const events = await detectStalledChildrenWithSLA("AI-9000", "tok", []);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].currentState).toBe("host-deploy");
  });

  it("detectStalledChildrenWithSLA emits a StallEvent for an ac-validate child 14 days past its SLA", async () => {
    globalThis.fetch = makeStallMock({ childId: "AI-9003", parentId: "AI-9000", stateLabel: "ac-validate" }) as typeof fetch;

    const { detectStalledChildrenWithSLA } = await import("./engine-stall.js");
    const events = await detectStalledChildrenWithSLA("AI-9000", "tok", []);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].currentState).toBe("ac-validate");
  });

  it("no stall event when child in implementation state was active only 1 hour ago", async () => {
    globalThis.fetch = makeStallMock({
      childId: "AI-9004", parentId: "AI-9000", stateLabel: "implementation", idleDays: 1 / 24, // 1 hour
    }) as typeof fetch;

    const { detectStalledChildrenWithSLA } = await import("./engine-stall.js");
    const events = await detectStalledChildrenWithSLA("AI-9000", "tok", []);

    expect(events.length).toBe(0);
  });
});

// ── AC2: Dead-vs-slow classification from liveness probe ────────────────────

describe("AC2 — stall signal carries dead-vs-slow liveness classification", () => {
  it("classifyStallLiveness returns 'dead' when liveness probe times out", async () => {
    // classifyStallLiveness is a new export from engine-stall.ts
    const { classifyStallLiveness } = await import("./engine-stall.js") as {
      classifyStallLiveness: (livenessResult: { available: boolean; reason?: string }) => "dead" | "slow";
    };

    expect(classifyStallLiveness({ available: false, reason: "timeout" })).toBe("dead");
  });

  it("classifyStallLiveness returns 'dead' when liveness probe returns unreachable", async () => {
    const { classifyStallLiveness } = await import("./engine-stall.js") as {
      classifyStallLiveness: (livenessResult: { available: boolean; reason?: string }) => "dead" | "slow";
    };

    expect(classifyStallLiveness({ available: false, reason: "unreachable" })).toBe("dead");
  });

  it("classifyStallLiveness returns 'dead' when liveness probe returns error", async () => {
    const { classifyStallLiveness } = await import("./engine-stall.js") as {
      classifyStallLiveness: (livenessResult: { available: boolean; reason?: string }) => "dead" | "slow";
    };

    expect(classifyStallLiveness({ available: false, reason: "error" })).toBe("dead");
  });

  it("classifyStallLiveness returns 'slow' when liveness probe is available", async () => {
    const { classifyStallLiveness } = await import("./engine-stall.js") as {
      classifyStallLiveness: (livenessResult: { available: boolean; reason?: string }) => "dead" | "slow";
    };

    expect(classifyStallLiveness({ available: true })).toBe("slow");
  });

  it("emitStallEventsWithLiveness annotates events with livenessClassification='dead' when probe fails", async () => {
    // emitStallEventsWithLiveness is a new export from engine-stall.ts that:
    //   1. Probes delegate liveness per stall event
    //   2. Annotates each event with livenessClassification before returning
    const { emitStallEventsWithLiveness } = await import("./engine-stall.js") as {
      emitStallEventsWithLiveness: (
        events: Array<{ childIdentifier: string; parentIdentifier: string; currentState: string; [k: string]: unknown }>,
        authToken: string,
        livenessConfig: { hooksUrl?: string; hooksToken?: string },
      ) => Promise<Array<{ livenessClassification: "dead" | "slow"; [k: string]: unknown }>>;
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("", { status: 503 });

    try {
      const annotated = await emitStallEventsWithLiveness(
        [{ childIdentifier: "AI-9010", parentIdentifier: "AI-9000", currentState: "write-tests", idleDurationMs: 100_000 }],
        "tok",
        { hooksUrl: "http://localhost:3100/ping", hooksToken: "test" },
      );

      expect(annotated).toHaveLength(1);
      expect(annotated[0].livenessClassification).toBe("dead");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("emitStallEventsWithLiveness annotates events with livenessClassification='slow' when probe succeeds", async () => {
    const { emitStallEventsWithLiveness } = await import("./engine-stall.js") as {
      emitStallEventsWithLiveness: (
        events: Array<{ childIdentifier: string; parentIdentifier: string; currentState: string; [k: string]: unknown }>,
        authToken: string,
        livenessConfig: { hooksUrl?: string; hooksToken?: string },
      ) => Promise<Array<{ livenessClassification: "dead" | "slow"; [k: string]: unknown }>>;
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });

    try {
      const annotated = await emitStallEventsWithLiveness(
        [{ childIdentifier: "AI-9011", parentIdentifier: "AI-9000", currentState: "implementation", idleDurationMs: 200_000 }],
        "tok",
        { hooksUrl: "http://localhost:3100/ping", hooksToken: "test" },
      );

      expect(annotated).toHaveLength(1);
      expect(annotated[0].livenessClassification).toBe("slow");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("StallEvent from buildStallEvent carries a livenessClassification field", async () => {
    // buildStallEvent must be extended to include livenessClassification
    const { buildStallEvent } = await import("./barrier.js");

    const fakeChild = {
      identifier: "AI-9012",
      parentIdentifier: "AI-9000",
      currentState: "write-tests",
      lastActivityAt: Date.now() - 60_000,
      idleDurationMs: 60_000,
      stateEnteredAt: Date.now() - 90_000,
      stateSlaMs: 30_000,
      timeInStateMs: 90_000,
      knownDeferralMs: 0,
      isDeferredAtCapacity: false,
    };

    const event = buildStallEvent(fakeChild, Date.now());

    // AC2: the StallEvent interface MUST include livenessClassification
    expect(event).toHaveProperty("livenessClassification");
  });
});

// ── AC3: Once-per-breach dedup — steward signaled exactly once ──────────────

describe("AC3 — steward signaled once per breach, not per tick", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stall-breach-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("StallBreachStore.isAlreadySignaled returns false on first call", async () => {
    // StallBreachStore is a new module: src/store/stall-breach-store.ts
    const { StallBreachStore } = await import("./store/stall-breach-store.js") as {
      StallBreachStore: new (dbPath: string) => {
        isAlreadySignaled(childId: string, stateEnteredAt: number): boolean;
        recordSignal(childId: string, stateEnteredAt: number): void;
        close(): void;
      };
    };

    const store = new StallBreachStore(path.join(tmpDir, "breach.db"));
    try {
      expect(store.isAlreadySignaled("AI-9020", 1_700_000_000_000)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("StallBreachStore.isAlreadySignaled returns true after recordSignal", async () => {
    const { StallBreachStore } = await import("./store/stall-breach-store.js") as {
      StallBreachStore: new (dbPath: string) => {
        isAlreadySignaled(childId: string, stateEnteredAt: number): boolean;
        recordSignal(childId: string, stateEnteredAt: number): void;
        close(): void;
      };
    };

    const store = new StallBreachStore(path.join(tmpDir, "breach.db"));
    try {
      store.recordSignal("AI-9021", 1_700_000_000_000);
      expect(store.isAlreadySignaled("AI-9021", 1_700_000_000_000)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("StallBreachStore: different stateEnteredAt (re-stall after recovery) is a new breach", async () => {
    const { StallBreachStore } = await import("./store/stall-breach-store.js") as {
      StallBreachStore: new (dbPath: string) => {
        isAlreadySignaled(childId: string, stateEnteredAt: number): boolean;
        recordSignal(childId: string, stateEnteredAt: number): void;
        close(): void;
      };
    };

    const store = new StallBreachStore(path.join(tmpDir, "breach.db"));
    try {
      store.recordSignal("AI-9022", 1_700_000_000_000);
      // Same child but different state-entry epoch = new breach instance
      expect(store.isAlreadySignaled("AI-9022", 1_700_000_100_000)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("StallBreachStore: survives close and reopen (SQLite persistence)", async () => {
    const { StallBreachStore } = await import("./store/stall-breach-store.js") as {
      StallBreachStore: new (dbPath: string) => {
        isAlreadySignaled(childId: string, stateEnteredAt: number): boolean;
        recordSignal(childId: string, stateEnteredAt: number): void;
        close(): void;
      };
    };

    const dbPath = path.join(tmpDir, "breach.db");
    const store1 = new StallBreachStore(dbPath);
    store1.recordSignal("AI-9023", 1_700_000_000_000);
    store1.close();

    // New instance on same file must see the prior signal
    const store2 = new StallBreachStore(dbPath);
    try {
      expect(store2.isAlreadySignaled("AI-9023", 1_700_000_000_000)).toBe(true);
    } finally {
      store2.close();
    }
  });

  it("triggerStallDetectionWithDedup: second tick on same breach emits 0 and reports 1 deduped", async () => {
    // triggerStallDetectionWithDedup wraps triggerStallDetection with StallBreachStore dedup.
    // Returns { emitted: number; deduped: number; deferred?: number }
    const { triggerStallDetectionWithDedup } = await import("./engine-stall.js") as {
      triggerStallDetectionWithDedup: (
        parentIdentifier: string,
        authToken: string,
        breachStorePath: string,
      ) => Promise<{ emitted: number; deduped: number; deferred?: number }>;
    };

    const breachStorePath = path.join(tmpDir, "breach.db");
    const origWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEF_PATH = FIXTURE_PATH;

    const now = Date.now();
    const staleAt = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
    const stateLabel = "state:write-tests";
    let commentsPosted = 0;

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string };
      const q = body.query ?? "";

      if (q.includes("ParentChildren")) {
        return new Response(JSON.stringify({
          data: { issue: { children: { nodes: [
            { identifier: "AI-9030", labels: { nodes: [
              { name: "wf:dev-impl" }, { name: stateLabel },
            ] } },
          ] } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (q.includes("ChildActivity")) {
        return new Response(JSON.stringify({ data: { issue: { updatedAt: staleAt } } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (q.includes("ChildStateHistory")) {
        return new Response(JSON.stringify({
          data: { issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: stateLabel }] },
            history: { nodes: [
              { __typename: "IssueLabelPayload", createdAt: staleAt, toLabel: { name: stateLabel } },
            ] },
          } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // Resolve parent internal id
      if (q.includes("issue") && q.includes("id")) {
        return new Response(JSON.stringify({ data: { issue: { id: "internal-uuid-9000" } } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // Comment / mutation
      if (q.toLowerCase().includes("comment") || q.toLowerCase().includes("mutation")) {
        commentsPosted++;
        return new Response(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c1" } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    try {
      jest.resetModules();
      const tick1 = await triggerStallDetectionWithDedup("AI-9000", "tok", breachStorePath);
      const tick2 = await triggerStallDetectionWithDedup("AI-9000", "tok", breachStorePath);

      // First tick should emit 1 (the breach notification)
      expect(tick1.emitted).toBe(1);
      // Second tick: same breach → deduped; steward NOT re-signaled
      expect(tick2.emitted).toBe(0);
      expect(tick2.deduped).toBe(1);
      // Linear comment posted exactly once
      expect(commentsPosted).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
      if (origWorkflowPath === undefined) delete process.env.WORKFLOW_DEF_PATH;
      else process.env.WORKFLOW_DEF_PATH = origWorkflowPath;
    }
  });
});

// ── AC4: Rollout throttle — stall storm prevention ──────────────────────────

describe("AC4 — rollout staged/throttled; day-one does not flood", () => {
  it("throttleStallRollout dispatches at most batchSize events; defers the rest", async () => {
    // throttleStallRollout is a new export from engine-stall.ts.
    // When N stalls all breach simultaneously, it returns only up to batchSize
    // events for immediate dispatch and defers the remainder.
    const { throttleStallRollout } = await import("./engine-stall.js") as {
      throttleStallRollout: (
        events: Array<{ childIdentifier: string; [k: string]: unknown }>,
        batchSize: number,
      ) => { dispatch: Array<{ childIdentifier: string; [k: string]: unknown }>; deferred: Array<{ childIdentifier: string; [k: string]: unknown }> };
    };

    const twentyEvents = Array.from({ length: 20 }, (_, i) => ({
      childIdentifier: `AI-${9100 + i}`,
      currentState: "write-tests",
    }));

    const { dispatch, deferred } = throttleStallRollout(twentyEvents, 5);

    expect(dispatch).toHaveLength(5);
    expect(deferred).toHaveLength(15);
    // Dispatch + deferred = all events (no drops)
    expect(dispatch.length + deferred.length).toBe(20);
  });

  it("throttleStallRollout with batchSize ≥ count dispatches all, defers none", async () => {
    const { throttleStallRollout } = await import("./engine-stall.js") as {
      throttleStallRollout: (
        events: Array<{ childIdentifier: string; [k: string]: unknown }>,
        batchSize: number,
      ) => { dispatch: Array<unknown>; deferred: Array<unknown> };
    };

    const threeEvents = Array.from({ length: 3 }, (_, i) => ({
      childIdentifier: `AI-${9200 + i}`,
      currentState: "implementation",
    }));

    const { dispatch, deferred } = throttleStallRollout(threeEvents, 10);

    expect(dispatch).toHaveLength(3);
    expect(deferred).toHaveLength(0);
  });

  it("throttleStallRollout with batchSize=0 defers all events (safety guard)", async () => {
    const { throttleStallRollout } = await import("./engine-stall.js") as {
      throttleStallRollout: (
        events: Array<{ childIdentifier: string; [k: string]: unknown }>,
        batchSize: number,
      ) => { dispatch: Array<unknown>; deferred: Array<unknown> };
    };

    const events = [{ childIdentifier: "AI-9210", currentState: "write-tests" }];
    const { dispatch, deferred } = throttleStallRollout(events, 0);

    expect(dispatch).toHaveLength(0);
    expect(deferred).toHaveLength(1);
  });

  it("triggerStallDetectionWithDedup respects STALL_ROLLOUT_BATCH_SIZE env: 5 stalls → 2 emitted, 3 deferred", async () => {
    const { triggerStallDetectionWithDedup } = await import("./engine-stall.js") as {
      triggerStallDetectionWithDedup: (
        parentIdentifier: string,
        authToken: string,
        breachStorePath: string,
      ) => Promise<{ emitted: number; deduped: number; deferred?: number }>;
    };

    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "stall-rollout-test-"));
    const breachStorePath = path.join(tmpDir2, "breach.db");

    const origEnv = process.env.STALL_ROLLOUT_BATCH_SIZE;
    const origWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    process.env.STALL_ROLLOUT_BATCH_SIZE = "2";
    process.env.WORKFLOW_DEF_PATH = FIXTURE_PATH;

    const now = Date.now();
    const staleAt = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string };
      const q = body.query ?? "";

      if (q.includes("ParentChildren")) {
        return new Response(JSON.stringify({
          data: { issue: { children: { nodes: Array.from({ length: 5 }, (_, i) => ({
            identifier: `AI-${9300 + i}`,
            labels: { nodes: [
              { name: "wf:dev-impl" }, { name: "state:write-tests" },
            ] },
          })) } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (q.includes("ChildActivity")) {
        return new Response(JSON.stringify({ data: { issue: { updatedAt: staleAt } } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (q.includes("ChildStateHistory")) {
        return new Response(JSON.stringify({
          data: { issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:write-tests" }] },
            history: { nodes: [
              { __typename: "IssueLabelPayload", createdAt: staleAt, toLabel: { name: "state:write-tests" } },
            ] },
          } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (q.includes("issue") && q.includes("id")) {
        return new Response(JSON.stringify({ data: { issue: { id: "internal-uuid-9000" } } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (q.toLowerCase().includes("comment") || q.toLowerCase().includes("mutation")) {
        return new Response(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "cx" } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    try {
      jest.resetModules();
      const result = await triggerStallDetectionWithDedup("AI-9000", "tok", breachStorePath);
      // 5 simultaneous stalls, batch size 2 → emit 2, defer 3
      expect(result.emitted).toBe(2);
      expect(result.deferred).toBe(3);
    } finally {
      globalThis.fetch = origFetch;
      if (origEnv === undefined) delete process.env.STALL_ROLLOUT_BATCH_SIZE;
      else process.env.STALL_ROLLOUT_BATCH_SIZE = origEnv;
      if (origWorkflowPath === undefined) delete process.env.WORKFLOW_DEF_PATH;
      else process.env.WORKFLOW_DEF_PATH = origWorkflowPath;
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});
