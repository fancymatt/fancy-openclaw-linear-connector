/**
 * AI-1954 — Tests for ops actions + admin actor-attribution fix (Phase 3 / Wave 1).
 *
 * AC1: set-state/recapture-ac without invoker+reason → 400; with them →
 *      mutation_audit row records op, invoker, reason (regression test).
 * AC2: Audit comment posts on the ticket for every admin mutation, naming the
 *      true invoker.
 * AC3: Terminal set-state from a gated state without `force` → refused with
 *      explanatory error.
 *
 * These tests FAIL against the current implementation by design. The
 * implementation is expected to add `invoker` and `reason` fields to the
 * admin mutation endpoints and record them in mutation_audit.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { createApp } from "./index.js";
import { MutationAuditStore } from "./store/mutation-audit-store.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetWorkflowCache } from "./workflow-gate.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-1954-test-"));
}

const ADMIN_SECRET = "ai-1954-admin-secret";

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      {
        name: "astrid",
        linearUserId: "user-astrid-linear-id",
        openclawAgent: "astrid",
        clientId: "client-id",
        clientSecret: "client-secret",
        accessToken: "access-token-astrid",
        refreshToken: "refresh-token-astrid",
        host: "local",
      },
    ],
  }), "utf8");
  return file;
}

function writePolicyYaml(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  const policy = {
    capabilities: [
      { id: "linear:transition" },
      { id: "human:escalate" },
    ],
    containers: [
      { id: "steward", grants: ["linear:transition", "human:escalate"] },
      { id: "dev", grants: ["linear:transition"] },
    ],
    roles: [
      { id: "steward", requires: ["human:escalate"] },
      { id: "dev", requires: ["linear:transition"] },
    ],
    bodies: [
      { id: "astrid", container: "steward", fills_roles: ["steward"] },
      { id: "igor", container: "dev", fills_roles: ["dev"] },
    ],
  };
  fs.writeFileSync(file, yaml.dump(policy), "utf8");
  return file;
}

function writeWorkflowDef(dir: string): string {
  const file = path.join(dir, "dev-impl.yaml");
  const def = {
    id: "dev-impl",
    version: 1,
    entry_state: "intake",
    break_glass: { command: "escape", to: "escape", owner_role: "steward" },
    states: [
      { id: "intake", owner_role: "steward", kind: "normal", native_state: "todo", transitions: [{ command: "accept", to: "implementation" }] },
      { id: "implementation", owner_role: "dev", kind: "normal", native_state: "todo", transitions: [{ command: "submit", to: "done" }] },
      { id: "done", kind: "terminal", native_state: "done" },
      { id: "escape", kind: "terminal", native_state: "invalid" },
    ],
  };
  fs.writeFileSync(file, yaml.dump(def), "utf8");
  return file;
}

const MOCK_TEAM_STATES = [
  { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
  { id: "state-done-uuid", name: "Done", type: "completed" },
  { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
];

/**
 * Tracks calls to the Linear commentCreate mutation so tests can assert
 * that an audit comment was posted with the invoker's name.
 */
