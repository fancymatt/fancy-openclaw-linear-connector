/**
 * AI-1547 — Transition atomicity + standing anti-entropy reconciliation loop (G-7/G-17).
 *
 * Two gaps addressed:
 *
 *   G-7: A crash between the label write and the native stateId write leaves the
 *   ticket with the new label but the old native state. On restart, the reconciliation
 *   pass detects the mismatch and heals the native stateId to match the label.
 *   (The label is authoritative because the proxy writes it first and restarts are
 *   more reliable than in-flight writes completing.)
 *
 *   G-17: Boot-time-only reconciliation misses dropped webhooks. A dropped
 *   terminal-child webhook leaves the parent's barrier un-decremented and projections
 *   stale. The standing anti-entropy loop catches this on its next cadence pass.
 *
 * AC1: fault-injected kill between the two writes → restart reconciles native to label.
 * AC2: a dropped terminal-child webhook → anti-entropy pass detects the barrier
 *      didn't decrement and reconciles it.
 * AC3: anti-entropy runs on a cadence and alerts on drift.
 */
import { type WorkflowDef } from "./workflow-gate.js";
export interface AntiEntropyTicket {
    /** Linear internal UUID */
    internalId: string;
    /** Human-readable identifier, e.g. "AI-1547" */
    identifier: string;
    /** Label names */
    labels: string[];
    /** Team internal UUID */
    teamId: string;
    /** Current native Linear state UUID */
    nativeStateId: string;
    /** Current native Linear state name (for logging) */
    nativeStateName: string;
}
export interface NativeDriftResult {
    identifier: string;
    expectedNativeState: string;
    expectedNativeStateId: string;
    actualNativeStateName: string;
    actualNativeStateId: string;
    healed: boolean;
    error?: string;
}
export interface BarrierReconcileResult {
    identifier: string;
    transitioned: boolean;
    skipped: boolean;
    skipReason?: string;
    error?: string;
}
export interface AntiEntropyResult {
    scanned: number;
    nativeDrifts: NativeDriftResult[];
    barrierFires: BarrierReconcileResult[];
    errors: string[];
}
export interface AntiEntropyOptions {
    /** Inject a pre-loaded registry (used in tests to avoid filesystem reads). */
    registry?: Map<string, WorkflowDef>;
}
/**
 * Fetch all active wf:* tickets with their native Linear state.
 * "Active" means not in terminal workflow states (state:done, state:escape).
 */
export declare function fetchActiveWfTickets(authToken: string): Promise<AntiEntropyTicket[]>;
/**
 * Run one anti-entropy pass: reconcile native states and fire any missed barriers.
 *
 * Called both at startup (G-7 AC1) and on the standing periodic cron (G-17 AC2/AC3).
 */
export declare function runAntiEntropy(authToken: string, options?: AntiEntropyOptions): Promise<AntiEntropyResult>;
//# sourceMappingURL=anti-entropy.d.ts.map