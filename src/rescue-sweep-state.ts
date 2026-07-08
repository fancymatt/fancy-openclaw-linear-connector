/**
 * AI-1857 AC3 — In-process store for rescue-sweep run metadata.
 * Exposed on /health so "did it run" is answerable without log access.
 *
 * AI-1970: Added lastOutcomeType + lastSkipReason + lastError fields so all
 * outcomes (skip, fail, success) produce a non-null lastRunAt with context.
 */

export type RescueSweepOutcome = "success" | "skip" | "fail";

export interface RescueSweepRunState {
  /** ISO timestamp of most recent attempt (run, skip, or fail). */
  lastRunAt: string | null;
  /** Outcome of the most recent attempt. */
  lastOutcomeType: RescueSweepOutcome | null;
  /** Aggregate counts from the most recent successful sweep. */
  lastOutcome: {
    rescued: number;
    failed: number;
    scanned: number;
  };
  /** Reason for skipping (populated on skip outcome). */
  lastSkipReason: string | null;
  /** Error message from a failed run (populated on fail outcome). */
  lastError: string | null;
}

let state: RescueSweepRunState = {
  lastRunAt: null,
  lastOutcomeType: null,
  lastOutcome: { rescued: 0, failed: 0, scanned: 0 },
  lastSkipReason: null,
  lastError: null,
};

/** Record a successful run with sweep result counts. */
export function recordRescueSweepRun(result: {
  scanned: number;
  rescued: number;
  rescues: Array<{ outcome: string }>;
}): void {
  state = {
    lastRunAt: new Date().toISOString(),
    lastOutcomeType: "success",
    lastOutcome: {
      scanned: result.scanned,
      rescued: result.rescued,
      failed: result.rescues.filter((r) => r.outcome === "failed").length,
    },
    lastSkipReason: null,
    lastError: null,
  };
}

/** Record a skipped run (e.g. no auth token available). */
export function recordRescueSweepSkip(reason: string): void {
  state = {
    lastRunAt: new Date().toISOString(),
    lastOutcomeType: "skip",
    lastOutcome: { rescued: 0, failed: 0, scanned: 0 },
    lastSkipReason: reason,
    lastError: null,
  };
}

/** Record a failed run (thrown error caught by cron wrapper). */
export function recordRescueSweepFail(error: string): void {
  state = {
    lastRunAt: new Date().toISOString(),
    lastOutcomeType: "fail",
    lastOutcome: { rescued: 0, failed: 0, scanned: 0 },
    lastSkipReason: null,
    lastError: error,
  };
}

export function getRescueSweepState(): RescueSweepRunState {
  return {
    lastRunAt: state.lastRunAt,
    lastOutcomeType: state.lastOutcomeType,
    lastOutcome: { ...state.lastOutcome },
    lastSkipReason: state.lastSkipReason,
    lastError: state.lastError,
  };
}

export function resetRescueSweepStateForTest(): void {
  state = {
    lastRunAt: null,
    lastOutcomeType: null,
    lastOutcome: { rescued: 0, failed: 0, scanned: 0 },
    lastSkipReason: null,
    lastError: null,
  };
}
