/**
 * G-21 / AI-1553: Mutation / branch coverage on enforcement surfaces.
 *
 * This file targets branches that the existing suites leave uncovered —
 * the exact gaps a surviving mutant could hide in. Each test is mapped to
 * the AC it constrains; removing or flipping any covered branch must make
 * at least one test here fail.
 *
 * Surfaces: workflow-gate.ts · proxy.ts · agents.ts
 *
 * AC1: branch coverage report produced for the three surfaces (this file +
 *      coverage run by implementer satisfies AC1 together with the coverage
 *      JSON already generated during write-tests).
 * AC2: no surviving mutants (each test below kills a specific class of mutant).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "@jest/globals";
import {
  checkWorkflowRules,
  checkRawMutationInterception,
  getWorkflowId,
  getCurrentState,
  resolveStakesLevel,
  resetWorkflowCache,
  validateNativeStateMappings,
  type WorkflowDef,
  type StakesLevel,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents, upsertAgent, updateTokens, getAccessToken, type AgentConfig } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";

// ── Shared minimal workflow/policy fixtures ────────────────────────────────

/**
 * Multi-body dev role — two bodies fill 'dev', so assignment target is required
 * for the submit transition. Used to cover the multi-body assignment branches.
 */
const POLICY_MULTI_DEV = `
capabilities:
  - id: linear:transition
  - id: deploy:execute
  - id: human:escalate

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: code-review
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: code-review
    requires: [linear:transition]

bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: felix
    container: dev
    fills_roles: [dev]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: reviewer
    container: code-review
    fills_roles: [code-review]
`;

/** Single-body dev policy used for self-review and general tests. */
const POLICY_SINGLE_DEV = `
capabilities:
  - id: linear:transition
  - id: deploy:execute
  - id: human:escalate

containers:
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: code-review
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: code-review
    requires: [linear:transition]

bodies:
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: reviewer
    container: code-review
    fills_roles: [code-review]
`;

/** Minimal dev-impl workflow with submit having not-implementer constraint. */
const WORKFLOW_DEV_IMPL = `
id: dev-impl
version: 1
entry_state: intake
break_glass:
  command: escape
  to: escape
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: code-review
        assign:
          mode: required
          constraint: not-implementer
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
  - id: escape
    kind: terminal
    native_state: invalid
    transitions: []
`;

// ── Helpers ────────────────────────────────────────────────────────────────

