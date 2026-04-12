/**
 * Routing engine for Linear → OpenClaw event dispatch.
 *
 * Pure function: takes a normalized `LinearEvent` and a `RoutingConfig`,
 * returns a `RouteResult` identifying the target agent, or `null` if no
 * mapping exists.
 *
 * ## Routing priority
 * 1. **Assignee match** — if the event carries an assigneeId that maps to
 *    an agent in `config.agents`, route there (priority 10).
 * 2. **Team fallback** — if the event carries a teamKey that maps to an
 *    agent in `config.teamDefaults`, route there (priority 20).
 * 3. **Unmapped** — return `null`. The caller decides what to do.
 *
 * ## Extracting routing signals
 * - `Issue` events: `data.assigneeId` and `data.teamKey`
 * - `Comment` events: no assignee/team on the comment itself, so comments
 *   always fall through to team-based or unmapped unless enriched upstream.
 * - Unknown event types: always unmapped.
 */
import type { LinearEvent } from "../webhook/schema";
import type { RouteResult } from "../types";
import type { RoutingConfig } from "./config";
/**
 * Routes a normalized Linear event to an OpenClaw agent.
 *
 * @param event - A normalized `LinearEvent` from the webhook layer.
 * @param config - Validated routing configuration.
 * @returns A `RouteResult` if a mapping is found, or `null` if unmapped.
 */
export declare function routeEvent(event: LinearEvent, config: RoutingConfig): RouteResult | null;
//# sourceMappingURL=router.d.ts.map