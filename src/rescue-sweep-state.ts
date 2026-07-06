/**
 * AI-1857 AC3 — In-process store for rescue-sweep run metadata.
 * Exposed on /health so "did it run" is answerable without log access.
 */

export interface RescueSweepRunState {
  lastRunAt: string | null;
  lastOutcome: {
    rescued: number;
    failed: number;
    scanned: number;
  };
}

let state: RescueSweepRunState = {
  lastRunAt: null,
  lastOutcome: { rescued: 0, failed: 0, scanned: 0 },
};

export function recordRescueSweepRun(result: {
  scanned: number;
  rescued: number;
  rescues: Array<{ outcome: string }>;
}): void {
  state = {
    lastRunAt: new Date().toISOString(),
    lastOutcome: {
      scanned: result.scanned,
      rescued: result.rescued,
      failed: result.rescues.filter((r) => r.outcome === "failed").length,
    },
  };
}

export function getRescueSweepState(): RescueSweepRunState {
  return {
    lastRunAt: state.lastRunAt,
    lastOutcome: { ...state.lastOutcome },
  };
}

export function resetRescueSweepStateForTest(): void {
  state = { lastRunAt: null, lastOutcome: { rescued: 0, failed: 0, scanned: 0 } };
}
