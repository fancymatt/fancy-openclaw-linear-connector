/**
 * AI-1914 AC3 (revision) — def-state-removal validation wired into the actual
 * registry-load path.
 *
 * The original AC3 landing shipped `validateDefStateRemovals` fully unit-tested
 * but with zero production call sites: editing a def to remove a state and
 * reloading activated it silently. ac-validate failed the ticket on exactly
 * that gap (the AI-1775/AI-1773 "module tested green, never called" shape).
 *
 * These tests prove the refusal THROUGH `loadWorkflowRegistry` — not the pure
 * function — and prove the previous-version state set is sourced from a durable
 * on-disk snapshot, so detection survives a connector restart (no in-memory
 * cache). The registry cache is reset between loads to simulate that restart.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWorkflowRegistry, resetWorkflowCache } from "./workflow-gate.js";
import { isHealthy, resetConfigHealth } from "./config-health.js";
import { defStateSnapshotPath } from "./store/def-state-snapshot-store.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

/** v(N): a valid dev-impl def with a `deploy` state present. */
const DEF_V_N = `id: dev-impl
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: thinking
  - id: implementation
    owner_role: dev
    native_state: doing
  - id: deploy
    owner_role: mechanic
    native_state: doing
  - id: done
    native_state: done
  - id: escape
    native_state: invalid
`;

/** v(N+1): removes `deploy` with NO migrations mapping and NO strand_acknowledged. */
const DEF_V_N1_UNSAFE = `id: dev-impl
version: 2
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: thinking
  - id: implementation
    owner_role: dev
    native_state: doing
  - id: done
    native_state: done
  - id: escape
    native_state: invalid
`;

/** v(N+1): removes `deploy` but declares a migrations mapping → safe to activate. */
const DEF_V_N1_MIGRATED = `id: dev-impl
version: 2
entry_state: intake
migrations:
  deploy: done
states:
  - id: intake
    owner_role: steward
    native_state: thinking
  - id: implementation
    owner_role: dev
    native_state: doing
  - id: done
    native_state: done
  - id: escape
    native_state: invalid
`;

/** v(N+1): removes `deploy` but explicitly acknowledges the strand → safe to activate. */
const DEF_V_N1_ACKED = `id: dev-impl
version: 2
entry_state: intake
strand_acknowledged:
  - deploy
states:
  - id: intake
    owner_role: steward
    native_state: thinking
  - id: implementation
    owner_role: dev
    native_state: doing
  - id: done
    native_state: done
  - id: escape
    native_state: invalid
`;

// ── Env harness ─────────────────────────────────────────────────────────────

let tmpDir: string;
let defsDir: string;
let snapshotPath: string;
const saved: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const k of keys) saved[k] = process.env[k];
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function writeDef(yamlText: string): void {
  fs.writeFileSync(path.join(defsDir, "dev-impl.yaml"), yamlText);
}

beforeEach(() => {
  saveEnv("WORKFLOW_DEFS_DIR", "WORKFLOW_DEF_PATH", "WORKFLOW_DEF_STATE_SNAPSHOT_PATH", "DATA_DIR");
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1914-ac3-"));
  defsDir = path.join(tmpDir, "defs");
  fs.mkdirSync(defsDir, { recursive: true });
  snapshotPath = path.join(tmpDir, "snapshot.json");
  process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = snapshotPath;
  process.env.WORKFLOW_DEFS_DIR = defsDir;
  resetWorkflowCache();
  resetConfigHealth();
});

