/**
 * Unit tests for the verbatim AC record store (AI-1482 Phase 6.5 / H-7).
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

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

  describe("default path durability", () => {
    it("does not default to /tmp (AI-1818 AC1)", async () => {
      // Verify that when no AC_RECORDS_PATH is set, the resolved path is durable
      // (not /tmp). We test by clearing the env var, forcing a reload, and checking
      // that persist writes to a non-/tmp location.
      const original = process.env.AC_RECORDS_PATH;
      delete process.env.AC_RECORDS_PATH;
      clearAcRecordStore();

      await captureAc("AI-TEST-DURABLE", {
        verbatimAc: "durable test",
        capturedAt: "2026-07-05T00:00:00Z",
        capturedBy: "test",
        source: "description",
      });

      // The file should exist at data/ac-records.json relative to the repo root
      const { existsSync } = await import("node:fs");
      const defaultPath = "data/ac-records.json";
      expect(existsSync(defaultPath)).toBe(true);

      // Clean up test record from the default path
      try {
        await fs.unlink(defaultPath);
      } catch {
        // ignore
      }

      // Restore env
      if (original !== undefined) process.env.AC_RECORDS_PATH = original;
      clearAcRecordStore();
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

    // ── AI-1776 AC1: Tolerant extraction — decorated headers ──────────────

    it("extracts AC from '## Acceptance criteria (draft — final at intake)' (AI-1776 AC1)", () => {
      const desc = "## Problem\nSome text.\n\n## Acceptance criteria (draft — final at intake)\n* AC1: Foo works\n* AC2: Bar passes\n\n## Pointers\nNotes.";
      expect(extractAcFromDescription(desc)).toBe("* AC1: Foo works\n* AC2: Bar passes");
    });

    it("extracts AC from '## Acceptance Criteria (v2)' (AI-1776 AC1)", () => {
      const desc = "## Acceptance Criteria (v2)\n* AC1: Thing\n\n## Notes\nBlah";
      expect(extractAcFromDescription(desc)).toBe("* AC1: Thing");
    });

    it("extracts AC from '### AC — final' decorated header (AI-1776 AC1)", () => {
      const desc = "## Background\nContext.\n\n### AC — final\n1. Pass this\n2. Pass that\n\n## Notes";
      expect(extractAcFromDescription(desc)).toBe("1. Pass this\n2. Pass that");
    });

    it("case-insensitive match with trailing decoration (AI-1776 AC1)", () => {
      const desc = "## acceptance criteria (final)\n- Works\n\n## Notes\nDone.";
      expect(extractAcFromDescription(desc)).toBe("- Works");
    });

    it("bare headers still extract correctly after tolerant-matching change (AI-1776 AC1 non-regression)", () => {
      const desc = "### Acceptance Criteria\n- Still works\n\n### Notes\nOk";
      expect(extractAcFromDescription(desc)).toBe("- Still works");
    });

    it("returns null when description has no AC header variant (AI-1776 AC1 non-regression)", () => {
      const desc = "## Problem\nBlah.\n\n## Notes\nNo AC section at all.";
      expect(extractAcFromDescription(desc)).toBeNull();
    });
  });
});
