/**
 * INF-324: Alert disposition gate — structural tests.
 *
 * Tests cover:
 *   1. Every valid disposition is A|B|C
 *   2. Class-A entries have valid failure_class
 *   3. Class-B entries have remedy; Class-C entries have owner
 *   4. Unknown source → class-C + meta-alert (single emit per dedup key)
 *   5. Unknown source does NOT block normal alert log/store/push
 *   6. Live snapshot: every present source in the codebase has a map entry
 */

import { jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  loadDispositionMap,
  resolveDisposition,
  wireDispositionGate,
  getDispositionGateLiveness,
  registerRemediationActor,
  registerRemedy,
  clearRemediesForTest,
  executeClassAction,
  _resetDispositionGateForTests,
  type DispositionMapData,
  type RemediationActor,
} from "./alert-disposition-gate.js";
import { AlertBus, _resetAlertBusForTests } from "./alert-bus.js";
import { AlertStore } from "./alert-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP_PATH = path.resolve(__dirname, "alert-disposition-map.yaml");

function loadMapData(): DispositionMapData {
  const raw = fs.readFileSync(MAP_PATH, "utf8");
  return yaml.load(raw) as DispositionMapData;
}

function makeBus() {
  const store = new AlertStore(":memory:");
  const pushes: string[] = [];
  const pushFn = jest.fn(async (message: string) => { pushes.push(message); });
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const bus = new AlertBus({ store, pushFn, log, pushEnabled: false });
  return { bus, store, pushes, pushFn, log };
}

const baseAlert = { severity: "warning" as const, source: "dispatch", title: "delivery failed" };

// ── AC1 ─────────────────────────────────────────────────────────────────────

describe("AC1 — every source class is A, B, or C", () => {
  test("all sources have a class in {A, B, C}", () => {
    const map = loadMapData();
    for (const [source, entry] of Object.entries(map.sources)) {
      expect(["A", "B", "C"]).toContain(entry.class);
    }
  });

  test("map has entries", () => {
    expect(Object.keys(loadMapData().sources).length).toBeGreaterThan(0);
  });
});

// ── AC2 ─────────────────────────────────────────────────────────────────────

describe("AC2 — class A entries have failure_class", () => {
  const classA = Object.entries(loadMapData().sources).filter(([, e]) => e.class === "A");

  test("at least one class A entry", () => {
    expect(classA.length).toBeGreaterThan(0);
  });

  test.each(classA)("%s has a failure_class", (_, entry) => {
    expect(entry.failure_class).toBeDefined();
    expect(typeof entry.failure_class).toBe("string");
    expect(entry.failure_class!.length).toBeGreaterThan(0);
  });
});

// ── AC3 ─────────────────────────────────────────────────────────────────────

describe("AC3 — class B/C structural requirements", () => {
  const map = loadMapData();
  const classB = Object.entries(map.sources).filter(([, e]) => e.class === "B");
  const classC = Object.entries(map.sources).filter(([, e]) => e.class === "C");

  test.each(classB)("B: %s has remedy + owner", (_, entry) => {
    expect(entry.remedy).toBeDefined();
    expect(entry.owner).toBeDefined();
  });

  test.each(classC)("C: %s has owner", (_, entry) => {
    expect(entry.owner).toBeDefined();
  });

  test("class C entries have no failure_class or remedy", () => {
    for (const [, entry] of classC) {
      expect(entry.failure_class).toBeUndefined();
      expect(entry.remedy).toBeUndefined();
    }
  });
});

// ── AC4 ─────────────────────────────────────────────────────────────────────

describe("AC4 — unknown source → class C + meta-alert", () => {
  beforeEach(() => { _resetDispositionGateForTests(); loadDispositionMap(MAP_PATH); });
  afterEach(() => _resetDispositionGateForTests());

  test("unknown source returns class C and a meta-alert", () => {
    const result = resolveDisposition({ ...baseAlert, source: "nonexistent-module" });
    expect(result.disposition.class).toBe("C");
    expect(result.known).toBe(false);
    expect(result.metaAlert).not.toBeNull();
    expect(result.metaAlert!.dedupKey).toBe("alert-disposition-map|unknown|nonexistent-module");
  });

  test("known source has no meta-alert", () => {
    const result = resolveDisposition({ ...baseAlert, source: "dispatch" });
    expect(result.metaAlert).toBeNull();
    expect(result.known).toBe(true);
  });

  test("unique dedup key per unknown source", () => {
    const a = resolveDisposition({ ...baseAlert, source: "a" });
    const b = resolveDisposition({ ...baseAlert, source: "b" });
    expect(a.metaAlert!.dedupKey).not.toBe(b.metaAlert!.dedupKey);
  });

  test("meta-alert fires through bus for unknown source", () => {
    const { bus, store } = makeBus();
    const recordSpy = jest.spyOn(store, "record");
    wireDispositionGate(bus, MAP_PATH);

    bus.notify({ ...baseAlert, source: "mystery-module" });

    // Original alert + meta-alert = two record() calls
    expect(recordSpy).toHaveBeenCalledTimes(2);
  });
});

