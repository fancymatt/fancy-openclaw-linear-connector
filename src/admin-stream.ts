/**
 * AI-1952: SSE live-refresh stream for the admin console.
 *
 * Exports:
 *   emitStreamTopic(topic) — fire-and-forget topic invalidation for internal signal sources
 *   mountStreamRoute(router) — register GET /api/stream on the admin router
 */

import { EventEmitter } from "node:events";
import type { Request, Response, Router } from "express";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(), "admin-stream");

export type StreamTopic = "board" | "fleet" | "alerts" | "events" | "dead-letters";

const TOPICS: readonly StreamTopic[] = ["board", "fleet", "alerts", "events", "dead-letters"];
const HEARTBEAT_INTERVAL_MS = 25_000;

// Module-level bus — all SSE clients subscribe here, internal signals emit here.
const _bus = new EventEmitter();
_bus.setMaxListeners(1000);

export function emitStreamTopic(topic: StreamTopic): void {
  _bus.emit(topic);
}

export function mountStreamRoute(router: Router): void {
  router.get("/api/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Initial comment doubles as a marker readable in raw body (used by tests).
    res.write(": text/event-stream\n\n");

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, HEARTBEAT_INTERVAL_MS);

    const listeners = TOPICS.map((topic) => {
      const listener = () => {
        res.write(`event: ${topic}\ndata: \n\n`);
      };
      _bus.on(topic, listener);
      return { topic, listener };
    });

    req.on("close", () => {
      clearInterval(heartbeat);
      for (const { topic, listener } of listeners) {
        _bus.off(topic, listener);
      }
    });
  });

  log.info("SSE stream mounted at /admin/api/stream; topics: board, fleet, alerts, events, dead-letters");
}
