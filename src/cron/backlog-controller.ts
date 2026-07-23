/**
 * INF-219 — Cron-backlog stampede protection.
 *
 * Bounded concurrency + per-ticket dedup + recovery rate-guard for cron-driven
 * wake floods. When a backlog of cron ticks accumulates (deploy gap, node
 * outage, etc.), naïve recovery fires every accumulated wake at once —
 * stampeding the Linear API and overwhelming agent sessions. This controller
 * bounds concurrency, collapses stale intermediate states per ticket, and
 * throttles dispatch during recovery to 2× the observed normal rate.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  ticketId?: string;
  execute: () => Promise<void>;
}

export interface DedupStats {
  total: number;
  skipped: number;
  fired: number;
  skippedIds?: string[];
}

export interface CronBacklogControllerOptions {
  maxConcurrency?: number;
  dedupWindowMs?: number;
  intervalMs?: number;
  rateWindowMs?: number;
  rateLimitMultiplier?: number;
  now?: () => number;
  logger?: { warn: (...args: unknown[]) => void };
}

export interface CronBacklogController {
  submit(job: CronJob & { scheduledAt?: number }): Promise<void>;
  getStats(): {
    maxConcurrency: number;
    running: number;
    queued: number;
    completed: number;
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
  shutdown(): void;
  recordActivity(atMs?: number): void;
  detectRecoveryGap(nowMs?: number): boolean;
  isRecovering(): boolean;
  drain(): Promise<void>;
}

// ── Internal job wrapper ────────────────────────────────────────────

interface InternalJob {
  id: string;
  ticketId?: string;
  scheduledAt?: number;
  execute: () => Promise<void>;
  resolveCompletion: () => void;
  rejectCompletion: (err: unknown) => void;
}

// ── Factory ─────────────────────────────────────────────────────────

export function createBacklogController(
  options?: CronBacklogControllerOptions,
): CronBacklogController {
  const maxConcurrency = options?.maxConcurrency ?? 3;
  if (maxConcurrency <= 0) {
    throw new Error(`maxConcurrency must be a positive integer, got ${maxConcurrency}`);
  }

  const dedupWindowMs = options?.dedupWindowMs ?? 60_000;
  const intervalMs = options?.intervalMs ?? 60_000;
  const rateWindowMs = options?.rateWindowMs ?? 60_000;
  const rateLimitMultiplier = options?.rateLimitMultiplier ?? 2;
  const nowFn = options?.now ?? (() => Date.now());
  const logger = options?.logger ?? console;

  // ── State ───────────────────────────────────────────────────────

  const runningMap = new Map<string, Promise<void>>();
  const queued: InternalJob[] = [];

  // Dedup: ticketId → job reference currently in the queue.
  const dedupMap = new Map<string, InternalJob>();

  // Sliding window of normal dispatch timestamps.
  const normalTimestamps: number[] = [];

  let completedCount = 0;
  let dedupTotal = 0;
  let dedupSkipped = 0;
  const dedupSkippedIds: string[] = [];

  // Recovery state.
  let lastActivityMs: number | null = null;
  let recoveryActive = false;
  let recoveryEnteredAt: number | null = null;
  let recoveryExitedAt: number | null = null;
  let recoveryDispatchCount = 0;
  let recoveryThrottleCount = 0;
  // Snapshot of the normal dispatch rate at the moment recovery was entered.
  // Used instead of the sliding window so the rate cap doesn't decay during recovery.
  let recoveryBaselineRate = 0;

  let shutdownFlag = false;

  // ── Helpers ─────────────────────────────────────────────────────

  function pruneNormalTimestamps(t: number): void {
    const cutoff = t - rateWindowMs;
    while (normalTimestamps.length > 0 && normalTimestamps[0] < cutoff) {
      normalTimestamps.shift();
    }
  }

  function normalRate(t: number): number {
    pruneNormalTimestamps(t);
    return normalTimestamps.length;
  }

  function allowedRecoveryDispatches(): number {
    // During recovery, use the snapshot baseline so the cap doesn't decay
    // as normal-timestamps age out of the sliding window. If there was no
    // normal activity before recovery (baseline is 0), still use 0 — no
    // throttling is needed.
    return Math.floor(recoveryBaselineRate * rateLimitMultiplier);
  }

  /**
   * In recovery mode, throttle when recovery dispatches exceed the allowed
   * cap (rateLimitMultiplier × normal rate snapshot at recovery-entry).
   */
  function isThrottled(): boolean {
    if (!recoveryActive) return false;
    const allowed = allowedRecoveryDispatches();
    if (allowed === 0) return false;
    return recoveryDispatchCount >= allowed;
  }

  function enterRecovery(t: number): void {
    if (recoveryActive) return;
    recoveryActive = true;
    recoveryEnteredAt = t;
    recoveryExitedAt = null;
    recoveryDispatchCount = 0;
    recoveryThrottleCount = 0;
    // Snapshot the raw count of normal timestamps (without pruning) so the
    // recovery rate cap reflects what was observed before the gap, even if
    // those timestamps have since aged out of the sliding window.
    recoveryBaselineRate = normalTimestamps.length;
    logger.warn(
      `[backlog-controller] entering recovery mode at ${t} ` +
      `(gap exceeded interval ${intervalMs}ms)`,
    );
  }

  function exitRecovery(t: number): void {
    if (!recoveryActive) return;
    recoveryActive = false;
    recoveryExitedAt = t;
    recoveryBaselineRate = 0;
    logger.warn(
      `[backlog-controller] exiting recovery mode at ${t} (backlog cleared)`,
    );
  }

  // ── Dispatch ────────────────────────────────────────────────────

  function dispatchJob(job: InternalJob): void {
    const t = nowFn();
    if (recoveryActive) {
      recoveryDispatchCount++;
    } else {
      normalTimestamps.push(t);
      pruneNormalTimestamps(t);
    }

    const promise = (async () => {
      try {
        await job.execute();
        job.resolveCompletion();
      } catch (err) {
        job.rejectCompletion(err);
      } finally {
        runningMap.delete(job.id);
        completedCount++;
        tryScheduleNext();
      }
    })();

    runningMap.set(job.id, promise);
  }

  function tryScheduleNext(): void {
    if (shutdownFlag) return;

    while (runningMap.size < maxConcurrency && queued.length > 0) {
      if (isThrottled()) break;

      const job = queued.shift()!;
      if (!job) break;

      // Remove from dedup map if this job is still the current entry.
      if (job.ticketId && dedupMap.get(job.ticketId) === job) {
        dedupMap.delete(job.ticketId);
      }

      dispatchJob(job);
    }
  }

  // ── Public API ──────────────────────────────────────────────────

  async function submit(job: CronJob & { scheduledAt?: number }): Promise<void> {
    if (shutdownFlag) {
      throw new Error("backlog-controller is shut down; cannot accept new jobs");
    }

    // Create a completion promise that resolves when the job finishes
    // (or immediately if the job is deduped/skipped).
    let resolveCompletion!: () => void;
    let rejectCompletion!: (err: unknown) => void;
    const completionPromise = new Promise<void>((res, rej) => {
      resolveCompletion = res;
      rejectCompletion = rej;
    });

    const internalJob: InternalJob = {
      id: job.id,
      ticketId: job.ticketId,
      scheduledAt: job.scheduledAt,
      execute: job.execute,
      resolveCompletion,
      rejectCompletion,
    };

    const t = nowFn();

    // Can we dispatch immediately?
    const slotAvailable = runningMap.size < maxConcurrency;
    const throttled = isThrottled();

    if (slotAvailable && !throttled) {
      dispatchJob(internalJob);
      return completionPromise;
    }

    // Job is being queued — track throttle count.
    if (slotAvailable && throttled) {
      recoveryThrottleCount++;
    }

    // Need to queue — check dedup for ticketId jobs.
    // Dedup only applies to queued jobs (immediately dispatched jobs
    // never collide because they start right away).
    if (job.ticketId) {
      dedupTotal++;

      const existing = dedupMap.get(job.ticketId);
      if (existing) {
        const existingScheduledAt = existing.scheduledAt ?? 0;
        const newScheduledAt = internalJob.scheduledAt ?? 0;

        if (newScheduledAt >= existingScheduledAt) {
          // New job is newer (or equal) — replace the old queued job.
          dedupSkipped++;
          dedupSkippedIds.push(existing.id);
          existing.resolveCompletion();

          const existingIndex = queued.indexOf(existing);
          if (existingIndex >= 0) {
            queued[existingIndex] = internalJob;
          }
          dedupMap.set(job.ticketId, internalJob);
        } else {
          // Old queued job is newer — skip the new submission.
          dedupSkipped++;
          dedupSkippedIds.push(internalJob.id);
          resolveCompletion();
        }

        return completionPromise;
      }

      // No collision — add to queue and track in dedup map.
      queued.push(internalJob);
      dedupMap.set(job.ticketId, internalJob);
      return completionPromise;
    }

    // No ticketId — just queue.
    queued.push(internalJob);
    return completionPromise;
  }

  function getStats() {
    const t = nowFn();
    pruneNormalTimestamps(t);

    return {
      maxConcurrency,
      running: runningMap.size,
      queued: queued.length,
      completed: completedCount,
      dedup: {
        total: dedupTotal,
        skipped: dedupSkipped,
        fired: dedupTotal - dedupSkipped,
        skippedIds: [...dedupSkippedIds],
      },
      rate: {
        windowMs: rateWindowMs,
        normalDispatches: normalTimestamps.length,
        recoveryDispatches: recoveryDispatchCount,
        // For stats display, use the recovery snapshot baseline when active;
        // otherwise compute from the sliding window (non-recovery display).
        // The actual throttle gate always uses the baseline during recovery.
        allowedRecoveryDispatches: recoveryActive
          ? Math.floor(recoveryBaselineRate * rateLimitMultiplier)
          : Math.floor(normalRate(t) * rateLimitMultiplier),
        throttled: recoveryThrottleCount,
      },
      recovery: {
        active: recoveryActive,
        backlog: queued.length,
        enteredAt: recoveryEnteredAt,
        exitedAt: recoveryExitedAt,
      },
    };
  }

  function shutdown(): void {
    shutdownFlag = true;
    for (const job of queued) {
      job.resolveCompletion();
    }
    queued.length = 0;
    dedupMap.clear();
  }

  function recordActivity(atMs?: number): void {
    lastActivityMs = atMs ?? nowFn();
  }

  function detectRecoveryGap(nowMs?: number): boolean {
    const t = nowMs ?? nowFn();
    if (lastActivityMs === null) return false;

    const gap = t - lastActivityMs;
    if (gap > intervalMs) {
      if (!recoveryActive) {
        enterRecovery(t);
      }
      return true;
    }
    return false;
  }

  function isRecovering(): boolean {
    return recoveryActive;
  }

  async function drain(): Promise<void> {
    // Drain bypasses recovery throttling — the explicit intent is to clear
    // the backlog, so all queued jobs dispatch as slots free up.
    while (runningMap.size > 0 || queued.length > 0) {
      // Schedule all queued jobs up to the concurrency limit, bypassing throttle.
      while (runningMap.size < maxConcurrency && queued.length > 0) {
        const job = queued.shift()!;
        if (job.ticketId && dedupMap.get(job.ticketId) === job) {
          dedupMap.delete(job.ticketId);
        }
        dispatchJob(job);
      }

      if (runningMap.size > 0) {
        // Wait for at least one running job to complete.
        await Promise.race(runningMap.values());
      } else if (queued.length > 0) {
        // Throttle should have been bypassed above, but yield as safety net.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    // Exit recovery now that the backlog is clear.
    if (recoveryActive && runningMap.size === 0 && queued.length === 0) {
      exitRecovery(nowFn());
    }
  }

  return {
    submit,
    getStats,
    shutdown,
    recordActivity,
    detectRecoveryGap,
    isRecovering,
    drain,
  };
}
