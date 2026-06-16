/**
 * GraphQL proxy — Phase 0B (transparent pass-through) + Phase 2 slice 1
 * (inbound command enforcement) + Phase 3 B1 (workflow-def-driven validation)
 * + Phase 3 B2 (atomic state-label transition application)
 * + Layer 2 raw mutation interception (AI-1387)
 * + AI-1402 default-deny + needs-human block + unknown-caller fail-closed,
 * design.md §4.2, §4.6, §11, §13, §16.
 * + Phase 6.5 / H-1 fail-closed + break-glass + config-health (AI-1476).
 *
 * Enforcement order (defense in depth):
 *   1. Phase 2 escalation-gate — capability rule table (needs-human steward-only).
 *   2. Phase 3 B1 workflow-gate — full legal-move validation against dev-impl.yaml,
 *      including delegate-only enforcement (AI-1397).
 *   3. Layer 2 raw mutation interception (AI-1387) — blocks direct status/assignee
 *      changes on workflow tickets that bypass the intent-header path.
 *   4. Phase 6.5 config-health — rejects wf:* commands when config is degraded (§16.0).
 * All must pass for the request to be forwarded.
 *
 * Break-glass (§4.4 lifted): X-Openclaw-Break-Glass header allows a steward to
 * bypass enforcement when config is degraded, preventing permanent queue wedging.
 *
 * After a successful forward, Phase 3 B2 applies the state:* label transition
 * atomically (single issueUpdate mutation). Seam: proxy-side, not CLI-side — the
 * state change is coupled to the validated forward so an agent cannot skip it.
 * Transition failures are fail-open: logged but never propagate to the response.
 *
 * AI-1397 version floor: workflow mutations from CLIs below MIN_WORKFLOW_CLI_VERSION
 * are rejected. Missing version header is warned but allowed (backward compat).
 */
import type { Request, Response } from "express";
import type { ObservationStore } from "./store/observation-store.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";
export interface ProxyDeps {
    /** Optional observation store for recording feedback observations (P4-1). */
    observationStore?: ObservationStore;
    /** Optional operational event store for audit events (G-13a). */
    operationalEventStore?: OperationalEventStore;
}
export declare function handleProxyRequest(req: Request, res: Response, deps?: ProxyDeps): Promise<void>;
//# sourceMappingURL=proxy.d.ts.map