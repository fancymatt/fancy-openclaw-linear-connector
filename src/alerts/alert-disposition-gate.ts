/**
 * Alert Disposition Gate — INF-324
 *
 * Reads the machine-readable disposition map (alert-disposition-map.yaml) and
 * routes each notify() call to the correct class action:
 *
 *   Class-A: routes to executeRemediation() with mapped failure_class (INF-320)
 *   Class-B: triggers the mapped remedy callback
 *   Class-C: passes through (surface to owner is follow-up), no auto-action
 *   UNKNOWN: surfaces as class-C + raises meta-alert with dedup key
 *            alert-disposition-map|unknown|<source>
 *
 * Hot-reloads the map on SIGHUP.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { componentLogger, createLogger, type Logger } from "../logger.js";
import { type AlertInput, type AlertBus } from "./alert-bus.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type DispositionClass = "A" | "B" | "C";

export interface DispositionEntry {
  class: DispositionClass;
  /** Class-A only: the failure_class passed to executeRemediation(). */
  failure_class?: string;
  /** Class-B only: the remedy action key. */
  remedy?: string;
  /** The owning party (agent name or role). */
  owner?: string;
  /** Human-readable label. */
  label?: string;
}

export interface DispositionMapData {
  sources: Record<string, DispositionEntry>;
}

// ── Remediation interface (INF-320) ─────────────────────────────────────────

export interface RemediationActor {
  executeRemediation(failureClass: string, source: string, alert: AlertInput): Promise<void>;
}

// ── Remedy callback type ────────────────────────────────────────────────────

export type RemedyCallback = (remedyKey: string, source: string, alert: AlertInput) => Promise<void>;

// ── Module state ────────────────────────────────────────────────────────────

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "alert-disposition");

let _mapPath: string | null = null;
let _dispositionMap: DispositionMapData | null = null;
let _remediationActor: RemediationActor | null = null;
let _remedyCallbacks = new Map<string, RemedyCallback>();
let _lastLoadError: string | null = null;
let _wired = false;

function defaultMapPath(): string {
  if (_mapPath) return _mapPath;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  _mapPath = path.resolve(dir, "alert-disposition-map.yaml");
  return _mapPath;
}

function resolveMapPath(customPath?: string): string {
  if (customPath) {
    _mapPath = path.resolve(customPath);
  }
  return defaultMapPath();
}

// ── YAML loading ────────────────────────────────────────────────────────────

