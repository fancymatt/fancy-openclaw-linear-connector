/**
 * GraphQL proxy — Phase 0B (transparent pass-through) + Phase 2 slice 1
 * (inbound command enforcement) + Phase 3 B1 (workflow-def-driven validation),
 * design.md §4.6, §11, §13, §16.
 *
 * Enforcement order (defense in depth):
 *   1. Phase 2 escalation-gate — capability rule table (needs-human steward-only).
 *   2. Phase 3 workflow-gate  — full legal-move validation against dev-impl.yaml.
 * Both must pass for the request to be forwarded.
 */
import type { Request, Response } from "express";
export declare function handleProxyRequest(req: Request, res: Response): Promise<void>;
//# sourceMappingURL=proxy.d.ts.map