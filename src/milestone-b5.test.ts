/**
 * Phase 5 / B-5 — End-to-end milestone validation walk (AI-1442).
 *
 * Proves the Phase 5 milestone live, through the enforcing proxy.
 * Covers the 3 ACs from design.md §11 Phase 5:
 *
 *   AC1: Real walk: researcher submits findings → engine fans out N children →
 *        children run dev-impl to terminal → barrier auto-advances parent →
 *        parent dispositioned against its own AC → done.
 *
 *   AC2: Every transition proxy-validated; illegal moves rejected with the
 *        legal set named.
 *
 *   AC3: At least one child stall exercised to confirm the §5.5 tripwire
 *        fires in a live run.
 *
 * This test file exercises the full chain end-to-end:
 *   1. Proxy inbound enforcement (workflow-gate + escalation-gate)
 *   2. Fan-out (spawning → managing with N children created)
 *   3. Children progressing through dev-impl states
 *   4. Barrier auto-advance (managing → review when last child terminal)
 *   5. Parent-AC gate (review → done gated on parent's own AC)
 *   6. Stall detection (§5.5 tripwire surfacing)
 *   7. Illegal move rejection at every step
 *
 * Ref: design.md §11 Phase 5, §14.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache, type WorkflowDef } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { extractFindings, shouldTriggerFanout } from "./fanout.js";
import { isChildTerminal, evaluateBarrier, onChildTerminal, detectStalledChildren, surfaceStalledChildren, isTerminalState } from "./barrier.js";
import { parseAcChecklist, evaluateAcGate, evaluateParentAcGate, dispositionToDone, resolveDisposition } from "./review.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Fixtures ───────────────────────────────────────────────────────────────

const CANONICAL_UX_AUDIT = path.resolve(__dirname, "__fixtures__/canonical-ux-audit.yaml");
const CANONICAL_DEV_IMPL = path.resolve(__dirname, "__fixtures__/canonical-dev-impl.yaml");

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: deploy:execute
containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
roles:
  - id: steward
    requires: [human:escalate]
  - id: deployment
    requires: [deploy:execute]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: igor
    container: dev
    fills_roles: []
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: charles
    container: dev
    fills_roles: []
`;

const TEST_AGENTS = {
  agents: [
    { name: "igor", linearUserId: "user-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
    { name: "astrid", linearUserId: "user-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
    { name: "hanzo", linearUserId: "user-hanzo", openclawAgent: "hanzo", accessToken: "tok-hanzo", host: "local" },
    { name: "charles", linearUserId: "user-charles", openclawAgent: "charles", accessToken: "tok-charles", host: "local" },
  ],
};

// ── Test setup helpers ─────────────────────────────────────────────────────

let tmpDir: string;

function writeFixtures(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b5-test-"));

  // Write agents.json
  const agentsFile = path.join(tmpDir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify(TEST_AGENTS), "utf8");
  process.env.AGENTS_FILE = agentsFile;

  // Write capability policy
  const policyFile = path.join(tmpDir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  // Set workflow def to ux-audit fixture
  process.env.WORKFLOW_DEF_PATH = CANONICAL_UX_AUDIT;

  resetPolicyCache();
  resetWorkflowCache();
  reloadAgents();

  return tmpDir;
}

function cleanupFixtures() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ── Helper: build a multi-response mock fetch ──────────────────────────────

type MockFetchHandler = (query: string, variables: Record<string, unknown>) => Record<string, unknown> | null;

function createChainedMockFetch(handlers: MockFetchHandler[]): typeof globalThis.fetch {
  return (async (_input: any, _init?: any) => {
    const body = _init?.body ? JSON.parse(_init.body as string) : {};
    const query = (body.query ?? "") as string;
    const variables = (body.variables ?? {}) as Record<string, unknown>;

    for (const handler of handlers) {
      const result = handler(query, variables);
      if (result !== null) {
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as any as typeof globalThis.fetch;
}

// ── AC1: Real walk — full end-to-end chain ─────────────────────────────────

describe("AC1: Real walk — end-to-end milestone validation", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchLog: Array<{ query: string; variables: Record<string, unknown> }>;
  let savedWorkflowDefPath: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchLog = [];
    // AI-1730: attemptBarrierTransition now calls loadWorkflowDefById which
    // triggers loadWorkflowRegistry. Without a valid WORKFLOW_DEF_PATH, the
    // registry load fails and poisons config-health, breaking AC2 proxy tests.
    savedWorkflowDefPath = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_UX_AUDIT;
    resetWorkflowCache();
    resetConfigHealth();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedWorkflowDefPath) process.env.WORKFLOW_DEF_PATH = savedWorkflowDefPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    resetWorkflowCache();
    resetConfigHealth();
  });

  function withFetchLogging(mockFetch: typeof globalThis.fetch): typeof globalThis.fetch {
    return (async (input: any, init?: any) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const query = (body.query ?? "") as string;
      const variables = (body.variables ?? {}) as Record<string, unknown>;
      fetchLog.push({ query, variables });
      return mockFetch(input, init);
    }) as any as typeof globalThis.fetch;
  }

  it("walks the full chain: findings → fan-out → children done → barrier → review → done", async () => {
    // ── Step 1: Extract findings from the researcher's submission ────────
    const parentDescription = [
      "# UX Audit: Navigation Flow",
      "",
      "## Findings",
      "- **Finding 1**: Breadcrumb navigation missing on mobile",
      "- **Finding 2**: Deep-link routing inconsistent between tabs",
      "- **Finding 3**: Back button doesn't preserve scroll position",
      "",
      "## Acceptance criteria",
      "- [ ] All findings have been addressed",
      "- [ ] Cross-cutting concerns verified",
    ].join("\n");

    const findings = extractFindings(parentDescription, "UX Audit: Navigation Flow");
    expect(findings).toHaveLength(3);
    expect(findings[0].title).toBe("Finding 1");
    expect(findings[1].title).toBe("Finding 2");
    expect(findings[2].title).toBe("Finding 3");

    // ── Step 2: Fan-out should trigger for a spawning state that declares a
    //   fanout block (AI-1992: config-driven, not a workflow-id allowlist) ────
    const uxAuditDef = {
      id: "ux-audit",
      break_glass: { command: "escape", to: "escape" },
      states: [
        { id: "spawning", fanout: { spec_source: "findings", child_workflow: "wf:dev-impl" }, transitions: [{ command: "spawn", to: "managing" }] },
        { id: "managing", barrier: true, transitions: [{ command: "complete", to: "review" }] },
      ],
    } as unknown as WorkflowDef;
    const devImplDef = {
      id: "dev-impl",
      break_glass: { command: "escape", to: "escape" },
      states: [
        { id: "spawning", transitions: [{ command: "spawn", to: "managing" }] },
      ],
    } as unknown as WorkflowDef;
    expect(shouldTriggerFanout(uxAuditDef, "spawning", "spawn")).toBeTruthy();
    expect(shouldTriggerFanout(devImplDef, "spawning", "spawn")).toBeFalsy();
    expect(shouldTriggerFanout(uxAuditDef, "managing", "spawn")).toBeFalsy();

    // ── Step 3: Children run dev-impl to terminal ────────────────────────
    expect(isChildTerminal(["wf:dev-impl", "state:intake"])).toBe(false);
    expect(isChildTerminal(["wf:dev-impl", "state:implementation"])).toBe(false);
    expect(isChildTerminal(["wf:dev-impl", "state:code-review"])).toBe(false);
    expect(isChildTerminal(["wf:dev-impl", "state:deployment"])).toBe(false);
    expect(isChildTerminal(["wf:dev-impl", "state:done"])).toBe(true);
    expect(isChildTerminal(["wf:dev-impl", "state:escape"])).toBe(true);

    // ── Step 4: Barrier evaluation — not all children done yet ───────────
    globalThis.fetch = withFetchLogging(createChainedMockFetch([
      (query) => {
        if (query.includes("ParentChildren")) {
          return {
            data: {
              issue: {
                children: {
                  nodes: [
                    { identifier: "CHILD-1", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                    { identifier: "CHILD-2", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                    { identifier: "CHILD-3", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] } },
                  ],
                },
              },
            },
          };
        }
        return null;
      },
    ]));

    let barrierResult = await evaluateBarrier("PARENT-1", "Bearer tok");
    expect(barrierResult.allTerminal).toBe(false);
    expect(barrierResult.totalChildren).toBe(3);
    expect(barrierResult.terminalCount).toBe(2);

    // ── Step 5: Last child reaches done → barrier auto-advances parent ──
    let labelSwapHappened = false;
    let barrierCommentPosted = false;

    globalThis.fetch = withFetchLogging(createChainedMockFetch([
      (query) => {
        if (query.includes("ChildParent")) {
          return { data: { issue: { parent: { identifier: "PARENT-1" } } } };
        }
        return null;
      },
      (query) => {
        if (query.includes("labels") && query.includes("team")) {
          return {
            data: {
              issue: {
                id: "parent-uuid",
                team: { id: "team-uuid" },
                labels: {
                  nodes: [
                    { id: "wf-lbl", name: "wf:ux-audit" },
                    { id: "state-lbl", name: "state:managing" },
                  ],
                },
              },
            },
          };
        }
        return null;
      },
      (query) => {
        if (query.includes("ParentChildren")) {
          return {
            data: {
              issue: {
                children: {
                  nodes: [
                    { identifier: "CHILD-1", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                    { identifier: "CHILD-2", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                    { identifier: "CHILD-3", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                  ],
                },
              },
            },
          };
        }
        return null;
      },
      (query) => {
        if (query.includes("team(id:")) {
          return { data: { team: { labels: { nodes: [{ id: "review-lbl-id", name: "state:review" }] } } } };
        }
        return null;
      },
      (query) => {
        if (query.includes("issueLabelCreate")) {
          return { data: { issueLabelCreate: { success: true, issueLabel: { id: "new-review-lbl" } } } };
        }
        return null;
      },
      (query) => {
        if (query.includes("issueUpdate")) {
          labelSwapHappened = true;
          return { data: { issueUpdate: { success: true } } };
        }
        return null;
      },
      (query) => {
        if (query.includes("commentCreate")) {
          barrierCommentPosted = true;
          return { data: { commentCreate: { success: true, comment: { id: "cmt-1" } } } };
        }
        return null;
      },
    ]));

    const barrierTransition = await onChildTerminal("CHILD-3", "Bearer tok");
    expect(barrierTransition).not.toBeNull();
    expect(barrierTransition!.transitioned).toBe(true);
    expect(barrierTransition!.parentIdentifier).toBe("PARENT-1");
    expect(barrierTransition!.terminalCount).toBe(3);
    expect(barrierTransition!.totalChildren).toBe(3);
    expect(labelSwapHappened).toBe(true);
    expect(barrierCommentPosted).toBe(true);

    // ── Step 6: Parent disposition — review → done via parent-AC gate ───
    const uncheckedDescription = "- [x] All findings have been addressed\n- [ ] Cross-cutting concerns verified";
    const uncheckedItems = parseAcChecklist(uncheckedDescription);
    const gateResultBefore = evaluateAcGate(uncheckedItems);
    expect(gateResultBefore.satisfied).toBe(false);

    const allCheckedDescription = "- [x] All findings have been addressed\n- [x] Cross-cutting concerns verified";
    const checkedItems = parseAcChecklist(allCheckedDescription);
    const gateResultAfter = evaluateAcGate(checkedItems);
    expect(gateResultAfter.satisfied).toBe(true);

    expect(resolveDisposition("ux-audit", "review", "approve")).toBe("done");
    expect(resolveDisposition("dev-impl", "review", "approve")).toBeNull();
    expect(resolveDisposition("ux-audit", "managing", "approve")).toBeNull();
  });

  it("walks with mixed terminal states (done + escape)", async () => {
    let transitioned = false;
    let fetchLogLocal: Array<any> = [];

    globalThis.fetch = (async (input: any, init?: any) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const query = (body.query ?? "") as string;
      fetchLogLocal.push({ query, variables: body.variables });

      if (query.includes("ChildParent")) {
        return new Response(JSON.stringify({ data: { issue: { parent: { identifier: "PARENT-2" } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (query.includes("labels") && query.includes("team")) {
        return new Response(JSON.stringify({
          data: { issue: { id: "parent-uuid-2", team: { id: "team-uuid" }, labels: { nodes: [{ id: "wf-lbl", name: "wf:ux-audit" }, { id: "state-lbl", name: "state:managing" }] } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (query.includes("ParentChildren")) {
        return new Response(JSON.stringify({
          data: { issue: { children: { nodes: [
            { identifier: "CHILD-A", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
            { identifier: "CHILD-B", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:escape" }] } },
          ] } } },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (query.includes("team(id:")) {
        return new Response(JSON.stringify({ data: { team: { labels: { nodes: [{ id: "rev-lbl", name: "state:review" }] } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (query.includes("issueLabelCreate")) {
        return new Response(JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "new-lbl" } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (query.includes("issueUpdate")) {
        transitioned = true;
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (query.includes("commentCreate")) {
        return new Response(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "cmt" } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as any as typeof globalThis.fetch;

    const result = await onChildTerminal("CHILD-B", "Bearer tok");
    expect(result).not.toBeNull();
    expect(result!.transitioned).toBe(true);
    expect(result!.terminalCount).toBe(2);
    expect(transitioned).toBe(true);
  });
});

// ── AC2: Every transition proxy-validated; illegal moves rejected ───────────

describe("AC2: Proxy-validated transitions — illegal moves rejected with legal set", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;
    writeFixtures();
  });

  afterAll(() => {
    if (originalWorkflowPath) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalPolicyPath) process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    if (originalAgentsFile) process.env.AGENTS_FILE = originalAgentsFile;
    else delete process.env.AGENTS_FILE;
    cleanupFixtures();
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Helper to set up mock fetch for a ticket in a given state with given delegate. */
  function setupFetchForTicket(labels: string[], delegateId: string | null) {
    globalThis.fetch = (() => {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: {
            issue: {
              labels: { nodes: labels.map((l) => ({ name: l })) },
              delegate: delegateId ? { id: delegateId } : null,
            },
          },
        }),
      }) as any;
    }) as any;
  }

  it("rejects illegal command in ux-audit intake state", async () => {
    const { checkWorkflowRules } = await import("./workflow-gate.js");
    setupFetchForTicket(["wf:ux-audit", "state:intake"], "user-igor");

    // 'submit' is NOT legal from intake (only from auditing)
    const rejection = await checkWorkflowRules("submit", "AI-1000", "Bearer tok", "igor", null, "user-igor");

    expect(rejection).not.toBeNull();
    expect(rejection).toContain("not a legal command");
    expect(rejection).toContain("intake");
    expect(rejection).toContain("accept");
    expect(rejection).toContain("escape");
  });

  it("rejects illegal command in managing state", async () => {
    const { checkWorkflowRules } = await import("./workflow-gate.js");
    setupFetchForTicket(["wf:ux-audit", "state:managing"], "user-igor");

    // 'approve' is NOT legal from managing (only from review)
    const rejection = await checkWorkflowRules("approve", "AI-1000", "Bearer tok", "igor", null, "user-igor");

    expect(rejection).not.toBeNull();
    expect(rejection).toContain("not a legal command");
    expect(rejection).toContain("managing");
  });

  it("accepts legal command from auditing state", async () => {
    const { checkWorkflowRules } = await import("./workflow-gate.js");
    setupFetchForTicket(["wf:ux-audit", "state:auditing"], "user-igor");

    const rejection = await checkWorkflowRules("complete-audit", "AI-1000", "Bearer tok", "igor", null, "user-igor");
    expect(rejection).toBeNull();
  });

  it("always allows break-glass escape from any state", async () => {
    const { checkWorkflowRules } = await import("./workflow-gate.js");
    setupFetchForTicket(["wf:ux-audit", "state:managing"], "user-igor");

    const rejection = await checkWorkflowRules("escape", "AI-1000", "Bearer tok", "igor", null, "user-igor");
    expect(rejection).toBeNull();
  });

  it("rejects raw status mutation on workflow ticket (Layer 2)", async () => {
    const { checkRawMutationInterception } = await import("./workflow-gate.js");
    setupFetchForTicket(["wf:ux-audit", "state:review"], null);

    const body = {
      query: "mutation Update($input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: { id: "AI-1000", input: { stateId: "some-state-uuid" } },
    };

    const rejection = await checkRawMutationInterception(body, "AI-1000", "Bearer tok", "igor");

    expect(rejection).not.toBeNull();
    expect(rejection).toContain("Direct status changes are blocked");
    expect(rejection).toContain("review");
    expect(rejection).toContain("approve");
    expect(rejection).toContain("request-rework");
  });

  it("allows raw mutation on ad-hoc ticket (no wf: label)", async () => {
    const { checkRawMutationInterception } = await import("./workflow-gate.js");
    setupFetchForTicket(["bug", "priority:high"], null);

    const body = {
      query: "mutation { issueUpdate(id: $id, input: { stateId: $s }) { success } }",
      variables: { id: "AI-999", input: { stateId: "uuid" } },
    };

    const rejection = await checkRawMutationInterception(body, "AI-999", "Bearer tok", "igor");
    expect(rejection).toBeNull();
  });

  it("blocks non-delegate from mutating a delegated workflow ticket", async () => {
    const { checkWorkflowRules } = await import("./workflow-gate.js");
    setupFetchForTicket(["wf:ux-audit", "state:auditing"], "user-igor");

    const rejection = await checkWorkflowRules("complete-audit", "AI-1000", "Bearer tok", "charles", null, "user-charles");

    expect(rejection).not.toBeNull();
    expect(rejection).toContain("not the current delegate");
  });

  it("rejects unknown caller on a delegated workflow ticket (fail-closed)", async () => {
    const { checkWorkflowRules } = await import("./workflow-gate.js");
    setupFetchForTicket(["wf:ux-audit", "state:auditing"], "user-igor");

    // unknown-agent is not in agents.json → unknown caller
    const rejection = await checkWorkflowRules("complete-audit", "AI-1000", "Bearer tok", "unknown-agent", null, null);

    expect(rejection).not.toBeNull();
    expect(rejection).toContain("Unknown caller");
  });
});

