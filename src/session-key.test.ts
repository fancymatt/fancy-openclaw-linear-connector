import { normalizeSessionKey, tryNormalizeSessionKey } from "./session-key.js";

describe("normalizeSessionKey", () => {
  it("passes through already-correct keys", () => {
    expect(normalizeSessionKey("linear-ILL-152")).toBe("linear-ILL-152");
    expect(normalizeSessionKey("linear-AI-584")).toBe("linear-AI-584");
    expect(normalizeSessionKey("linear-LIFE-177")).toBe("linear-LIFE-177");
  });

  it("fixes lowercase identifiers", () => {
    expect(normalizeSessionKey("linear-ill-152")).toBe("linear-ILL-152");
    expect(normalizeSessionKey("linear-ai-584")).toBe("linear-AI-584");
    expect(normalizeSessionKey("ill-152")).toBe("linear-ILL-152");
  });

  it("strips wake-linear- prefix", () => {
    expect(normalizeSessionKey("wake-linear-ILL-152")).toBe("linear-ILL-152");
    expect(normalizeSessionKey("wake-linear-ill-152")).toBe("linear-ILL-152");
  });

  it("strips linear-wake- prefix", () => {
    expect(normalizeSessionKey("linear-wake-ILL-152")).toBe("linear-ILL-152");
    expect(normalizeSessionKey("linear-wake-ill-152")).toBe("linear-ILL-152");
  });

  it("strips bare wake- prefix", () => {
    expect(normalizeSessionKey("wake-ILL-152")).toBe("linear-ILL-152");
  });

  it("handles bare identifiers without prefix", () => {
    expect(normalizeSessionKey("ILL-152")).toBe("linear-ILL-152");
    expect(normalizeSessionKey("AI-1")).toBe("linear-AI-1");
  });

  it("throws on invalid keys", () => {
    expect(() => normalizeSessionKey("")).toThrow();
    expect(() => normalizeSessionKey("garbage")).toThrow();
    expect(() => normalizeSessionKey("linear-garbage")).toThrow();
  });

  it("handles mixed case prefix stripping", () => {
    expect(normalizeSessionKey("WAKE-LINEAR-ill-152")).toBe("linear-ILL-152");
    expect(normalizeSessionKey("Linear-Wake-ILL-152")).toBe("linear-ILL-152");
  });
});

describe("tryNormalizeSessionKey", () => {
  it("returns normalized key for valid inputs", () => {
    expect(tryNormalizeSessionKey("linear-ILL-152")).toBe("linear-ILL-152");
  });

  it("returns null for invalid inputs", () => {
    expect(tryNormalizeSessionKey("garbage")).toBeNull();
    expect(tryNormalizeSessionKey("")).toBeNull();
  });
});
