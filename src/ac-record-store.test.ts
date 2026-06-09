/**
 * Unit tests for the verbatim AC record store (AI-1482 Phase 6.5 / H-7).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  captureAc,
  getAcRecord,
  hasAcRecord,
  removeAcRecord,
  clearAcRecordStore,
  extractAcFromDescription,
} from "./ac-record-store.js";

// Use a temp file for persistence tests so we don't pollute /tmp
let tmpDir: string;
let tmpFile: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `ac-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(tmpDir, { recursive: true });
  tmpFile = path.join(tmpDir, "ac-records.json");
  process.env.AC_RECORDS_PATH = tmpFile;
  clearAcRecordStore();
});

afterEach(async () => {
  clearAcRecordStore();
  delete process.env.AC_RECORDS_PATH;
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("ac-record-store", () => {
  describe("captureAc / getAcRecord", () => {
    it("stores and retrieves an AC record", async () => {
      await captureAc("AI-1482", {
        verbatimAc: "### AC\n- Foo works\n- Bar passes",
        capturedAt: "2026-06-09T20:00:00Z",
        capturedBy: "igor",
        source: "description",
      });

      const record = await getAcRecord("AI-1482");
      expect(record).not.toBeNull();
      expect(record!.verbatimAc).toBe("### AC\n- Foo works\n- Bar passes");
      expect(record!.capturedBy).toBe("igor");
      expect(record!.source).toBe("description");
    });

    it("returns null for unknown ticket", async () => {
      expect(await getAcRecord("NONEXISTENT")).toBeNull();
    });

    it("overwrites existing record on re-capture", async () => {
      await captureAc("AI-1482", {
        verbatimAc: "original AC",
        capturedAt: "2026-06-09T20:00:00Z",
        capturedBy: "igor",
        source: "description",
      });
      await captureAc("AI-1482", {
        verbatimAc: "updated AC",
        capturedAt: "2026-06-09T21:00:00Z",
        capturedBy: "charles",
        source: "description",
      });

      const record = await getAcRecord("AI-1482");
      expect(record!.verbatimAc).toBe("updated AC");
      expect(record!.capturedBy).toBe("charles");
    });
  });

  describe("hasAcRecord", () => {
    it("returns false when no record exists", async () => {
      expect(await hasAcRecord("AI-1482")).toBe(false);
    });

    it("returns true after capture", async () => {
      await captureAc("AI-1482", {
        verbatimAc: "AC text",
        capturedAt: "2026-06-09T20:00:00Z",
        capturedBy: "igor",
        source: "description",
      });
      expect(await hasAcRecord("AI-1482")).toBe(true);
    });
  });

  describe("removeAcRecord", () => {
    it("removes an existing record", async () => {
      await captureAc("AI-1482", {
        verbatimAc: "AC text",
        capturedAt: "2026-06-09T20:00:00Z",
        capturedBy: "igor",
        source: "description",
      });
      expect(await removeAcRecord("AI-1482")).toBe(true);
      expect(await getAcRecord("AI-1482")).toBeNull();
    });

    it("returns false when no record exists", async () => {
      expect(await removeAcRecord("NONEXISTENT")).toBe(false);
    });
  });

  describe("persistence", () => {
    it("persists records to disk and reloads them", async () => {
      await captureAc("AI-1482", {
        verbatimAc: "persisted AC",
        capturedAt: "2026-06-09T20:00:00Z",
        capturedBy: "igor",
        source: "description",
      });

      // Verify file exists
      const raw = await fs.readFile(tmpFile, "utf8");
      const data = JSON.parse(raw);
      expect(data["AI-1482"]).toBeDefined();
      expect(data["AI-1482"].verbatimAc).toBe("persisted AC");

      // Clear in-memory store and reload
      clearAcRecordStore();
      const record = await getAcRecord("AI-1482");
      expect(record).not.toBeNull();
      expect(record!.verbatimAc).toBe("persisted AC");
    });

    it("starts with empty store when no file exists", async () => {
      // Use a path that doesn't exist
      process.env.AC_RECORDS_PATH = path.join(tmpDir, "nonexistent.json");
      clearAcRecordStore();
      expect(await getAcRecord("AI-1482")).toBeNull();
    });

    it("removes record from disk on removeAcRecord", async () => {
      await captureAc("AI-1482", {
        verbatimAc: "to be removed",
        capturedAt: "2026-06-09T20:00:00Z",
        capturedBy: "igor",
        source: "description",
      });
      await removeAcRecord("AI-1482");

      // Verify file no longer contains the record
      const raw = await fs.readFile(tmpFile, "utf8");
      const data = JSON.parse(raw);
      expect(data["AI-1482"]).toBeUndefined();
    });
  });

  describe("extractAcFromDescription", () => {
    it("extracts AC from ### Acceptance Criteria header", () => {
      const desc = "Some intro text\n\n### Acceptance Criteria\n- Foo works\n- Bar passes\n\n### Notes\nSome notes";
      expect(extractAcFromDescription(desc)).toBe("- Foo works\n- Bar passes");
    });

    it("extracts AC from ### Acceptance header", () => {
      const desc = "## Task\n\n### Acceptance\n- [ ] AC 1\n- [ ] AC 2\n\n## Other";
      expect(extractAcFromDescription(desc)).toBe("- [ ] AC 1\n- [ ] AC 2");
    });

    it("extracts AC from ### AC header", () => {
      const desc = "## Task\n\n### AC\n1. Thing one\n2. Thing two\n\n## Later";
      expect(extractAcFromDescription(desc)).toBe("1. Thing one\n2. Thing two");
    });

    it("extracts AC from ## Acceptance header", () => {
      const desc = "## Acceptance\n- Test passes\n\n## Notes\nblah";
      expect(extractAcFromDescription(desc)).toBe("- Test passes");
    });

    it("returns null when no AC header found (not the full description)", () => {
      const desc = "Just some text without any AC header";
      expect(extractAcFromDescription(desc)).toBeNull();
    });

    it("returns null for empty description", () => {
      expect(extractAcFromDescription("")).toBeNull();
    });

    it("extracts AC to end of string when no following heading", () => {
      const desc = "## Task\n\n### AC\n- Last item in the doc";
      expect(extractAcFromDescription(desc)).toBe("- Last item in the doc");
    });

    it("is case-insensitive for AC header", () => {
      const desc = "### acceptance criteria\n- Lowercase AC";
      expect(extractAcFromDescription(desc)).toBe("- Lowercase AC");
    });
  });
});
