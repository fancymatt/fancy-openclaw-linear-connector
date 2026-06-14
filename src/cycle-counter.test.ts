import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  incrementCycle,
  getCycleCount,
  getCycleRecord,
  removeCycleRecord,
  clearCycleCounterStore,
} from "./cycle-counter.js";

function tmpStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cycle-counter-test-"));
  return path.join(dir, "cycle-counter.json");
}

describe("cycle-counter", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = tmpStorePath();
    process.env.CYCLE_COUNTER_PATH = storePath;
    clearCycleCounterStore();
  });

  afterEach(() => {
    delete process.env.CYCLE_COUNTER_PATH;
    clearCycleCounterStore();
    fs.rmSync(path.dirname(storePath), { recursive: true, force: true });
  });

  it("starts at cycle 1 on first increment", async () => {
    const count = await incrementCycle("AI-1483", "sprint");
    expect(count).toBe(1);
  });

  it("increments on subsequent calls for the same ticket", async () => {
    await incrementCycle("AI-1483", "sprint");
    const count = await incrementCycle("AI-1483", "sprint");
    expect(count).toBe(2);

    const count2 = await incrementCycle("AI-1483", "sprint");
    expect(count2).toBe(3);
  });

  it("tracks separate counters per ticket", async () => {
    await incrementCycle("AI-100", "sprint");
    await incrementCycle("AI-100", "sprint");

    const count100 = await getCycleCount("AI-100");
    expect(count100).toBe(2);

    const count200 = await getCycleCount("AI-200");
    expect(count200).toBe(0);
  });

  it("returns 0 for unknown tickets", async () => {
    const count = await getCycleCount("AI-9999");
    expect(count).toBe(0);
  });

  it("returns null record for unknown tickets", async () => {
    const record = await getCycleRecord("AI-9999");
    expect(record).toBeNull();
  });

  it("returns full record with timestamps", async () => {
    await incrementCycle("AI-1483", "sprint");
    const record = await getCycleRecord("AI-1483");

    expect(record).not.toBeNull();
    expect(record!.cycles).toBe(1);
    expect(record!.workflowId).toBe("sprint");
    expect(record!.firstCycleAt).toBeTruthy();
    expect(record!.lastCycleAt).toBeTruthy();
  });

  it("updates lastCycleAt but not firstCycleAt on increment", async () => {
    await incrementCycle("AI-1483", "sprint");
    const r1 = await getCycleRecord("AI-1483");
    const firstAt = r1!.firstCycleAt;

    // Small delay to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 10));

    await incrementCycle("AI-1483", "sprint");
    const r2 = await getCycleRecord("AI-1483");

    expect(r2!.cycles).toBe(2);
    expect(r2!.firstCycleAt).toBe(firstAt);
    expect(r2!.lastCycleAt).not.toBe(firstAt);
  });

  it("removes a cycle record", async () => {
    await incrementCycle("AI-1483", "sprint");
    const removed = await removeCycleRecord("AI-1483");
    expect(removed).toBe(true);

    const count = await getCycleCount("AI-1483");
    expect(count).toBe(0);
  });

  it("returns false when removing non-existent record", async () => {
    const removed = await removeCycleRecord("AI-9999");
    expect(removed).toBe(false);
  });

  it("persists records to disk", async () => {
    await incrementCycle("AI-1483", "sprint");

    // Simulate restart by clearing in-memory state
    clearCycleCounterStore();

    // Should reload from disk
    const count = await getCycleCount("AI-1483");
    expect(count).toBe(1);
  });

  it("§14b AC: a sprint that re-spawns fixes increments the cycle counter", async () => {
    // Simulate a sprint going through validating → spawning multiple times
    const c1 = await incrementCycle("AI-SPRINT-1", "sprint");
    expect(c1).toBe(1);

    const c2 = await incrementCycle("AI-SPRINT-1", "sprint");
    expect(c2).toBe(2);

    const c3 = await incrementCycle("AI-SPRINT-1", "sprint");
    expect(c3).toBe(3);

    // High cycle count is observable
    const record = await getCycleRecord("AI-SPRINT-1");
    expect(record!.cycles).toBe(3);
  });
});
