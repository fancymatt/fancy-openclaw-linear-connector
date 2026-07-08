import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAlertBus, _resetAlertBusForTests, getAlertBus } from "./alerts/alert-bus.js";
import { knownHumansPath, loadKnownHumans, knownHumanName, resetKnownHumansCache } from "./known-humans.js";

// AI-1900: known-human Linear user IDs are instance config. Missing file →
// empty (pager behaves as before); malformed file → empty + warning alert
// (silently losing the exclusion would re-noise the channel).
describe("known-humans config loader", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "known-humans-test-"));
    resetKnownHumansCache();
    initAlertBus({ pushEnabled: false });
  });

  afterEach(() => {
    delete process.env.KNOWN_HUMANS_PATH;
    resetKnownHumansCache();
    _resetAlertBusForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(content: string): string {
    const file = path.join(dir, "known-humans.yaml");
    fs.writeFileSync(file, content);
    process.env.KNOWN_HUMANS_PATH = file;
    return file;
  }

  test("KNOWN_HUMANS_PATH overrides the default path", () => {
    process.env.KNOWN_HUMANS_PATH = "/tmp/somewhere/known-humans.yaml";
    expect(knownHumansPath()).toBe("/tmp/somewhere/known-humans.yaml");
  });

  test("missing file → empty map, no alert", () => {
    process.env.KNOWN_HUMANS_PATH = path.join(dir, "does-not-exist.yaml");
    expect(loadKnownHumans().size).toBe(0);
    expect(getAlertBus().getStore()!.query({}).filter((r) => r.source === "known-humans")).toHaveLength(0);
  });

  test("parses id+name mappings and bare id strings", () => {
    writeConfig(
      [
        "known_humans:",
        "  - id: 544710ca-0438-478e-b97f-3aaee89cbb69",
        "    name: Matt Henry",
        "  - 00000000-0000-0000-0000-000000000001",
      ].join("\n"),
    );
    const humans = loadKnownHumans();
    expect(humans.size).toBe(2);
    expect(knownHumanName("544710ca-0438-478e-b97f-3aaee89cbb69")).toBe("Matt Henry");
    expect(knownHumanName("00000000-0000-0000-0000-000000000001")).toBe("00000000-0000-0000-0000-000000000001");
    expect(knownHumanName("not-configured")).toBeNull();
  });

  test("empty known_humans list → empty map", () => {
    writeConfig("known_humans: []\n");
    expect(loadKnownHumans().size).toBe(0);
  });

  test("malformed file → empty map + warning alert (fail-open, loudly)", () => {
    writeConfig("known_humans:\n  - name: no id here\n");
    expect(loadKnownHumans().size).toBe(0);
    const alerts = getAlertBus().getStore()!.query({}).filter((r) => r.source === "known-humans");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  test("config edits are picked up via mtime without a restart", () => {
    const file = writeConfig("known_humans:\n  - id: aaa\n    name: A\n");
    expect(loadKnownHumans().has("aaa")).toBe(true);
    fs.writeFileSync(file, "known_humans:\n  - id: bbb\n    name: B\n");
    // Force a distinct mtime — some filesystems have coarse timestamps.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    const humans = loadKnownHumans();
    expect(humans.has("aaa")).toBe(false);
    expect(humans.has("bbb")).toBe(true);
  });
});