export function loadDispositionMap(customPath?: string): DispositionMapData {
  const resolvedPath = resolveMapPath(customPath);
  try {
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const parsed = yaml.load(raw) as DispositionMapData;
    if (!parsed || typeof parsed !== "object" || !parsed.sources) {
      throw new Error("disposition map must have a 'sources' key at the root");
    }
    // Validate every entry
    for (const [source, entry] of Object.entries(parsed.sources)) {
      if (!entry.class || !["A", "B", "C"].includes(entry.class)) {
        throw new Error(`source '${source}': invalid or missing class (must be A, B, or C)`);
      }
      if (entry.class === "A" && !entry.failure_class) {
        throw new Error(`source '${source}': class A entries must have a failure_class`);
      }
      if (entry.class === "B" && !entry.remedy) {
        throw new Error(`source '${source}': class B entries must have a remedy`);
      }
      if (entry.class === "C" && !entry.owner) {
        throw new Error(`source '${source}': class C entries must have an owner`);
      }
    }
    _dispositionMap = parsed;
    _lastLoadError = null;
    return parsed;
  } catch (err) {
    _lastLoadError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export function reloadDispositionMap(): DispositionMapData | null {
  try {
    return loadDispositionMap();
  } catch (err) {
    log.error(`disposition map reload failed: ${err instanceof Error ? err.message : String(err)}`);
    // Keep the previous map on failure
    return _dispositionMap;
  }
}

// ── Source resolution ───────────────────────────────────────────────────────

export interface SourceDisposition {
  entry: DispositionEntry;
  known: boolean;
}

export function resolveSource(source: string): SourceDisposition {
  const map = _dispositionMap;
  if (!map) {
    return {
      entry: { class: "C", owner: "operations", label: "No disposition map loaded" },
      known: false,
    };
  }
  const entry = map.sources[source];
  if (!entry) {
    return {
      entry: { class: "C", owner: "operations", label: "Unknown source" },
      known: false,
    };
  }
  return { entry, known: true };
}

// ── Remediation and remedy registration ─────────────────────────────────────

export function registerRemediationActor(actor: RemediationActor): void {
  _remediationActor = actor;
}

export function registerRemedy(key: string, callback: RemedyCallback): void {
  _remedyCallbacks.set(key, callback);
}

export function clearRemediesForTest(): void {
  _remedyCallbacks.clear();
  _remediationActor = null;
  _dispositionMap = null;
  _lastLoadError = null;
  _wired = false;
}

// ── Core disposition logic ──────────────────────────────────────────────────

export interface DispositionResult {
  disposition: DispositionEntry;
  known: boolean;
  /** A meta-alert payload if the source is unknown. Null if known. */
  metaAlert: { severity: "warning"; source: string; title: string; dedupKey: string } | null;
}

/**
 * Resolve the disposition for a given alert.
 * Returns the disposition entry, whether the source is known,
 * and a meta-alert payload for unknown sources.
 */
export function resolveDisposition(alert: AlertInput): DispositionResult {
  const { entry, known } = resolveSource(alert.source);
  let metaAlert: DispositionResult["metaAlert"] = null;
  if (!known) {
    metaAlert = {
      severity: "warning",
      source: "alert-disposition",
      title: `Unknown alert source: ${alert.source} — no disposition map entry`,
      dedupKey: `alert-disposition-map|unknown|${alert.source}`,
    };
  }
  return { disposition: entry, known, metaAlert };
}

/**
 * Execute the class action for a resolved disposition.
 * Fire-and-forget for class A and B — never blocks notify().
 */
export async function executeClassAction(
  disposition: DispositionEntry,
  source: string,
  alert: AlertInput,
): Promise<void> {
  if (disposition.class === "A") {
    if (_remediationActor && disposition.failure_class) {
      await _remediationActor.executeRemediation(disposition.failure_class, source, alert);
    }
  } else if (disposition.class === "B") {
    if (disposition.remedy) {
      const callback = _remedyCallbacks.get(disposition.remedy);
      if (callback) {
        await callback(disposition.remedy, source, alert);
      }
    }
  }
  // Class C: no auto-action
}

// ── AlertBus integration ────────────────────────────────────────────────────

export interface DispositionGateLiveness {
  wired: boolean;
  mapLoaded: boolean;
  sources: string[];
  lastLoadError: string | null;
}

export function getDispositionGateLiveness(): DispositionGateLiveness {
  return {
    wired: _wired,
    mapLoaded: _dispositionMap !== null,
    sources: _dispositionMap ? Object.keys(_dispositionMap.sources).sort() : [],
    lastLoadError: _lastLoadError,
  };
}

/**
 * Wire the disposition gate onto an AlertBus.
 *
 * Wraps the bus's notify() to add disposition resolution. The original
 * notify() always fires (log/store/push) — the gate never blocks alert
 * delivery. Class actions and meta-alerts are fire-and-forget.
 *
 * Call this once at bootstrap, after initAlertBus().
 */
export function wireDispositionGate(bus: AlertBus, customMapPath?: string): void {
  // Load the map first
  try {
    loadDispositionMap(customMapPath);
  } catch (err) {
    log.error(
      `disposition gate: map load failed at bootstrap — UNKNOWN disposition for all sources: ${err instanceof Error ? err.message : String(err)}`,
    );
    // _dispositionMap unchanged — last-good map is preserved on reload failure
  }

  const originalNotify = bus.notify.bind(bus);

  // Wrap notify — never change the signature or throw behavior
  bus.notify = (alert: AlertInput): void => {
    // Always fire the original notify (log/store/push never blocked)
    originalNotify(alert);

    // Resolve disposition (fire-and-forget — errors never reach the caller)
    try {
      const { disposition, known, metaAlert } = resolveDisposition(alert);

      // Unknown source: emit meta-alert via the same bus
      if (metaAlert && !isTestSource(alert.source)) {
        originalNotify({
          severity: metaAlert.severity,
          source: metaAlert.source,
          title: metaAlert.title,
          detail: { originalAlert: { source: alert.source, severity: alert.severity, title: alert.title } },
          dedupKey: metaAlert.dedupKey,
        });
      }

      // Fire class action asynchronously (never blocks notify return)
      if (disposition.class === "A" || disposition.class === "B") {
        executeClassAction(disposition, alert.source, alert).catch((err) => {
          log.error(
            `class-${disposition.class} action failed for source=${alert.source}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    } catch (err) {
      // Gate failure must never break the alert path
      log.error(
        `disposition gate error for source=${alert.source}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  _wired = true;

  // Register SIGHUP handler for hot-reload
  // Use a once-only registration pattern so repeated wireDispositionGate calls
  // (e.g. in tests) don't stack handlers
  if (!process.listenerCount("SIGHUP")) {
    process.on("SIGHUP", () => {
      reloadDispositionMap();
    });
  }

  log.info("alert disposition gate wired — SIGHUP hot-reload enabled");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Test sources are those injected by test suites (e.g. "test", "jest").
 * Meta-alerts should not be raised for test sources to avoid noise.
 */
function isTestSource(source: string): boolean {
  return source.startsWith("test") || source === "jest";
}

/** Reset the module state for testing. */
export function _resetDispositionGateForTests(): void {
  clearRemediesForTest();
  _mapPath = null;
  _wired = false;
  // Remove SIGHUP listener only in test context
  const listeners = process.listeners("SIGHUP");
  for (const listener of listeners) {
    process.removeListener("SIGHUP", listener);
  }
}
