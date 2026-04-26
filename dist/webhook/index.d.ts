import { Router } from "express";
import { EventStore } from "../store/event-store";
import { NudgeStore } from "../store/nudge-store";
import { AgentQueue } from "../queue";
export { LinearEvent } from "./schema";
export { verifyLinearSignature } from "./signature";
export { normalizeLinearEvent } from "./normalize";
export declare function createWebhookRouter(eventStore?: EventStore, nudgeStore?: NudgeStore, agentQueue?: AgentQueue): Router;
//# sourceMappingURL=index.d.ts.map