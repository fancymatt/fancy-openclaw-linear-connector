/**
 * Tests for AI-1665 — Include workflow context in connector wake-up delivery message.
 *
 * Verifies buildWorkflowAwareWakeUpMessage:
 *   AC1: Governed single-ticket delivery messages include the current state name and
 *        the legal verb set for that state.
 *   AC2: Non-governed (ad-hoc) ticket wake-ups are unchanged.
 *   AC3: The verb list is derived from the workflow YAML, not hardcoded.
 *   AC4: Delivery message for a governed ticket contains the correct verbs for its state.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetWorkflowCache } from "../workflow-gate.js";
import { buildWorkflowAwareWakeUpMessage } from "./wake-up.js";
import { buildWakeUpMessage } from "./wake-up.js";

// ── Fixture workflow YAMLs ─────────────────────────────────────────────────

const DEV_IMPL_YAML = `
id: dev-impl
version: 8
archetype: single-task
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
        to: write-tests
        assign: { mode: auto }
      - command: demote
        to: __ad_hoc__

  - id: write-tests
    owner_role: test-author
    kind: normal
    native_state: todo
    transitions:
      - command: tests-ready
        to: implementation
        assign: { mode: required }

  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review
        assign:
          mode: required
          constraint: not-implementer

  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: deployment
        assign: { mode: auto }
      - command: request-changes
        to: implementation
        feedback:
          required: true
          category_enum: [missing-tests, style, correctness]

  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: deploy
        to: done
        assign: { mode: auto }

  - id: done
    kind: terminal
    native_state: done

  - id: escape
    kind: terminal
    native_state: invalid
`;

// VOC workflow — distinct verb names to prove verbs derive from YAML (AC3)
const VOC_YAML = `
id: voc
version: 1
archetype: single-task
entry_state: briefing

break_glass:
  command: escape
  to: escape

states:
  - id: briefing
    owner_role: briefer
    kind: normal
    native_state: todo
    transitions:
      - command: brief-ready
        to: generating
        assign: { mode: auto }

  - id: generating
    owner_role: generator
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: review
        assign: { mode: auto }

  - id: review
    owner_role: reviewer
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: done
      - command: request-changes
        to: generating
        feedback:
          required: true
          category_enum: [correctness, style]

  - id: done
    kind: terminal
    native_state: done

  - id: escape
    kind: terminal
    native_state: invalid
`;

// ── Mock fetch helper ──────────────────────────────────────────────────────

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

// ── Setup / teardown ──────────────────────────────────────────────────────

let tmpDir: string;
let devImplYamlPath: string;
let vocYamlPath: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-up-workflow-context-test-"));
  devImplYamlPath = path.join(tmpDir, "dev-impl.yaml");
  vocYamlPath = path.join(tmpDir, "voc.yaml");
  fs.writeFileSync(devImplYamlPath, DEV_IMPL_YAML, "utf8");
  fs.writeFileSync(vocYamlPath, VOC_YAML, "utf8");
});

beforeEach(() => {
  resetWorkflowCache();
  originalFetch = globalThis.fetch;
  process.env.WORKFLOW_DEF_PATH = devImplYamlPath;
  delete process.env.WORKFLOW_DEFS_DIR;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.WORKFLOW_DEFS_DIR;
  resetWorkflowCache();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── AC1: Governed ticket — state name and legal verb set ──────────────────

describe("AC1 — governed single-ticket delivery message includes state name and legal verb set", () => {
  it("includes the current state name in the message", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665"], "Bearer tok");

    expect(msg).toContain("write-tests");
  });

  it("includes the legal verb for write-tests state (tests-ready)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665"], "Bearer tok");

    expect(msg).toContain("tests-ready");
  });

  it("includes the break-glass escape verb", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665"], "Bearer tok");

    expect(msg).toContain("escape");
  });

  it("still includes consider-work so agent can fetch full ticket context", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665"], "Bearer tok");

    expect(msg).toContain("linear consider-work AI-1665");
  });

  it("intake state includes accept verb and intake state name", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-100"], "Bearer tok");

    expect(msg).toContain("accept");
    expect(msg).toContain("intake");
  });

  it("implementation state includes submit verb", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-200"], "Bearer tok");

    expect(msg).toContain("submit");
    expect(msg).toContain("implementation");
  });

  it("strips linear- session-key prefix from ticket ID in the message", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["linear-AI-1665"], "Bearer tok");

    expect(msg).toContain("AI-1665");
    expect(msg).not.toContain("linear-AI-1665");
  });
});

// ── AC2: Non-governed (ad-hoc) ticket wake-ups are unchanged ──────────────

describe("AC2 — non-governed ticket wake-ups are unchanged", () => {
  it("ad-hoc ticket (no wf:* label) → output equals generic buildWakeUpMessage", async () => {
    globalThis.fetch = makeLabelFetch(["priority:high"]); // no wf:* label

    const msg = await buildWorkflowAwareWakeUpMessage(["FCY-100"], "Bearer tok");
    const expected = buildWakeUpMessage(["FCY-100"]);

    expect(msg).toBe(expected);
  });

  it("empty label set → output equals generic buildWakeUpMessage", async () => {
    globalThis.fetch = makeLabelFetch([]);

    const msg = await buildWorkflowAwareWakeUpMessage(["FCY-200"], "Bearer tok");
    const expected = buildWakeUpMessage(["FCY-200"]);

    expect(msg).toBe(expected);
  });

  it("multi-ticket (2 tickets) → unchanged generic multi-ticket output", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665", "AI-1666"], "Bearer tok");
    const expected = buildWakeUpMessage(["AI-1665", "AI-1666"]);

    expect(msg).toBe(expected);
  });

  it("no authToken → returns generic message without attempting fetch", async () => {
    let fetchCalled = false;
    globalThis.fetch = async (..._args) => {
      fetchCalled = true;
      throw new Error("should not be called");
    };

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665"]);
    const expected = buildWakeUpMessage(["AI-1665"]);

    expect(msg).toBe(expected);
    expect(fetchCalled).toBe(false);
  });

  it("fetch throws → falls back to generic message", async () => {
    globalThis.fetch = async () => {
      throw new Error("network error");
    };

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665"], "Bearer tok");
    const expected = buildWakeUpMessage(["AI-1665"]);

    expect(msg).toBe(expected);
  });
});

// ── AC3: Verb list derived from workflow YAML ─────────────────────────────

describe("AC3 — verb list is derived from the workflow YAML, not hardcoded", () => {
  it("write-tests state lists tests-ready (from dev-impl YAML), not submit or approve", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665"], "Bearer tok");

    expect(msg).toContain("tests-ready");
    // submit belongs to implementation; approve to code-review — not legal in write-tests
    expect(msg).not.toContain("linear submit AI-1665");
    expect(msg).not.toContain("linear approve AI-1665");
  });

  it("code-review state lists approve and request-changes (from dev-impl YAML)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-400"], "Bearer tok");

    expect(msg).toContain("approve");
    expect(msg).toContain("request-changes");
    expect(msg).not.toContain("tests-ready");
  });

  it("VOC briefing state lists brief-ready (from voc YAML), not tests-ready or accept", async () => {
    process.env.WORKFLOW_DEF_PATH = vocYamlPath;
    resetWorkflowCache();
    globalThis.fetch = makeLabelFetch(["wf:voc", "state:briefing"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["VOC-4"], "Bearer tok");

    expect(msg).toContain("brief-ready");
    expect(msg).not.toContain("tests-ready");
    expect(msg).not.toContain("linear accept VOC-4");
  });

  it("verb set changes when workflow YAML changes (not hardcoded)", async () => {
    const customYaml = `
id: dev-impl
version: 99
archetype: single-task
entry_state: special

break_glass:
  command: escape
  to: escape

states:
  - id: special
    owner_role: custom-role
    kind: normal
    native_state: todo
    transitions:
      - command: unique-custom-verb-ai1665
        to: done
        assign: { mode: auto }

  - id: done
    kind: terminal
    native_state: done

  - id: escape
    kind: terminal
    native_state: invalid
`;
    const customYamlPath = path.join(tmpDir, "custom-ai1665.yaml");
    fs.writeFileSync(customYamlPath, customYaml, "utf8");
    process.env.WORKFLOW_DEF_PATH = customYamlPath;
    resetWorkflowCache();

    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:special"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-500"], "Bearer tok");

    expect(msg).toContain("unique-custom-verb-ai1665");
    expect(msg).not.toContain("tests-ready");
    expect(msg).not.toContain("accept");
  });
});

// ── AC4: Governed ticket contains correct verbs for its state ─────────────

describe("AC4 — delivery message for a governed ticket contains the correct verbs for its state", () => {
  it("write-tests ticket contains tests-ready (its only forward transition)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:write-tests"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665"], "Bearer tok");

    // tests-ready is the only legal forward move from write-tests
    expect(msg).toContain("tests-ready");
  });

  it("intake ticket contains accept but not tests-ready or submit", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:intake"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665"], "Bearer tok");

    expect(msg).toContain("accept");
    expect(msg).not.toContain("tests-ready");
    expect(msg).not.toContain("linear submit AI-1665");
  });

  it("implementation ticket contains submit but not tests-ready or approve", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665"], "Bearer tok");

    expect(msg).toContain("submit");
    expect(msg).not.toContain("tests-ready");
    expect(msg).not.toContain("linear approve AI-1665");
  });

  it("unknown state on governed ticket → falls back to generic message", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:nonexistent-state"]);

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665"], "Bearer tok");
    const expected = buildWakeUpMessage(["AI-1665"]);

    expect(msg).toBe(expected);
  });

  it("governed ticket with missing state:* label → falls back to generic message", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl"]); // no state:* label

    const msg = await buildWorkflowAwareWakeUpMessage(["AI-1665"], "Bearer tok");
    const expected = buildWakeUpMessage(["AI-1665"]);

    expect(msg).toBe(expected);
  });
});
