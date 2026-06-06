/**
 * GraphQL proxy — Phase 0B (transparent pass-through) + Phase 2 slice 1
 * (inbound command enforcement), design.md §4.6, §11, §13.
 *
 * Slice 1 adds the first enforced inbound rule: on workflow tickets (wf:*)
 * the `needs-human` command is steward-only. All other commands remain
 * transparent pass-through.
 */
import type { Request, Response } from "express";
export declare function handleProxyRequest(req: Request, res: Response): Promise<void>;
//# sourceMappingURL=proxy.d.ts.map