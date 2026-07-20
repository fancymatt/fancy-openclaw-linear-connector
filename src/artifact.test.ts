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
      '<!-- artifact-disclosure: {"branch":"feature/a","sha":"ABC1234","to":"u-ai"} -->',
      '<!-- artifact-disclosure: {"branch": -->',
      '<!-- artifact-disclosure: {"branch":"","sha":"def5678","to":"u-ai"} -->',
      '<!-- artifact-disclosure: {"branch":"feature/b","sha":"DEF5678","to":"u-ai"} -->',
    ].join("\n");

    expect(parseArtifactMarkers(body)).toEqual([
      { branch: "feature/a", sha: "abc1234", to: "u-ai" },
      { branch: "feature/b", sha: "def5678", to: "u-ai" },
    ]);
  });

  // Ai's AI-2479 refusal: the reader enforced only "non-empty string" on the sha
  // while the writer enforced SHA_RE. Since shasMatch prefix-compares on the
  // shorter operand, a recorded sha of "9" matched every declared sha starting
  // with 9 — the comparison silently stopped comparing on the one field it rests
  // on. If this goes red because parseArtifactMarkers got lenient again, fix the
  // parser, not the assertion.
  it("drops a record whose sha is not a sha, rather than trusting it to shasMatch", () => {
    const shortSha = '<!-- artifact-disclosure: {"branch":"feature/x","sha":"9","to":"u-ai"} -->';
    expect(parseArtifactMarkers(shortSha)).toEqual([]);

    const notHex = '<!-- artifact-disclosure: {"branch":"feature/x","sha":"zzzzzzz","to":"u-ai"} -->';
    expect(parseArtifactMarkers(notHex)).toEqual([]);

    // The over-match the lax parser allowed, spelled out: had "9" survived the
    // parse, it would have prefix-matched this real sha.
    expect(shasMatch("9", "9bc4942")).toBe(true);
  });

  it("drops a record with no recipient — an obligation with nobody to owe it", () => {
    const unaddressed = '<!-- artifact-disclosure: {"branch":"feature/x","sha":"b777e17"} -->';
    expect(parseArtifactMarkers(unaddressed)).toEqual([]);
  });

  it("matches abbreviated shas by prefix on the shorter value", () => {
    expect(shasMatch("ABC1234", "abc1234567890")).toBe(true);
    expect(shasMatch("abc1234567890", "ABC1234")).toBe(true);
  });

  it("does not match non-prefix sha substrings", () => {
    expect(shasMatch("bc1234", "abc1234567890")).toBe(false);
    expect(shasMatch("1234567", "abc1234567")).toBe(false);
  });

  it("compares artifacts by case-insensitive branch and sha prefix", () => {
    expect(sameArtifact(
      { branch: "feature/x", sha: "abc1234" },
      { branch: "feature/x", sha: "abc1234567890" },
    )).toBe(true);
    expect(sameArtifact(
      { branch: "feature/x", sha: "abc1234" },
      { branch: "feature/y", sha: "abc1234567890" },
    )).toBe(false);
    // Case-insensitive branch comparison (INF-169)
    expect(sameArtifact(
      { branch: "feature/GEN-288", sha: "def5678" },
      { branch: "feature/gen-288", sha: "def5678901234" },
    )).toBe(true);
    expect(sameArtifact(
      { branch: "FEATURE/X", sha: "abc1234" },
      { branch: "feature/x", sha: "abc1234567890" },
    )).toBe(true);
  });

  it("formats code artifacts as branch@sha", () => {
    expect(formatCodeArtifact({ branch: "feature/x", sha: "abc1234" })).toBe("feature/x@abc1234");
  });
});
