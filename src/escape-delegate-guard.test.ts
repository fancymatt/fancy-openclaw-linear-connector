/**
 * AI-1668 — Restrict escape command to delegates and stewards only.
 *
 * The escape (break-glass) command currently short-circuits all delegate checks
 * at workflow-gate.ts line ~976:
 *   `if (intent === breakGlassCommand) return null;`
 *
 * This allows ANY known agent to destroy an active workflow step by escaping
 * a ticket they don't own. The fix must:
 *
 *   AC1: Block escape from non-delegate, non-steward callers on governed tickets.
 *   AC2: Allow the current delegate to still escape their own ticket.
 *   AC3: Allow the steward (break_glass.owner_role) to escape any ticket.
 *   AC4: Block message explains the restriction and suggests escalation.
 *   AC5: Regression — no-delegate tickets still fail-open (existing tests preserved).
 *   AC6: Ad-hoc (ungoverned) tickets pass through unchanged.
 *
 * Tests here are written RED-first against the current implementation (AC1 tests
 * fail because escape currently bypasses delegate enforcement entirely).
 *
 * Reproduction context: AI-1660 — Astrid (no longer delegate) ran `escape` on
 * a ticket while TDD was the active delegate, orphaning TDD's session.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: deployment
    grants: [linear:transition, deploy:execute]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]
  - id: deployment
    requires: [deploy:execute]

bodies:
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: tdd
    container: dev
    fills_roles: [dev]
`;

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: escape
  owner_role: steward

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: write-tests

  - id: write-tests
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: tests-ready
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

  - id: done
    kind: terminal
    native_state: done
    transitions: []

  - id: escape
    kind: terminal
    native_state: invalid
    transitions: []
`;

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "escape-delegate-guard-"));

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const workflowFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "charles", linearUserId: "charles-linear-uuid", clientId: "c-client", clientSecret: "c-secret", accessToken: "c-token", refreshToken: "c-refresh" },
        { name: "astrid",  linearUserId: "astrid-linear-uuid",  clientId: "a-client", clientSecret: "a-secret", accessToken: "a-token", refreshToken: "a-refresh" },
        { name: "hanzo",   linearUserId: "hanzo-linear-uuid",   clientId: "h-client", clientSecret: "h-secret", accessToken: "h-token", refreshToken: "h-refresh" },
        { name: "tdd",     linearUserId: "tdd-linear-uuid",     clientId: "t-client", clientSecret: "t-secret", accessToken: "t-token", refreshToken: "t-refresh" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.AGENTS_FILE;
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
});

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Fetch mock: returns issue context with the given labels and delegate.
 * Used to simulate a governed ticket with a specific delegate set.
 */
function makeContextFetch(
  labelNames: string[],
  delegateId: string | null,
): typeof globalThis.fetch {
  return async (_url, _init) =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            labels: { nodes: labelNames.map((name) => ({ name })) },
            delegate: delegateId ? { id: delegateId } : null,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

/** All non-terminal governed states. */
const GOVERNED_STATES = ["intake", "write-tests", "implementation", "code-review"];

// ── AC1: Non-delegate, non-steward → blocked ───────────────────────────────

describe("AI-1668 AC1: escape blocked for non-delegate, non-steward on governed tickets", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("blocks escape from a non-delegate dev agent (charles) when another user is the delegate", async () => {
    // tdd is the delegate; charles is not the delegate and not a steward.
    globalThis.fetch = makeContextFetch(["wf:dev-impl", "state:write-tests"], "tdd-linear-uuid");
    const result = await checkWorkflowRules(
      "escape", "AI-1668", "Bearer tok", "charles",
      null, "charles-linear-uuid",
    );
    expect(result).not.toBeNull();
    expect(result).toMatch(/\[Proxy\]/);
  });

  it("block message explains the restriction (names delegate/steward requirement)", async () => {
    globalThis.fetch = makeContextFetch(["wf:dev-impl", "state:write-tests"], "tdd-linear-uuid");
    const result = await checkWorkflowRules(
      "escape", "AI-1668", "Bearer tok", "charles",
      null, "charles-linear-uuid",
    );
    // Message must explain WHY and suggest escalation.
    expect(result).toMatch(/delegate|steward/i);
    expect(result).toMatch(/escape|escalat/i);
  });

  it("blocks escape from every governed state when caller is not the delegate", async () => {
    for (const state of GOVERNED_STATES) {
      resetWorkflowCache();
      resetPolicyCache();
      globalThis.fetch = makeContextFetch(["wf:dev-impl", `state:${state}`], "tdd-linear-uuid");
      const result = await checkWorkflowRules(
        "escape", "AI-1668", "Bearer tok", "charles",
        null, "charles-linear-uuid",
      );
      expect(result).not.toBeNull(); // state: ${state}
    }
  });

  it("blocks escape from a non-delegate deployment agent (hanzo) when tdd is the delegate", async () => {
    globalThis.fetch = makeContextFetch(["wf:dev-impl", "state:implementation"], "tdd-linear-uuid");
    const result = await checkWorkflowRules(
      "escape", "AI-1668", "Bearer tok", "hanzo",
      null, "hanzo-linear-uuid",
    );
    expect(result).not.toBeNull();
    expect(result).toMatch(/\[Proxy\]/);
  });

  // Reproduction case: Astrid (steward role but NOT the delegate) escaping TDD's ticket.
  // After AI-1668 fix, astrid IS the steward so she IS allowed — this is AC3.
  // But a non-steward third party (charles, a dev) must be blocked (this is AC1).
  it("AI-1660 regression: non-delegate, non-steward agent cannot destroy an active workflow step", async () => {
    // Simulate: tdd is actively working (delegate), charles has no ownership.
    globalThis.fetch = makeContextFetch(["wf:dev-impl", "state:write-tests"], "tdd-linear-uuid");
    const result = await checkWorkflowRules(
      "escape", "AI-1660", "Bearer tok", "charles",
      null, "charles-linear-uuid",
    );
    expect(result).not.toBeNull();
    expect(result).toMatch(/\[Proxy\]/);
  });
});

