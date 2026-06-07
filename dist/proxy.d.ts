/**
 * GraphQL proxy — Phase 0B (transparent pass-through) + Phase 2 slice 1
 * (inbound command enforcement) + Phase 3 B1 (workflow-def-driven validation)
 * + Phase 3 B2 (atomic state-label transition application),
 * design.md §4.2, §4.6, §11, §13, §16.
 *
 * Enforcement order (defense in depth):
 *   1. Phase 2 escalation-gate — capability rule table (needs-human steward-only).
 *   2. Phase 3 B1 workflow-gate — full legal-move validation against dev-impl.yaml.
 * Both must pass for the request to be forwarded.
 *
 * After a successful forward, Phase 3 B2 applies the state:* label transition
 * atomically (single issueUpdate mutation). Seam: proxy-side, not CLI-side — the
 * state change is coupled to the validated forward so an agent cannot skip it.
 * Transition failures are fail-open: logged but never propagate to the response.
 */
import type { Request, Response } from "express";
import type { ObservationStore } from "./store/observation-store.js";
export interface ProxyDeps {
    /** Optional observation store for recording feedback observations (P4-1). */
    observationStore?: ObservationStore;
}
export declare function handleProxyRequest(req: Request, res: Response, deps?: ProxyDeps): Promise<void>;
//# sourceMappingURL=proxy.d.ts.map