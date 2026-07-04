/**
 * Upload proxy — AI-1767.
 *
 * `uploads.linear.app` URLs require a real Linear OAuth token. Agent containers
 * only have `lpx_` proxy tokens (the connector swaps in real credentials for
 * GraphQL calls in proxy.ts, but fetch-image bypassed the proxy entirely).
 *
 * This endpoint mirrors the GraphQL proxy pattern: resolve the agent from its
 * proxy token, swap in the vaulted real Linear token, fetch the asset from
 * uploads.linear.app, and stream the bytes back to the caller.
 *
 * Security:
 *   - Same broker-token authentication as /proxy/graphql (getAgentByProxyToken).
 *   - Linear-host allowlist enforced server-side so the real token can never be
 *     sent to an arbitrary host (same rationale as the CLI-side guard, but
 *     enforced at the point where the real token is used).
 *   - Size capped at MAX_UPLOAD_BYTES to prevent unbounded buffering.
 */

import type { Request, Response } from "express";
import { componentLogger, createLogger } from "./logger.js";
import { getAgentByProxyToken } from "./agents.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "proxy-upload");

/** Maximum response size we'll buffer from uploads.linear.app (50 MB). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Only Linear-owned hosts are allowed — never send the real token elsewhere. */
function assertLinearHost(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing non-https URL: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "linear.app" && !host.endsWith(".linear.app")) {
    throw new Error(
      `Refusing to fetch a non-Linear host (${host}). Only uploads.linear.app / *.linear.app URLs are accepted.`
    );
  }
  return parsed;
}

function stripBearer(auth: string): string {
  return auth.replace(/^Bearer\s+/i, "").trim();
}

export async function handleProxyUploadRequest(req: Request, res: Response): Promise<void> {
  // --- Auth: resolve agent from proxy token (same as /proxy/graphql) ---
  const rawAuthorization = req.headers["authorization"];
  if (!rawAuthorization) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }
  const authHeader = Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization;
  const brokerAgent = getAgentByProxyToken(stripBearer(authHeader));

  if (!brokerAgent) {
    // No fallback for upload proxy — direct tokens are not accepted because
    // the whole point is that agent containers don't have real Linear tokens.
    res.status(401).json({ error: "Unrecognized proxy token" });
    return;
  }

  const authorization = brokerAgent.accessToken;
  const agentId = brokerAgent.name;

  // --- Parse request ---
  const uploadUrl = typeof req.query.url === "string" ? req.query.url : undefined;
  if (!uploadUrl) {
    res.status(400).json({ error: "Missing 'url' query parameter" });
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = assertLinearHost(uploadUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
    return;
  }

  // --- Fetch from uploads.linear.app with the REAL Linear token ---
  log.info(`upload-fetch agent=${agentId} url=${parsedUrl.toString()}`);

  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(parsedUrl.toString(), {
      headers: { Authorization: authorization },
      redirect: "follow",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`upload-fetch failed agent=${agentId}: ${msg}`);
    res.status(502).json({ error: `Failed to fetch upload from Linear: ${msg}` });
    return;
  }

  if (!upstreamRes.ok) {
    const body = await upstreamRes.text().catch(() => "");
    log.warn(`upload-fetch upstream-error agent=${agentId} status=${upstreamRes.status}`);
    res.status(upstreamRes.status).json({
      error: `Linear returned HTTP ${upstreamRes.status} fetching the upload`,
      upstreamStatus: upstreamRes.status,
      detail: body.slice(0, 500),
    });
    return;
  }

  // --- Stream bytes back ---
  const contentType = upstreamRes.headers.get("content-type") ?? "application/octet-stream";
  const contentLength = upstreamRes.headers.get("content-length");

  // Guard against unbounded responses
  if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_BYTES) {
    log.warn(`upload-fetch too-large agent=${agentId} size=${contentLength}`);
    res.status(413).json({ error: `Upload exceeds ${MAX_UPLOAD_BYTES} byte limit` });
    return;
  }

  const buffer = Buffer.from(await upstreamRes.arrayBuffer());
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    log.warn(`upload-fetch too-large agent=${agentId} size=${buffer.byteLength}`);
    res.status(413).json({ error: `Upload exceeds ${MAX_UPLOAD_BYTES} byte limit` });
    return;
  }

  log.info(`upload-fetch ok agent=${agentId} bytes=${buffer.byteLength} type=${contentType}`);

  res.status(200)
    .set("Content-Type", contentType)
    .set("Content-Length", String(buffer.byteLength))
    .send(buffer);
}