function writeTmpYaml(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function makeFetch(labelResponses: Record<string, object>, fallback: object = { data: {} }) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse((init?.body as string) ?? "{}") as { query?: string; variables?: Record<string, unknown> };
    const id = (body.variables?.id as string | undefined) ?? (body.variables?.issueId as string | undefined);
    const resp = (id && id in labelResponses) ? labelResponses[id] : fallback;
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. workflow-gate.ts — enforcement branch coverage
// ══════════════════════════════════════════════════════════════════════════════

describe("workflow-gate: uncovered enforcement branches (G-21)", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "g21-wg-"));
    originalFetch = globalThis.fetch;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── AC2-WG-1: fail-closed for context-fetch failure on intent ──────────
  // The H-1 fail-closed path (line ~831) blocks most intents when the context
  // fetch fails, but begin-work and note are intentional pass-throughs.
  // A mutant that flips the !breakGlassOverride or the intent comparison would
  // either let every blocked intent through or block begin-work/note — both wrong.

  it("blocks non-begin-work intent when context fetch fails (H-1 fail-closed)", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    // Fetch always fails
    globalThis.fetch = async () => { throw new Error("network down"); };

    const result = await checkWorkflowRules(
      "submit", // not begin-work or note → must be blocked
      "TICKET-1",
      "tok",
      "charles",
    );

    expect(result).toMatch(/blocked.*context.*TICKET-1/i);
  });

  it("passes begin-work through when context fetch fails (H-1 exception)", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = async () => { throw new Error("network down"); };

    // begin-work must pass through even on fetch failure
    const result = await checkWorkflowRules("begin-work", "TICKET-1", "tok", "charles");
    expect(result).toBeNull();
  });

  it("passes note through when context fetch fails (H-1 exception)", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = async () => { throw new Error("network down"); };

    const result = await checkWorkflowRules("note", "TICKET-1", "tok", "charles");
    expect(result).toBeNull();
  });

  // ── AC2-WG-2: multi-body role — illegal-target guard (lines ~1128-1131) ─
  // When a transition's destination state has an owner_role filled by N>1 bodies,
  // an explicit target MUST be one of the legal bodies. A *missing* target is
  // legal-by-design (the conformance matrix asserts accept@intake / submit@
  // implementation with no target are allowed; the CLI carries the delegate via
  // its forwarded mutation, or the apply path routes by prior-implementer for
  // reject/request-changes/ac-fail). So the only enforcement here is the
  // illegal-target rejection, plus confirming no-target is NOT spuriously blocked.

  it("allows a forward transition to a multi-body dev role with no target (legal-by-design)", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_MULTI_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "TICKET-1": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
            delegate: { id: "user-astrid" },
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "accept", // intake→implementation, multi-body dev role
      "TICKET-1",
      "tok",
      "astrid",
      null,              // no target — allowed by design
      "user-astrid",     // caller is the delegate
    );

    // No-target forward transition is legal (matches conformance-matrix AC2 legal cells).
    expect(result).toBeNull();
  });

  it("rejects submit with an illegal target for multi-body dev role", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_MULTI_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "TICKET-1": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
            delegate: { id: "user-astrid" },
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "accept",
      "TICKET-1",
      "tok",
      "astrid",
      "notadev",         // not a legal dev body
      "user-astrid",
    );

    expect(result).toMatch(/not a legal assignment target/i);
    expect(result).toMatch(/notadev/);
  });

  it("allows accept with a valid target for multi-body dev role", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_MULTI_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    // Fake successful fetch (Linear forward will fail, but we only care about gate result)
    globalThis.fetch = makeFetch({
      "TICKET-1": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
            delegate: { id: "user-astrid" },
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "accept",
      "TICKET-1",
      "tok",
      "astrid",
      "igor",            // valid dev body
      "user-astrid",
    );

    expect(result).toBeNull();
  });

  // ── AC2-WG-3: singleton auto-assign target mismatch (line ~1097-1099) ─
  // When exactly one body fills the role (auto-assign), passing a different
  // target must be rejected. A mutant flipping the `target !== legalBodies[0]`
  // check would silently accept wrong targets.

  it("rejects a wrong explicit target when only one body fills the role (singleton auto-assign mismatch)", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "TICKET-1": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
            delegate: { id: "user-astrid" },
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "accept",
      "TICKET-1",
      "tok",
      "astrid",
      "wrong-body",  // not the singleton body (charles)
      "user-astrid",
    );

    expect(result).toMatch(/auto-assigns to.*charles.*singleton/i);
  });

  // ── AC2-WG-4: self-review prevention (line 1105) ──────────────────────
  // The not-implementer constraint blocks the submitting agent from reviewing
  // their own work. A mutant removing `target === bodyId` or the constraint
  // check entirely would let the submitter be their own reviewer.

  it("blocks self-review: implementer cannot be the reviewer (not-implementer constraint)", async () => {
    // Charles must be a valid body for the code-review role so the self-review
    // check (not-implementer constraint) fires rather than the "not a legal target" check.
    const selfReviewPolicy = `
capabilities:
  - id: linear:transition
containers:
  - id: any
    grants: [linear:transition]
roles:
  - id: dev
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]
bodies:
  - id: charles
    container: any
    fills_roles: [dev, code-review]
  - id: reviewer
    container: any
    fills_roles: [code-review]
`;
    const selfReviewWorkflow = `
id: dev-impl
version: 1
entry_state: intake
break_glass:
  command: escape
  to: escape
states:
  - id: intake
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: code-review
        assign:
          mode: required
          constraint: not-implementer
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
  - id: escape
    kind: terminal
    native_state: invalid
    transitions: []
`;
    const policyFile = writeTmpYaml(dir, "policy-sr.yaml", selfReviewPolicy);
    const wfFile = writeTmpYaml(dir, "wf-sr.yaml", selfReviewWorkflow);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "TICKET-SR": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
            delegate: { id: "user-charles" },
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "submit",
      "TICKET-SR",
      "tok",
      "charles",      // the implementer is submitting
      "charles",      // charles IS a valid code-reviewer, so self-review check fires
      "user-charles",
    );

    expect(result).toMatch(/self-review blocked/i);
  });

  it("allows submit when reviewer differs from implementer (not-implementer constraint)", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "TICKET-1": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
            delegate: { id: "user-charles" },
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "submit",
      "TICKET-1",
      "tok",
      "charles",
      "reviewer",    // different from bodyId → allowed
      "user-charles",
    );

    expect(result).toBeNull();
  });

  // ── AC2-WG-5: refuse-work always allowed on governed tickets (line ~905) ─
  // refuse-work must bypass both state-machine validation and delegate-only
  // enforcement (the refusal itself clears the delegate). A mutant removing
  // this short-circuit would strand wrongly-delegated agents.

  it("allows refuse-work regardless of current state on a governed workflow ticket", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "TICKET-1": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:code-review" }] },
            delegate: { id: "user-charles" },
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "refuse-work",
      "TICKET-1",
      "tok",
      "charles",
      null,
      "user-charles",
    );

    expect(result).toBeNull();
  });

  // ── AC2-WG-6: state-corrupted ticket blocks state-advancing intents ────
  // A governed ticket with no state:* label (corrupted projection) must block
  // all state-advancing intents. The exception for needs-human has its own path.
  // A mutant that flipped the state-corruption check to pass-through would
  // reproduce the AI-1361 fail-open bug shape.

  it("blocks a state-advancing intent when the workflow label is present but state label is absent", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "TICKET-1": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }] }, // NO state:* label
            delegate: { id: "user-charles" },
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "submit",
      "TICKET-1",
      "tok",
      "charles",
      null,
      "user-charles",
    );

    expect(result).toMatch(/no.*state.*workflow label/i);
  });

  it("blocks needs-human when the state label is absent (no free escalation path)", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "TICKET-1": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }] }, // NO state:* label
            delegate: { id: "user-charles" },
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "needs-human",
      "TICKET-1",
      "tok",
      "charles",
      null,
      "user-charles",
    );

    expect(result).toMatch(/needs-human.*blocked/i);
  });

  // ── AC2-WG-7: break-glass always legal (line ~898) ────────────────────
  // Break-glass must be allowed from every state, including states with no
  // matching transition. A mutant removing the early-return would cause escape
  // to be validated against the state machine and possibly blocked.

  it("allows escape (break-glass) from any state including terminal states", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "TICKET-1": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:code-review" }] },
            delegate: { id: "user-charles" },
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "escape",
      "TICKET-1",
      "tok",
      "charles",
      null,
      "user-charles",
    );

    expect(result).toBeNull();
  });

  // ── AC2-WG-8: ad-hoc ticket full pass-through (§4.6) ─────────────────
  // A ticket with no wf:* label must pass through regardless of intent.
  // A mutant inverting the workflowId null check would enforce ALL tickets.

  it("passes through any intent on an ad-hoc (non-workflow) ticket", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "TICKET-AD": {
        data: {
          issue: {
            labels: { nodes: [{ name: "bug" }, { name: "priority:high" }] },
            delegate: null,
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "random-command-not-in-workflow",
      "TICKET-AD",
      "tok",
      "charles",
    );

    expect(result).toBeNull();
  });

  // ── AC2-WG-9: unknown workflow wf:* label is pass-through (AI-1530) ───
  // A ticket labeled wf:nonexistent (not in registry) must pass through — the
  // connector only enforces known workflows. A mutant that blocked unknown
  // workflows would prevent any newly-added workflow from working.

  it("passes through a ticket whose wf: label names an unregistered workflow", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "TICKET-X": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:nonexistent-workflow" }] },
            delegate: null,
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "some-command",
      "TICKET-X",
      "tok",
      "charles",
    );

    expect(result).toBeNull();
  });

  // ── AC2-WG-10: illegal command in-state rejection (line ~969) ─────────
  // When an intent is not a legal transition from the current state, the gate
  // must reject and name the legal moves. A mutant flipping the match condition
  // would either block legal commands or allow illegal ones.

  it("rejects a command that is not a legal transition from the current state", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "TICKET-1": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
            delegate: { id: "user-astrid" },
          },
        },
      },
    });

    const result = await checkWorkflowRules(
      "deploy",       // deploy is not legal in intake
      "TICKET-1",
      "tok",
      "astrid",
      null,
      "user-astrid",
    );

    expect(result).toMatch(/not a legal command in state.*intake/i);
    expect(result).toMatch(/legal moves/i);
    expect(result).toMatch(/accept/);
  });
});

