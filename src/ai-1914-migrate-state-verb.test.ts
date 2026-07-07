/**
 * AI-1914 — AC2 + AC5 (steward-blocked): the `migrate-state <id> <target>`
 * fallback verb.
 *
 * AC2: a `migrate-state` command, capability-gated to `workflow:break-glass`
 * and audited like escape, performs a targeted non-lossy migration when no map
 * exists. Target must be a state in the live def; delegate is set per the target
 * state's owner role.
 *
 * AC5: the steward verb must be PROVEN blocked for non-steward callers.
 *
 * Transport contract (implementer conforms): the CLI sends the workflow intent
 * `migrate-state` with the target state carried in the `X-Openclaw-Migrate-Target`
 * header. The gate authorizes on the `workflow:break-glass` capability.
 *
 * These tests exercise the real proxy (`POST /proxy/graphql`) and are RED until
 * the verb exists: today `migrate-state` is an unknown intent, so a steward's
 * request is rejected (must become allowed) and a non-steward's rejection does
 * not name the verb / capability gate (must become a capability denial).
 */

import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

// astrid = steward (workflow:break-glass); hanzo = deployment role (NO break-glass).
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

// Live dev-impl def WITHOUT `deployment` — a ticket at state:deployment is the
// stranded, no-map case that migrate-state exists to rescue.
const WORKFLOW_YAML = `
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

const DEFUNCT_TICKET_RESPONSE = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] },
      delegate: { id: "user-hanzo" },
    },
  },
};

const MOCK_MUTATION_SUCCESS = { data: { issueUpdate: { success: true } } };

const MIGRATE_MUTATION = {
  query: "mutation M($id: String!) { issueUpdate(id: $id, input: { labelIds: [\"lbl-acvalidate\"] }) { success } }",
  variables: { id: "issue-1857" },
};

let dir: string;
let appState: ReturnType<typeof createApp>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1914-migrate-"));

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "user-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "hanzo", linearUserId: "user-hanzo", openclawAgent: "hanzo", accessToken: "tok-hanzo", host: "local" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = agentsFile;

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const defFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(defFile, WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = defFile;
  delete process.env.WORKFLOW_DEFS_DIR;

  resetPolicyCache();
  resetWorkflowCache();
  resetConfigHealth();
  reloadAgents();

  appState = createApp({
    bagDbPath: path.join(dir, "bag.db"),
    agentQueueDbPath: path.join(dir, "queue.db"),
    operationalEventsDbPath: path.join(dir, "events.db"),
  });
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  appState.bag.close();
  appState.sessionTracker.close();
  appState.agentQueue.close();
  appState.operationalEventStore.close();
  appState.watchdog.stop();
  appState.noActivityDetector.stop();
  appState.managingPoller.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENTS_FILE;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.WORKFLOW_DEF_PATH;
});

function makeFetch(labelResponse: object, mutationResponse = MOCK_MUTATION_SUCCESS): typeof globalThis.fetch {
  return (async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      return originalFetch(url as never, init);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const parsed = bodyText ? (JSON.parse(bodyText) as { query?: string }) : {};
    if (parsed.query?.includes("IssueContext") || parsed.query?.includes("IssueLabels") || parsed.query?.includes("delegate")) {
      return new Response(JSON.stringify(labelResponse), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(mutationResponse), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
}

describe("AC2: migrate-state is capability-gated to workflow:break-glass", () => {
  it("AC5: rejects migrate-state from a non-steward body (hanzo/deployment — no break-glass)", async () => {
    globalThis.fetch = makeFetch(DEFUNCT_TICKET_RESPONSE);
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-hanzo")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "migrate-state")
      .set("X-Openclaw-Migrate-Target", "ac-validate")
      .send(MIGRATE_MUTATION);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    // The rejection must be a CAPABILITY denial that identifies the caller as not
    // holding workflow:break-glass — mirroring the existing break-glass identity
    // gate ("caller 'x' is not the recovery steward"). The current defunct-state
    // message (which merely says "contact a steward") names neither the caller nor
    // the capability, so this is RED today and GREEN only once the gate exists.
    const msg = res.body.errors[0].message as string;
    expect(msg).toMatch(/steward|break.glass|capabilit|authoriz/i);
    expect(msg).toMatch(/hanzo|caller|not authoriz|only the steward|workflow:break-glass/i);
  });

  it("allows migrate-state from a steward body (astrid) — the sanctioned non-lossy path", async () => {
    globalThis.fetch = makeFetch(DEFUNCT_TICKET_RESPONSE);
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "migrate-state")
      .set("X-Openclaw-Migrate-Target", "ac-validate")
      .send(MIGRATE_MUTATION);

    expect(res.status).toBe(200);
    // A steward migrating a stranded ticket to a live state must NOT be rejected.
    expect(res.body.errors).toBeUndefined();
  });

  it("rejects migrate-state whose target is not a state in the live def (even for a steward)", async () => {
    globalThis.fetch = makeFetch(DEFUNCT_TICKET_RESPONSE);
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "migrate-state")
      .set("X-Openclaw-Migrate-Target", "no-such-state")
      .send(MIGRATE_MUTATION);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/target|not a (valid|live|known) state|no-such-state/i);
  });
});
