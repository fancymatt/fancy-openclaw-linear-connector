import { jest } from "@jest/globals";
import { AlertBus, _resetAlertBusForTests } from "./alert-bus.js";
import { AlertStore, defaultDedupKey } from "./alert-store.js";

function makeBus(overrides: Partial<ConstructorParameters<typeof AlertBus>[0]> = {}) {
  const store = new AlertStore(":memory:");
  const pushes: string[] = [];
  const pushFn = jest.fn(async (message: string) => {
    pushes.push(message);
  });
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  let nowMs = Date.parse("2026-07-02T12:00:00.000Z");
  const bus = new AlertBus({
    store,
    pushFn,
    log,
    pushEnabled: true,
    pushMinSeverity: "warning",
    pushBudget: 10,
    now: () => new Date(nowMs),
    ...overrides,
  });
  return { bus, store, pushes, pushFn, log, advance: (ms: number) => { nowMs += ms; }, flush: () => new Promise((r) => setImmediate(r)) };
}

const baseAlert = { severity: "warning" as const, source: "dispatch", title: "delivery failed", agent: "felix", ticket: "AI-1" };

describe("AlertStore", () => {
  test("inserts a new row per burst and folds repeats within the window", () => {
    const store = new AlertStore(":memory:");
    const t0 = new Date("2026-07-02T12:00:00Z");
    const first = store.record(baseAlert, 60_000, t0);
    expect(first.suppressed).toBe(false);
    expect(first.row.count).toBe(1);

    const second = store.record(baseAlert, 60_000, new Date(t0.getTime() + 30_000));
    expect(second.suppressed).toBe(true);
    expect(second.row.count).toBe(2);
    expect(second.row.id).toBe(first.row.id);

    const third = store.record(baseAlert, 60_000, new Date(t0.getTime() + 120_000));
    expect(third.suppressed).toBe(false);
    expect(third.row.id).not.toBe(first.row.id);
    expect(third.priorBurstCount).toBe(2);
  });

  test("different dedup keys never fold together", () => {
    const store = new AlertStore(":memory:");
    const t0 = new Date();
    const a = store.record(baseAlert, 60_000, t0);
    const b = store.record({ ...baseAlert, ticket: "AI-2" }, 60_000, t0);
    expect(b.suppressed).toBe(false);
    expect(b.row.id).not.toBe(a.row.id);
  });

  test("redacts secrets in detail before storage", () => {
    const store = new AlertStore(":memory:");
    const result = store.record(
      { ...baseAlert, detail: { note: "authorization: Bearer lin_api_supersecret123" } },
      60_000
    );
    expect(JSON.stringify(result.row.detail)).not.toContain("supersecret123");
  });

  test("ack marks a row once", () => {
    const store = new AlertStore(":memory:");
    const { row } = store.record(baseAlert, 60_000);
    expect(store.ack(row.id)).toBe(true);
    expect(store.ack(row.id)).toBe(false);
    expect(store.query({ unackedOnly: true })).toHaveLength(0);
  });

  test("query filters by severity and source", () => {
    const store = new AlertStore(":memory:");
    store.record(baseAlert, 60_000);
    store.record({ ...baseAlert, severity: "critical", source: "config-health", title: "policy invalid" }, 60_000);
    expect(store.query({ severity: "critical" })).toHaveLength(1);
    expect(store.query({ source: "dispatch" })).toHaveLength(1);
    expect(store.query()).toHaveLength(2);
  });
});

describe("AlertBus", () => {
  afterEach(() => _resetAlertBusForTests());

  test("log and store sinks always fire; push fires at/above min severity", async () => {
    const { bus, store, pushes, log, flush } = makeBus();
    bus.notify({ ...baseAlert, severity: "info", title: "started" });
    bus.notify(baseAlert);
    await flush();

    expect(log.info).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    expect(store.query()).toHaveLength(2);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("[connector:warning]");
    expect(pushes[0]).toContain("delivery failed");
    expect(pushes[0]).toContain("AI-1");
  });

  test("suppressed repeats within a burst do not re-push", async () => {
    const { bus, pushes, advance, flush } = makeBus();
    bus.notify(baseAlert);
    advance(10_000);
    bus.notify(baseAlert);
    await flush();
    expect(pushes).toHaveLength(1);
  });

  test("a new burst after the window pushes again with prior count", async () => {
    const { bus, pushes, advance, flush } = makeBus();
    bus.notify(baseAlert);
    advance(1_000);
    bus.notify(baseAlert);
    advance(61 * 60_000); // beyond the 60-min warning window
    bus.notify(baseAlert);
    await flush();
    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toContain("previous burst: x2");
  });

  test("global push budget: overflow sends one storm digest then goes quiet", async () => {
    const { bus, pushes, flush } = makeBus({ pushBudget: 3 });
    for (let i = 0; i < 6; i++) {
      bus.notify({ ...baseAlert, title: `failure ${i}` });
    }
    await flush();
    expect(pushes).toHaveLength(4); // 3 within budget + 1 storm digest
    expect(pushes[3]).toContain("ALERT STORM");
  });

  test("push failure never throws and alert is still stored", async () => {
    const { bus, store, log, flush } = makeBus({
      pushFn: async () => {
        throw new Error("gateway down");
      },
    });
    expect(() => bus.notify(baseAlert)).not.toThrow();
    await flush();
    expect(store.query()).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("push sink failed"));
  });

  test("store failure degrades to log-only without throwing", () => {
    const store = new AlertStore(":memory:");
    store.close(); // subsequent writes will throw
    const { bus, log } = makeBus({ store });
    expect(() => bus.notify(baseAlert)).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("alert store write failed"));
  });

  test("pushEnabled=false stores but never pushes", async () => {
    const { bus, store, pushes, flush } = makeBus({ pushEnabled: false });
    bus.notify({ ...baseAlert, severity: "critical" });
    await flush();
    expect(store.query()).toHaveLength(1);
    expect(pushes).toHaveLength(0);
  });

  test("successful push marks the row pushed", async () => {
    const { bus, store, flush } = makeBus();
    bus.notify(baseAlert);
    await flush();
    expect(store.query()[0].pushedAt).not.toBeNull();
  });
});

describe("defaultDedupKey", () => {
  test("is stable across identical alerts and distinct across tickets", () => {
    expect(defaultDedupKey(baseAlert)).toBe(defaultDedupKey({ ...baseAlert }));
    expect(defaultDedupKey(baseAlert)).not.toBe(defaultDedupKey({ ...baseAlert, ticket: "AI-2" }));
  });
});
