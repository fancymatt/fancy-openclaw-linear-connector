/**
 * AI-1559 / Gap G-15(b) — external proxy liveness evaluation.
 *
 * The connector/proxy cannot alert on its own death (a dead process can't fire
 * an alarm). This module holds the *pure* decision logic for an EXTERNAL monitor
 * process (a systemd-timer-driven runner, see scripts/proxy-liveness-monitor.mjs)
 * that polls the proxy's /health endpoint and decides when to alert.
 *
 * Design goals:
 *   - Hysteresis: only declare DOWN after N consecutive failed probes, so a
 *     single transient blip doesn't page anyone.
 *   - No spam: alert once on the down-transition and once on recovery. While
 *     down, re-alert only on a slow reminder cadence, never every tick.
 *
 * The runner owns I/O (state file, probe, alert delivery); this module is pure
 * and unit-tested so the alerting contract is verifiable without a live proxy.
 */

export type ProxyStatus = "up" | "down";

export interface MonitorState {
  status: ProxyStatus;
  /** Consecutive failed probes observed while not-yet-declared-down. */
  consecutiveFailures: number;
  /** Epoch ms of the last alert we emitted (down or reminder). 0 = never. */
  lastAlertAt: number;
}

export type MonitorAction = "none" | "alert-down" | "alert-recovered" | "alert-reminder";

export interface EvaluateOptions {
  /** Consecutive failures required to declare DOWN. Default 3. */
  failureThreshold?: number;
  /** While down, re-alert at most this often (ms). Default 1h. */
  reminderIntervalMs?: number;
}

export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_REMINDER_INTERVAL_MS = 60 * 60 * 1000;

export function initialState(): MonitorState {
  return { status: "up", consecutiveFailures: 0, lastAlertAt: 0 };
}

/**
 * Given the previous monitor state and a fresh probe result, compute the next
 * state and the action the runner should take. Pure and deterministic.
 *
 * @param prev   prior persisted state
 * @param probeOk whether the latest /health probe succeeded
 * @param now    epoch ms (injected for testability)
 */
export function evaluate(
  prev: MonitorState,
  probeOk: boolean,
  now: number,
  opts: EvaluateOptions = {},
): { next: MonitorState; action: MonitorAction } {
  const threshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const reminderMs = opts.reminderIntervalMs ?? DEFAULT_REMINDER_INTERVAL_MS;

  if (probeOk) {
    if (prev.status === "down") {
      // Recovery transition — alert once, reset counters.
      return {
        next: { status: "up", consecutiveFailures: 0, lastAlertAt: now },
        action: "alert-recovered",
      };
    }
    // Already up — clear any partial failure streak, no action.
    return {
      next: { status: "up", consecutiveFailures: 0, lastAlertAt: prev.lastAlertAt },
      action: "none",
    };
  }

  // Probe failed.
  if (prev.status === "down") {
    // Still down — only re-alert on the slow reminder cadence (no per-tick spam).
    if (now - prev.lastAlertAt >= reminderMs) {
      return {
        next: { ...prev, lastAlertAt: now },
        action: "alert-reminder",
      };
    }
    return { next: prev, action: "none" };
  }

  // Was up; increment the failure streak.
  const failures = prev.consecutiveFailures + 1;
  if (failures >= threshold) {
    // Cross the threshold → declare DOWN and alert once.
    return {
      next: { status: "down", consecutiveFailures: failures, lastAlertAt: now },
      action: "alert-down",
    };
  }
  // Under threshold — hold, no alert yet (hysteresis).
  return {
    next: { status: "up", consecutiveFailures: failures, lastAlertAt: prev.lastAlertAt },
    action: "none",
  };
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/**
 * Probe the proxy's /health endpoint. OK iff a 2xx response whose JSON body
 * reports status:"ok". Any connection error, timeout, non-2xx, or unexpected
 * body counts as a failed probe. Never throws.
 */
export async function probeHealth(url: string, timeoutMs = 5000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.status === "ok") {
      return { ok: true, detail: "health ok" };
    }
    return { ok: false, detail: `unexpected health body: ${JSON.stringify(body).slice(0, 120)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { name?: string }).name === "AbortError" ? "timeout" : "unreachable";
    return { ok: false, detail: `${code}: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
