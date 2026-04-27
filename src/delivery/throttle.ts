/**
 * Per-agent delivery throttle.
 *
 * Prevents burst-spawned sessions by enforcing a minimum interval between
 * consecutive deliveries to the same agent. Each agent gets its own cooldown
 * tracked independently.
 *
 * Default interval: 2 seconds (configurable via DISPATCH_THROTTLE_MS env).
 */

const DEFAULT_THROTTLE_MS = 2_000;

export class DeliveryThrottle {
  private lastDelivery: Map<string, number> = new Map();
  private intervalMs: number;

  constructor(intervalMs?: number) {
    this.intervalMs =
      intervalMs ?? parseInt(process.env.DISPATCH_THROTTLE_MS ?? `${DEFAULT_THROTTLE_MS}`, 10);
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

  /** Return the configured interval in ms. */
  getInterval(): number {
    return this.intervalMs;
  }
}
