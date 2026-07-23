/**
 * INF-201 — Barrier-state transitions must not be surfaced as steward CLI verbs.
 *
 * Barrier states (e.g. sprint-spawner `scoping`/`managing`) auto-advance via
 * engine native-state detection when their child barrier is satisfied. Their
 * forward transitions are intentionally untagged (AI-2519) and have no CLI
 * subcommand. The dispatch message must render them as informational
 * auto-advance lines, never as `linear <verb>` commands.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetWorkflowCache } from "../workflow-gate.js";
import { resetPolicyCache } from "../escalation-gate.js";
import { _resetAppliedStateStore } from "../store/applied-state-store.js";

const TEST_WORKFLOW_YAML = `
id: sprint-spawner
version: 4
archetype: continuous-loop
entry_state: evaluating

break_glass:
  command: escape
  to: evaluating

states:
  - id: scoping
    owner_role: steward
    kind: normal
    native_state: managing
    barrier: true
    transitions:
      - command: launch
        to: launching

  - id: launching
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: managing
        generic: continue

  - id: managing
    owner_role: steward
    kind: normal
    native_state: managing
    barrier: true
    transitions:
      - command: release
        to: releasing

  - id: releasing
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: loop
        to: evaluating
        generic: continue
`;

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition

containers:
  - id: steward
    grants: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

function makeRoute(identifier: string, title: string): import("../types.js").RouteResult {
  return {
    agentId: "astrid",
    sessionKey: `linear-${identifier}`,
    priority: 0,
    routingReason: "delegate",
    event: {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "Ai", type: "user" },
      data: { identifier, title },
    } as unknown as import("../types.js").RouteResult["event"],
  };
}

function makeLabelFetch(labels: string[]): typeof globalThis.fetch {
  return async (_url, _init) =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            labels: { nodes: labels.map((name) => ({ name })) },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

let tmpDir: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barrier-msg-test-"));
  fs.writeFileSync(path.join(tmpDir, "sprint-spawner.yaml"), TEST_WORKFLOW_YAML, "utf8");
  fs.mkdirSync(path.join(tmpDir, "guidance", "sprint-spawner"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "capability-policy.yaml"), TEST_POLICY_YAML, "utf8");
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  _resetAppliedStateStore();
  process.env.WORKFLOW_DEF_PATH = path.join(tmpDir, "sprint-spawner.yaml");
  process.env.WORKFLOW_GUIDANCE_DIR = path.join(tmpDir, "guidance");
  process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "capability-policy.yaml");
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.WORKFLOW_GUIDANCE_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  resetWorkflowCache();
  resetPolicyCache();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("INF-201 — barrier transitions not surfaced as steward verbs", () => {
  it("scoping (barrier) renders launch as auto-advance info, not a CLI command", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-spawner", "state:scoping"]);
    const { buildDeliveryMessage } = await import("./build-message.js");
    const msg = await buildDeliveryMessage(makeRoute("INF-196", "Spawner"), "Bearer tok");

    expect(msg).toContain("state: **scoping**");
    expect(msg).toContain("advances automatically");
    expect(msg).toContain("→ launching");
    // The phantom verb must never appear as a runnable command.
    expect(msg).not.toContain("linear launch INF-196");
  });

  it("managing (barrier) renders release as auto-advance info, not a CLI command", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-spawner", "state:managing"]);
    const { buildDeliveryMessage } = await import("./build-message.js");
    const msg = await buildDeliveryMessage(makeRoute("INF-196", "Spawner"), "Bearer tok");

    expect(msg).toContain("advances automatically");
    expect(msg).not.toContain("linear release INF-196");
  });

  it("non-barrier steward states still render real commands (no regression)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-spawner", "state:launching"]);
    const { buildDeliveryMessage } = await import("./build-message.js");
    const msg = await buildDeliveryMessage(makeRoute("INF-196", "Spawner"), "Bearer tok");

    // launching is NOT a barrier state; its generic:continue transition
    // resolves to the real continue-workflow verb.
    expect(msg).toContain("linear continue-workflow INF-196");
    expect(msg).not.toContain("advances automatically");
  });
});
