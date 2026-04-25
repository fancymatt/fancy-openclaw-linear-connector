/**
 * Verifies the HMAC-SHA256 signature for a single secret.
 *
 * Uses constant-time comparison to prevent timing attacks.
 */
export declare function verifyLinearSignature(rawBody: Buffer, signature: string, secret: string): boolean;
/**
 * Verifies a Linear webhook signature against multiple secrets.
 *
 * Each Linear webhook (org-level or team-level) has its own signing secret.
 * This function tries each secret until one matches, using constant-time
 * comparison per attempt to avoid leaking which secret matched.
 *
 * @param rawBody   - The raw (unparsed) request body buffer.
 * @param signature - The value of the `x-linear-signature` header.
 * @param secrets   - Array of signing secrets to try.
 * @returns `true` if any secret validates the signature, `false` otherwise.
 */
export declare function verifyLinearSignatureMulti(rawBody: Buffer, signature: string, secrets: string[]): boolean;
/**
 * Parses the webhook secrets from environment variables.
 *
 * Supports two formats:
 * - `LINEAR_WEBHOOK_SECRETS` — comma-separated list (new, preferred)
 * - `LINEAR_WEBHOOK_SECRET` — single secret (legacy, backward compatible)
 *
 * If both are set, `LINEAR_WEBHOOK_SECRETS` takes precedence and
 * `LINEAR_WEBHOOK_SECRET` is included as the first entry.
 */
export declare function parseWebhookSecrets(): string[];
//# sourceMappingURL=signature.d.ts.map