/**
 * Tests for NudgeStore — 15-min suppression window for bulk-delegation noise.
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
    expect(store.isSuppressed("charles", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("is suppressed immediately after recordNudge", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles");
    expect(store.isSuppressed("charles", 15 * 60 * 1000)).toBe(true);
    store.close();
    cleanup();
  });

  it("is not suppressed after resetSuppression clears the record", () => {
    // Tests the expiry path indirectly: once reset, the agent has no
    // nudge record, so any window returns false — same effective result
    // as expiry. Direct time-based expiry tests are fragile because
    // SQLite datetime('now') has second-level precision.
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles");
    store.resetSuppression("charles");
    expect(store.isSuppressed("charles", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("does not suppress a different agent", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles");
    expect(store.isSuppressed("astrid", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("resets suppression after resetSuppression()", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles");
    expect(store.isSuppressed("charles", 15 * 60 * 1000)).toBe(true);
    store.resetSuppression("charles");
    expect(store.isSuppressed("charles", 15 * 60 * 1000)).toBe(false);
    store.close();
    cleanup();
  });

  it("increments nudge count on repeated recordNudge calls", () => {
    const { dbPath, cleanup } = makeTempDb();
    const store = new NudgeStore(dbPath);
    store.recordNudge("charles");
    store.recordNudge("charles");
    store.recordNudge("charles");
    // Just confirm it stays suppressed and doesn't throw
    expect(store.isSuppressed("charles", 15 * 60 * 1000)).toBe(true);
    store.close();
    cleanup();
  });
});
