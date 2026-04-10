import crypto from "crypto";
import { verifyLinearSignature } from "./signature";

const SECRET = "test-webhook-secret-abc123";

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
