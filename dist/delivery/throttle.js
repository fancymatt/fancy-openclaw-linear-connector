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
const DEFAULT_THROTTLE_MS = 2000;
const DEFAULT_MAX_CONCURRENT = 3;
export class DeliveryThrottle {
    constructor(intervalMs, maxConcurrent) {
        this.lastDelivery = new Map();
        this.active = 0;
        this.waitQueue = [];
        this.intervalMs =
            intervalMs ?? parseInt(process.env.DISPATCH_THROTTLE_MS ?? `${DEFAULT_THROTTLE_MS}`, 10);
        this.maxConcurrent =
            maxConcurrent ?? parseInt(process.env.MAX_CONCURRENT_DISPATCHES ?? `${DEFAULT_MAX_CONCURRENT}`, 10);
    }
    /**
     * If the agent was delivered to within the throttle window, wait the
     * remaining duration before resolving. Otherwise resolves immediately.
     */
    async wait(agentId) {
        const last = this.lastDelivery.get(agentId);
        const now = Date.now();
        if (last !== undefined) {
            const elapsed = now - last;
            if (elapsed < this.intervalMs) {
                const delay = this.intervalMs - elapsed;
                return new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
        // No wait needed — record now as last delivery time
        this.lastDelivery.set(agentId, now);
    }
    /** Record a delivery for an agent (call after successful dispatch). */
    record(agentId) {
        this.lastDelivery.set(agentId, Date.now());
    }
    /**
     * Acquire a global dispatch slot. Waits if MAX_CONCURRENT_DISPATCHES
     * deliveries are already in flight. Call releaseSlot() when done.
     */
    async acquireSlot() {
        if (this.active < this.maxConcurrent) {
            this.active++;
            return;
        }
        return new Promise((resolve) => {
            this.waitQueue.push(() => {
                this.active++;
                resolve();
            });
        });
    }
    /** Release a global dispatch slot, unblocking the next waiter if any. */
    releaseSlot() {
        const next = this.waitQueue.shift();
        if (next) {
            next();
        }
        else {
            this.active--;
        }
    }
    /** Return the configured per-agent interval in ms. */
    getInterval() {
        return this.intervalMs;
    }
    /** Return the configured global concurrent dispatch limit. */
    getMaxConcurrent() {
        return this.maxConcurrent;
    }
}
//# sourceMappingURL=throttle.js.map