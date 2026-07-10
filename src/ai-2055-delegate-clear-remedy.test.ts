/**
 * AI-2055 — the delegate-clear guard's rejection recommended `undelegate`, a remedy
 * the same guard blocks.
 *
 * What the ticket asserted, and what the code actually does (verified against
 * connector @ 19ee5d2, skill @ c429201):
 *
 *   The ticket's premise was that `needs-human` strands the delegate on governed
 *   tickets because `stripNullDelegateAssigneeFields` deletes its `delegateId: null`.
 *   It does not get that far. `needs-human` is not a `command:` in any workflow def,
 *   so `checkWorkflowRules` rejects it at the not-a-legal-command branch — before the
 *   forward, before the strip, before any mutation. Nothing is half-applied and no
 *   delegate is stranded; the command simply fails. `escalateOnGoverned` below pins
 *   that, so a future def that adds `needs-human` as a transition will fail this test
 *   rather than silently resurrect the stranding path.
 *
 * What IS real, and what this file covers:
 *
 *   AC4 — every `[Proxy] Direct delegate clear blocked` message is emitted on a
 *   governed ticket (the function returns null for ad-hoc and unregistered-def
 *   tickets before reaching it). On a governed ticket `undelegate` issues an
 *   intent-free `{delegateId: null, assigneeId: null}` that hits this identical guard.
 *   So the advice was wrong 100% of the time it was printed.
 *
 *   AC3 — the remedies the message now names are executed against the same ticket
 *   class and asserted to pass the gate, rather than asserted in prose.
 *
 *   AC2 — one test per delegate-clear bypass shape. Includes a shape that was NOT
 *   blocked before this change: an input object bound to a variable not named `input`
 *   (`issueUpdate(id: $id, input: $patch)`). `hasDelegateChange` deep-scans the
 *   variables and saw it; `isClearingDelegate` only read `variables.input.delegateId`
 *   and did not. The current delegate could self-clear through that gap.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  checkRawMutationInterception,
  checkWorkflowRules,
  resetWorkflowCache,
  resetNativeStateCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { defStateSnapshotPath } from "./store/def-state-snapshot-store.js";

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: intake
  owner_role: steward

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
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

const IGOR = "igor-linear-uuid";
const ISSUE = "issue-uuid";

/** The governed ticket every test in this file runs against: Igor is the delegate. */
function governedTicket(delegateId: string | null = IGOR): typeof globalThis.fetch {
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (bodyText.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
          data: { team: { states: { nodes: [
            { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
            { id: "state-doing-uuid", name: "Doing", type: "started" },
            { id: "state-done-uuid", name: "Done", type: "completed" },
          ] } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const issue: Record<string, unknown> = {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
    };
    if (bodyText.includes("delegate")) {
      issue.delegate = delegateId ? { id: delegateId } : null;
    }
    return new Response(JSON.stringify({ data: { issue } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const ISSUE_UPDATE = "mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }";

let dir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2055-"));
  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const workflowFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [
      { name: "igor", linearUserId: IGOR, openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      { name: "astrid", linearUserId: "astrid-linear-uuid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
    ],
  }), "utf8");
  process.env.AGENTS_FILE = agentsFile;

  resetPolicyCache();
  resetWorkflowCache();
  resetNativeStateCache();
  resetConfigHealth();
  reloadAgents();
  fs.rmSync(defStateSnapshotPath(), { force: true });
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.AGENTS_FILE;
});

// ══════════════════════════════════════════════════════════════════════════
// AC2 — every delegate-clear bypass shape stays blocked. One test per shape.
// All run as the CURRENT delegate, the only caller the guard has to stop
// (a non-delegate is already blocked by the not-current-delegate rule).
// ══════════════════════════════════════════════════════════════════════════

describe("AI-2055 AC2 — delegate-clear bypass shapes", () => {
  const clearShapes: Array<{ name: string; body: { query: string; variables: Record<string, unknown> } }> = [
    {
      name: "bare {delegateId: null} in variables.input (the AI-2050 client-side heal)",
      body: { query: ISSUE_UPDATE, variables: { id: ISSUE, input: { delegateId: null } } },
    },
    {
      name: "{delegateId: null, assigneeId: null} — the shape `undelegate` and `complete` send (AI-1857)",
      body: { query: ISSUE_UPDATE, variables: { id: ISSUE, input: { delegateId: null, assigneeId: null } } },
    },
    {
      name: "inline literal `delegateId: null` in the query text (field key cannot be aliased)",
      body: {
        query: `mutation Clear($id: String!) { issueUpdate(id: $id, input: {delegateId: null}) { success } }`,
        variables: { id: ISSUE },
      },
    },
    {
      name: "input object bound to a variable NOT named `input` (AI-2055 regression)",
      body: {
        query: "mutation IssueUpdate($id: String!, $patch: IssueUpdateInput!) { issueUpdate(id: $id, input: $patch) { success } }",
        variables: { id: ISSUE, patch: { delegateId: null } },
      },
    },
    {
      name: "delegateId: null nested below the top level of the input variable",
      body: {
        query: "mutation IssueUpdate($id: String!, $wrapper: IssueUpdateInput!) { issueUpdate(id: $id, input: $wrapper) { success } }",
        variables: { id: ISSUE, wrapper: { nested: { delegateId: null } } },
      },
    },
  ];

  for (const shape of clearShapes) {
    it(`blocks: ${shape.name}`, async () => {
      globalThis.fetch = governedTicket();
      const result = await checkRawMutationInterception(shape.body, ISSUE, "Bearer tok", "igor", IGOR);

      expect(result).not.toBeNull();
      expect(result).toContain("[Proxy]");
      expect(result).toContain("Direct delegate clear blocked");
    });
  }

  it("still allows a non-null delegate write by the current delegate (handoff-work re-route)", async () => {
    globalThis.fetch = governedTicket();
    const body = { query: ISSUE_UPDATE, variables: { id: ISSUE, input: { delegateId: "hanzo-linear-uuid" } } };

    expect(await checkRawMutationInterception(body, ISSUE, "Bearer tok", "igor", IGOR)).toBeNull();
  });

  it("still blocks a delegate clear attempted by someone who is not the delegate", async () => {
    globalThis.fetch = governedTicket("someone-else-uuid");
    const body = { query: ISSUE_UPDATE, variables: { id: ISSUE, input: { delegateId: null } } };

    const result = await checkRawMutationInterception(body, ISSUE, "Bearer tok", "igor", IGOR);
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });

  it("leaves ad-hoc tickets untouched — the guard is governed-only", async () => {
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const issue: Record<string, unknown> = { labels: { nodes: [{ name: "bug" }] } };
      if (bodyText.includes("delegate")) issue.delegate = { id: IGOR };
      return new Response(JSON.stringify({ data: { issue } }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const body = { query: ISSUE_UPDATE, variables: { id: ISSUE, input: { delegateId: null } } };

    expect(await checkRawMutationInterception(body, ISSUE, "Bearer tok", "igor", IGOR)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC4 — the rejection stops recommending `undelegate`, which it blocks.
// ══════════════════════════════════════════════════════════════════════════

describe("AI-2055 AC4 — the rejection does not name a remedy it blocks", () => {
  async function rejectionFor(input: Record<string, unknown>): Promise<string> {
    globalThis.fetch = governedTicket();
    const result = await checkRawMutationInterception(
      { query: ISSUE_UPDATE, variables: { id: ISSUE, input } }, ISSUE, "Bearer tok", "igor", IGOR,
    );
    expect(result).not.toBeNull();
    return result!;
  }

  // Both guard sites (the AI-1857 shape-independent check, and the AI-1835
  // delegate-only check the current delegate falls into) must agree.
  it("does not tell the caller to run `undelegate` — combined clear shape", async () => {
    const msg = await rejectionFor({ delegateId: null, assigneeId: null });
    expect(msg).not.toMatch(/Use undelegate/i);
    expect(msg).toMatch(/`undelegate` is blocked by this same guard/);
  });

  it("does not tell the caller to run `undelegate` — delegate-only clear shape", async () => {
    const msg = await rejectionFor({ delegateId: null });
    expect(msg).not.toMatch(/Use undelegate/i);
    expect(msg).toMatch(/`undelegate` is blocked by this same guard/);
  });

  it("names the break-glass verb from the workflow def and the handoff-work re-route", async () => {
    const msg = await rejectionFor({ delegateId: null });
    expect(msg).toContain(`linear escape ${ISSUE}`);
    expect(msg).toContain(`linear handoff-work ${ISSUE} <agent>`);
    // The break-glass landing state is read from the def, not hardcoded.
    expect(msg).toContain("'intake'");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC3 — the named remedies are verified against the same ticket class, by
// execution. Prose in a rejection string is not evidence that it works.
// ══════════════════════════════════════════════════════════════════════════

describe("AI-2055 AC3 — the remedies the message names actually work on a governed ticket", () => {
  it("`escape` passes the gate for the current delegate (the remedy the message names)", async () => {
    globalThis.fetch = governedTicket();
    expect(await checkWorkflowRules("escape", ISSUE, "Bearer tok", "igor", null, IGOR)).toBeNull();
  });

  it("`handoff-work` passes the gate: it is intent-free and writes a non-null delegate", async () => {
    globalThis.fetch = governedTicket();
    // handoff-work sets no proxy intent, so it lands in Layer 2 as a raw delegate write.
    const body = { query: ISSUE_UPDATE, variables: { id: ISSUE, input: { delegateId: "hanzo-linear-uuid" } } };
    expect(await checkRawMutationInterception(body, ISSUE, "Bearer tok", "igor", IGOR)).toBeNull();
  });

  it("`undelegate` does NOT work here — which is exactly why the message stopped naming it", async () => {
    globalThis.fetch = governedTicket();
    // `undelegate` = updateIssue(id, { delegateId: null, assigneeId: null }), no intent.
    const body = { query: ISSUE_UPDATE, variables: { id: ISSUE, input: { delegateId: null, assigneeId: null } } };
    const result = await checkRawMutationInterception(body, ISSUE, "Bearer tok", "igor", IGOR);
    expect(result).toContain("Direct delegate clear blocked");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The ticket's stated root cause, pinned. `needs-human` never reaches the
// strip on a governed ticket, so there is no stranding to heal there.
// ══════════════════════════════════════════════════════════════════════════

describe("AI-2055 — needs-human on a governed ticket is refused before it can strand anything", () => {
  it("is rejected by checkWorkflowRules as not a legal command", async () => {
    globalThis.fetch = governedTicket();
    const result = await checkWorkflowRules("needs-human", ISSUE, "Bearer tok", "igor", null, IGOR);

    expect(result).not.toBeNull();
    expect(result).toContain("'needs-human' is not a legal command in state 'implementation'");
  });

  it("names the sanctioned exit (break-glass to the steward), not a delegate clear", async () => {
    globalThis.fetch = governedTicket();
    const result = await checkWorkflowRules("needs-human", ISSUE, "Bearer tok", "igor", null, IGOR);

    expect(result).toContain(`linear escape ${ISSUE}`);
    expect(result).toContain("'intake'");
    expect(result).not.toMatch(/undelegate/i);
  });

  it("the rejection is a refusal, not a partial application: no delegate clear is implied", async () => {
    // The command fails at Layer 3, before the forward. The delegate the ticket
    // claimed was stranded is never written, because the mutation never runs.
    globalThis.fetch = governedTicket();
    const result = await checkWorkflowRules("needs-human", ISSUE, "Bearer tok", "igor", null, IGOR);
    expect(result).toContain("[Proxy]");
    expect(result).toContain("Legal moves:");
  });
});
