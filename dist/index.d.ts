import 'dotenv/config';
import { OperationalEventStore } from "./store/operational-event-store.js";
import { AgentQueue } from "./queue/index.js";
import { PendingWorkBag, SessionTracker, DispatchAckTracker, DispatchWatchdog, NoActivityDetector } from "./bag/index.js";
export interface CreateAppOptions {
    /** Override PendingWorkBag database path (for testing). */
    bagDbPath?: string;
    /** Override AgentQueue database path (for testing). */
    agentQueueDbPath?: string;
    /** Override OperationalEventStore database path (for testing). */
    operationalEventsDbPath?: string;
}
export declare function createApp(options?: CreateAppOptions): {
    app: import("express-serve-static-core").Express;
    agentQueue: AgentQueue;
    bag: PendingWorkBag;
    sessionTracker: SessionTracker;
    operationalEventStore: OperationalEventStore;
    wakeConfig: {
        nodeBin: string;
        hooksUrl: string | undefined;
        hooksToken: string | undefined;
        hooksThinking: string | undefined;
        hooksModel: string | undefined;
        timeoutMs: number | undefined;
        maxRetries: number | undefined;
    };
    ackTracker: DispatchAckTracker;
    watchdog: DispatchWatchdog;
    noActivityDetector: NoActivityDetector;
};
//# sourceMappingURL=index.d.ts.map