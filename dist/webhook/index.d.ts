import { Router } from "express";
import { EventStore } from "../store/event-store.js";
import { NudgeStore } from "../store/nudge-store.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import { DeliveryThrottle } from "../delivery/index.js";
import { AgentQueue } from "../queue/index.js";
import { PendingWorkBag, SessionTracker } from "../bag/index.js";
export type { LinearEvent } from "./schema.js";
export { verifyLinearSignature } from "./signature.js";
export { normalizeLinearEvent } from "./normalize.js";
export declare function createWebhookRouter(eventStore?: EventStore, nudgeStore?: NudgeStore, agentQueue?: AgentQueue, bag?: PendingWorkBag, sessionTracker?: SessionTracker, throttle?: DeliveryThrottle, operationalEventStore?: OperationalEventStore): Router;
//# sourceMappingURL=index.d.ts.map