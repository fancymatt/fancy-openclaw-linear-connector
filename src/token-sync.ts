/**
 * Pull-based OAuth token sync endpoint for remote agent hosts.
 *
 * GET /tokens/:agent
 *   Authorization: Bearer <TOKEN_SYNC_SECRET>
 *
 * Returns the agent's current tokens so remote hosts can pull on a schedule.
 */

import { Router, Request, Response } from "express";
import { getAgent } from "./agents.js";
import { createLogger, componentLogger } from "./logger.js";

const log = componentLogger(createLogger(), "token-sync");

export function createTokenSyncRouter(): Router {
  const router = Router();

  router.get("/tokens/:agent", (req: Request, res: Response) => {
    const { agent: agentName } = req.params;

    // Validate bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      log.warn(`Rejected token fetch for '${agentName}': missing or malformed auth header`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = authHeader.slice(7);
    const expected = process.env.TOKEN_SYNC_SECRET;
    if (!expected || token !== expected) {
      log.warn(`Rejected token fetch for '${agentName}': invalid bearer token`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Look up agent
    const agent = getAgent(agentName);
    if (!agent) {
      log.warn(`Token fetch: agent '${agentName}' not found`);
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    log.info(
      `Token fetched for '${agentName}': ${agent.accessToken.slice(0, 20)}...`,
    );

    res.json({
      access_token: agent.accessToken,
      refresh_token: agent.refreshToken,
      scope: "read",
      updated_at: new Date().toISOString(),
    });
  });

  return router;
}