afterEach(() => {
  restoreEnv();
  resetWorkflowCache();
  resetConfigHealth();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("AI-1914 AC3 — def-state-removal validation through loadWorkflowRegistry", () => {
  test("first load of v(N) activates and writes a durable state snapshot", async () => {
    writeDef(DEF_V_N);
    const registry = await loadWorkflowRegistry();

    expect(registry.has("dev-impl")).toBe(true);
    expect(isHealthy()).toBe(true);

    // The snapshot is persisted to disk (the restart-durable previous-version source).
    expect(defStateSnapshotPath()).toBe(snapshotPath);
    expect(fs.existsSync(snapshotPath)).toBe(true);
    const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    expect(snap["dev-impl"]).toEqual(["intake", "implementation", "deploy", "done", "escape"]);
  });

  test("v(N+1) removing a state with no map/ack is REFUSED on reload — def excluded, config-health unhealthy", async () => {
    // Activate v(N) → snapshot records `deploy`.
    writeDef(DEF_V_N);
    await loadWorkflowRegistry();
    expect((await loadWorkflowRegistry()).has("dev-impl")).toBe(true);

    // Simulate a restart: drop the in-memory registry cache. The only surviving
    // record of the previous version is the on-disk snapshot.
    resetWorkflowCache();
    resetConfigHealth();

    // Reload with the unsafe v(N+1).
    writeDef(DEF_V_N1_UNSAFE);
    const registry = await loadWorkflowRegistry();

    // "Does not activate": the def is excluded from the registry (dir mode) and
    // config-health goes unhealthy — the loud, observable refusal, not a strand.
    expect(registry.has("dev-impl")).toBe(false);
    expect(isHealthy()).toBe(false);
  });

  test("v(N+1) with a migrations mapping activates (sanctioned migration path)", async () => {
    writeDef(DEF_V_N);
    await loadWorkflowRegistry();

    resetWorkflowCache();
    resetConfigHealth();

    writeDef(DEF_V_N1_MIGRATED);
    const registry = await loadWorkflowRegistry();

    expect(registry.has("dev-impl")).toBe(true);
    expect(isHealthy()).toBe(true);
    // Snapshot advances to the new state set (deploy dropped).
    const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    expect(snap["dev-impl"]).not.toContain("deploy");
  });

  test("v(N+1) with an explicit strand_acknowledged entry activates", async () => {
    writeDef(DEF_V_N);
    await loadWorkflowRegistry();

    resetWorkflowCache();
    resetConfigHealth();

    writeDef(DEF_V_N1_ACKED);
    const registry = await loadWorkflowRegistry();

    expect(registry.has("dev-impl")).toBe(true);
    expect(isHealthy()).toBe(true);
  });

  test("a REFUSED def keeps its prior snapshot entry — it stays refused across repeated reloads", async () => {
    writeDef(DEF_V_N);
    await loadWorkflowRegistry();

    // First unsafe reload → refused.
    resetWorkflowCache();
    writeDef(DEF_V_N1_UNSAFE);
    expect((await loadWorkflowRegistry()).has("dev-impl")).toBe(false);

    // The rejected state set must NOT have overwritten the baseline snapshot;
    // `deploy` is still recorded as the previous version, so a second reload of
    // the same unsafe def is refused again (not silently "accepted" the 2nd time).
    const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    expect(snap["dev-impl"]).toContain("deploy");

    resetWorkflowCache();
    expect((await loadWorkflowRegistry()).has("dev-impl")).toBe(false);
  });

  test("single-file mode rethrows a clear error naming the removed state (fail-closed)", async () => {
    // Switch to single-file mode.
    delete process.env.WORKFLOW_DEFS_DIR;
    const defFile = path.join(tmpDir, "primary.yaml");
    process.env.WORKFLOW_DEF_PATH = defFile;

    // Activate v(N) → snapshot records `deploy`.
    fs.writeFileSync(defFile, DEF_V_N);
    await loadWorkflowRegistry();

    resetWorkflowCache();
    resetConfigHealth();

    // Reload unsafe v(N+1): single-file mode must reject the whole load.
    fs.writeFileSync(defFile, DEF_V_N1_UNSAFE);
    await expect(loadWorkflowRegistry()).rejects.toThrow(/removes state 'deploy'/);
    expect(isHealthy()).toBe(false);
  });
});