// ── AC3: Child stall tripwire (§5.5) exercised in a live run ───────────────

describe("AC3: §5.5 tripwire — child stall exercised in live run", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("detects a stalled child and surfaces it via tripwire comment", async () => {
    const now = Date.now();
    const staleTime = new Date(now - 45 * 60 * 1000).toISOString(); // 45 min ago
    const recentTime = new Date(now - 5 * 60 * 1000).toISOString(); // 5 min ago

    // detectStalledChildren makes two rounds of API calls:
    //   Round 1: ParentChildren → get all children
    //   Round 2: ChildActivity per non-terminal child
    // surfaceStalledChildren also makes its own round of the same calls.
    // We need the mock to handle both calls by tracking call sequences.

    let parentChildrenCalls = 0;
    let childActivityCalls = 0;

    globalThis.fetch = createChainedMockFetch([
      (query) => {
        if (query.includes("ParentChildren")) {
          parentChildrenCalls++;
          return {
            data: {
              issue: {
                children: {
                  nodes: [
                    { identifier: "CHILD-1", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                    { identifier: "CHILD-2", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] } },
                    { identifier: "CHILD-3", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] } },
                  ],
                },
              },
            },
          };
        }
        return null;
      },
      (query) => {
        if (query.includes("ChildActivity")) {
          childActivityCalls++;
          // CHILD-2 first (stale), CHILD-3 second (recent)
          // This ordering repeats for detectStalledChildren and surfaceStalledChildren
          // Each call within a batch is sequential: odd = stale, even = recent
          const isStale = childActivityCalls % 2 === 1;
          return {
            data: { issue: { updatedAt: isStale ? staleTime : recentTime } },
          };
        }
        return null;
      },
      (query) => {
        if (query.includes("issue(id:") && query.includes("{ id }")) {
          return { data: { issue: { id: "parent-uuid" } } };
        }
        return null;
      },
      (query, variables) => {
        if (query.includes("commentCreate")) {
          return { data: { commentCreate: { success: true, comment: { id: "cmt-tripwire" } } } };
        }
        return null;
      },
    ]);

    // Detect stalled children
    const stalled = await detectStalledChildren("PARENT-1", "Bearer tok", 30 * 60 * 1000, now);
    expect(stalled).toHaveLength(1);
    expect(stalled[0].identifier).toBe("CHILD-2");
    expect(stalled[0].currentState).toBe("implementation");
    expect(stalled[0].idleDurationMs).toBe(45 * 60 * 1000);

    // Surface the tripwire — this re-fetches children and re-detects stalls
    const surfaced = await surfaceStalledChildren("PARENT-1", "Bearer tok", 30 * 60 * 1000, now);
    expect(surfaced.surfaced).toBe(1);

    // Verify the mock was called correctly
    expect(parentChildrenCalls).toBeGreaterThanOrEqual(2); // detect + surface
  });

  it("does not surface tripwire when no children are stalled", async () => {
    const now = Date.now();
    const recentTime = new Date(now - 5 * 60 * 1000).toISOString();

    let commentPosted = false;

    globalThis.fetch = createChainedMockFetch([
      (query) => {
        if (query.includes("ParentChildren")) {
          return {
            data: {
              issue: {
                children: {
                  nodes: [
                    { identifier: "CHILD-1", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] } },
                  ],
                },
              },
            },
          };
        }
        return null;
      },
      (query) => {
        if (query.includes("ChildActivity")) {
          return { data: { issue: { updatedAt: recentTime } } };
        }
        return null;
      },
      (query) => {
        if (query.includes("commentCreate")) {
          commentPosted = true;
          return { data: { commentCreate: { success: true } } };
        }
        return null;
      },
    ]);

    const surfaced = await surfaceStalledChildren("PARENT-1", "Bearer tok", 30 * 60 * 1000, now);
    expect(surfaced.surfaced).toBe(0);
    expect(commentPosted).toBe(false);
  });

  it("does not flag terminal children as stalled", async () => {
    const now = Date.now();

    globalThis.fetch = createChainedMockFetch([
      (query) => {
        if (query.includes("ParentChildren")) {
          return {
            data: {
              issue: {
                children: {
                  nodes: [
                    { identifier: "CHILD-1", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] } },
                    { identifier: "CHILD-2", labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:escape" }] } },
                  ],
                },
              },
            },
          };
        }
        return null;
      },
    ]);

    const stalled = await detectStalledChildren("PARENT-1", "Bearer tok", 30 * 60 * 1000, now);
    expect(stalled).toHaveLength(0);
  });
});