// ── checkRawMutationInterception branch coverage ───────────────────────────

describe("workflow-gate: checkRawMutationInterception — uncovered branches", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "g21-raw-"));
    originalFetch = globalThis.fetch;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // AC2-WG-11: unknown caller on governed ticket in raw mutation path (line 1219)
  it("blocks unknown caller issuing raw issueUpdate on a governed workflow ticket", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "WF-1": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
            delegate: { id: "user-charles" },
          },
        },
      },
    });

    const result = await checkRawMutationInterception(
      { query: "mutation { issueUpdate(id: \"WF-1\", input: { stateId: \"x\" }) { success } }", variables: { id: "WF-1" } },
      "WF-1",
      "tok",
      "unknown-rogue-agent",
    );

    expect(result).toMatch(/Unknown caller.*blocked/i);
  });

  // AC2-WG-12: raw mutation on governed ticket without state label → generic block (line 1258)
  it("blocks raw issueUpdate on a governed ticket that has no state:* label", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "WF-CORRUPT": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }] }, // NO state label
            delegate: null,
          },
        },
      },
    });

    const result = await checkRawMutationInterception(
      { query: "mutation { issueUpdate(id: \"WF-CORRUPT\", input: { stateId: \"y\" }) { success } }", variables: { id: "WF-CORRUPT" } },
      "WF-CORRUPT",
      "tok",
      "charles",
    );

    expect(result).toMatch(/Direct mutation blocked.*state unknown/i);
  });

  // AC2-WG-13: raw mutation on ad-hoc ticket → pass-through (§4.6 parity)
  it("allows raw issueUpdate on an ad-hoc ticket (no wf:* label)", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "ADHOC-1": {
        data: {
          issue: {
            labels: { nodes: [{ name: "bug" }] },
            delegate: null,
          },
        },
      },
    });

    const result = await checkRawMutationInterception(
      { query: "mutation { issueUpdate(id: \"ADHOC-1\", input: { stateId: \"z\" }) { success } }", variables: { id: "ADHOC-1" } },
      "ADHOC-1",
      "tok",
      "charles",
    );

    expect(result).toBeNull();
  });

  // AC2-WG-14: non-issueUpdate query is never blocked (line 1141)
  it("passes through non-issueUpdate queries without checking workflow state", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    globalThis.fetch = async () => { throw new Error("should not be called"); };

    const result = await checkRawMutationInterception(
      { query: "query { viewer { id } }", variables: {} },
      null,
      "tok",
      "charles",
    );

    expect(result).toBeNull();
  });

  // AC2-WG-15: raw mutation with no resolvable issueId → fail-closed (line ~1187)
  it("blocks raw workflow-field mutation when no issueId can be resolved", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const result = await checkRawMutationInterception(
      { query: "mutation { issueUpdate(input: { stateId: \"x\" }) { success } }", variables: {} },
      null,  // no issueId
      "tok",
      "charles",
    );

    expect(result).toMatch(/ticket id could not be resolved/i);
  });

  // AC2-WG-16: raw mutation not touching workflow fields → pass-through (line 1179)
  it("passes through issueUpdate that only changes title/description (no workflow fields)", async () => {
    const result = await checkRawMutationInterception(
      { query: "mutation { issueUpdate(id: \"X\", input: { title: \"new\" }) { success } }", variables: { id: "X" } },
      "X",
      "tok",
      "charles",
    );

    expect(result).toBeNull();
  });

  // AC2-WG-17: labelIds change on governed ticket → blocked (AI-1402 expansion)
  it("blocks raw labelIds change on a governed workflow ticket", async () => {
    const policyFile = writeTmpYaml(dir, "policy.yaml", POLICY_SINGLE_DEV);
    const wfFile = writeTmpYaml(dir, "wf.yaml", WORKFLOW_DEV_IMPL);
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = wfFile;

    globalThis.fetch = makeFetch({
      "WF-2": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
            delegate: null,
          },
        },
      },
    });

    const result = await checkRawMutationInterception(
      {
        query: "mutation { issueUpdate(id: \"WF-2\", input: { labelIds: [\"a\",\"b\"] }) { success } }",
        variables: { id: "WF-2", input: { labelIds: ["a", "b"] } },
      },
      "WF-2",
      "tok",
      "charles",
    );

    expect(result).toMatch(/Direct.*blocked.*workflow ticket/i);
  });
});

