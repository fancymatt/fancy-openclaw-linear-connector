import type { RouteResult } from "../types.js";
/**
 * SQLite-backed per-agent serialized queue.
 *
 * Each agent gets at most one active task at a time. Additional tasks
 * are queued FIFO and promoted when the active task completes.
 */
export declare class AgentQueue {
    private db;
    constructor(dbPath?: string);
    private migrate;
    /**
     * Enqueue a routed event for an agent. If the agent has no active task,
     * the task becomes active immediately and 'deliver' is returned.
     * Otherwise it is queued and 'queued' is returned.
     */
    enqueue(result: RouteResult): {
        action: "deliver" | "queued";
    };
    /**
     * Mark the active task for an agent as completed. Promote the next
     * queued task (FIFO by created_at) to active and return it, or null
     * if the queue is empty.
     */
    complete(agentId: string): RouteResult | null;
    /**
     * Return the currently active task for an agent, or null.
     */
    getActive(agentId: string): RouteResult | null;
    /**
     * Return all queued (not active, not completed) tasks for an agent, FIFO order.
     */
    getQueued(agentId: string): RouteResult[];
    /**
     * Enqueue or coalesce: if a queued task already exists for the same
     * agent+sessionKey (ticket), replace it with the newer payload instead
     * of stacking duplicates. Active tasks are never replaced.
     *
     * Returns 'deliver' if no active task (becomes active), 'queued' if
     * queued (new or replaced), 'coalesced' if an existing queued item was
     * replaced, or 'active-busy' if the active task is for the same ticket.
     */
    enqueueOrCoalesce(result: RouteResult): {
        action: "deliver" | "queued" | "coalesced" | "active-busy";
    };
    /**
     * Operational visibility: per-agent active status and queue depth.
     */
    getStats(): {
        agentId: string;
        active: boolean;
        queueDepth: number;
    }[];
    /**
     * Return distinct agent IDs that have any active or queued task.
     * Used by the startup drainer to recover backlog from prior process state.
     */
    agentsWithBacklog(): string[];
    close(): void;
}
//# sourceMappingURL=agent-queue.d.ts.map