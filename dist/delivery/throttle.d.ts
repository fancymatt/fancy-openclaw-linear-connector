/**
 * Per-agent delivery throttle + global concurrent-dispatch semaphore.
 *
 * Prevents burst-spawned sessions by:
 * 1. Per-agent: enforcing a minimum interval between consecutive deliveries
 *    to the same agent (DISPATCH_THROTTLE_MS, default 2s).
 * 2. Global: capping the number of in-flight deliveries across all agents
 *    (MAX_CONCURRENT_DISPATCHES, default 3).  This prevents a Linear webhook
 *    burst from queuing 20+ sessions on the OpenClaw gateway's lane=main
 *    simultaneously, which caused runtime-plugins bootstrap stalls fleet-wide
 *    when the main lane was saturated (AI-1216).
 */
export declare class DeliveryThrottle {
    private lastDelivery;
    private intervalMs;
    private maxConcurrent;
    private active;
    private waitQueue;
    constructor(intervalMs?: number, maxConcurrent?: number);
    /**
     * If the agent was delivered to within the throttle window, wait the
     * remaining duration before resolving. Otherwise resolves immediately.
     */
    wait(agentId: string): Promise<void>;
    /** Record a delivery for an agent (call after successful dispatch). */
    record(agentId: string): void;
    /**
     * Acquire a global dispatch slot. Waits if MAX_CONCURRENT_DISPATCHES
     * deliveries are already in flight. Call releaseSlot() when done.
     */
    acquireSlot(): Promise<void>;
    /** Release a global dispatch slot, unblocking the next waiter if any. */
    releaseSlot(): void;
    /** Return the configured per-agent interval in ms. */
    getInterval(): number;
    /** Return the configured global concurrent dispatch limit. */
    getMaxConcurrent(): number;
}
//# sourceMappingURL=throttle.d.ts.map