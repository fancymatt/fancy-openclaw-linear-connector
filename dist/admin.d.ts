import { Router } from "express";
import type { AgentQueue } from "./queue/index.js";
import type { PendingWorkBag } from "./bag/index.js";
import type { SessionTracker } from "./bag/index.js";
import type { OperationalEventStore } from "./store/operational-event-store.js";
interface AdminDeps {
    agentQueue: AgentQueue;
    bag: PendingWorkBag;
    sessionTracker: SessionTracker;
    operationalEventStore?: OperationalEventStore;
    deploymentName: string;
}
export declare function createAdminRouter(deps: AdminDeps): Router;
export {};
//# sourceMappingURL=admin.d.ts.map