// ── AC2: Current delegate → always allowed ────────────────────────────────

describe("AI-1668 AC2: current delegate can still escape their own ticket", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("allows escape when the caller IS the current delegate", async () => {
    // tdd is both the caller and the delegate.
    globalThis.fetch = makeContextFetch(["wf:dev-impl", "state:write-tests"], "tdd-linear-uuid");
    const result = await checkWorkflowRules(
      "escape", "AI-1668", "Bearer tok", "tdd",
      null, "tdd-linear-uuid",
    );
    expect(result).toBeNull();
  });

  it("delegate can escape from every governed state", async () => {
    for (const state of GOVERNED_STATES) {
      resetWorkflowCache();
      resetPolicyCache();
      globalThis.fetch = makeContextFetch(["wf:dev-impl", `state:${state}`], "tdd-linear-uuid");
      const result = await checkWorkflowRules(
        "escape", "AI-1668", "Bearer tok", "tdd",
        null, "tdd-linear-uuid",
      );
      expect(result).toBeNull(); // state: ${state}
    }
  });

  it("charles can escape when charles is the delegate", async () => {
    globalThis.fetch = makeContextFetch(["wf:dev-impl", "state:implementation"], "charles-linear-uuid");
    const result = await checkWorkflowRules(
      "escape", "AI-1668", "Bearer tok", "charles",
      null, "charles-linear-uuid",
    );
    expect(result).toBeNull();
  });
});

// ── AC3: Steward (break_glass.owner_role) → always allowed ───────────────

describe("AI-1668 AC3: steward can escape any ticket in their workflow", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("steward (astrid) can escape even when not the delegate", async () => {
    // tdd is the delegate; astrid is the steward.
    globalThis.fetch = makeContextFetch(["wf:dev-impl", "state:write-tests"], "tdd-linear-uuid");
    const result = await checkWorkflowRules(
      "escape", "AI-1668", "Bearer tok", "astrid",
      null, "astrid-linear-uuid",
    );
    expect(result).toBeNull();
  });

  it("steward can escape from every governed state", async () => {
    for (const state of GOVERNED_STATES) {
      resetWorkflowCache();
      resetPolicyCache();
      globalThis.fetch = makeContextFetch(["wf:dev-impl", `state:${state}`], "tdd-linear-uuid");
      const result = await checkWorkflowRules(
        "escape", "AI-1668", "Bearer tok", "astrid",
        null, "astrid-linear-uuid",
      );
      expect(result).toBeNull(); // state: ${state}
    }
  });

  it("steward can escape when no delegate is set (orphaned ticket recovery)", async () => {
    globalThis.fetch = makeContextFetch(["wf:dev-impl", "state:write-tests"], null);
    const result = await checkWorkflowRules(
      "escape", "AI-1668", "Bearer tok", "astrid",
      null, "astrid-linear-uuid",
    );
    expect(result).toBeNull();
  });
});

// ── AC5: Regression — fail-open when no delegate is set ──────────────────

describe("AI-1668 AC5: fail-open when no delegate is set (existing behavior preserved)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("escape with no delegate set passes through for any known caller (fail-open)", async () => {
    // No delegate — cannot determine who owns the ticket, so fail open.
    globalThis.fetch = makeContextFetch(["wf:dev-impl", "state:write-tests"], null);
    const result = await checkWorkflowRules(
      "escape", "AI-1668", "Bearer tok", "charles",
      null, "charles-linear-uuid",
    );
    expect(result).toBeNull();
  });

  it("escape with no delegate and no callerLinearUserId passes through (legacy/unknown identity)", async () => {
    globalThis.fetch = makeContextFetch(["wf:dev-impl", "state:implementation"], null);
    // No callerLinearUserId provided — cannot verify identity, fail open.
    const result = await checkWorkflowRules(
      "escape", "AI-1668", "Bearer tok", "charles",
    );
    expect(result).toBeNull();
  });

  it("escape still passes when no state:* label is present (corrupt projection, fail-open)", async () => {
    globalThis.fetch = makeContextFetch(["wf:dev-impl", "bug"], null);
    const result = await checkWorkflowRules(
      "escape", "AI-1668", "Bearer tok", "charles",
      null, "charles-linear-uuid",
    );
    expect(result).toBeNull();
  });
});

// ── AC6: Ad-hoc (ungoverned) tickets unchanged ────────────────────────────

describe("AI-1668 AC6: escape on ungoverned (ad-hoc) tickets is unchanged", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("escape on an ad-hoc ticket (no wf:* label) always passes through", async () => {
    // §4.6 mode switch: tickets without wf:* are ungoverned — full pass-through.
    globalThis.fetch = makeContextFetch(["bug", "priority:high"], "tdd-linear-uuid");
    const result = await checkWorkflowRules(
      "escape", "AI-1668", "Bearer tok", "charles",
      null, "charles-linear-uuid",
    );
    expect(result).toBeNull();
  });

  it("escape on ad-hoc ticket passes through even when caller is not 'owner'", async () => {
    globalThis.fetch = makeContextFetch(["enhancement"], null);
    const result = await checkWorkflowRules(
      "escape", "AI-1668", "Bearer tok", "charles",
      null, "charles-linear-uuid",
    );
    expect(result).toBeNull();
  });
});
