import { describe, it, expect } from "@jest/globals";
import { parseMergeGateOutcome, resolveNextRoleRoute } from "./merge-gate-dispatch.js";
import { reloadAgents } from "./agents.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Merge Gate Dispatch (INF-400)", () => {
  describe("parseMergeGateOutcome", () => {
    it("parses lead-line outcome format", () => {
      expect(parseMergeGateOutcome("Merge gate pass.")).toBe("pass");
      expect(parseMergeGateOutcome("Merge gate fail.")).toBe("fail");
      expect(parseMergeGateOutcome("Merge gate held.")).toBe("held");
      expect(parseMergeGateOutcome("Merge gate HELD.")).toBe("held");
    });

    it("parses token outcome format", () => {
      expect(parseMergeGateOutcome("GATE_RESULT=PASS")).toBe("pass");
      expect(parseMergeGateOutcome("GATE_RESULT=FAIL")).toBe("fail");
      expect(parseMergeGateOutcome("GATE_RESULT=HELD")).toBe("held");
    });

    it("returns null for unrelated comments", () => {
      expect(parseMergeGateOutcome("This is a comment.")).toBeNull();
      expect(parseMergeGateOutcome("The gate is open.")).toBeNull();
    });
  });

  describe("resolveNextRoleRoute", () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-gate-dispatch-test-"));
      const agentsFile = path.join(tmpDir, "agents.json");
      fs.writeFileSync(agentsFile, JSON.stringify({
        agents: [
          { name: "charles", linearUserId: "charles-uuid" },
          { name: "igor", linearUserId: "igor-uuid" },
          { name: "hanzo", linearUserId: "hanzo-uuid" },
        ]
      }));
      process.env.AGENTS_FILE = agentsFile;
      reloadAgents();
    });

    afterAll(() => {
      delete process.env.AGENTS_FILE;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const mockEvent: any = { type: "Comment", action: "create" };

    it("resolves 'held' to charles", async () => {
      const route = await resolveNextRoleRoute({ outcome: "held", ticketId: "AI-123" }, mockEvent);
      expect(route?.agentId).toBe("charles");
      expect(route?.sessionKey).toBe("linear-AI-123");
    });

    it("resolves 'fail' to igor", async () => {
      const route = await resolveNextRoleRoute({ outcome: "fail", ticketId: "AI-123" }, mockEvent);
      expect(route?.agentId).toBe("igor");
    });

    it("resolves 'pass' to hanzo", async () => {
      const route = await resolveNextRoleRoute({ outcome: "pass", ticketId: "AI-123" }, mockEvent);
      expect(route?.agentId).toBe("hanzo");
    });
  });
});
