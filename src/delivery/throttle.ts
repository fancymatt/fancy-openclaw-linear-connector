/**
 * Per-agent delivery spacing + global delivery-rate throttle.
 *
 * Prevents burst-spawned sessions by:
 * 1. Per-agent: enforcing a minimum interval between consecutive deliveries
 *    to the same agent (DISPATCH_THROTTLE_MS, default 2s).
 * 2. Global: limiting in-flight delivery handoffs across all agents
 *    (MAX_CONCURRENT_DISPATCHES, default 6). This protects the OpenClaw gateway's
 *    lane=main from gateway lane saturation during Linear webhook bursts
 *    (AI-1216). The slot is released when the wake handoff returns.
 */

const DEFAULT_THROTTLE_MS = 2_000;
const DEFAULT_GATEWAY_DELIVERY_BURST_LIMIT = 6;

export class DeliveryThrottle {
  private lastDelivery: Map<string, number> = new Map();
  private intervalMs: number;
  private maxInFlightDeliveries: number;
  private active: number = 0;
  private waitQueue: Array<() => void> = [];

  constructor(intervalMs?: number, maxInFlightDeliveries?: number) {
    this.intervalMs =
      intervalMs ?? parseInt(process.env.DISPATCH_THROTTLE_MS ?? `${DEFAULT_THROTTLE_MS}`, 10);
    this.maxInFlightDeliveries =
      maxInFlightDeliveries ??
      parseInt(process.env.MAX_CONCURRENT_DISPATCHES ?? `${DEFAULT_GATEWAY_DELIVERY_BURST_LIMIT}`, 10);
  }

  /**
   * If the agent was delivered to within the throttle window, wait the
   * remaining duration before resolving. Otherwise resolves immediately.
   */
  async wait(agentId: string): Promise<void> {
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
  record(agentId: string): void {
    this.lastDelivery.set(agentId, Date.now());
  }

  /**
   * Acquire a global delivery handoff slot. Waits if MAX_CONCURRENT_DISPATCHES
   * delivery handoffs are already in flight. Call releaseSlot() when done.
   */
  async acquireSlot(): Promise<void> {
    if (this.active < this.maxInFlightDeliveries) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  /** Release a global dispatch slot, unblocking the next waiter if any. */
  releaseSlot(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }

  /** Return the configured per-agent interval in ms. */
  getInterval(): number {
    return this.intervalMs;
  }

  /** Return the configured global in-flight delivery handoff limit. */
  getMaxConcurrent(): number {
    return this.maxInFlightDeliveries;
  }
}
