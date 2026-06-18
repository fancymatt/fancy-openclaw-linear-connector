/**
 * AI-1550 (Gap G-18) — Workflow def version pinning + in-flight migration.
 *
 * The connector stamps the def version a ticket enters on (wfver:<N> label) and
 * retains a snapshot of every def version it has ever loaded. When the live def
 * advances (vN → vN+1), an in-flight ticket pinned to vN must keep completing
 * under vN's state machine — even when vN+1 makes a breaking change (renames or
 * removes a state). A ticket stranded in a state that no longer exists in the
 * resolved def is treated as orphaned and routed to break-glass (never silently
 * allowed).
 *
 * These scenario tests inject v1/v2 def fixtures via WORKFLOW_DEF_PATH (the same
 * single-file load path production uses), load the registry at each version to
 * populate the snapshot cache, then exercise checkWorkflowRules against pinned
 * and unpinned tickets.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  checkWorkflowRules,
  loadWorkflowRegistry,
  getDefSnapshot,
  getPinnedVersion,
  resolveDefForTicket,
  resetWorkflowCache,
  _resetDefSnapshots,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { reloadAgents } from "./agents.js";

// ── Capability policy: steward / dev / code-review roles ────────────────────

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
  - id: code-review
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: dev
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: reviewer
    container: code-review
    fills_roles: [code-review]
`;

// ── v1: states intake → implementation → code-review → done (+escape) ───────

const V1_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  owner_role: steward

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
      - command: demote
        to: __ad_hoc__

  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: code-review

  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: done
      - command: request-changes
        to: implementation

  - id: done
    kind: terminal
    native_state: done

  - id: escape
    kind: terminal
    native_state: invalid
`;

// ── v2: breaking change — code-review is RENAMED to review ──────────────────

const V2_YAML = `
id: dev-impl
version: 2
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  owner_role: steward

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
      - command: demote
        to: __ad_hoc__

  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: review

  - id: review
    owner_role: code-review
    kind: normal
    native_state: thinking
    transitions:
      - command: approve
        to: done
      - command: request-changes
        to: implementation

  - id: done
    kind: terminal
    native_state: done

  - id: escape
    kind: terminal
    native_state: invalid
`;

let dir: string;
let workflowFile: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-version-migration-"));

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  workflowFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(workflowFile, V1_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;
  // Single-file mode only — dir mode would change resolution semantics.
  delete process.env.WORKFLOW_DEFS_DIR;

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "astrid-uuid", clientId: "a", clientSecret: "a", accessToken: "a", refreshToken: "a" },
        { name: "charles", linearUserId: "charles-uuid", clientId: "c", clientSecret: "c", accessToken: "c", refreshToken: "c" },
        { name: "reviewer", linearUserId: "reviewer-uuid", clientId: "r", clientSecret: "r", accessToken: "r", refreshToken: "r" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetWorkflowCache();
  _resetDefSnapshots();
  resetPolicyCache();
  resetConfigHealth();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Write the given def YAML to disk and (re)load the registry, retaining snapshots. */
async function loadDefVersion(yamlContent: string): Promise<void> {
  fs.writeFileSync(workflowFile, yamlContent, "utf8");
  resetWorkflowCache(); // does NOT clear snapshots — emulates a live def edit
  await loadWorkflowRegistry();
}

