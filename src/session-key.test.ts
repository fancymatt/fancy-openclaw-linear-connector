import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionKey, tryNormalizeSessionKey } from "./session-key.js";

describe("normalizeSessionKey", () => {
  it("passes through already-correct keys", () => {
    assert.equal(normalizeSessionKey("linear-ILL-152"), "linear-ILL-152");
    assert.equal(normalizeSessionKey("linear-AI-584"), "linear-AI-584");
    assert.equal(normalizeSessionKey("linear-LIFE-177"), "linear-LIFE-177");
  });

  it("fixes lowercase identifiers", () => {
    assert.equal(normalizeSessionKey("linear-ill-152"), "linear-ILL-152");
    assert.equal(normalizeSessionKey("linear-ai-584"), "linear-AI-584");
    assert.equal(normalizeSessionKey("ill-152"), "linear-ILL-152");
  });

  it("strips wake-linear- prefix", () => {
    assert.equal(normalizeSessionKey("wake-linear-ILL-152"), "linear-ILL-152");
    assert.equal(normalizeSessionKey("wake-linear-ill-152"), "linear-ILL-152");
  });

  it("strips linear-wake- prefix", () => {
    assert.equal(normalizeSessionKey("linear-wake-ILL-152"), "linear-ILL-152");
    assert.equal(normalizeSessionKey("linear-wake-ill-152"), "linear-ILL-152");
  });

  it("strips bare wake- prefix", () => {
    assert.equal(normalizeSessionKey("wake-ILL-152"), "linear-ILL-152");
  });

  it("handles bare identifiers without prefix", () => {
    assert.equal(normalizeSessionKey("ILL-152"), "linear-ILL-152");
    assert.equal(normalizeSessionKey("AI-1"), "linear-AI-1");
  });

  it("throws on invalid keys", () => {
    assert.throws(() => normalizeSessionKey(""));
    assert.throws(() => normalizeSessionKey("garbage"));
    assert.throws(() => normalizeSessionKey("linear-garbage"));
  });

  it("handles mixed case prefix stripping", () => {
    assert.equal(normalizeSessionKey("WAKE-LINEAR-ill-152"), "linear-ILL-152");
    assert.equal(normalizeSessionKey("Linear-Wake-ILL-152"), "linear-ILL-152");
  });
});

describe("tryNormalizeSessionKey", () => {
  it("returns normalized key for valid inputs", () => {
    assert.equal(tryNormalizeSessionKey("linear-ILL-152"), "linear-ILL-152");
  });

  it("returns null for invalid inputs", () => {
    assert.equal(tryNormalizeSessionKey("garbage"), null);
    assert.equal(tryNormalizeSessionKey(""), null);
  });
});