function makeAdminMutationFetch(opts: {
  fromLabels?: string[];
  consistencyLabels?: string[];
  capturedComments?: string[];
  descriptionWithAc?: string;
}): typeof globalThis.fetch {
  const {
    fromLabels = ["wf:dev-impl", "state:implementation"],
    capturedComments = [],
    descriptionWithAc = "## Acceptance Criteria\n* AC1: does a thing",
  } = opts;

  let issueCallCount = 0;
  const consistencyLabels = opts.consistencyLabels ?? fromLabels;

  return async (_url, init) => {
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Buffer
          ? init.body.toString()
          : "";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";

    if (query.includes("TeamStates")) {
      return new Response(
        JSON.stringify({ data: { team: { states: { nodes: MOCK_TEAM_STATES } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "label-state-done-uuid", name: "state:done" },
                  { id: "label-state-escape-uuid", name: "state:escape" },
                  { id: "label-state-implementation-uuid", name: "state:implementation" },
                  { id: "label-wf-dev-impl-uuid", name: "wf:dev-impl" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("IssueWithLabels")) {
      const labels = issueCallCount++ === 0 ? fromLabels : consistencyLabels;
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-issue-uuid",
              team: { id: "team-uuid" },
              labels: {
                nodes: labels.map((name) => ({
                  id: `label-${name.replace(/[:/]/g, "-")}-uuid`,
                  name,
                })),
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("ApplyAtomicTransition") || (query.includes("issueUpdate") && query.includes("labelIds"))) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // AI-1762 verified read-after-write: setStateAtomic reads the issue back to
    // confirm the write persisted (state label + native state). Reflect the
    // post-write (consistency) labels and the native state the target resolves to.
    if (query.includes("VerifyTransitionWrite")) {
      const nativeByState: Record<string, string> = {
        "state:intake": "state-todo-uuid",
        "state:implementation": "state-todo-uuid",
        "state:done": "state-done-uuid",
        "state:escape": "state-invalid-uuid",
      };
      const stateLabel = consistencyLabels.find((l) => l.startsWith("state:"));
      const nativeId = stateLabel ? nativeByState[stateLabel] ?? null : null;
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: consistencyLabels.map((name) => ({ name })) },
              delegate: null,
              state: nativeId ? { id: nativeId } : null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("commentCreate")) {
      // Capture the body text for AC2 assertions.
      const vars = parsed.variables as { input?: { body?: string } } | undefined;
      const body = vars?.input?.body ?? bodyText;
      capturedComments.push(body);
      return new Response(
        JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "cmt-audit-1" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // IssueDescription for recapture-ac
    if (query.includes("IssueDescription") || query.includes("issue(id:")) {
      return new Response(
        JSON.stringify({ data: { issue: { description: descriptionWithAc } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe("AI-1954 — invoker+reason attribution on admin mutation endpoints", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let mutationAuditDbPath: string;

  beforeEach(() => {
    dir = tempDir();
    const policyFile = writePolicyYaml(dir);
    const agentsFile = writeAgents(dir);
    const wfDir = path.join(dir, "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    writeWorkflowDef(wfDir);
    mutationAuditDbPath = path.join(dir, "mutation-audit.db");

    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.AGENTS_FILE = agentsFile;
    process.env.WORKFLOW_DEF_DIR = wfDir;
    process.env.AC_RECORDS_PATH = path.join(dir, "ac-records.json");

    reloadAgents();
    resetPolicyCache();
    resetWorkflowCache();
    originalFetch = globalThis.fetch;

    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
      mutationAuditDbPath,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.mutationAuditStore.close();
    resetPolicyCache();
    resetWorkflowCache();
    delete process.env.ADMIN_SECRET;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    delete process.env.WORKFLOW_DEF_DIR;
    delete process.env.AC_RECORDS_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── AC1: set-state requires invoker+reason ─────────────────────────────

  describe("AC1 — POST /admin/api/set-state invoker+reason validation", () => {
    it("returns 400 when invoker is missing", async () => {
      const res = await request(appState.app)
        .post("/admin/api/set-state")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({ ticketId: "AI-1954", targetState: "implementation", reason: "testing" })
        .expect(400);

      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/invoker/i);
    });

    it("returns 400 when reason is missing", async () => {
      const res = await request(appState.app)
        .post("/admin/api/set-state")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({ ticketId: "AI-1954", targetState: "implementation", invoker: "astrid" })
        .expect(400);

      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/reason/i);
    });

    it("returns 400 when both invoker and reason are missing", async () => {
      const res = await request(appState.app)
        .post("/admin/api/set-state")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({ ticketId: "AI-1954", targetState: "implementation" })
        .expect(400);

      expect(res.body.ok).toBe(false);
    });

    it("AC1: set-state with invoker+reason writes mutation_audit row with op, invoker, reason", async () => {
      globalThis.fetch = makeAdminMutationFetch({
        fromLabels: ["wf:dev-impl", "state:intake"],
        consistencyLabels: ["wf:dev-impl", "state:implementation"],
      });

      await request(appState.app)
        .post("/admin/api/set-state")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({
          ticketId: "AI-1954",
          targetState: "implementation",
          invoker: "astrid",
          reason: "manual correction after mis-route",
        })
        .expect(200);

      // The mutation_audit store must contain a row for this admin operation.
      const auditStore = new MutationAuditStore(mutationAuditDbPath);
      const rows = auditStore.byTicket("AI-1954");
      auditStore.close();

      expect(rows.length).toBeGreaterThan(0);
      const adminRow = rows.find((r) => r.intent === "set-state" || r.opName === "set-state" || (r as Record<string, unknown>).op === "set-state");
      expect(adminRow).toBeDefined();
      // The row must carry the invoker identity and reason.
      const invoker = (adminRow as Record<string, unknown>).invoker ?? adminRow?.actorId;
      const reason = (adminRow as Record<string, unknown>).reason ?? adminRow?.intent;
      expect(invoker).toBe("astrid");
      expect(reason).toBe("manual correction after mis-route");
    });
  });

  // ── AC1: recapture-ac requires invoker+reason ──────────────────────────

  describe("AC1 — POST /admin/api/recapture-ac invoker+reason validation", () => {
    it("returns 400 when invoker is missing", async () => {
      const res = await request(appState.app)
        .post("/admin/api/recapture-ac")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({ ticketId: "AI-1954", callerBodyId: "astrid", reason: "re-capture after spec change" })
        .expect(400);

      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/invoker/i);
    });

    it("returns 400 when reason is missing", async () => {
      const res = await request(appState.app)
        .post("/admin/api/recapture-ac")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({ ticketId: "AI-1954", callerBodyId: "astrid", invoker: "astrid" })
        .expect(400);

      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/reason/i);
    });

    it("AC1 regression: recapture-ac with invoker+reason writes mutation_audit row with op, invoker, reason", async () => {
      globalThis.fetch = makeAdminMutationFetch({});

      await request(appState.app)
        .post("/admin/api/recapture-ac")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({
          ticketId: "AI-1954",
          callerBodyId: "astrid",
          invoker: "astrid",
          reason: "spec updated by PM",
        })
        .expect(200);

      const auditStore = new MutationAuditStore(mutationAuditDbPath);
      const rows = auditStore.byTicket("AI-1954");
      auditStore.close();

      expect(rows.length).toBeGreaterThan(0);
      const adminRow = rows.find(
        (r) =>
          r.intent === "recapture-ac" ||
          r.opName === "recapture-ac" ||
          (r as Record<string, unknown>).op === "recapture-ac",
      );
      expect(adminRow).toBeDefined();
      const invoker = (adminRow as Record<string, unknown>).invoker ?? adminRow?.actorId;
      const reason = (adminRow as Record<string, unknown>).reason ?? adminRow?.intent;
      expect(invoker).toBe("astrid");
      expect(reason).toBe("spec updated by PM");
    });
  });

  // ── AC2: audit comment posts naming the true invoker ───────────────────

  describe("AC2 — audit comment names the true invoker on every admin mutation", () => {
    it("set-state posts a Linear comment containing the invoker name", async () => {
      const capturedComments: string[] = [];
      globalThis.fetch = makeAdminMutationFetch({
        fromLabels: ["wf:dev-impl", "state:intake"],
        consistencyLabels: ["wf:dev-impl", "state:implementation"],
        capturedComments,
      });

      await request(appState.app)
        .post("/admin/api/set-state")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({
          ticketId: "AI-1954",
          targetState: "implementation",
          invoker: "astrid",
          reason: "mis-route correction",
        })
        .expect(200);

      // At least one commentCreate must have fired naming the invoker.
      expect(capturedComments.length).toBeGreaterThan(0);
      const auditComment = capturedComments.find((c) => c.includes("astrid"));
      expect(auditComment).toBeDefined();
      // The comment should describe the operation and transition.
      expect(auditComment).toMatch(/set-state/i);
    });

    it("recapture-ac posts a Linear comment containing the invoker name", async () => {
      const capturedComments: string[] = [];
      globalThis.fetch = makeAdminMutationFetch({ capturedComments });

      await request(appState.app)
        .post("/admin/api/recapture-ac")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({
          ticketId: "AI-1954",
          callerBodyId: "astrid",
          invoker: "astrid",
          reason: "spec updated by PM",
        })
        .expect(200);

      expect(capturedComments.length).toBeGreaterThan(0);
      const auditComment = capturedComments.find((c) => c.includes("astrid"));
      expect(auditComment).toBeDefined();
      expect(auditComment).toMatch(/recapture-ac/i);
    });
  });

  // ── AC3: terminal set-state from gated state requires force ────────────

  describe("AC3 — terminal set-state from a gated state requires force", () => {
    it("returns an error when targeting a terminal state from a gated (non-terminal) workflow state without force", async () => {
      // Ticket is currently in a non-terminal workflow state (implementation).
      globalThis.fetch = makeAdminMutationFetch({
        fromLabels: ["wf:dev-impl", "state:implementation"],
        consistencyLabels: ["wf:dev-impl", "state:done"],
      });

      const res = await request(appState.app)
        .post("/admin/api/set-state")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({
          ticketId: "AI-1954",
          targetState: "done",
          invoker: "astrid",
          reason: "closing stale ticket",
          // force: absent
        });

      // Must be refused — not 200.
      expect(res.status).not.toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/force/i);
    });

    it("returns an error when targeting escape (terminal) from a gated state without force", async () => {
      globalThis.fetch = makeAdminMutationFetch({
        fromLabels: ["wf:dev-impl", "state:intake"],
        consistencyLabels: ["wf:dev-impl", "state:escape"],
      });

      const res = await request(appState.app)
        .post("/admin/api/set-state")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({
          ticketId: "AI-1954",
          targetState: "escape",
          invoker: "astrid",
          reason: "emergency recovery",
        });

      expect(res.status).not.toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/force/i);
    });

    it("AC3: terminal set-state with force: true from a gated state succeeds", async () => {
      globalThis.fetch = makeAdminMutationFetch({
        fromLabels: ["wf:dev-impl", "state:implementation"],
        consistencyLabels: ["wf:dev-impl", "state:done"],
      });

      const res = await request(appState.app)
        .post("/admin/api/set-state")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({
          ticketId: "AI-1954",
          targetState: "done",
          invoker: "astrid",
          reason: "manual close — ticket superceded",
          force: true,
        })
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it("set-state to a non-terminal state from a gated state does NOT require force", async () => {
      globalThis.fetch = makeAdminMutationFetch({
        fromLabels: ["wf:dev-impl", "state:intake"],
        consistencyLabels: ["wf:dev-impl", "state:implementation"],
      });

      const res = await request(appState.app)
        .post("/admin/api/set-state")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({
          ticketId: "AI-1954",
          targetState: "implementation",
          invoker: "astrid",
          reason: "skipping write-tests for hotfix",
          // No force needed — target is not terminal.
        })
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it("set-state from a terminal source state does NOT require force (no gating on terminal sources)", async () => {
      // Ticket is already in a terminal state (done). Re-routing from terminal
      // is the classic steward recovery path and should NOT require force.
      globalThis.fetch = makeAdminMutationFetch({
        fromLabels: ["wf:dev-impl", "state:done"],
        consistencyLabels: ["wf:dev-impl", "state:implementation"],
      });

      const res = await request(appState.app)
        .post("/admin/api/set-state")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({
          ticketId: "AI-1954",
          targetState: "implementation",
          invoker: "astrid",
          reason: "re-opening after regression found",
        })
        .expect(200);

      expect(res.body.ok).toBe(true);
    });
  });

  // ── AC4: cookie/secret-authed redispatch endpoint ──────────────────────
  // The console Redispatch button posts to /admin/api/redispatch (cookie-authed),
  // since the app-root /redispatch is x-admin-secret-header-gated and unreachable
  // from a browser session. This mounts the same delegation-reconciliation sweep.
  describe("AC4 — POST /admin/api/redispatch", () => {
    it("returns 400 when ticketId is missing", async () => {
      const res = await request(appState.app)
        .post("/admin/api/redispatch")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/ticketId/i);
    });

    it("rejects an unauthenticated session (no admin secret / cookie)", async () => {
      await request(appState.app)
        .post("/admin/api/redispatch")
        .send({ ticketId: "AI-1954" })
        .expect(401);
    });

    it("runs the delegation-reconciliation sweep for the single ticket and returns success", async () => {
      // Stub the governed-ticket query to return an empty set — the sweep then
      // scans nothing and returns a clean result without waking any agent.
      globalThis.fetch = (async (_url, _init) =>
        new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof globalThis.fetch;

      const res = await request(appState.app)
        .post("/admin/api/redispatch")
        .set("x-admin-secret", ADMIN_SECRET)
        .send({ ticketId: "AI-1954" })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.scanned).toBe(0);
    });
  });
});