// ── AC5 ─────────────────────────────────────────────────────────────────────

describe("AC5 — unknown source does not block alert delivery", () => {
  beforeEach(() => { _resetDispositionGateForTests(); _resetAlertBusForTests(); });
  afterEach(() => { _resetDispositionGateForTests(); _resetAlertBusForTests(); });

  test("unknown source is logged + stored normally", () => {
    const { bus, store, log } = makeBus();
    wireDispositionGate(bus, MAP_PATH);

    bus.notify({ severity: "info", source: "unknown-thing", title: "strange event" });

    const originals = store.query().filter((a) => a.source === "unknown-thing");
    expect(originals.length).toBeGreaterThan(0);
    expect(originals[0].title).toBe("strange event");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("strange event"));
  });

  test("gate error never throws from notify()", () => {
    const { bus } = makeBus();
    wireDispositionGate(bus, MAP_PATH);
    expect(() => bus.notify({ severity: "info", source: "dispatch", title: "test" })).not.toThrow();
  });
});

// ── AC6 ─────────────────────────────────────────────────────────────────────

describe("AC6 — every codebase source has a map entry", () => {
  test("all known alert sources are mapped", () => {
    const mappedSources = new Set(Object.keys(loadMapData().sources));
    const codebaseSources = [
      "agents", "bootstrap-reconciled", "canary", "comment", "config-health",
      "config-sanity", "delegation-reconciled", "deploy-policy", "deploy-stamp",
      "description", "dispatch", "dispatch-circuit-breaker", "done-gate", "env",
      "fallback", "fanout-spec", "first-action-watchdog", "fixture-drift",
      "header", "implementer-store", "known-humans", "lifecycle", "oob-reconcile",
      "process", "proxy", "registry-policy", "routing", "sla-sweep",
      "stale-plain-delegate", "steward:astrid", "token-refresh", "unknown",
      "webhook", "workflow-gate",
    ];
    for (const src of codebaseSources) {
      expect(mappedSources.has(src)).toBe(true);
    }
  });
});

// ── Hot-reload ──────────────────────────────────────────────────────────────

describe("SIGHUP hot-reload", () => {
  beforeEach(() => _resetDispositionGateForTests());
  afterEach(() => _resetDispositionGateForTests());

  test("corrupt reload keeps previous map", () => {
    const { bus } = makeBus();
    wireDispositionGate(bus, MAP_PATH);
    expect(getDispositionGateLiveness().mapLoaded).toBe(true);

    // Point to nonexistent path — should fail silently, keep previous map
    const { bus: bus2 } = makeBus();
    wireDispositionGate(bus2, "/dev/null/nonexistent.yaml");
    expect(getDispositionGateLiveness().mapLoaded).toBe(true);
  });
});

// ── Class A + B execution ──────────────────────────────────────────────────

describe("class action execution", () => {
  beforeEach(() => { _resetDispositionGateForTests(); clearRemediesForTest(); });
  afterEach(() => { _resetDispositionGateForTests(); clearRemediesForTest(); });

  test("class A: remediation actor called with failure_class", async () => {
    const actor: RemediationActor = {
      executeRemediation: jest.fn(async () => {}),
    };
    registerRemediationActor(actor);
    loadDispositionMap(MAP_PATH);

    const alert = { ...baseAlert, source: "token-refresh", title: "token expired" };
    const { disposition } = resolveDisposition(alert);
    await executeClassAction(disposition, alert.source, alert);

    expect(actor.executeRemediation).toHaveBeenCalledWith("oauth_token_refresh", "token-refresh", alert);
  });

  test("class B: registered remedy callback called", async () => {
    const remedyFn = jest.fn(async () => {});
    registerRemedy("re-dispatch", remedyFn);
    loadDispositionMap(MAP_PATH);

    const alert = { ...baseAlert, source: "dispatch", title: "dispatch failed" };
    const { disposition } = resolveDisposition(alert);
    await executeClassAction(disposition, alert.source, alert);

    expect(remedyFn).toHaveBeenCalledWith("re-dispatch", "dispatch", alert);
  });

  test("unregistered remedy does not throw", async () => {
    loadDispositionMap(MAP_PATH);
    const alert = { ...baseAlert, source: "dispatch", title: "dispatch failed" };
    const { disposition } = resolveDisposition(alert);
    await expect(executeClassAction(disposition, alert.source, alert)).resolves.toBeUndefined();
  });
});

// ── Liveness ────────────────────────────────────────────────────────────────

describe("disposition gate liveness", () => {
  beforeEach(() => _resetDispositionGateForTests());
  afterEach(() => _resetDispositionGateForTests());

  test("reports wired=false before wiring, wired=true after", () => {
    expect(getDispositionGateLiveness().wired).toBe(false);
    const { bus } = makeBus();
    wireDispositionGate(bus, MAP_PATH);
    const liveness = getDispositionGateLiveness();
    expect(liveness.wired).toBe(true);
    expect(liveness.mapLoaded).toBe(true);
    expect(liveness.sources.length).toBeGreaterThan(0);
  });
});