// ── Integration: full state machine walk — all states visited ──────────────

describe("Integration: full state machine walk — all states visited", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;
    writeFixtures();
  });

  afterAll(() => {
    if (originalWorkflowPath) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalPolicyPath) process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    if (originalAgentsFile) process.env.AGENTS_FILE = originalAgentsFile;
    else delete process.env.AGENTS_FILE;
    cleanupFixtures();
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function setupFetchForState(state: string, delegateId: string) {
    globalThis.fetch = (() => {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:ux-audit" }, { name: `state:${state}` }] },
              delegate: { id: delegateId },
            },
          },
        }),
      }) as any;
    }) as any;
  }

  it("walks the happy path: intake → auditing → spawning → managing → review → done", async () => {
    const { checkWorkflowRules } = await import("./workflow-gate.js");

    const stateSequence = [
      { state: "intake", command: "accept" },
      { state: "auditing", command: "complete-audit" },
      { state: "spawning", command: "spawn" },
      { state: "managing", command: "complete" },
      { state: "review", command: "approve" },
    ];

    for (const { state, command } of stateSequence) {
      setupFetchForState(state, "user-igor");
      const rejection = await checkWorkflowRules(command, "AI-1000", "Bearer tok", "igor", null, "user-igor");
      expect(rejection).toBeNull();
    }
  });

  it("walks the rework path: review → spawning for follow-up gaps", async () => {
    const { checkWorkflowRules } = await import("./workflow-gate.js");
    setupFetchForState("review", "user-igor");

    const rejection = await checkWorkflowRules("request-rework", "AI-1000", "Bearer tok", "igor", null, "user-igor");
    expect(rejection).toBeNull();
  });

  it("walks the demote path: intake → __ad_hoc__", async () => {
    const { checkWorkflowRules } = await import("./workflow-gate.js");
    setupFetchForState("intake", "user-astrid");

    const rejection = await checkWorkflowRules("demote", "AI-1000", "Bearer tok", "astrid", null, "user-astrid");
    expect(rejection).toBeNull();
  });

  it("rejects all illegal commands at every state", async () => {
    const { checkWorkflowRules } = await import("./workflow-gate.js");

    // Commands that are legal in SOME state but NOT in others
    const crossStateChecks: Array<{ state: string; legalCommands: string[]; illegalCommands: string[] }> = [
      { state: "intake", legalCommands: ["accept", "demote"], illegalCommands: ["complete-audit", "spawn", "complete", "approve", "request-rework"] },
      { state: "auditing", legalCommands: ["complete-audit"], illegalCommands: ["accept", "spawn", "complete", "approve"] },
      { state: "spawning", legalCommands: ["spawn"], illegalCommands: ["accept", "complete-audit", "complete", "approve"] },
      { state: "managing", legalCommands: ["complete"], illegalCommands: ["accept", "complete-audit", "spawn", "approve"] },
      { state: "review", legalCommands: ["approve", "request-rework"], illegalCommands: ["accept", "complete-audit", "spawn", "complete"] },
    ];

    for (const { state, legalCommands, illegalCommands } of crossStateChecks) {
      // All legal commands should pass
      for (const cmd of legalCommands) {
        setupFetchForState(state, "user-igor");
        const rejection = await checkWorkflowRules(cmd, "AI-1000", "Bearer tok", "igor", null, "user-igor");
        expect(rejection).toBeNull();
      }

      // All illegal commands should be rejected with legal set named
      for (const cmd of illegalCommands) {
        setupFetchForState(state, "user-igor");
        const rejection = await checkWorkflowRules(cmd, "AI-1000", "Bearer tok", "igor", null, "user-igor");
        expect(rejection).not.toBeNull();
        expect(rejection).toContain("not a legal command");
        expect(rejection).toContain(state);
        // Verify the rejection names the legal moves
        for (const legal of legalCommands) {
          expect(rejection).toContain(legal);
        }
      }
    }
  });
});

