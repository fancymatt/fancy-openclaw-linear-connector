import 'dotenv/config';
import { OperationalEventStore } from "./store/operational-event-store.js";
import { ManagingStateStore } from "./store/managing-state-store.js";
import { AgentQueue } from "./queue/index.js";
import { PendingWorkBag, SessionTracker, DispatchAckTracker, DispatchWatchdog, NoActivityDetector, ManagingPoller } from "./bag/index.js";
import { type WakeUpConfig } from "./bag/wake-up.js";
export interface CreateAppOptions {
    /** Override PendingWorkBag database path (for testing). */
    bagDbPath?: string;
    /** Override AgentQueue database path (for testing). */
    agentQueueDbPath?: string;
    /** Override OperationalEventStore database path (for testing). */
    operationalEventsDbPath?: string;
    /** Override ObservationStore database path (for testing). */
    observationsDbPath?: string;
    /** Override ManagingStateStore database path (for testing). */
    managingStateDbPath?: string;
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
    wakeConfigForAgent: (agentIdLookup: string) => WakeUpConfig;
    resignalOptions: {
        sendWakeUp: (agentId: string, ticketIds: string[]) => Promise<void | {
            runId?: string;
        }>;
    };
    ackTracker: DispatchAckTracker;
    watchdog: DispatchWatchdog;
    noActivityDetector: NoActivityDetector;
    managingPoller: ManagingPoller;
    managingStateStore: ManagingStateStore;
};
//# sourceMappingURL=index.d.ts.map