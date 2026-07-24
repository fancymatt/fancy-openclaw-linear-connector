import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { probeDeployOutcome } from "./deploy-probe.js";

describe("src/deploy-probe.ts", () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch" as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("fails open when no URL is provided", async () => {
    const result = await probeDeployOutcome("commit-a", undefined);
    expect(result.success).toBe(true);
    expect(result.reason).toContain("no health check URL");
  });

  it("succeeds when commit SHA matches exactly", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ commit: "commit-a" }),
    });

    const result = await probeDeployOutcome("commit-a", "http://health");
    expect(result.success).toBe(true);
    expect(result.runningCommit).toBe("commit-a");
  });

  it("fails when commit SHA mismatch", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ commit: "stale-commit" }),
    });

    const result = await probeDeployOutcome("commit-new", "http://health");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("stale");
    expect(result.runningCommit).toBe("stale-commit");
  });

  it("succeeds when behavioral probe matches even if commit is unknown", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ commit: "unknown", feature_x: "active" }),
    });

    const result = await probeDeployOutcome("commit-new", "http://health", {
      pattern: '"feature_x":"active"',
      description: "Feature X"
    });
    expect(result.success).toBe(true);
  });

  it("fails when behavioral probe pattern is missing", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ commit: "commit-new", feature_x: "inactive" }),
    });

    const result = await probeDeployOutcome("commit-new", "http://health", {
      pattern: '"feature_x":"active"',
      description: "Feature X"
    });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("behavioral probe failed");
  });

  it("INF-296 shape: fails when commit matches but behavior is stale (negative case for behavior probe)", async () => {
      // In some cases, the commit SHA might be updated in the registry but the code behavior hasn't changed.
      // Or more likely: the commit matches because it's a re-deploy of the same SHA but a behavior flag is different.
      fetchSpy.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ commit: "commit-a", status: "degraded" }),
      });
  
      const result = await probeDeployOutcome("commit-a", "http://health", {
        pattern: '"status":"ok"',
        description: "Status OK"
      });
      expect(result.success).toBe(false);
      expect(result.reason).toContain("behavioral probe failed");
    });
});