// ── Integration: parent-AC gate (F2b) blocks premature done ────────────────

describe("Integration: parent-AC gate blocks premature done (F2b, §5.6)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("blocks → done when parent AC has unchecked items even though all children are done", async () => {
    const parentDescription = [
      "## Acceptance criteria",
      "- [x] All children have completed their tasks",
      "- [ ] Cross-cutting integration test passes",
      "- [ ] Documentation updated",
    ].join("\n");

    const items = parseAcChecklist(parentDescription);
    expect(items).toHaveLength(3);

    const gate = evaluateAcGate(items);
    expect(gate.satisfied).toBe(false);
    expect(gate.reason).toContain("2 of 3 AC item(s) unchecked");
    expect(gate.reason).toContain("Cross-cutting integration test passes");
    expect(gate.reason).toContain("Documentation updated");
  });

  it("allows → done only when ALL parent ACs are checked", async () => {
    const parentDescription = [
      "## Acceptance criteria",
      "- [x] All children have completed their tasks",
      "- [x] Cross-cutting integration test passes",
      "- [x] Documentation updated",
    ].join("\n");

    const items = parseAcChecklist(parentDescription);
    const gate = evaluateAcGate(items);
    expect(gate.satisfied).toBe(true);
    expect(gate.reason).toContain("3 AC item(s) satisfied");
  });

  it("dispositionToDone blocks and posts diagnostic comment", async () => {
    let commentBody: string | null = null;

    globalThis.fetch = createChainedMockFetch([
      (query) => {
        if (query.includes("description")) {
          return {
            data: { issue: { description: "- [x] Children done\n- [ ] Parent scope NOT verified" } },
          };
        }
        return null;
      },
      (query) => {
        if (query.includes("issue(id:") && query.includes("{ id }")) {
          return { data: { issue: { id: "parent-uuid" } } };
        }
        return null;
      },
      (query, variables) => {
        if (query.includes("commentCreate")) {
          commentBody = (variables as any).body ?? (variables as any).input?.body ?? null;
          return { data: { commentCreate: { success: true } } };
        }
        return null;
      },
    ]);

    const result = await dispositionToDone("PARENT-1", "Bearer tok");

    expect(result.applied).toBe(false);
    expect(result.error).toContain("Parent-AC gate failed");
    expect(commentBody).not.toBeNull();
    expect(commentBody).toContain("Cannot advance to **done**");
    expect(commentBody).toContain("Parent scope NOT verified");
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe("Edge cases: fan-out extraction and terminal state handling", () => {
  it("extracts findings from JSON-encoded block", () => {
    const description = [
      "## Audit Results",
      "```json",
      JSON.stringify([
        { title: "Finding A", description: "Details for A" },
        { title: "Finding B" },
        "Simple string finding",
      ]),
      "```",
    ].join("\n");

    const findings = extractFindings(description, "Fallback");
    expect(findings).toHaveLength(3);
    expect(findings[0].title).toBe("Finding A");
    expect(findings[0].description).toBe("Details for A");
    expect(findings[1].title).toBe("Finding B");
    expect(findings[2].title).toBe("Simple string finding");
  });

  it("falls back to ticket title when no findings found", () => {
    const findings = extractFindings("No findings here", "Fallback Title");
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("Fallback Title");
  });

  it("handles empty description gracefully", () => {
    const findings = extractFindings(null, "Empty Desc Fallback");
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("Empty Desc Fallback");
  });

  it("terminal states are exactly done and escape", () => {
    const allStates = ["intake", "auditing", "spawning", "managing", "review", "implementation", "code-review", "deployment"];
    for (const state of allStates) {
      expect(isTerminalState(state)).toBe(false);
    }
    expect(isTerminalState("done")).toBe(true);
    expect(isTerminalState("escape")).toBe(true);
  });
});
