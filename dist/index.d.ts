import 'dotenv/config';
import { AgentQueue } from "./queue/index.js";
import { PendingWorkBag, SessionTracker } from "./bag/index.js";
export interface CreateAppOptions {
    /** Override PendingWorkBag database path (for testing). */
    bagDbPath?: string;
    /** Override AgentQueue database path (for testing). */
    agentQueueDbPath?: string;
}
export declare function createApp(options?: CreateAppOptions): {
    app: import("express-serve-static-core").Express;
    agentQueue: AgentQueue;
    bag: PendingWorkBag;
    sessionTracker: SessionTracker;
};
//# sourceMappingURL=index.d.ts.map