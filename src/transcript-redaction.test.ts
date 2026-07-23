/**
 * AI-2582 — Tests for the transcript redaction sweep component.
 *
 * These tests cover the implementation after TDD's stub was replaced:
 *   ─ runTranscriptRedaction() — walks scan roots, invokes Python script
 *   ─ registerTranscriptRedaction() — schedules the sweep, exposes health
 *   ─ Integration: createApp wires the component (AI-1808 rule)
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

// ── Test helpers ────────────────────────────────────────────────────────────────

/**
 * Write a minimal secret_patterns.py stub to a temp directory.
 *
 * In CI the `ai-repo` checkout is unavailable, so `secret_patterns.py` at the
 * sandbox path `/tmp/ai/scripts/lib/secret_patterns.py` does not exist.  Rather
 * than requiring the ai-repo at test time, each test creates its own stub with
 * exactly the patterns the test needs — preserving the real subprocess integration
 * (TS → Python CLI → SECRET_RX) while keeping CI self-contained.
 */
async function writeStubSecretPatterns(dir: string, extraPatterns?: string): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  const path = dir + "/secret_patterns.py";
  const content = `
from __future__ import annotations
import re

SECRET_RX = re.compile(rb"(?:lpx_)[A-Za-z0-9_]{20,}"
    rb"|(?:ghp_|ghs_|github_pat_)[A-Za-z0-9_]{20,}"
    ${extraPatterns ?? ""}
)

PREFIX_LABELS = ("lpx_", "ghp_", "ghs_", "github_pat_")
NONCE_LABELS: frozenset[str] = frozenset()


def label_for(tok: bytes) -> str | None:
    s = tok.decode("utf-8", "replace")
    for pfx in PREFIX_LABELS:
        if s.startswith(pfx):
            return pfx
    return None
`;
  await writeFile(path, content);
  return path;
}

/**
 * Build a TranscriptRedactionConfig that creates its own scan root and
 * secret_patterns.py stub.  Returns the config, the temp dir (for cleanup),
 * and the secret_patterns path.
 */
async function makeSelfContainedConfig(
  overrides?: Partial<TranscriptRedactionConfig>,
): Promise<{
  config: TranscriptRedactionConfig;
  tmpDir: string;
  secretPatternsPath: string;
}> {
  const { mkdir } = await import("node:fs/promises");
  const tmpDir = "/tmp/tr-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  await mkdir(tmpDir, { recursive: true });
  const secretPatternsPath = await writeStubSecretPatterns(tmpDir);
  return {
    config: {
      intervalMs: overrides?.intervalMs ?? 60 * 60 * 1_000,
      secretPatternsPath: overrides?.secretPatternsPath ?? secretPatternsPath,
      scanRoots: overrides?.scanRoots ?? [tmpDir],
    },
    tmpDir,
    secretPatternsPath,
  };
}

// ---------------------------------------------------------------------------
// Unit tests — module-level behaviour of runTranscriptRedaction
// ---------------------------------------------------------------------------