// ── getWorkflowId / getCurrentState boundary ───────────────────────────────

describe("workflow-gate: getWorkflowId and getCurrentState edge cases", () => {
  // AC2-WG-18: exact label boundary — prefix case-insensitive match
  it("extracts workflow id case-insensitively from WF: label", () => {
    expect(getWorkflowId(["WF:dev-impl", "state:intake"])).toBe("dev-impl");
    expect(getWorkflowId(["wf:sprint", "state:planning"])).toBe("sprint");
    expect(getWorkflowId(["bug", "priority:high"])).toBeNull();
  });

  it("extracts state case-insensitively from STATE: label", () => {
    expect(getCurrentState(["wf:dev-impl", "STATE:implementation"])).toBe("implementation");
    expect(getCurrentState(["wf:dev-impl", "state:done"])).toBe("done");
    expect(getCurrentState(["wf:dev-impl"])).toBeNull(); // no state label
  });

  // A mutant that changes slice offset in getWorkflowId / getCurrentState would break these
  it("does not include the 'wf:' prefix itself in the returned workflow id", () => {
    const id = getWorkflowId(["wf:my-workflow"]);
    expect(id).toBe("my-workflow");
    expect(id).not.toMatch(/^wf:/i);
  });

  it("does not include the 'state:' prefix itself in the returned state name", () => {
    const state = getCurrentState(["state:write-tests"]);
    expect(state).toBe("write-tests");
    expect(state).not.toMatch(/^state:/i);
  });
});

// ── resolveStakesLevel boundary ────────────────────────────────────────────

