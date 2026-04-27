/**
 * Wake-up signal delivery.
 *
 * Sends a thin "you have N pending tickets" message to an agent when the bag
 * has work for them and they're not in an active session. The agent then uses
 * `linear queue` / `linear my-next` to fetch and process work in priority order.
 *
 * NOTE: The session key `wake-up-${ts}` constructed below is a synthetic ID
 * used only by the connector. The OpenClaw gateway has no knowledge of it.
 * Once the gateway plugin is implemented (see follow-up ticket), the real
 * gateway session ID should round-trip through the connector instead.
 */

import { deliverToAgent, type DeliveryConfig } from "../delivery/index.js";
import { createLogger, componentLogger } from "../logger.js";
import type { RouteResult } from "../types.js";

const log = componentLogger(createLogger(), "wakeup");

export interface WakeUpConfig extends DeliveryConfig {
  /** Signal message template. {count} and {tickets} are replaced. */
  signalTemplate?: string;
}

const DEFAULT_TEMPLATE =
  "You have {count} pending ticket(s) waiting: {tickets}. Run `linear my-next` to pick up the highest-priority one, or `linear queue` to see all.";

/**
 * Send a wake-up signal to an agent.
 *
 * The signal is intentionally thin — just tells the agent how many tickets
 * are pending and their IDs. The agent re-queries Linear for full details.
 */
export async function sendWakeUpSignal(
  agentId: string,
  ticketIds: string[],
  config: WakeUpConfig,
): Promise<void> {
  const count = ticketIds.length;
  const tickets = ticketIds.join(", ");
  const message = (config.signalTemplate ?? DEFAULT_TEMPLATE)
    .replace("{count}", String(count))
    .replace("{tickets}", tickets);

  const route: RouteResult = {
    agentId,
    sessionKey: `wake-up-${Date.now()}`,
    priority: 0,
    event: {
      type: "WakeUp",
      action: "signal",
      createdAt: new Date().toISOString(),
      data: { pendingTickets: ticketIds },
    } as unknown as RouteResult["event"],
    routingReason: "wake-up" as RouteResult["routingReason"],
  };

  log.info(`Sending wake-up signal to ${agentId}: ${count} ticket(s) [${tickets}]`);

  try {
    await deliverToAgent(route, config);
  } catch (err) {
    log.error(
      `Wake-up signal failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`
    );
    throw err;
  }
}
