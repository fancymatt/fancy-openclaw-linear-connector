import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWakeUpMessage, buildWorkflowPreamble, SINGLE_TICKET_TEMPLATE, MULTI_TICKET_TEMPLATE } from "./wake-up.js";
import { resetWorkflowCache } from "../workflow-gate.js";
import { resetPolicyCache } from "../escalation-gate.js";

// Valid Linear CLI commands that wake-up messages may reference.
// Any backtick-wrapped `linear <cmd>` not in this list is a test failure.
const VALID_WAKE_UP_COMMANDS = [
  "linear consider-work",
  "linear queue --next",
  "linear queue",
];

function findInvalidLinearCommand(message: string): string | null {
  const pattern = /`(linear [^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message)) !== null) {
    const cmd = match[1];
    if (!VALID_WAKE_UP_COMMANDS.some((v) => cmd === v || cmd.startsWith(v + " "))) {
      return cmd;
    }
  }
  return null;
}

describe("buildWakeUpMessage — single ticket", () => {
  test("includes linear consider-work with the ticket ID", () => {
    const msg = buildWakeUpMessage(["AI-832"]);
    expect(msg).toContain("linear consider-work AI-832");
  });

  test("does not mention linear my-next", () => {
    const msg = buildWakeUpMessage(["AI-832"]);
    expect(msg).not.toContain("linear my-next");
  });

  test("only references valid Linear CLI commands", () => {
    const msg = buildWakeUpMessage(["AI-832"]);
    expect(findInvalidLinearCommand(msg)).toBeNull();
  });

  test("contains the ticket ID", () => {
    const msg = buildWakeUpMessage(["ILL-500"]);
    expect(msg).toContain("ILL-500");
  });
});

describe("buildWakeUpMessage — multiple tickets", () => {
  test("includes linear queue --next", () => {
    const msg = buildWakeUpMessage(["AI-832", "AI-833"]);
    expect(msg).toContain("linear queue --next");
  });

  test("includes linear queue", () => {
    const msg = buildWakeUpMessage(["AI-832", "AI-833"]);
    expect(msg).toContain("linear queue");
  });

  test("does not mention linear my-next", () => {
    const msg = buildWakeUpMessage(["AI-832", "AI-833", "AI-834"]);
    expect(msg).not.toContain("linear my-next");
  });

  test("only references valid Linear CLI commands", () => {
    const msg = buildWakeUpMessage(["AI-832", "AI-833"]);
    expect(findInvalidLinearCommand(msg)).toBeNull();
  });

  test("lists all ticket IDs", () => {
    const msg = buildWakeUpMessage(["AI-832", "AI-833"]);
    expect(msg).toContain("AI-832");
    expect(msg).toContain("AI-833");
  });
});

describe("buildWakeUpMessage — custom template", () => {
  test("custom template is substituted correctly", () => {
    const msg = buildWakeUpMessage(["AI-832", "AI-833"], "Custom: {count} — {tickets}");
    expect(msg).toBe("Custom: 2 — AI-832, AI-833");
  });

  test("replaces all occurrences of {tickets}", () => {
    const msg = buildWakeUpMessage(["AI-832"], "First: {tickets}. Second: {tickets}.");
    expect(msg).toBe("First: AI-832. Second: AI-832.");
  });
});

describe("default templates — command validity", () => {
  test("SINGLE_TICKET_TEMPLATE does not reference linear my-next", () => {
    expect(SINGLE_TICKET_TEMPLATE).not.toContain("linear my-next");
  });

  test("MULTI_TICKET_TEMPLATE does not reference linear my-next", () => {
    expect(MULTI_TICKET_TEMPLATE).not.toContain("linear my-next");
  });

  test("SINGLE_TICKET_TEMPLATE references linear consider-work", () => {
    expect(SINGLE_TICKET_TEMPLATE).toContain("linear consider-work");
  });

  test("MULTI_TICKET_TEMPLATE references linear queue --next", () => {
    expect(MULTI_TICKET_TEMPLATE).toContain("linear queue --next");
  });
});

describe("findInvalidLinearCommand guard", () => {
  test("flags linear my-next as invalid", () => {
    expect(findInvalidLinearCommand("Run `linear my-next` now.")).toBe("linear my-next");
  });

  test("passes linear consider-work AI-832", () => {
    expect(findInvalidLinearCommand("Run `linear consider-work AI-832` to begin.")).toBeNull();
  });

  test("passes linear queue --next", () => {
    expect(findInvalidLinearCommand("Run `linear queue --next` for highest priority.")).toBeNull();
  });

  test("passes linear queue", () => {
    expect(findInvalidLinearCommand("Run `linear queue` to see all.")).toBeNull();
  });
});

// ── AI-1659: buildWorkflowPreamble ───────────────────────────────────────────

const BRIEFING_WORKFLOW_YAML = `
id: briefing-wf
version: 1
archetype: single-task
entry_state: briefing

break_glass:
  command: escape
  to: escape

states:
  - id: briefing
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: brief-ready
        to: generating

  - id: generating
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: done

  - id: done
    kind: terminal
    native_state: done

  - id: escape
    kind: terminal
    native_state: invalid
`;

const TEST_CAPABILITY_POLICY_YAML = `
capabilities:
  - id: linear:transition

containers:
  - id: dev
    grants: [linear:transition]

bodies:
  - id: felix
    container: dev
    fills_roles: [dev]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

function makeLabelFetch(labels: string[]): typeof globalThis.fetch {
  return async (_url: RequestInfo | URL, _init?: RequestInit) =>
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

describe("buildWorkflowPreamble — AI-1659 workflow context in wake-up", () => {
  let tmpDir: string;
  let tmpYamlPath: string;
  let tmpPolicyPath: string;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-up-preamble-test-"));
    tmpYamlPath = path.join(tmpDir, "briefing-wf.yaml");
    fs.writeFileSync(tmpYamlPath, BRIEFING_WORKFLOW_YAML, "utf8");
    tmpPolicyPath = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(tmpPolicyPath, TEST_CAPABILITY_POLICY_YAML, "utf8");
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    process.env.WORKFLOW_DEF_PATH = tmpYamlPath;
    process.env.CAPABILITY_POLICY_PATH = tmpPolicyPath;
    delete process.env.WORKFLOW_DEFS_DIR;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkflowCache();
    resetPolicyCache();
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.WORKFLOW_DEFS_DIR;
    delete process.env.CAPABILITY_POLICY_PATH;
  });

  test("briefing-state ticket includes brief-ready verb and does not include accept or submit", async () => {
    globalThis.fetch = makeLabelFetch(["wf:briefing-wf", "state:briefing"]);

    const preamble = await buildWorkflowPreamble("VOC-4", "Bearer testtoken");

    expect(preamble).not.toBeNull();
    expect(preamble).toContain("brief-ready");
    expect(preamble).toContain("VOC-4");
    expect(preamble).toContain("briefing");
    // Must not leak verbs from other states
    expect(preamble).not.toContain("accept");
    expect(preamble).not.toContain("linear submit");
    // Break-glass always present
    expect(preamble).toContain("linear escape VOC-4");
  });

  test("preamble includes workflow id and current state name", async () => {
    globalThis.fetch = makeLabelFetch(["wf:briefing-wf", "state:briefing"]);

    const preamble = await buildWorkflowPreamble("AI-1659", "Bearer testtoken");

    expect(preamble).toContain("[briefing-wf]");
    expect(preamble).toContain("**briefing**");
  });

  test("ad-hoc ticket (no wf:* label) returns null", async () => {
    globalThis.fetch = makeLabelFetch(["priority:high"]);

    const preamble = await buildWorkflowPreamble("AI-000", "Bearer testtoken");

    expect(preamble).toBeNull();
  });

  test("workflow ticket with no state:* label returns null (fail-open)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:briefing-wf"]);

    const preamble = await buildWorkflowPreamble("AI-000", "Bearer testtoken");

    expect(preamble).toBeNull();
  });

  test("fetch error returns null (fail-open)", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };

    const preamble = await buildWorkflowPreamble("AI-000", "Bearer testtoken");

    expect(preamble).toBeNull();
  });

  test("terminal state returns null", async () => {
    globalThis.fetch = makeLabelFetch(["wf:briefing-wf", "state:done"]);

    const preamble = await buildWorkflowPreamble("AI-000", "Bearer testtoken");

    expect(preamble).toBeNull();
  });
});
