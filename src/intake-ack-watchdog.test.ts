import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import { runIntakeAckWatchdog, type IntakeAckWatchdogOptions } from "./intake-ack-watchdog.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-ack-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}

describe("IntakeAckWatchdog", () => {
  it("detects and nudges a stalled intake ticket", async () => {
    const mockTicket = {
      id: "issue-1",
      identifier: "AI-101",
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
      delegate: { id: "agent-1-uuid", name: "igor" },
      history: { nodes: [{ createdAt: hoursAgo(2) }] }, // 2h ago > 1h threshold
    };

    const wakeAgent = jest.fn(async () => {});
    const fetchFn = jest.fn(async (_url, init: any) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("IntakeAckWatchdogGoverned")) {
        return new Response(JSON.stringify({
          data: { issues: { nodes: [mockTicket] } }
        }));
      }
      if (body.query.includes("CreateIntakeAckNudge")) {
        return new Response(JSON.stringify({
          data: { commentCreate: { success: true, comment: { id: "new-comment-id" } } }
        }));
      }
      return new Response(JSON.stringify({ data: {} }));
    });

    const opts: IntakeAckWatchdogOptions = {
      authToken: "test-token",
      agentLinearUserIds: new Set(["agent-1-uuid"]),
      fetchFn: fetchFn as any,
      wakeAgent,
      nudgeStorePath: path.join(tmpDir, "nudge-1.db"),
      thresholdMs: 60 * 60 * 1000,
    };

    const result = await runIntakeAckWatchdog(opts);

    expect(result.scanned).toBe(1);
    expect(result.candidatesFound).toBe(1);
    expect(result.staleDetected).toBe(1);
    expect(result.nudgesPosted).toBe(1);
    expect(result.wakesDispatched).toBe(1);
    expect(wakeAgent).toHaveBeenCalledWith("AI-101", "igor");

    // Verify GraphQL calls
    const calls = fetchFn.mock.calls;
    // Call 0: Fetch governed tickets
    expect(calls[0][1]?.body).toContain("IntakeAckWatchdogGoverned");
    // Call 1: Create comment nudge
    expect(calls[1][1]?.body).toContain("CreateIntakeAckNudge");
    expect(calls[1][1]?.body).toContain("AI-101");
    expect(calls[1][1]?.body).toContain("stalled in **`state:intake`**");
  });

  it("skips tickets within threshold", async () => {
    const mockTicket = {
      id: "issue-2",
      identifier: "AI-102",
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
      delegate: { id: "agent-1-uuid", name: "igor" },
      history: { nodes: [{ createdAt: hoursAgo(0.5) }] }, // 30m ago < 1h threshold
    };

    const wakeAgent = jest.fn(async () => {});
    const fetchFn = jest.fn(async (_url, init: any) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("IntakeAckWatchdogGoverned")) {
        return new Response(JSON.stringify({
          data: { issues: { nodes: [mockTicket] } }
        }));
      }
      return new Response(JSON.stringify({ data: {} }));
    });

    const opts: IntakeAckWatchdogOptions = {
      authToken: "test-token",
      agentLinearUserIds: new Set(["agent-1-uuid"]),
      fetchFn: fetchFn as any,
      wakeAgent,
      nudgeStorePath: path.join(tmpDir, "nudge-2.db"),
    };

    const result = await runIntakeAckWatchdog(opts);

    expect(result.staleDetected).toBe(0);
    expect(result.nudgesPosted).toBe(0);
    expect(wakeAgent).not.toHaveBeenCalled();
  });

  it("skips tickets without an AI delegate", async () => {
    const mockTicket = {
      id: "issue-3",
      identifier: "AI-103",
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
      delegate: { id: "human-uuid", name: "Matt" }, // Not in agent set
      history: { nodes: [{ createdAt: hoursAgo(2) }] },
    };

    const wakeAgent = jest.fn(async () => {});
    const fetchFn = jest.fn(async (_url, init: any) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("IntakeAckWatchdogGoverned")) {
        return new Response(JSON.stringify({
          data: { issues: { nodes: [mockTicket] } }
        }));
      }
      return new Response(JSON.stringify({ data: {} }));
    });

    const opts: IntakeAckWatchdogOptions = {
      authToken: "test-token",
      agentLinearUserIds: new Set(["agent-1-uuid"]),
      fetchFn: fetchFn as any,
      wakeAgent,
      nudgeStorePath: path.join(tmpDir, "nudge-3.db"),
    };

    const result = await runIntakeAckWatchdog(opts);

    expect(result.candidatesFound).toBe(0);
    expect(result.nudgesPosted).toBe(0);
  });

  it("deduplicates nudges using the cooldown", async () => {
    const mockTicket = {
      id: "issue-4",
      identifier: "AI-104",
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
      delegate: { id: "agent-1-uuid", name: "igor" },
      history: { nodes: [{ createdAt: hoursAgo(2) }] },
    };

    const nudgeStorePath = path.join(tmpDir, "nudge-4.db");
    const wakeAgent = jest.fn(async () => {});
    const fetchFn = jest.fn(async (_url, init: any) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("IntakeAckWatchdogGoverned")) {
        return new Response(JSON.stringify({
          data: { issues: { nodes: [mockTicket] } }
        }));
      }
      if (body.query.includes("CreateIntakeAckNudge")) {
        return new Response(JSON.stringify({
          data: { commentCreate: { success: true, comment: { id: "new-comment-id" } } }
        }));
      }
      return new Response(JSON.stringify({ data: {} }));
    });

    const opts: IntakeAckWatchdogOptions = {
      authToken: "test-token",
      agentLinearUserIds: new Set(["agent-1-uuid"]),
      fetchFn: fetchFn as any,
      wakeAgent,
      nudgeStorePath,
      cooldownMs: 30 * 60 * 1000,
    };

    // First run - nudges
    await runIntakeAckWatchdog(opts);
    expect(wakeAgent).toHaveBeenCalledTimes(1);

    // Second run (immediately) - skips due to cooldown
    const result2 = await runIntakeAckWatchdog(opts);
    expect(result2.nudgesPosted).toBe(0);
    expect(wakeAgent).toHaveBeenCalledTimes(1);
  });
});
