import { componentLogger, createLogger, type Logger } from "../logger.js";
import { AlertStore, defaultDedupKey, type AlertInput, type AlertSeverity } from "./alert-store.js";
import { sendThroughChain } from "./push-transports.js";
import { emitStreamTopic } from "../admin-stream.js";

export type { AlertInput, AlertSeverity };

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

/** Dedup suppression window per severity (docs/alert-bus.md). */
const SUPPRESS_WINDOW_MS: Record<AlertSeverity, number> = {
  critical: 15 * 60_000,
  warning: 60 * 60_000,
  info: 6 * 60 * 60_000,
};

const PUSH_BUDGET_WINDOW_MS = 15 * 60_000;

export interface AlertBusOptions {
  store?: AlertStore;
  log?: Logger;
  /** Override push transport (tests). Default posts push_notification to the OpenClaw gateway. */
  pushFn?: (message: string) => Promise<string | void>;
  pushEnabled?: boolean;
  pushMinSeverity?: AlertSeverity;
  pushBudget?: number;
  now?: () => Date;
}

function envBool(name: string, defaultVal: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultVal;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function envSeverity(name: string, defaultVal: AlertSeverity): AlertSeverity {
  const raw = (process.env[name] ?? "").toLowerCase();
  return raw === "info" || raw === "warning" || raw === "critical" ? raw : defaultVal;
}

async function gatewayPush(message: string): Promise<string> {
  return await sendThroughChain(message);
}

/**
 * The single funnel for "a human should know about this" (docs/alert-bus.md).
 *
 * notify() never throws and never blocks the caller beyond synchronous
 * log+store writes — it is safe to call from any error path. Sinks:
 *   log   — always
 *   store — always (alerts.db, the console's future event feed)
 *   push  — severity >= pushMinSeverity, storm-controlled
 */
export class AlertBus {
  private store: AlertStore | null;
  private log: Logger;
  private pushFn: (message: string) => Promise<string | void>;
  private pushEnabled: boolean;
  private pushMinSeverity: AlertSeverity;
  private pushBudget: number;
  private pushTimestamps: number[] = [];
  private stormDigestSent = false;
  private suppressedDuringStorm = 0;
  private now: () => Date;

  constructor(options: AlertBusOptions = {}) {
    this.log = options.log ?? componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "alert");
    let store: AlertStore | null = options.store ?? null;
    if (!store) {
      try {
        // Under jest, an unconfigured default bus must not write the real
        // alerts.db (wire-in suites exercise notify() paths constantly).
        store = new AlertStore(process.env.JEST_WORKER_ID ? ":memory:" : undefined);
      } catch (err) {
        // A broken store must never make notify() a crash source — degrade to log-only.
        this.log.error(`alert store unavailable, degrading to log-only: ${err instanceof Error ? err.message : String(err)}`);
        store = null;
      }
    }
    this.store = store;
    this.pushFn = options.pushFn ?? gatewayPush;
    // Never fire real pushes from a test run (jest suites exercise wire-in
    // sites with the default bus); store/log sinks still work under test.
    const inTestRun = Boolean(process.env.JEST_WORKER_ID);
    this.pushEnabled = options.pushEnabled ?? (envBool("ALERT_PUSH_ENABLED", true) && !inTestRun);
    this.pushMinSeverity = options.pushMinSeverity ?? envSeverity("ALERT_PUSH_MIN_SEVERITY", "warning");
    this.pushBudget = options.pushBudget ?? parseInt(process.env.ALERT_PUSH_BUDGET ?? "10", 10);
    this.now = options.now ?? (() => new Date());
  }

  notify(alert: AlertInput): void {
    try {
      this.notifyInner(alert);
    } catch (err) {
      // Last-resort guard: alerting must never take down the thing it watches.
      this.log.error(`notify() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private notifyInner(alert: AlertInput): void {
    const context = [alert.ticket, alert.agent].filter(Boolean).join(", ");
    const logLine = `[${alert.severity}] [${alert.source}] ${alert.title}${context ? ` (${context})` : ""}`;
    if (alert.severity === "critical") this.log.error(logLine);
    else if (alert.severity === "warning") this.log.warn(logLine);
    else this.log.info(logLine);

    let suppressed = false;
    let burstCount = 1;
    let priorBurstCount: number | null = null;
    let rowId: number | null = null;
    if (this.store) {
      try {
        const windowMs = alert.suppressWindowMs ?? SUPPRESS_WINDOW_MS[alert.severity];
        const result = this.store.record(alert, windowMs, this.now());
        suppressed = result.suppressed;
        burstCount = result.row.count;
        priorBurstCount = result.priorBurstCount;
        rowId = result.row.id;
      } catch (err) {
        this.log.error(`alert store write failed (log sink already fired): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    emitStreamTopic("alerts");
    if (suppressed) return; // Folded into an active burst — no repeat push.
    if (!this.pushEnabled) return;
    if (SEVERITY_RANK[alert.severity] < SEVERITY_RANK[this.pushMinSeverity]) return;

    const nowMs = this.now().getTime();
    this.pushTimestamps = this.pushTimestamps.filter((t) => nowMs - t < PUSH_BUDGET_WINDOW_MS);
    if (this.pushTimestamps.length >= this.pushBudget) {
      this.suppressedDuringStorm += 1;
      if (!this.stormDigestSent) {
        this.stormDigestSent = true;
        this.sendPush(
          `[connector:critical] ALERT STORM — push budget (${this.pushBudget}/${PUSH_BUDGET_WINDOW_MS / 60_000}min) exhausted; ` +
            `further alerts suppressed from push. See alerts store / console for the full stream.`,
          null
        );
      }
      return;
    }
    // Budget freed — report what the storm swallowed, then resume normal service.
    if (this.stormDigestSent) {
      this.stormDigestSent = false;
      const swallowed = this.suppressedDuringStorm;
      this.suppressedDuringStorm = 0;
      if (swallowed > 0) {
        this.log.warn(`alert storm ended — ${swallowed} alert(s) were push-suppressed (all stored)`);
      }
    }

    const counts =
      priorBurstCount !== null ? ` (previous burst: x${priorBurstCount})` : burstCount > 1 ? ` (x${burstCount})` : "";
    const detailStr =
      typeof alert.detail === "string" ? alert.detail : alert.detail ? JSON.stringify(alert.detail) : "";
    const detailSnippet = detailStr ? `\n${detailStr.slice(0, 300)}` : "";
    this.sendPush(
      `[connector:${alert.severity}] [${alert.source}] ${alert.title}${context ? ` (${context})` : ""}${counts}${detailSnippet}`,
      rowId
    );
    this.pushTimestamps.push(nowMs);
  }

  private sendPush(message: string, rowId: number | null): void {
    this.pushFn(message)
      .then((via) => {
        if (rowId !== null && this.store) this.store.markPushed(rowId, this.now(), typeof via === "string" ? via : undefined);
      })
      .catch((err) => {
        this.log.error(`push sink failed (alert is stored+logged): ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  getStore(): AlertStore | null {
    return this.store;
  }
}

// ── Module-level default bus ────────────────────────────────────────────────
// Callers deep in error paths shouldn't need dependency plumbing to raise a
// flag. initAlertBus() is called once from index.ts; notify() falls back to a
// lazily-created default bus so an early/missed init never loses a signal.

let _defaultBus: AlertBus | null = null;

export function initAlertBus(options: AlertBusOptions = {}): AlertBus {
  _defaultBus = new AlertBus(options);
  return _defaultBus;
}

export function getAlertBus(): AlertBus {
  if (!_defaultBus) _defaultBus = new AlertBus();
  return _defaultBus;
}

export function notify(alert: AlertInput): void {
  getAlertBus().notify(alert);
}

/** Test hook: reset the module singleton. */
export function _resetAlertBusForTests(): void {
  _defaultBus = null;
}
