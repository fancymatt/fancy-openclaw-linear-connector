import { describe, expect, it } from "@jest/globals";
import {
  formatCodeArtifact,
  parseArtifactMarkers,
  parseCodeArtifact,
  sameArtifact,
  shasMatch,
} from "./artifact.js";

describe("artifact helpers", () => {
  it("parses branch@sha using the last @ and lowercases sha", () => {
    expect(parseCodeArtifact("feature/owner@topic@ABC1234")).toEqual({
      branch: "feature/owner@topic",
      sha: "abc1234",
    });
  });

  it("rejects malformed code artifact headers", () => {
    expect(parseCodeArtifact("@abc1234")).toBeNull();
    expect(parseCodeArtifact("feature/no-sha@")).toBeNull();
    expect(parseCodeArtifact("feature/no-at")).toBeNull();
    expect(parseCodeArtifact("feature/bad@123456")).toBeNull();
    expect(parseCodeArtifact("feature/bad@notasha")).toBeNull();
  });

  it("parses disclosure markers in document order and skips malformed markers", () => {
    const body = [
      "before",
      '<!-- artifact-disclosure: {"branch":"feature/a","sha":"ABC1234"} -->',
      '<!-- artifact-disclosure: {"branch": -->',
      '<!-- artifact-disclosure: {"branch":"","sha":"def5678"} -->',
      '<!-- artifact-disclosure: {"branch":"feature/b","sha":"DEF5678"} -->',
    ].join("\n");

    expect(parseArtifactMarkers(body)).toEqual([
      { branch: "feature/a", sha: "abc1234" },
      { branch: "feature/b", sha: "def5678" },
    ]);
  });

  it("matches abbreviated shas by prefix on the shorter value", () => {
    expect(shasMatch("ABC1234", "abc1234567890")).toBe(true);
    expect(shasMatch("abc1234567890", "ABC1234")).toBe(true);
  });

  it("does not match non-prefix sha substrings", () => {
    expect(shasMatch("bc1234", "abc1234567890")).toBe(false);
    expect(shasMatch("1234567", "abc1234567")).toBe(false);
  });

  it("compares artifacts by exact branch and sha prefix", () => {
    expect(sameArtifact(
      { branch: "feature/x", sha: "abc1234" },
      { branch: "feature/x", sha: "abc1234567890" },
    )).toBe(true);
    expect(sameArtifact(
      { branch: "feature/x", sha: "abc1234" },
      { branch: "feature/y", sha: "abc1234567890" },
    )).toBe(false);
  });

  it("formats code artifacts as branch@sha", () => {
    expect(formatCodeArtifact({ branch: "feature/x", sha: "abc1234" })).toBe("feature/x@abc1234");
  });
});
