/**
 * INF-314 — In-process state for stall detection liveness.
 *
 * Exposed on /health so ac-validate can confirm the stall detection
 * component is active and see the effective thresholds without waiting
 * for a stall to occur (AC9).
 *
 * Pattern mirrors src/rescue-sweep-state.ts.
 */

/** Default ACK timeout: 3 minutes. */
export const DEFAULT_ACK_TIMEOUT_MS = 180_000;

/** Default progress timeout: 12 minutes. */
export const DEFAULT_PROGRESS_TIMEOUT_MS = 720_000;

/** Default config assembled from the constants above. */
export const DEFAULT_STALL_CONFIG = {
  ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
  progressTimeoutMs: DEFAULT_PROGRESS_TIMEOUT_MS,
} as const;

export interface StallDetectionState {
  /** True once registerStallSweepCron() has been called at bootstrap. */
  active: boolean;
  /** Effective ACK timeout in ms. */
  ackTimeoutMs: number;
  /** Effective progress timeout in ms. */
  progressTimeoutMs: number;
}

let state: StallDetectionState = {
  active: false,
  ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
  progressTimeoutMs: DEFAULT_PROGRESS_TIMEOUT_MS,
};

/**
 * Record that stall detection is active with the given thresholds.
 * Called by registerStallSweepCron() when the cron is armed.
 */
export function recordStallDetectionActive(config: {
  ackTimeoutMs: number;
  progressTimeoutMs: number;
}): void {
  state = {
    active: true,
    ackTimeoutMs: config.ackTimeoutMs,
    progressTimeoutMs: config.progressTimeoutMs,
  };
}

/** Read the current stall detection liveness state (for /health). */
export function getStallDetectionState(): StallDetectionState {
  return { ...state };
}

/** Test-only: reset state to defaults. */
export function resetStallDetectionStateForTest(): void {
  state = {
    active: false,
    ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
    progressTimeoutMs: DEFAULT_PROGRESS_TIMEOUT_MS,
  };
}
