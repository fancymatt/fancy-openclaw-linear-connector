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
export declare function verifyLinearSignature(rawBody: Buffer, signature: string, secret: string): boolean;
//# sourceMappingURL=signature.d.ts.map