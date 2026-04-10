"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyLinearSignature = verifyLinearSignature;
const crypto_1 = __importDefault(require("crypto"));
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
function verifyLinearSignature(rawBody, signature, secret) {
    if (!signature || !secret) {
        return false;
    }
    const expected = crypto_1.default
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");
    // Constant-time comparison to prevent timing attacks
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
    }
    catch {
        // Buffer lengths differ (malformed signature) → reject
        return false;
    }
}
//# sourceMappingURL=signature.js.map