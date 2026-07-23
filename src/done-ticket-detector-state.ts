/**
 * AI-2468 — In-process store for Done-ticket detector run metadata.
 * Exposed on /health so "did it scan" is answerable without log access.
 *
 * Mirrors the rescue-sweep-state.ts pattern.
 */

export type DetectorOutcome = "success" | "skip" | "fail";

export interface DetectorRunState {
  /** ISO timestamp of most recent attempt (run, skip, or fail). */
  lastRunAt: string | null;
  /** Outcome of the most recent attempt. */
  lastOutcomeType: DetectorOutcome | null;
  /** Aggregate counts from the most recent successful scan. */
  lastOutcome: {
    scanned: number;
    violations: number;
    errors: number;
  };
  /** Reason for skipping (populated on skip outcome). */
  lastSkipReason: string | null;
  /** Error message from a failed run (populated on fail outcome). */
  lastError: string | null;
}

let state: DetectorRunState = {
  lastRunAt: null,
  lastOutcomeType: null,
  lastOutcome: { scanned: 0, violations: 0, errors: 0 },
  lastSkipReason: null,
  lastError: null,
};

/** Record a successful scan with result counts. */
export function recordDetectorRun(result: {
  scanned: number;
  violations: number;
  errors: number;
}): void {
  state = {
    lastRunAt: new Date().toISOString(),
    lastOutcomeType: "success",
    lastOutcome: {
      scanned: result.scanned,
      violations: result.violations,
      errors: result.errors,
    },
    lastSkipReason: null,
    lastError: null,
  };
}

/** Record a skipped scan (e.g. no auth token available). */
export function recordDetectorSkip(reason: string): void {
  state = {
    lastRunAt: new Date().toISOString(),
    lastOutcomeType: "skip",
    lastOutcome: { scanned: 0, violations: 0, errors: 0 },
    lastSkipReason: reason,
    lastError: null,
  };
}

/** Record a failed scan (thrown error caught by cron wrapper). */
export function recordDetectorFail(error: string): void {
  state = {
    lastRunAt: new Date().toISOString(),
    lastOutcomeType: "fail",
    lastOutcome: { scanned: 0, violations: 0, errors: 0 },
    lastSkipReason: null,
    lastError: error,
  };
}

export function getDetectorState(): DetectorRunState {
  return {
    lastRunAt: state.lastRunAt,
    lastOutcomeType: state.lastOutcomeType,
    lastOutcome: { ...state.lastOutcome },
    lastSkipReason: state.lastSkipReason,
    lastError: state.lastError,
  };
}

export function resetDetectorStateForTest(): void {
  state = {
    lastRunAt: null,
    lastOutcomeType: null,
    lastOutcome: { scanned: 0, violations: 0, errors: 0 },
    lastSkipReason: null,
    lastError: null,
  };
}
