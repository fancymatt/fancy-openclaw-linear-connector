import type { LinearEvent } from "./schema.js";
/**
 * Parses a raw Linear webhook payload into a normalized `LinearEvent`.
 *
 * Unknown event types are preserved as `LinearUnknownEvent` so they can be
 * logged or forwarded without being silently dropped.
 *
 * @throws {Error} if the payload is missing required top-level fields.
 */
export declare function normalizeLinearEvent(payload: unknown): LinearEvent;
//# sourceMappingURL=normalize.d.ts.map