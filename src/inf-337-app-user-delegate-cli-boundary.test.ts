import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

type UpdateCall = { issueId: string; input: Record<string, unknown> };
type Harness = {
  updateCalls: UpdateCall[];
  persistDelegate: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __INF337_CLI_HARNESS__: Harness | undefined;
}

const requireFromTest = createRequire(import.meta.url);

function stubLinearModules(packageDir: string) {
  const distDir = path.join(packageDir, "dist");
  const issueStub = `
const baseIssue = {
  id: "issue-uuid",
  identifier: "INF-337",
  title: "scratch ad-hoc issue",
  team: { id: "team-infra", key: "INF", name: "Infrastructure" },
  state: { id: "state-doing", name: "Doing", type: "started" },
  assignee: { id: "u-ai", name: "Ai" },
  delegate: { id: "u-ai", name: "Ai" },
  labels: [],
};
const users = {
  Hanzo: { id: "u-hanzo", name: "Hanzo", app: true },
  "Hanzo (Merge Gate)": { id: "u-hanzo", name: "Hanzo (Merge Gate)", app: true },
  Grover: { id: "u-grover", name: "Grover", app: true },
};
exports.getIssue = async () => ({ ...baseIssue });
exports.resolveUserWithHints = async (name) => users[name] ?? { id: "u-human", name, app: false };
exports.findUserByName = exports.resolveUserWithHints;
exports.addComment = async () => ({
  issueId: "INF-337",
  commentId: "comment-1",
  commentUrl: "https://linear.test/comment-1",
  commentCreatedAt: "2026-07-22T21:24:00.000Z",
  commentBodyLength: 15,
});
exports.updateIssue = async (issueId, input) => {
  const harness = globalThis.__INF337_CLI_HARNESS__;
  harness.updateCalls.push({ issueId, input });
  const delegate =
    input.delegateId && harness.persistDelegate
      ? { id: input.delegateId, name: input.delegateId === "u-hanzo" ? "Hanzo" : "Grover" }
      : baseIssue.delegate;
  return {
    ...baseIssue,
    state: input.stateId ? { id: input.stateId, name: "Todo", type: "unstarted" } : baseIssue.state,
    assignee: input.assigneeId === null ? null : baseIssue.assignee,
    delegate,
  };
};
`;

  fs.writeFileSync(path.join(distDir, "issues.js"), issueStub, "utf8");
  fs.writeFileSync(
    path.join(distDir, "states.js"),
    `
exports.SEMANTIC_STATE_MAP = { todo: ["todo"], doing: ["doing"], thinking: ["thinking"] };
exports.findSemanticState = async (_teamId, semantic) => ({ id: \`state-\${semantic}\`, name: semantic === "todo" ? "Todo" : semantic, type: "unstarted" });
exports.findStateByName = async (_teamId, name) => ({ id: \`state-\${String(name).toLowerCase()}\`, name, type: "unstarted" });
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(distDir, "boards.js"),
    "exports.getComments = async () => []; exports.getIssueHistory = async () => [];",
    "utf8",
  );
  fs.writeFileSync(
    path.join(distDir, "auth.js"),
    "exports.getSelfUser = async () => ({ id: 'u-ai', name: 'Ai' });",
    "utf8",
  );
  fs.writeFileSync(
    path.join(distDir, "labels.js"),
    "exports.resolveLabelIds = async (_teamId, labels) => labels.map((label) => `label-${label}`);",
    "utf8",
  );
  fs.writeFileSync(
    path.join(distDir, "matt-escalation-guard.js"),
    "exports.isMattTarget = () => false; exports.checkMattEscalation = () => null; exports.logRefusal = async () => {}; exports.formatRefusalError = () => '';",
    "utf8",
  );
  fs.writeFileSync(
    path.join(distDir, "client.js"),
    "exports.setProxyIntent = () => {}; exports.linearGraphQL = async () => ({});",
    "utf8",
  );
}

function loadVendoredCli() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-337-cli-"));
  const tarball = path.join(process.cwd(), "vendor", "fancy-openclaw-linear-skill-cli-0.3.5.tgz");
  execFileSync("tar", ["-xzf", tarball, "-C", tempDir]);
  const packageDir = path.join(tempDir, "package");
  stubLinearModules(packageDir);
  const semantic = requireFromTest(path.join(packageDir, "dist", "semantic.js")) as {
    handoffWork: (issueId: string, delegateName: string, options?: { comment?: string }) => Promise<unknown>;
  };
  return { tempDir, semantic };
}

describe("INF-337: app-user delegate writes at the CLI/proxy boundary", () => {
  let tempDir: string | undefined;

  beforeEach(() => {
    globalThis.__INF337_CLI_HARNESS__ = {
      updateCalls: [],
      persistDelegate: true,
    };
  });

  afterEach(() => {
    delete globalThis.__INF337_CLI_HARNESS__;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("AC2: handoff-work to an app user sends delegateId alongside assigneeId:null", async () => {
    const loaded = loadVendoredCli();
    tempDir = loaded.tempDir;

    await loaded.semantic.handoffWork("INF-337", "Hanzo", { comment: "delegate to merge gate" });

    expect(globalThis.__INF337_CLI_HARNESS__?.updateCalls).toHaveLength(1);
    expect(globalThis.__INF337_CLI_HARNESS__?.updateCalls[0].input).toMatchObject({
      stateId: "state-todo",
      delegateId: "u-hanzo",
      assigneeId: null,
    });
  });

  it("AC3: if Linear does not persist the app-user delegate, the CLI rejects synchronously with an explicit reason", async () => {
    const loaded = loadVendoredCli();
    tempDir = loaded.tempDir;
    globalThis.__INF337_CLI_HARNESS__!.persistDelegate = false;

    await expect(
      loaded.semantic.handoffWork("INF-337", "Hanzo", { comment: "delegate to merge gate" }),
    ).rejects.toThrow(/delegate.*persist|Linear.*refus|app-user/i);
  });
});
