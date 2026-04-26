import { Request, Response } from "express";
/**
 * Handles the OAuth callback from Linear.
 *
 * Expected query params:
 *   code  — authorization code from Linear
 *   state — agent name (set when building the authorize URL)
 *
 * The agent must already exist in agents.json with at least `name`,
 * `clientId`, and `clientSecret` populated (a "partial" entry).
 * The callback fills in `linearUserId`, `accessToken`, and `refreshToken`.
 */
export declare function handleOAuthCallback(req: Request, res: Response): Promise<void>;
//# sourceMappingURL=oauth-callback.d.ts.map