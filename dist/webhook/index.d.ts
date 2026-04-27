import { Router } from "express";
import { EventStore } from "../store/event-store.js";
import { NudgeStore } from "../store/nudge-store.js";
import { AgentQueue } from "../queue/index.js";
export type { LinearEvent } from "./schema.js";
export { verifyLinearSignature } from "./signature.js";
export { normalizeLinearEvent } from "./normalize.js";
export declare function createWebhookRouter(eventStore?: EventStore, nudgeStore?: NudgeStore, agentQueue?: AgentQueue): Router;
//# sourceMappingURL=index.d.ts.map