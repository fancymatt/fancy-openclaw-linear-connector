/**
 * AI-1914 — AC4 + AC5 (raw-swap-blocked): close the raw-mutation fail-open on
 * defunct-state tickets.
 *
 * `checkRawMutationInterception` currently hits `if (!stateNode) return null;
 * // unknown state — fail-open` (workflow-gate.ts ~2051) when a governed
 * ticket's `state:*` label names a state that is not in the live def. That
 * fail-OPEN is exactly how AI-1857 was migrated by a raw label swap through an
 * unaudited hole — and it lets ANY known caller silently rewrite workflow
 * state on any ticket stranded by a def change.
 *
 * AC4: that branch must fail CLOSED — block the raw mutation and point the
 * caller at the sanctioned path (`migrate-state` / steward). AC5 requires that
 * a raw label swap on a defunct-state ticket is proven blocked.
 *
 * These tests are RED against the current fail-open behavior.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { checkRawMutationInterception, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";

// A live dev-impl def that does NOT contain `deployment` (it was removed in the
// merge/deploy split, v13). A ticket still labeled state:deployment is therefore
// at a defunct state relative to this def.
const DEF_YAML = `
id: dev-impl
version: 14
entry_state: intake
break_glass:
  command: escape
  to: escape
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    native_state: doing
    transitions:
      - command: submit
        to: ac-validate
  - id: ac-validate
    owner_role: steward
    native_state: doing
    transitions:
      - command: validated
        to: done
  - id: done
    native_state: done
    transitions: []
  - id: escape
    native_state: invalid
    transitions: []
`;

// hanzo is a KNOWN caller (deployment role) — this is the crux: the fail-open
// let a *known* non-steward caller through. The test must reach the defunct-state
// branch, not be blocked earlier by the unknown-caller guard.
const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
  - id: deploy:execute
containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
  - id: deployment
    grants: [linear:transition, deploy:execute]
roles:
  - id: steward
    requires: [workflow:break-glass]
  - id: deployment
    requires: [deploy:execute]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
`;

let dir: string;
let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1914-raw-"));
  const defFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(defFile, DEF_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = defFile;
  delete process.env.WORKFLOW_DEFS_DIR;

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  resetWorkflowCache();
  resetPolicyCache();
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.CAPABILITY_POLICY_PATH;
});

// fetchTicketContext issues `query IssueContext`. Return a governed ticket at
// the defunct `state:deployment`.
function makeDefunctStateFetch(): typeof globalThis.fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const parsed = bodyText ? (JSON.parse(bodyText) as { query?: string }) : {};
    if (parsed.query?.includes("IssueContext")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] },
              delegate: { id: "user-hanzo" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
      status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
}

// A raw issueUpdate that swaps the workflow state label — the exact AI-1857
// migration shape (raw stateId + labelIds mutation, no intent header).
const RAW_STATE_SWAP_BODY = {
  query: "mutation M($id: String!, $stateId: String!, $labelIds: [String!]) { issueUpdate(id: $id, input: { stateId: $stateId, labelIds: $labelIds }) { success } }",
  variables: { id: "issue-1857", stateId: "state-acvalidate-uuid", labelIds: ["lbl-acvalidate"] },
};

describe("AC4: checkRawMutationInterception fails CLOSED on a defunct-state governed ticket", () => {
  it("blocks a raw state/label swap on a state:deployment ticket (def has no deployment state)", async () => {
    globalThis.fetch = makeDefunctStateFetch();
    // hanzo is a known, non-steward caller — the fail-open let exactly this through.
    const result = await checkRawMutationInterception(
      RAW_STATE_SWAP_BODY,
      "issue-1857",
      "Bearer tok-hanzo",
      "hanzo",
      "user-hanzo",
    );
    // Currently returns null (fail-open at ~2051). AC4 requires a non-null block.
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });

  it("the block points the caller at the sanctioned migrate-state / steward path", async () => {
    globalThis.fetch = makeDefunctStateFetch();
    const result = await checkRawMutationInterception(
      RAW_STATE_SWAP_BODY,
      "issue-1857",
      "Bearer tok-hanzo",
      "hanzo",
      "user-hanzo",
    );
    // The message must direct the caller to the sanctioned path so closing the
    // hole does not recreate the AI-1857 deadlock (admin-console-only recovery).
    expect(result).toMatch(/migrate-state|steward/i);
  });
});