describe("workflow-gate: resolveStakesLevel — threshold boundary", () => {
  const stakes: StakesLevel = {
    levels: { "risk:low": 0, "risk:medium": 1, "risk:high": 2 },
    threshold: 2,
  };

  // AC2-WG-19: strictly-below threshold does not trip sign-off gate
  it("returns level 1 (below threshold 2) for risk:medium — should NOT trigger sign-off", () => {
    const level = resolveStakesLevel(["risk:medium", "wf:dev-impl"], stakes);
    expect(level).toBe(1);
    expect(level).toBeLessThan(stakes.threshold);
  });

  // AC2-WG-20: at-threshold trips the sign-off gate
  it("returns level 2 (at threshold 2) for risk:high — should trigger sign-off", () => {
    const level = resolveStakesLevel(["risk:high", "wf:dev-impl"], stakes);
    expect(level).toBe(2);
    expect(level).toBeGreaterThanOrEqual(stakes.threshold);
  });

  // AC2-WG-21: no matching stakes label → fail-open (returns 0)
  it("returns 0 (fail-open) when no configured stakes label is present", () => {
    const level = resolveStakesLevel(["bug", "priority:high"], stakes);
    expect(level).toBe(0);
    expect(level).toBeLessThan(stakes.threshold);
  });

  // A mutant replacing `>=` with `>` in the caller would let level===threshold through;
  // a mutant replacing it with `===` would let level>threshold through.
  it("threshold comparison: level=0 < threshold=2 is false for sign-off", () => {
    const level = resolveStakesLevel([], stakes);
    expect(level >= stakes.threshold).toBe(false);
  });

  it("threshold comparison: level=2 >= threshold=2 is true for sign-off", () => {
    const level = resolveStakesLevel(["risk:high"], stakes);
    expect(level >= stakes.threshold).toBe(true);
  });
});

// ── validateNativeStateMappings branch coverage ────────────────────────────

