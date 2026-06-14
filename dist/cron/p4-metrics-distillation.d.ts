/**
 * Phase 4 / P4-3 — Periodic distillation of reject metrics into skill-workshop proposals.
 *
 * Scheduled job that:
 * 1. Reads P4-2 metric aggregation from ObservationStore
 * 2. Detects (workflow, step, reason_code) patterns exceeding threshold
 * 3. Emits a pending skill-workshop proposal for each crossing pattern (deduplicated)
 * 4. Follows existing propose → review → apply flow (pending by default)
 *
 * Design: design.md §8 (learning loop), §8.2 (system-level fix), §8.3 (propose → review → apply)
 */
import type { ObservationStore } from "../store/observation-store.js";
export interface DistillationResult {
    proposalsCreated: number;
    patternsCrossed: number;
    skipped: {
        pattern: string;
        reason: string;
    }[];
    error?: string;
}
/**
 * Run P4-3 distillation: scan metrics and create proposals for threshold-crossing patterns.
 */
export declare function runDistillation(observationStore: ObservationStore, threshold?: number): Promise<DistillationResult>;
/**
 * Register the P4-3 distillation as an in-process recurring job.
 * Interval is controlled by P4_DISTILL_INTERVAL env var (default: 1h).
 * The timer is unref'd so it won't prevent graceful shutdown.
 */
export declare function registerDistillationCron(observationStore: ObservationStore): void;
//# sourceMappingURL=p4-metrics-distillation.d.ts.map