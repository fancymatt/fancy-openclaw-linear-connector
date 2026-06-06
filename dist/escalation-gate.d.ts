/**
 * Phase 2 / slice 1 — escalation gate enforcement (AI-1346).
 *
 * Enforces inbound Linear CLI rules in the connector proxy. Slice 1 rule:
 * on workflow tickets (carrying a wf:* label), `needs-human` is steward-only.
 * Ad-hoc tickets (no wf:* label) are full pass-through — §4.6 mode switch.
 *
 * The rule table is data-driven so Phase 3 (full per-step command validation)
 * can add rules as config rather than surgery.
 *
 * Authority model:
 *   body → container (capability-policy.yaml) → grants capabilities[]
 *   The proxy NEVER trusts agent-supplied state; it fetches labels independently.
 *
 * Design: design.md §4.6, §11, §13.
 */
/**
 * One enforcement rule. The proxy evaluates all rules matching the incoming
 * intent; the first violation produces a rejection.
 */
export interface EnforcementRule {
    /** Value of `x-openclaw-linear-intent` that triggers this rule. */
    intent: string;
    /** Capability the calling body must hold. */
    requiredCapability: string;
    /** Human-readable description of the legal alternative, used in the error. */
    legalMove: string;
}
/**
 * Phase 2 enforcement rules (slice 1: one rule).
 * Phase 3 will extend this table — adding a rule is config, not code surgery.
 */
export declare const ENFORCEMENT_RULES: EnforcementRule[];
/** Invalidate the in-process policy cache (used in tests). */
export declare function resetPolicyCache(): void;
/**
 * Returns true when the body holds the given capability via its container.
 * Exported for unit tests.
 */
export declare function bodyHasCapability(bodyId: string, capability: string): Promise<boolean>;
/**
 * Evaluate enforcement rules for an inbound proxied request.
 *
 * Returns a rejection message string when the request should be blocked,
 * or `null` if it should be forwarded unchanged.
 *
 * Fails open on ambiguity (no issue context, label fetch failure, unknown body):
 * enforcement only blocks when it has affirmative evidence of a violation.
 */
export declare function checkEnforcementRules(intent: string, issueId: string | null, authToken: string, bodyId: string): Promise<string | null>;
//# sourceMappingURL=escalation-gate.d.ts.map