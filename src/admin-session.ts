import crypto from "node:crypto";
import type { Request, Response } from "express";

/**
 * Cookie-session layer for the management console (Phase 3).
 *
 * Tokens are stateless HMAC values derived from ADMIN_SECRET, so sessions
 * survive connector restarts (which are routine) and are all invalidated at
 * once by rotating ADMIN_SECRET. Header-based auth (x-admin-secret / Bearer /
 * Basic) remains first-class for API clients and the readonly socket.
 */

export const SESSION_COOKIE = "admin_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const TOKEN_VERSION = "v1";

function sessionKey(secret: string): Buffer {
  // HKDF so the cookie-signing key is never the raw admin secret.
  return Buffer.from(
    crypto.hkdfSync("sha256", secret, "linear-connector-admin-session", TOKEN_VERSION, 32),
  );
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", sessionKey(secret)).update(payload).digest("base64url");
}

export function mintSessionToken(secret: string, now: Date = new Date(), ttlMs: number = SESSION_TTL_MS): string {
  const expires = now.getTime() + ttlMs;
  const nonce = crypto.randomBytes(12).toString("base64url");
  const payload = `${TOKEN_VERSION}.${expires}.${nonce}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token: string, secret: string, now: Date = new Date()): boolean {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return false;
  const [version, expiresRaw, nonce, mac] = parts;
  const expires = Number.parseInt(expiresRaw, 10);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return false;
  const expected = sign(`${version}.${expiresRaw}.${nonce}`, secret);
  const macBuffer = Buffer.from(mac, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (macBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(macBuffer, expectedBuffer);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function sessionTokenFromRequest(req: Request): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

export function setSessionCookie(res: Response, token: string, ttlMs: number = SESSION_TTL_MS): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * In-memory login throttle. Brute-forcing ADMIN_SECRET through the login
 * endpoint must be slower than guessing it offline is impossible.
 */
export class LoginRateLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private maxFailures = 10,
    private windowMs = 5 * 60 * 1000,
    private now: () => number = Date.now,
  ) {}

  /** True when this key has exhausted its failure budget. */
  isBlocked(key: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    this.failures.set(key, recent);
    return recent.length >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const list = this.failures.get(key) ?? [];
    list.push(this.now());
    this.failures.set(key, list);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
