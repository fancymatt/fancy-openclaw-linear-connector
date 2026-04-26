import fs from "fs";
import path from "path";
import os from "os";
import { EventStore } from "./event-store.js";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-store-test-"));
  return path.join(dir, "test-events.db");
}

describe("EventStore", () => {
  let dbPath: string;
  let store: EventStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("reports a new event as not duplicate", () => {
    expect(store.isDuplicate("evt-1")).toBe(false);
  });

  it("reports the same event ID as duplicate after recording", () => {
    store.recordEvent("evt-1", { type: "Issue", action: "create" });
    expect(store.isDuplicate("evt-1")).toBe(true);
  });

  it("does not treat different event IDs as duplicates", () => {
    store.recordEvent("evt-1", { type: "Issue", action: "create" });
    expect(store.isDuplicate("evt-2")).toBe(false);
  });

  it("persists events across store instances (restart safety)", () => {
    store.recordEvent("evt-restart", { type: "Issue", action: "update" });
    store.close();

    // Simulate restart — new instance, same DB file
    const store2 = new EventStore(dbPath);
    expect(store2.isDuplicate("evt-restart")).toBe(true);
    store2.close();

    // Reassign so afterEach cleanup doesn't double-close
    store = new EventStore(dbPath);
  });

  it("stores and retrieves processing metadata", () => {
    const payload = { type: "Comment", action: "create", data: { id: "c1" } };
    store.recordEvent("evt-meta", payload);

    const retrieved = store.getEvent("evt-meta");
    expect(retrieved).toBeDefined();
    expect(retrieved!.eventId).toBe("evt-meta");
    expect(retrieved!.payload).toEqual(payload);
    expect(retrieved!.status).toBe("processed");
    expect(retrieved!.createdAt).toBeDefined();
  });

  it("returns undefined for non-existent event metadata", () => {
    expect(store.getEvent("nope")).toBeUndefined();
  });

  it("silently ignores duplicate inserts", () => {
    store.recordEvent("evt-dup", { first: true });
    store.recordEvent("evt-dup", { second: true });

    const retrieved = store.getEvent("evt-dup");
    // First write wins
    expect((retrieved!.payload as Record<string, unknown>).first).toBe(true);
  });
});