/** A fetch mock that returns the given label names with no delegate set. */
function labelFetch(labelNames: string[]): typeof globalThis.fetch {
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (bodyText.includes("TeamStates")) {
      return new Response(JSON.stringify({ data: { team: { states: { nodes: [] } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = {
      data: {
        issue: {
          labels: { nodes: labelNames.map((name) => ({ name })) },
          delegate: null,
        },
      },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ── Snapshot cache mechanics ─────────────────────────────────────────────────

describe("AI-1550 — version snapshot cache", () => {
  it("retains every loaded version across resetWorkflowCache()", async () => {
    await loadDefVersion(V1_YAML);
    expect(getDefSnapshot("dev-impl", 1)?.version).toBe(1);

    // Live def advances to v2 (a vault edit + cache reset). The v1 snapshot must
    // survive the reset; the v2 snapshot is added.
    await loadDefVersion(V2_YAML);
    expect(getDefSnapshot("dev-impl", 1)?.version).toBe(1);
    expect(getDefSnapshot("dev-impl", 2)?.version).toBe(2);

    // v1 snapshot still has the old state machine (code-review), v2 has review.
    expect(getDefSnapshot("dev-impl", 1)?.states.some((s) => s.id === "code-review")).toBe(true);
    expect(getDefSnapshot("dev-impl", 1)?.states.some((s) => s.id === "review")).toBe(false);
    expect(getDefSnapshot("dev-impl", 2)?.states.some((s) => s.id === "review")).toBe(true);
    expect(getDefSnapshot("dev-impl", 2)?.states.some((s) => s.id === "code-review")).toBe(false);
  });

  it("getPinnedVersion reads a wfver:<N> label", () => {
    expect(getPinnedVersion(["wf:dev-impl", "state:intake", "wfver:3"])).toBe(3);
    expect(getPinnedVersion(["wf:dev-impl", "state:intake"])).toBeNull();
  });

  it("resolveDefForTicket prefers the pinned snapshot, else live def", async () => {
    await loadDefVersion(V1_YAML);
    await loadDefVersion(V2_YAML);
    const live = (await loadWorkflowRegistry()).get("dev-impl");
    expect(live?.version).toBe(2);

    // Pinned v1 → v1 snapshot.
    expect(resolveDefForTicket("dev-impl", live, ["wfver:1"])?.version).toBe(1);
    // Unpinned → live def.
    expect(resolveDefForTicket("dev-impl", live, [])?.version).toBe(2);
    // Pinned to a version we never retained → falls back to live.
    expect(resolveDefForTicket("dev-impl", live, ["wfver:99"])?.version).toBe(2);
  });
});

// ── AC1: in-flight ticket completes under its pinned version ─────────────────

describe("AI-1550 AC1 — pinned ticket uses its entry-version semantics", () => {
  it("allows a v1 'approve' from code-review even after live def renamed it (v2)", async () => {
    // Ticket entered on v1 (snapshot retained), live def is now v2.
    await loadDefVersion(V1_YAML);
    await loadDefVersion(V2_YAML);

    globalThis.fetch = labelFetch(["wf:dev-impl", "state:code-review", "wfver:1"]);
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "reviewer");
    // code-review.approve is legal under v1 → forwarded (null).
    expect(result).toBeNull();
  });

  it("control: same ticket WITHOUT a pin is orphaned under live v2", async () => {
    await loadDefVersion(V1_YAML);
    await loadDefVersion(V2_YAML);

    globalThis.fetch = labelFetch(["wf:dev-impl", "state:code-review"]);
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "reviewer");
    // No pin → live v2 has no 'code-review' state → orphan rejection.
    expect(result).not.toBeNull();
    expect(result).toContain("no longer exists");
  });
});

// ── AC2: ticket in a removed state has a defined, non-crash outcome ──────────

describe("AI-1550 AC2 — removed-state ticket is orphaned, routed to break-glass", () => {
  it("rejects (does not crash or silently allow) when the pinned snapshot is gone", async () => {
    // Simulate a connector that only ever saw v2 (e.g. restarted after the def
    // already advanced): the ticket carries a v1 pin but no v1 snapshot exists.
    await loadDefVersion(V2_YAML);
    expect(getDefSnapshot("dev-impl", 1)).toBeUndefined();

    globalThis.fetch = labelFetch(["wf:dev-impl", "state:code-review", "wfver:1"]);
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "reviewer");

    expect(result).not.toBeNull();
    expect(result).toContain("no longer exists");
    expect(result).toContain("escape"); // routed to break-glass / steward
  });

  it("break-glass escape is STILL legal on an orphaned ticket", async () => {
    await loadDefVersion(V2_YAML);
    globalThis.fetch = labelFetch(["wf:dev-impl", "state:code-review", "wfver:1"]);
    // escape is the documented recovery hatch and must never be blocked.
    const result = await checkWorkflowRules("escape", "issue-uuid", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });
});

// ── Backwards compatibility: unpinned tickets track the live def ─────────────

describe("AI-1550 — backwards compatibility (no wfver pin)", () => {
  it("an unpinned ticket in a still-valid state uses the live def normally", async () => {
    await loadDefVersion(V1_YAML);
    await loadDefVersion(V2_YAML);

    // intake exists in both versions; accept is legal there.
    globalThis.fetch = labelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("accept", "issue-uuid", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("an unpinned ticket gets an illegal-command rejection (not a crash) for a bad move", async () => {
    await loadDefVersion(V2_YAML);
    // 'approve' is not legal in intake under any version.
    globalThis.fetch = labelFetch(["wf:dev-impl", "state:intake"]);
    const result = await checkWorkflowRules("approve", "issue-uuid", "Bearer tok", "astrid");
    expect(result).not.toBeNull();
    expect(result).toContain("not a legal command");
  });
});