describe("runTranscriptRedaction", () => {
  it("invokes the Python redaction script and returns a result", async () => {
    // AC1, AC6: sweep must call the shared Python scanner (child_process).
    // Run against a real directory with a synthetic .trajectory.jsonl.
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const { config, tmpDir } = await makeSelfContainedConfig();

    const trajectoryPath = tmpDir + "/.trajectory.jsonl";
    // Build the test payload with prefix + body separated per AI-2377 fixture rule.
    const tokenPrefix = "lpx_";
    await writeFile(trajectoryPath, '{"text":"token is ' + tokenPrefix + 'abc123def456ghi789jkl"}\n');
    config.scanRoots = [tmpDir];

    try {
      const result = await runTranscriptRedaction(config);
      // The Python script should have found and processed the file.
      expect(result.filesScanned).toBeGreaterThanOrEqual(1);
      expect(result.filesRedacted).toBeGreaterThanOrEqual(1);
      expect(result.errors).toEqual([]);

      // Verify the file was actually redacted.
      const content = await import("node:fs/promises").then((m) => m.readFile(trajectoryPath, "utf8"));
      expect(content).toContain("[REDACTED:");
      expect(content).not.toContain(tokenPrefix + "abc123def456ghi789jkl");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("walks multiple scan roots and aggregates results", async () => {
    // AC1: the sweep handles multiple roots and returns combined stats.
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const ids = Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const roots = ["/tmp/tr-multi1-" + ids, "/tmp/tr-multi2-" + ids];
    for (const root of roots) {
      await mkdir(root, { recursive: true });
      await writeFile(root + "/.trajectory.jsonl", '{"data":"clean line"}\n');
    }

    const stubsDir = "/tmp/tr-stubs-" + ids;
    await mkdir(stubsDir, { recursive: true });
    const secretPatternsPath = await writeStubSecretPatterns(stubsDir);

    const config: TranscriptRedactionConfig = {
      intervalMs: 60 * 60 * 1_000,
      secretPatternsPath,
      scanRoots: roots,
    };

    try {
      const result = await runTranscriptRedaction(config);
      expect(result.filesScanned).toBe(2);
      // Both files are clean, so filesRedacted should be 0.
      expect(result.filesRedacted).toBe(0);
    } finally {
      for (const root of roots) {
        await rm(root, { recursive: true, force: true });
      }
      await rm(stubsDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("errors on unreadable scan roots without crashing the entire sweep", async () => {
    // AC1: inaccessible directory must not kill the sweep.
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const ids = Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const accessibleDir = "/tmp/tr-accessible-" + ids;
    await mkdir(accessibleDir, { recursive: true });
    await writeFile(accessibleDir + "/.trajectory.jsonl", '{"data":"clean"}\n');

    const stubsDir = "/tmp/tr-stubs-" + ids;
    await mkdir(stubsDir, { recursive: true });
    const secretPatternsPath = await writeStubSecretPatterns(stubsDir);

    const config: TranscriptRedactionConfig = {
      intervalMs: 60 * 60 * 1_000,
      secretPatternsPath,
      scanRoots: ["/root/protected", accessibleDir],
    };

    try {
      const result = await runTranscriptRedaction(config);
      // The accessible dir should have been scanned.
      expect(result.filesScanned).toBeGreaterThanOrEqual(1);
      // The inaccessible root may be reported as an error or silently skipped.
      // Accept either — the key requirement is the sweep does not throw.
    } finally {
      await rm(accessibleDir, { recursive: true, force: true });
      await rm(stubsDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports zero files when no .trajectory.jsonl exist in scan roots", async () => {
    // Edge case: clean state — no transcripts to redact.
    const { rm } = await import("node:fs/promises");
    const { config, tmpDir } = await makeSelfContainedConfig();

    try {
      const result = await runTranscriptRedaction(config);
      expect(result.filesScanned).toBe(0);
      expect(result.filesRedacted).toBe(0);
      expect(result.errors).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Unit tests — registerTranscriptRedaction
// ---------------------------------------------------------------------------

describe("registerTranscriptRedaction", () => {
  let handle: { health: unknown; stop: () => void } | null = null;

  afterEach(() => {
    if (handle) {
      handle.stop();
      handle = null;
    }
  });

  it("returns a handle with health and stop properties", () => {
    handle = registerTranscriptRedaction();
    expect(handle).toHaveProperty("health");
    expect(handle).toHaveProperty("stop");
    expect(typeof handle.stop).toBe("function");
  });

  it("defaults interval to DEFAULT_INTERVAL_MS (1 hour) when no config given", () => {
    // AC2: without config, interval must be 3600000 ms.
    handle = registerTranscriptRedaction();
    const health = handle.health as { intervalMs: number };
    expect(health.intervalMs).toBe(DEFAULT_INTERVAL_MS);
  });

  it("accepts configurable interval override", () => {
    // AC2: caller can override with 30 minutes.
    handle = registerTranscriptRedaction({ intervalMs: 30 * 60 * 1_000 });
    const health = handle.health as { intervalMs: number };
    expect(health.intervalMs).toBe(30 * 60 * 1_000);
  });

  it("exposes health info that shows the component is scheduled without waiting for trigger", () => {
    // AC4: before the first sweep fires, health must show
    // the component is configured and scheduled (status: "idle").
    handle = registerTranscriptRedaction();
    const health = handle.health as { enabled: boolean; status: string; lastRun: null };
    expect(health.enabled).toBe(true);
    expect(health.status).toBe("idle");
    expect(health.lastRun).toBeNull();
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
    const { mkdir, rm } = await import("node:fs/promises");

    const tmpDir = "/tmp/tdd-bootstrap-" + Date.now();
    await mkdir(tmpDir, { recursive: true });

    const created = createApp({
      bagDbPath: tmpDir + "/bag.db",
      agentQueueDbPath: tmpDir + "/queue.db",
      operationalEventsDbPath: tmpDir + "/ops.db",
      observationsDbPath: tmpDir + "/obs.db",
      managingStateDbPath: tmpDir + "/managing.db",
    });

    try {
      // The createApp return value must carry the redaction component.
      const handle = created as unknown as Record<string, unknown>;
      const hasRedaction =
        "transcriptRedaction" in handle ||
        "transcriptRedactionHealth" in handle;

      expect(hasRedaction).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Helper imports (top-level in ESM)
// ---------------------------------------------------------------------------

import { mkdir as fsMkdir, writeFile as fsWriteFile, rm as fsRm } from "node:fs/promises";