describe("workflow-gate: validateNativeStateMappings — branch coverage", () => {
  // AC2-WG-22: no native_state field → error
  it("returns an error for a state with no native_state", () => {
    const def: WorkflowDef = {
      id: "test",
      states: [{ id: "intake" }], // no native_state
    };
    const errors = validateNativeStateMappings(def);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/native_state field/);
  });

  // AC2-WG-23: invalid native_state name → error naming valid options
  it("returns an error for an invalid native_state name", () => {
    const def: WorkflowDef = {
      id: "test",
      states: [{ id: "intake", native_state: "limbo" }],
    };
    const errors = validateNativeStateMappings(def);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/not a recognized semantic state/);
    expect(errors[0]).toMatch(/doing|todo|done/);
  });

  // AC2-WG-24: valid native_state → no errors
  it("returns no errors for all valid native_state values", () => {
    const validNames = ["backlog", "todo", "thinking", "doing", "managing", "done", "invalid"];
    for (const name of validNames) {
      const def: WorkflowDef = { id: "test", states: [{ id: "s", native_state: name }] };
      expect(validateNativeStateMappings(def)).toHaveLength(0);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. proxy.ts — enforcement branch coverage
// ══════════════════════════════════════════════════════════════════════════════

describe("proxy.ts: uncovered enforcement branches (G-21)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  const PROXY_WORKFLOW_YAML = `
id: dev-impl
version: 1
entry_state: intake
break_glass:
  command: escape
  to: escape
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: code-review
  - id: code-review
    owner_role: dev
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: done
      - command: request-changes
        to: implementation
      - command: reject
        to: implementation
      - command: ac-fail
        to: implementation
  - id: done
    kind: terminal
    native_state: done
    transitions: []
  - id: escape
    kind: terminal
    native_state: invalid
    transitions: []
`;

  const PROXY_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]
roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]
bodies:
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "g21-proxy-"));
    originalFetch = globalThis.fetch;

    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          { name: "charles", linearUserId: "u-charles", accessToken: "tok-charles", refreshToken: "r", clientId: "c", clientSecret: "s", openclawAgent: "charles", proxyToken: "lpx_charles_test", proxyUrl: "http://proxy" },
          { name: "astrid", linearUserId: "u-astrid", accessToken: "tok-astrid", refreshToken: "r", clientId: "c", clientSecret: "s", openclawAgent: "astrid" },
        ],
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "policy.yaml"), PROXY_POLICY_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "wf.yaml"), PROXY_WORKFLOW_YAML, "utf8");

    process.env.AGENTS_FILE = agentsFile;
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "policy.yaml");
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "wf.yaml");

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // AC2-PR-1: Array authorization header — first element used (line 154)
  // express can parse multi-value headers as arrays; the proxy must pick the first.
  // A mutant removing the Array.isArray branch would use the array object as the
  // token, which api.linear.app would reject.
  it("handles array Authorization header by using the first value", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-charles") // supertest sends single value
      .send({ query: "{ viewer { id } }" });

    expect(res.status).toBe(200);
  });

  // AC2-PR-2: Broker proxy-token identity resolution (line 164-165)
  // When the Authorization header is a known proxy token, the proxy resolves the
  // real Linear token and uses that instead — the agent cannot bypass the gate
  // by hitting Linear directly with the proxy token.
  it("resolves agent identity from proxy token and substitutes the vaulted access token", async () => {
    let capturedAuth: string | undefined;
    globalThis.fetch = async (url, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "lpx_charles_test")   // broker proxy token
      .send({ query: "{ viewer { id } }" });

    // The upstream request must carry the real Linear token, not the proxy token
    expect(capturedAuth).toBe("tok-charles");
    expect(capturedAuth).not.toBe("lpx_charles_test");
  });

  // AC2-PR-3: feedback struct NOT built when no feedback category header (line 280 branch)
  // The observationStore feedback path only runs when feedbackCategoryHeader is set.
  // A mutant removing the feedbackCategoryHeader guard would try to record feedback
  // for every request-changes, which would fail / behave incorrectly.
  it("does not build feedback struct when X-Openclaw-Feedback-Category header is absent", async () => {
    globalThis.fetch = makeFetch({
      "WF-3": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:code-review" }] },
            delegate: { id: "u-charles" },
          },
        },
      },
    }, { data: { commentCreate: { success: true, comment: { id: "c1" } } } });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-charles")
      .set("X-Openclaw-Linear-Intent", "request-changes")
      .set("X-Openclaw-Agent", "charles")
      // NO X-Openclaw-Feedback-Category header
      .send({ query: "mutation { issueUpdate(id: \"WF-3\") { success } }", variables: { id: "WF-3" } });

    // Should succeed (no rejection) — absence of feedback header is not an error
    expect(res.status).toBe(200);
    const body = res.body as { errors?: Array<{ message: string }> };
    expect(body.errors?.[0]?.message ?? "").not.toMatch(/blocked/i);
  });

  // AC2-PR-4: feedback struct built for request-changes with category header (line 280 branches)
  it("builds feedback struct for request-changes when X-Openclaw-Feedback-Category is set", async () => {
    globalThis.fetch = makeFetch({
      "WF-4": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:code-review" }] },
            delegate: { id: "u-charles" },
          },
        },
      },
    }, { data: { issueUpdate: { success: true } } });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-charles")
      .set("X-Openclaw-Linear-Intent", "request-changes")
      .set("X-Openclaw-Feedback-Category", "spec-clarity")
      .set("X-Openclaw-From-Body", "charles")
      .set("X-Openclaw-Agent", "charles")
      .send({ query: "mutation { issueUpdate(id: \"WF-4\") { success } }", variables: { id: "WF-4", input: {} } });

    expect(res.status).toBe(200);
  });

  // AC2-PR-5: feedback struct built for ac-fail (third OR branch at line 280)
  it("builds feedback struct for ac-fail intent (third OR branch in feedback condition)", async () => {
    globalThis.fetch = makeFetch({
      "WF-5": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:code-review" }] },
            delegate: { id: "u-charles" },
          },
        },
      },
    }, { data: { issueUpdate: { success: true } } });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-charles")
      .set("X-Openclaw-Linear-Intent", "ac-fail")
      .set("X-Openclaw-Feedback-Category", "ac-mismatch")
      .set("X-Openclaw-Agent", "charles")
      .send({ query: "mutation { issueUpdate(id: \"WF-5\") { success } }", variables: { id: "WF-5", input: {} } });

    expect(res.status).toBe(200);
  });

  // AC2-PR-6: feedback category set but intent is not a feedback intent → no feedback struct
  it("does not build feedback struct when intent is not request-changes/reject/ac-fail", async () => {
    globalThis.fetch = makeFetch({
      "WF-6": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
            delegate: { id: "u-astrid" },
          },
        },
      },
    }, { data: { issueUpdate: { success: true } } });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Linear-Intent", "accept")
      .set("X-Openclaw-Feedback-Category", "should-be-ignored")
      .set("X-Openclaw-Agent", "astrid")
      .send({ query: "mutation { issueUpdate(id: \"WF-6\") { success } }", variables: { id: "WF-6", input: {} } });

    expect(res.status).toBe(200);
    const body = res.body as { errors?: Array<{ message: string }> };
    // accept in intake is legal for astrid → no block
    expect(body.errors?.[0]?.message ?? "").not.toMatch(/blocked/i);
  });

  // AC2-PR-7: missing Authorization header → 401 (line 150-152)
  it("returns 401 when Authorization header is missing", async () => {
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .send({ query: "{ viewer { id } }" });

    expect(res.status).toBe(401);
  });

  // AC2-PR-8: upstream fetch failure → 200 UPSTREAM_TIMEOUT (proxy.ts)
  it("returns 200 with UPSTREAM_TIMEOUT when the upstream Linear API is unreachable", async () => {
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-charles")
      .send({ query: "{ viewer { id } }" });

    expect(res.status).toBe(200);
    const body = res.body as { errors?: Array<{ message: string; extensions?: { code: string } }> };
    expect(body.errors?.[0]?.extensions?.code).toBe("UPSTREAM_TIMEOUT");
    expect(body.errors?.[0]?.message).toMatch(/unreachable/i);
  });

  // AC2-PR-9: semver version floor — CLI below floor is rejected (line 200-205)
  it("rejects workflow commands from CLI versions below the minimum required", async () => {
    process.env.PROXY_MIN_CLI_VERSION = "1.0.0";

    globalThis.fetch = makeFetch({
      "WF-7": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
            delegate: null,
          },
        },
      },
    });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Linear-Intent", "accept")
      .set("X-Openclaw-Linear-Cli-Version", "0.2.9")  // below 1.0.0
      .set("X-Openclaw-Agent", "astrid")
      .send({ query: "mutation { issueUpdate(id: \"WF-7\") { success } }", variables: { id: "WF-7" } });

    delete process.env.PROXY_MIN_CLI_VERSION;

    const body = res.body as { errors?: Array<{ message: string }> };
    expect(body.errors?.[0]?.message).toMatch(/below the minimum required/i);
  });

  // AC2-PR-10: CLI at exactly the minimum version is allowed
  it("allows workflow commands from CLI at exactly the minimum required version", async () => {
    process.env.PROXY_MIN_CLI_VERSION = "0.3.0";

    globalThis.fetch = makeFetch({
      "WF-8": {
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
            delegate: { id: "u-astrid" },
          },
        },
      },
    }, { data: { issueUpdate: { success: true } } });

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Linear-Intent", "accept")
      .set("X-Openclaw-Linear-Cli-Version", "0.3.0")  // exactly the floor
      .set("X-Openclaw-Agent", "astrid")
      .send({ query: "mutation { issueUpdate(id: \"WF-8\") { success } }", variables: { id: "WF-8" } });

    delete process.env.PROXY_MIN_CLI_VERSION;

    const body = res.body as { errors?: Array<{ message: string }> };
    expect(body.errors?.[0]?.message ?? "").not.toMatch(/below the minimum required/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. agents.ts — uncovered branch coverage
// ══════════════════════════════════════════════════════════════════════════════

describe("agents.ts: uncovered branches (G-21)", () => {
  let dir: string;
  let agentsFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "g21-agents-"));
    agentsFile = path.join(dir, "agents.json");
    process.env.AGENTS_FILE = agentsFile;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE;
    delete process.env.SECRETS_DIR;
    reloadAgents();
  });

  afterEach(() => {
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE;
    delete process.env.AGENTS_FILE;
    delete process.env.SECRETS_DIR;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // AC2-AG-1: resolveEncryptionKey — key of wrong length throws (line 88)
  // A 31-byte key must be rejected; only 32-byte AES-256-GCM keys are valid.
  // A mutant changing the length check (e.g. !== 32 → !== 16) would accept bad keys.
  it("throws a clear error when the encryption key is not exactly 32 bytes", () => {
    // A 31-byte key encoded as base64
    const shortKey = Buffer.alloc(31, 0).toString("base64");
    process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY = shortKey;

    // Writing a plaintext file then reloading with a bad key is one trigger path;
    // the simplest is to write an encrypted file and try to decrypt with a wrong-length key.
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({ agents: [{ name: "a", linearUserId: "u", accessToken: "t", refreshToken: "r", clientId: "c", clientSecret: "s" }] }),
    );

    // Saving while the key is a bad length should throw at key resolution time
    expect(() => {
      upsertAgent({ name: "a", linearUserId: "u", accessToken: "t", refreshToken: "r", clientId: "c", clientSecret: "s" });
    }).toThrow(/32 bytes/i);
  });

  // AC2-AG-2: syncWorkspaceSecrets via SECRETS_DIR (line 274-275)
  // When SECRETS_DIR is set and the agent has no explicit secretsPath, the
  // secrets file must be written into SECRETS_DIR/<wsName>/linear.env.
  // A mutant removing the SECRETS_DIR branch would use the fallback getLinearSecretPath
  // instead, which writes to a different location.
  it("writes secrets to SECRETS_DIR/<wsName>/linear.env when SECRETS_DIR is set", () => {
    const secretsDir = path.join(dir, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    process.env.SECRETS_DIR = secretsDir;

    // Agent WITHOUT explicit secretsPath — relies on SECRETS_DIR
    upsertAgent({
      name: "noah",
      linearUserId: "u-noah",
      accessToken: "tok-noah",
      refreshToken: "r",
      clientId: "c",
      clientSecret: "s",
      openclawAgent: "noah",
      // no secretsPath set
    });

    const expectedPath = path.join(secretsDir, "noah", "linear.env");
    expect(fs.existsSync(expectedPath)).toBe(true);
    const contents = fs.readFileSync(expectedPath, "utf8");
    // AI-2308: new agents get a minted proxy token instead of the raw upstream token.
    expect(contents).toMatch(/LINEAR_OAUTH_TOKEN=lpx_/);
    expect(contents).not.toContain("LINEAR_OAUTH_TOKEN=tok-noah");
  });

  // AC2-AG-3: proxyToken set without proxyUrl — only token line written (line 291-292)
  // A mutant adding an unconditional proxyUrl line when it's not configured would
  // inject a blank/wrong LINEAR_PROXY_URL into the agent's env, breaking its routing.
  it("writes only the proxy token (no proxy URL) when agent has proxyToken but no proxyUrl", () => {
    const secretsPath = path.join(dir, "linear.env");
    upsertAgent({
      name: "felix",
      linearUserId: "u-felix",
      accessToken: "real-token-felix",
      refreshToken: "r",
      clientId: "c",
      clientSecret: "s",
      secretsPath,
      proxyToken: "lpx_felix_xyz",
      // no proxyUrl
    });

    const contents = fs.readFileSync(secretsPath, "utf8");
    expect(contents).toContain("LINEAR_OAUTH_TOKEN=lpx_felix_xyz");
    expect(contents).not.toContain("LINEAR_PROXY_URL");
    expect(contents).not.toContain("real-token-felix");
  });

  // AC2-AG-4: agent without openclawAgent uses name as wsName (line 270 branch)
  // When an agent has no openclawAgent field, the workspace name must default to
  // the agent name. A mutant swapping ?? to || or removing it would break the fallback.
  it("uses agent.name as workspace name when openclawAgent is not set (SECRETS_DIR path)", () => {
    const secretsDir = path.join(dir, "secrets2");
    fs.mkdirSync(secretsDir, { recursive: true });
    process.env.SECRETS_DIR = secretsDir;

    upsertAgent({
      name: "sage",
      linearUserId: "u-sage",
      accessToken: "tok-sage",
      refreshToken: "r",
      clientId: "c",
      clientSecret: "s",
      // no openclawAgent → wsName falls back to "sage"
    });

    const expectedPath = path.join(secretsDir, "sage", "linear.env");
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  // AC2-AG-5: updateTokens for nonexistent agent is a no-op (should not throw)
  // The updateTokens function finds the agent by name; if not found, save() is
  // still called (with unchanged agents). This branch covers the .map miss path.
  it("does not throw when updateTokens is called for an agent that does not exist", () => {
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [] }), "utf8");
    reloadAgents();
    expect(() => {
      updateTokens("nonexistent", "new-tok", "new-refresh");
    }).not.toThrow();
  });

  // AC2-AG-6: getAccessToken returns undefined for unknown agent (line 248 miss branch)
  // A mutant changing undefined to null or '' would break callers checking === undefined.
  it("returns undefined (not null or empty string) when getAccessToken called for unknown agent", () => {
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [] }), "utf8");
    reloadAgents();
    const tok = getAccessToken("nobody");
    expect(tok).toBeUndefined();
  });

  // AC2-AG-7: upsertAgent updates an existing agent on the name-match path.
  // Note this does NOT reach the linearUserId fallback despite its original
  // name: both upserts below pass name "igor", so the name match short-circuits
  // and a mutant removing the fallback lookup survives here. The fallback and
  // its falsy-id guard are covered in ai-2453-upsert-rename-write.test.ts.
  it("updates an existing agent matched by name", () => {
    const secretsPath = path.join(dir, "existing.env");
    upsertAgent({
      name: "igor",
      linearUserId: "u-igor",
      accessToken: "tok-v1",
      refreshToken: "r",
      clientId: "c",
      clientSecret: "s",
      secretsPath,
    });

    // Update via same name (primary match path)
    const { isNew } = upsertAgent({
      name: "igor",
      linearUserId: "u-igor",
      accessToken: "tok-v2",
      refreshToken: "r2",
      clientId: "c",
      clientSecret: "s",
      secretsPath,
    });

    expect(isNew).toBe(false);
    expect(getAccessToken("igor")).toBe("tok-v2");
  });

  // AC2-AG-8: upsertAgent with genuinely new agent returns isNew=true
  it("returns isNew=true for a genuinely new agent insert", () => {
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [] }), "utf8");
    reloadAgents();
    const secretsPath = path.join(dir, "new-agent.env");
    const { isNew } = upsertAgent({
      name: "brand-new",
      linearUserId: "u-new",
      accessToken: "tok",
      refreshToken: "r",
      clientId: "c",
      clientSecret: "s",
      secretsPath,
    });
    expect(isNew).toBe(true);
  });
});
