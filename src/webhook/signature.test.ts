import crypto from "crypto";
import { verifyLinearSignature, verifyLinearSignatureMulti, parseWebhookSecrets } from "./signature";

const SECRET = "test-webhook-secret-abc123";
const PRIVATE_SECRET = "private-team-secret-xyz789";

function makeSignature(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

describe("verifyLinearSignature", () => {
  const body = JSON.stringify({ type: "Issue", action: "create" });
  const rawBody = Buffer.from(body);
  const validSig = makeSignature(body, SECRET);

  it("returns true for a valid signature", () => {
    expect(verifyLinearSignature(rawBody, validSig, SECRET)).toBe(true);
  });

  it("returns false for a wrong signature", () => {
    const badSig = makeSignature(body, "wrong-secret");
    expect(verifyLinearSignature(rawBody, badSig, SECRET)).toBe(false);
  });

  it("returns false for a tampered body", () => {
    const tamperedBody = Buffer.from(
      JSON.stringify({ type: "Issue", action: "remove" })
    );
    expect(verifyLinearSignature(tamperedBody, validSig, SECRET)).toBe(false);
  });

  it("returns false when signature is empty string", () => {
    expect(verifyLinearSignature(rawBody, "", SECRET)).toBe(false);
  });

  it("returns false when secret is empty string", () => {
    expect(verifyLinearSignature(rawBody, validSig, "")).toBe(false);
  });

  it("returns false for a malformed (non-hex) signature", () => {
    expect(verifyLinearSignature(rawBody, "not-hex!!!", SECRET)).toBe(false);
  });

  it("is not susceptible to length mismatch crashing (odd-length hex)", () => {
    expect(verifyLinearSignature(rawBody, "abc", SECRET)).toBe(false);
  });
});

describe("verifyLinearSignatureMulti", () => {
  const body = JSON.stringify({ type: "Issue", action: "create" });
  const rawBody = Buffer.from(body);

  it("returns true when the first secret matches", () => {
    const sig = makeSignature(body, SECRET);
    expect(verifyLinearSignatureMulti(rawBody, sig, [SECRET, PRIVATE_SECRET])).toBe(true);
  });

  it("returns true when a later secret matches", () => {
    const sig = makeSignature(body, PRIVATE_SECRET);
    expect(verifyLinearSignatureMulti(rawBody, sig, [SECRET, PRIVATE_SECRET])).toBe(true);
  });

  it("returns true when the only secret matches", () => {
    const sig = makeSignature(body, SECRET);
    expect(verifyLinearSignatureMulti(rawBody, sig, [SECRET])).toBe(true);
  });

  it("returns false when no secret matches", () => {
    const sig = makeSignature(body, "wrong-secret");
    expect(verifyLinearSignatureMulti(rawBody, sig, [SECRET, PRIVATE_SECRET])).toBe(false);
  });

  it("returns false for empty secrets array", () => {
    const sig = makeSignature(body, SECRET);
    expect(verifyLinearSignatureMulti(rawBody, sig, [])).toBe(false);
  });

  it("returns false for empty signature", () => {
    expect(verifyLinearSignatureMulti(rawBody, "", [SECRET, PRIVATE_SECRET])).toBe(false);
  });

  it("handles 5+ secrets (practical limit for private teams)", () => {
    const secrets = ["s1", "s2", "s3", "s4", "s5"];
    const sig = makeSignature(body, "s4");
    expect(verifyLinearSignatureMulti(rawBody, sig, secrets)).toBe(true);
  });
});

describe("parseWebhookSecrets", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns single secret from LINEAR_WEBHOOK_SECRET", () => {
    process.env.LINEAR_WEBHOOK_SECRET = "only-secret";
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    expect(parseWebhookSecrets()).toEqual(["only-secret"]);
  });

  it("returns parsed comma-separated secrets from LINEAR_WEBHOOK_SECRETS", () => {
    process.env.LINEAR_WEBHOOK_SECRETS = "secret-a, secret-b, secret-c";
    delete process.env.LINEAR_WEBHOOK_SECRET;
    expect(parseWebhookSecrets()).toEqual(["secret-a", "secret-b", "secret-c"]);
  });

  it("prefers LINEAR_WEBHOOK_SECRETS and includes LINEAR_WEBHOOK_SECRET as first entry", () => {
    process.env.LINEAR_WEBHOOK_SECRETS = "private-1, private-2";
    process.env.LINEAR_WEBHOOK_SECRET = "org-secret";
    expect(parseWebhookSecrets()).toEqual(["org-secret", "private-1", "private-2"]);
  });

  it("deduplicates if LINEAR_WEBHOOK_SECRET is already in LINEAR_WEBHOOK_SECRETS", () => {
    process.env.LINEAR_WEBHOOK_SECRETS = "org-secret, private-1";
    process.env.LINEAR_WEBHOOK_SECRET = "org-secret";
    expect(parseWebhookSecrets()).toEqual(["org-secret", "private-1"]);
  });

  it("trims whitespace and filters empty entries", () => {
    process.env.LINEAR_WEBHOOK_SECRETS = "  a  , , b ,  ";
    delete process.env.LINEAR_WEBHOOK_SECRET;
    expect(parseWebhookSecrets()).toEqual(["a", "b"]);
  });

  it("returns empty array when neither is set", () => {
    delete process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    expect(parseWebhookSecrets()).toEqual([]);
  });
});
