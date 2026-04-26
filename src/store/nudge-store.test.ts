/**
 * Tests for NudgeStore — per-ticket 15-min suppression window.
 * Suppresses rapid-fire events on the same ticket, but different tickets always deliver.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NudgeStore } from "./nudge-store";

function makeTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nudge-test-"));
  const dbPath = path.join(dir, "nudges.db");
  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("NudgeStore", () => {
  it("is not suppressed when no nudge recorded", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    expect(store.isSuppressed("charles", "AI-100", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("is suppressed for same agent + same ticket after recordNudge", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    expect(store.isSuppressed("charles", "AI-100", 15 * 60 * 1000)).toBe(true);
    store.close();
    cleanup();
  });

  it("is NOT suppressed for same agent + different ticket", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    expect(store.isSuppressed("charles", "AI-200", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("is not suppressed after resetSuppression clears the record", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    store.resetSuppression("charles");
    expect(store.isSuppressed("charles", "AI-100", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("does not suppress a different agent", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    expect(store.isSuppressed("astrid", "AI-100", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("resets suppression after resetSuppression()", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    expect(store.isSuppressed("charles", "AI-100", 15 * 60 * 1000)).toBe(true);
    store.resetSuppression("charles");
    expect(store.isSuppressed("charles", "AI-100", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("increments nudge count on repeated recordNudge calls", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    store.recordNudge("charles", "AI-100");
    store.recordNudge("charles", "AI-100");
    // Just confirm it stays suppressed and doesn't throw
    expect(store.isSuppressed("charles", "AI-100", 15 * 60 * 1000)).toBe(true);
    store.close();
    cleanup();
  });

  // ── Coalescing tests ────────────────────────────────────────────────

  it("recordCoalesced increments coalesced count for suppressed events", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    store.recordCoalesced("charles", "AI-100", "Comment", "create");
    store.recordCoalesced("charles", "AI-100", "Issue", "update");
    store.recordCoalesced("charles", "AI-100");
    const info = store.getCoalesceInfo("charles", "AI-100", 15 * 60 * 1000);
    expect(info.suppressed).toBe(true);
    expect(info.coalescedCount).toBe(3);
    store.close();
    cleanup();
  });

  it("drainCoalescedCount returns count and resets to zero", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles", "AI-100");
    store.recordCoalesced("charles", "AI-100", "Comment", "create");
    store.recordCoalesced("charles", "AI-100");
    expect(store.drainCoalescedCount("charles", "AI-100")).toBe(2);
    expect(store.drainCoalescedCount("charles", "AI-100")).toBe(0);
    store.close();
    cleanup();
  });

  it("drainCoalescedCount returns 0 when no coalesced events", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    expect(store.drainCoalescedCount("charles", "AI-100")).toBe(0);
    store.close();
    cleanup();
  });

  it("getCoalesceInfo returns coalescedCount=0 when not suppressed", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    // Record a nudge, wait for window to "expire" by using windowMs=0
    store.recordNudge("charles", "AI-100");
    const info = store.getCoalesceInfo("charles", "AI-100", 0);
    expect(info.suppressed).toBe(false);
    expect(info.coalescedCount).toBe(0);
    store.close();
    cleanup();
  });
});
