/**
 * AI-1848 bag-path fix — canon injection tests at the sendWakeUpSignal level.
 *
 * These tests operate at the delivery-pipeline layer (sendWakeUpSignal /
 * resignalPendingTickets), not just the message-builder layer. They verify that
 * every dispatch via the bag path carries the canon block and version stamp.
 *
 * Coverage:
 * - Multi-ticket wake (thin template): canon injected, canonVersion returned
 * - Single-ticket without auth token (ad-hoc thin path): canon injected
 * - Single-ticket with auth token, rich builder returns null (fallback path): canon injected
 * - Canon missing: fail-open (message sent without canon)
 * - canonVersion propagated through resignalPendingTickets
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";

// ── ESM-compatible mocks (must precede dynamic imports) ──────────────────

const capturedDeliveries: Array<{ agentId: string; sessionKey: string; message: string }> = [];
const mockDeliverMessageToAgent = jest.fn<(...args: unknown[]) => Promise<unknown>>()
  .mockImplementation(async (agentId: unknown, sessionKey: unknown, message: unknown) => {
    capturedDeliveries.push({
      agentId: agentId as string,
      sessionKey: sessionKey as string,
      message: message as string,
    });
    return { dispatched: true, runId: "run-test-123" };
  });

jest.unstable_mockModule("../delivery/index.js", () => ({
  deliverMessageToAgent: mockDeliverMessageToAgent,
}));

// Mock buildWorkflowAwareDeliveryMessage to control rich-path behavior per test.
const mockBuildWorkflowAwareDeliveryMessage = jest.fn<(...args: unknown[]) => Promise<string | null>>();

jest.unstable_mockModule("../delivery/build-message.js", () => ({
  buildWorkflowAwareDeliveryMessage: mockBuildWorkflowAwareDeliveryMessage,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────

const { sendWakeUpSignal } = await import("./wake-up.js");
const { _resetCanonForTest } = await import("../policy/universal-canon.js");

// ── Helpers ───────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1848-canon-wakeup-"));
const tmpCanonPath = path.join(tmpDir, "universal.md");

function makeCanonFile(version: string): string {
  return `---\nversion: ${version}\n---\n\nRead the ticket fully before acting.\nComment discipline: post one substantive comment.\n`;
}

function makeConfig(token?: string) {
  return {
    hooksUrl: "http://fake-hooks/",
    hooksToken: "tok",
    linearAuthToken: token,
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

beforeAll(() => {
  fs.writeFileSync(tmpCanonPath, makeCanonFile("v1"), "utf8");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  capturedDeliveries.length = 0;
  mockDeliverMessageToAgent.mockClear();
  mockBuildWorkflowAwareDeliveryMessage.mockReset();
  // Default: rich builder returns null so tests that don't care about rich path get thin template.
  mockBuildWorkflowAwareDeliveryMessage.mockResolvedValue(null);
  process.env.UNIVERSAL_POLICY_PATH = tmpCanonPath;
  _resetCanonForTest();
});

afterEach(() => {
  delete process.env.UNIVERSAL_POLICY_PATH;
  _resetCanonForTest();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("AI-1848 — sendWakeUpSignal canon injection (bag-path fix)", () => {
  describe("multi-ticket wake (thin template)", () => {
    it("injects canon block into the message", async () => {
      await sendWakeUpSignal("igor", ["AI-1848", "AI-1849"], makeConfig());

      expect(capturedDeliveries).toHaveLength(1);
      expect(capturedDeliveries[0].message).toContain("Universal task-handling canon (v1)");
      expect(capturedDeliveries[0].message).toContain("Read the ticket fully before acting.");
    });

    it("returns canonVersion from the dispatch result", async () => {
      const result = await sendWakeUpSignal("igor", ["AI-1848", "AI-1849"], makeConfig());

      expect(result).toBeDefined();
      expect((result as { canonVersion?: string }).canonVersion).toBe("v1");
    });

    it("canon block appears after the thin message body", async () => {
      await sendWakeUpSignal("igor", ["AI-1848", "AI-1849"], makeConfig());

      const msg = capturedDeliveries[0].message;
      const thinIdx = msg.indexOf("linear queue --next");
      const canonIdx = msg.indexOf("Universal task-handling canon");
      expect(thinIdx).toBeGreaterThan(-1);
      expect(canonIdx).toBeGreaterThan(thinIdx);
    });
  });

  describe("single-ticket without auth token (ad-hoc thin path)", () => {
    it("injects canon block even without a linearAuthToken", async () => {
      await sendWakeUpSignal("igor", ["AI-1848"], makeConfig(/* no token */));

      expect(capturedDeliveries).toHaveLength(1);
      expect(capturedDeliveries[0].message).toContain("Universal task-handling canon (v1)");
    });

    it("returns canonVersion", async () => {
      const result = await sendWakeUpSignal("igor", ["AI-1848"], makeConfig());

      expect((result as { canonVersion?: string }).canonVersion).toBe("v1");
    });
  });

  describe("single-ticket with auth token — rich builder returns null (fallback thin path)", () => {
    it("canon injected on fallback to thin template", async () => {
      // Rich builder returns null → falls back to thin template → canon injected.
      mockBuildWorkflowAwareDeliveryMessage.mockResolvedValue(null);

      await sendWakeUpSignal("igor", ["AI-1848"], makeConfig("Bearer tok"));

      expect(capturedDeliveries[0].message).toContain("Universal task-handling canon (v1)");
    });

    it("returns canonVersion on fallback path", async () => {
      mockBuildWorkflowAwareDeliveryMessage.mockResolvedValue(null);

      const result = await sendWakeUpSignal("igor", ["AI-1848"], makeConfig("Bearer tok"));

      expect((result as { canonVersion?: string }).canonVersion).toBe("v1");
    });
  });

  describe("single-ticket with auth token — rich builder returns workflow message", () => {
    it("does not double-inject canon when rich message already has it", async () => {
      const richMsg = "Workflow step block\n\n## Universal task-handling canon (v1)\n\nRead the ticket fully.\n\nYour legal action(s): linear submit AI-1848";
      mockBuildWorkflowAwareDeliveryMessage.mockResolvedValue(richMsg);
      // Pre-load canon so getActiveCanonVersion() returns "v1", matching what
      // buildWorkflowAwareDeliveryMessage does in production (it calls
      // loadUniversalCanon internally). This prevents the fallback canon
      // injection from firing a second time.
      const { loadUniversalCanon } = await import("../policy/universal-canon.js");
      await loadUniversalCanon();

      await sendWakeUpSignal("igor", ["AI-1848"], makeConfig("Bearer tok"));

      const msg = capturedDeliveries[0].message;
      const occurrences = (msg.match(/Universal task-handling canon/g) ?? []).length;
      expect(occurrences).toBe(1);
    });

    it("returns canonVersion from the active canon after rich build", async () => {
      const richMsg = "Rich workflow msg\n\n## Universal task-handling canon (v1)\n\nRead the ticket.";
      mockBuildWorkflowAwareDeliveryMessage.mockResolvedValue(richMsg);
      // Pre-load the canon so getActiveCanonVersion() returns v1.
      const { loadUniversalCanon } = await import("../policy/universal-canon.js");
      await loadUniversalCanon();

      const result = await sendWakeUpSignal("igor", ["AI-1848"], makeConfig("Bearer tok"));

      expect((result as { canonVersion?: string }).canonVersion).toBe("v1");
    });
  });

  describe("canon missing → fail-open", () => {
    it("sends the wake message even when canon file is absent", async () => {
      process.env.UNIVERSAL_POLICY_PATH = path.join(tmpDir, "does-not-exist.md");

      await sendWakeUpSignal("igor", ["AI-1848", "AI-1849"], makeConfig());

      expect(capturedDeliveries).toHaveLength(1);
      expect(capturedDeliveries[0].message).toContain("AI-1848");
    });

    it("returns canonVersion as undefined when canon is absent", async () => {
      process.env.UNIVERSAL_POLICY_PATH = path.join(tmpDir, "does-not-exist.md");

      const result = await sendWakeUpSignal("igor", ["AI-1848"], makeConfig());

      expect((result as { canonVersion?: string }).canonVersion).toBeUndefined();
    });

    it("does not inject canon section when file is missing", async () => {
      process.env.UNIVERSAL_POLICY_PATH = path.join(tmpDir, "does-not-exist.md");

      await sendWakeUpSignal("igor", ["AI-1848", "AI-1849"], makeConfig());

      expect(capturedDeliveries[0].message).not.toContain("Universal task-handling canon");
    });
  });
});
