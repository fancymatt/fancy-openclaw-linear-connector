"use strict";
/**
 * Normalized internal event shape for Linear webhook payloads.
 *
 * All inbound Linear webhook events are parsed into a `LinearEvent` before
 * being routed downstream. This decouples routing/queue logic from the raw
 * Linear API surface and gives us a stable internal contract.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=schema.js.map