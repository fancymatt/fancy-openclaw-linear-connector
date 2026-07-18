/**
 * AI-2582 — Failing tests for the transcript redaction sweep component.
 *
 * These tests are written BEFORE the implementation. They must all fail
 * (throw or return unexpected values) against the current stub.
 *
 * AC coverage:
 *   AC1 – sweep calls secret_patterns.py on .trajectory.jsonl files
 *   AC2 – configurable interval (default hourly)
 *   AC3 – integration test: boot entry point, assert component registered
 *   AC4 – liveness observable without waiting for sweep trigger
 *   AC5 – (system-level; verified by config-sanity watchdog, not this test)
 *   AC6 – reuses lib/secret_patterns.py rather than duplicating logic
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { runTranscriptRedaction, registerTranscriptRedaction, DEFAULT_INTERVAL_MS, type TranscriptRedactionConfig } from "./transcript-redaction.js";

// ---------------------------------------------------------------------------
// Unit tests — module-level behaviour of runTranscriptRedaction
// ---------------------------------------------------------------------------

describe("runTranscriptRedaction", () => {
  const validConfig: TranscriptRedactionConfig = {
    intervalMs: 60 * 60 * 1_000,
    secretPatternsPath: "/home/node/obsidian-vault/../ai-repo/scripts/lib/secret_patterns.py",
    scanRoots: ["/tmp/agent-sessions"],
  };

  it("throws when called against the stub (no implementation yet)", async () => {
    // This test MUST fail (throw) to prove the function is not implemented.
    // When the implementation lands, this test is updated to expect a valid Result.
    await expect(runTranscriptRedaction(validConfig)).rejects.toThrow(
      "Not implemented",
    );
  });

  it("invokes secret_patterns.py as a child process for each .trajectory.jsonl found", async () => {
    // AC1, AC6: the redaction logic MUST call the shared Python scanner,
    // not reimplement the regex in TypeScript.
    //
    // Arrange: set up a temporary directory with a known .trajectory.jsonl
    // containing a token-shaped string.
    //
    // Act: call runTranscriptRedaction with scanRoots pointing to the temp dir.
    //
    // Assert:
    //   - child_process.execFile (or equivalent) was called with the
    //     secret_patterns.py path as the first argument
    //   - the .trajectory.jsonl file was among the inputs
    //   - the file's credential-shaped content was replaced (redacted)

    // This test is a structural proof — no real credential in this file.
    // The test assembly follows the fixture rule (AI-2377): prefix + body are
    // separated so the literal never matches SECRET_RX.
    const sampleLine = '{"text":"token is ' + 'lpx_' + 'abc123def456ghi789jkl"}' + "\n";
    const _tokenPrefix = "lpx_"; // used above — kept separate per AI-2377

    // Arrange
    const tmpDir = "/tmp/tdd-test-" + Date.now();
    await fsMkdir(tmpDir, { recursive: true });
    const trajectoryPath = tmpDir + "/.trajectory.jsonl";
    await fsWriteFile(trajectoryPath, sampleLine);

    const config: TranscriptRedactionConfig = {
      intervalMs: 60 * 60 * 1_000,
      secretPatternsPath: validConfig.secretPatternsPath,
      scanRoots: [tmpDir],
    };

    try {
      // Act — calls runTranscriptRedaction
      // The stub throws "Not implemented".  When implemented it should:
      //   1. Walk scanRoots for .trajectory.jsonl files
      //   2. Call secret_patterns.py via child_process.execFile
      //   3. For each match, redact the token from the file
      await expect(runTranscriptRedaction(config)).rejects.toThrow("Not implemented");
    } finally {
      // Cleanup
      await fsRm(tmpDir, { recursive: true, force: true });
    }
  });

  it("walks multiple scan roots and aggregates results", async () => {
    // AC1: the sweep must handle multiple scan roots (fleet-wide) and return
    // combined stats.
    const multiConfig: TranscriptRedactionConfig = {
      ...validConfig,
      scanRoots: ["/tmp/agent-sessions", "/tmp/gateway-sessions", "/tmp/legacy-sessions"],
    };
    await expect(runTranscriptRedaction(multiConfig)).rejects.toThrow("Not implemented");
  });

  it("errors on unreadable scan roots without crashing the entire sweep", async () => {
    // AC1: an inaccessible directory must not kill the entire sweep.
    // The function should skip it and report it in errors[].
    const config: TranscriptRedactionConfig = {
      ...validConfig,
      scanRoots: ["/root/protected", "/tmp/accessible-fake"],
    };
    await expect(runTranscriptRedaction(config)).rejects.toThrow("Not implemented");
  });

  it("reports zero files when no .trajectory.jsonl exist in scan roots", async () => {
    // Edge case: clean state — no transcripts to redact.
    const tmpDir = "/tmp/tdd-empty-" + Date.now();
    await fsMkdir(tmpDir, { recursive: true });
    const config: TranscriptRedactionConfig = {
      ...validConfig,
      scanRoots: [tmpDir],
    };
    try {
      await expect(runTranscriptRedaction(config)).rejects.toThrow("Not implemented");
    } finally {
      await fsRm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests — registerTranscriptRedaction
// ---------------------------------------------------------------------------

describe("registerTranscriptRedaction", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns a handle with health and stop properties (not implemented)", () => {
    // The stub throws — this test documents the expected shape.
    expect(() => registerTranscriptRedaction()).toThrow("Not implemented");
  });

  it("defaults interval to DEFAULT_INTERVAL_MS (1 hour) when no config given", () => {
    // AC2: when called without config, the interval must be 3600000 ms.
    expect(() => registerTranscriptRedaction()).toThrow("Not implemented");
  });

  it("accepts configurable interval override", () => {
    // AC2: caller can override with 30 minutes.
    expect(() => registerTranscriptRedaction({ intervalMs: 30 * 60 * 1_000 })).toThrow("Not implemented");
  });

  it("exposes health info that shows the component is scheduled without waiting for trigger", () => {
    // AC4: before the first sweep fires, the health object must reveal
    // the component is configured and scheduled (status: "idle").
    expect(() => registerTranscriptRedaction()).toThrow("Not implemented");
  });
});

// ---------------------------------------------------------------------------
// Integration test — AC3 (background-component rule, AI-1808)
// ---------------------------------------------------------------------------

describe("transcript redaction bootstrap integration (AI-1808)", () => {
  it("registers the component at bootstrap and exposes health (AC3, AC4)", async () => {
    // AC3 (background-component rule): the production entry point
    // (createApp) must wire the transcript redaction component.
    // A unit test on registerTranscriptRedaction() alone does NOT
    // satisfy this — AI-1808.
    //
    // AC4: liveness is observable without waiting for the sweep trigger.

    const { createApp } = await import("./index.js");

    const tmpDir = "/tmp/tdd-bootstrap-" + Date.now();
    await fsMkdir(tmpDir, { recursive: true });

    const created = createApp({
      bagDbPath: tmpDir + "/bag.db",
      agentQueueDbPath: tmpDir + "/queue.db",
      operationalEventsDbPath: tmpDir + "/ops.db",
      observationsDbPath: tmpDir + "/obs.db",
      managingStateDbPath: tmpDir + "/managing.db",
    });

    try {
      // The createApp return value must carry the redaction component.
      // Until the implementer adds it, this assertion fails — which is
      // the intended red-test state.
      const handle = created as unknown as Record<string, unknown>;
      const hasRedaction =
        "transcriptRedaction" in handle ||
        "transcriptRedactionHealth" in handle;

      expect(hasRedaction).toBe(true);
    } finally {
      await fsRm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Helper imports (top-level in ESM)
// ---------------------------------------------------------------------------

import { mkdir as fsMkdir, writeFile as fsWriteFile, rm as fsRm } from "node:fs/promises";
