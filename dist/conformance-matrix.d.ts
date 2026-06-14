/**
 * AI-1543 / G-9 — Conformance matrix generator.
 *
 * Given a workflow def + capability policy, emits every cell of the
 * (state × command × caller-class × ticket-flags) cross-product and annotates
 * each cell with the expected gate outcome (allow / block + reason).
 *
 * Caller classes:
 *   delegate             — the current ticket delegate; same role as state owner
 *   non-delegate-same-role — a different body that fills the same role
 *   wrong-role           — a body from an unrelated role (no delegate set)
 *   steward              — the steward body; delegate set to state owner
 *   human                — an unknown body (not in the capability policy)
 *
 * Ticket-flag dimensions: stakeLabel × delegateLinearUserId
 *
 * The generator is purely synchronous and derives every value from the supplied
 * def + policy. No network calls, no file I/O, no caches.
 */
import type { WorkflowDef } from './workflow-gate.js';
export type CallerKind = 'delegate' | 'non-delegate-same-role' | 'wrong-role' | 'steward' | 'human';
export interface CapabilityPolicyInput {
    capabilities?: Array<{
        id: string;
    }>;
    roles?: Array<{
        id: string;
        requires?: string[];
    }>;
    containers: Array<{
        id: string;
        grants: string[];
    }>;
    bodies: Array<{
        id: string;
        container: string;
        fills_roles: string[];
        openclaw_agent?: string;
    }>;
}
export interface ConformanceCell {
    state: string;
    command: string;
    caller: {
        kind: CallerKind;
        bodyId: string;
        linearUserId?: string | null;
    };
    flags: {
        stakeLabel: string | null;
        delegateLinearUserId?: string | null;
    };
    expected: 'allow' | 'block';
    blockReason?: 'wrong-state' | 'cap-missing' | 'wrong-delegate' | 'human-signoff' | 'unknown-caller';
    legalCommands: string[];
    requiredCapability?: string;
}
/**
 * Generate the full (state × command × caller-class × ticket-flags) conformance
 * matrix from the supplied workflow def and capability policy.
 *
 * Every cell carries:
 *   • `expected`      — 'allow' or 'block'
 *   • `blockReason`   — why it's blocked (undefined on allow cells)
 *   • `legalCommands` — the commands that ARE legal in this state (for wrong-state
 *                       rejection assertions)
 *
 * The result is deterministic and synchronous: same inputs → same matrix.
 */
export declare function buildConformanceMatrix(def: WorkflowDef, policy: CapabilityPolicyInput): ConformanceCell[];
//# sourceMappingURL=conformance-matrix.d.ts.map