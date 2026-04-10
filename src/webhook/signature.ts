import crypto from "crypto";

/**
 * Verifies the HMAC-SHA256 signature attached to a Linear webhook request.
 *
 * Linear signs each webhook with the shared secret configured on the webhook
 * endpoint in their dashboard. The signature is sent in the
 * `x-linear-signature` header as a hex digest.
 *
 * @param rawBody   - The raw (unparsed) request body buffer.
 * @param signature - The value of the `x-linear-signature` header.
 * @param secret    - The `LINEAR_WEBHOOK_SECRET` environment variable value.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export function verifyLinearSignature(
  rawBody: Buffer,
  signature: string,
  secret: string
): boolean {
  if (!signature || !secret) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    // Buffer lengths differ (malformed signature) → reject
    return false;
  }
}
