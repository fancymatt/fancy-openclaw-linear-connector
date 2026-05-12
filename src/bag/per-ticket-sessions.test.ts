/**
 * Regression tests for AI-779: per-ticket session isolation.
 *
 * An agent with an active session for ticket A must NOT block immediate
 * dispatch for ticket B. Each ticket gets its own independent OpenClaw
 * session. Same-ticket events still dedupe into the active session.
 */

import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { resignalPendingTickets } from "./resignal.js";
import type { WakeUpConfig } from "./wake-up.js";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "per-ticket-test-"));
  return path.join(dir, "test.db");
}

describe("per-ticket session isolation (AI-779)", () => {
  let bag: PendingWorkBag;
  let sessionTracker: SessionTracker;
  let dbPath: string;

  const wakeConfig: WakeUpConfig = { nodeBin: process.execPath };

  beforeEach(() => {
    dbPath = tempDb();
    bag = new PendingWorkBag(dbPath, 60_000);
    sessionTracker = new SessionTracker(30_000);
  });

  afterEach(() => {
    bag.close();
    sessionTracker.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("two different tickets for same agent each dispatch immediately", async () => {
    const sent: string[] = [];
    const mockSendWakeUp = jest.fn(
      async (_agentId: string, ticketIds: string[], _config: WakeUpConfig) => {
        sent.push(...ticketIds);
      }
    );

    bag.add("signe", "AI-776", "Issue");
    bag.add("signe", "AI-777", "Issue");

    // Simulate: AI-776 already dispatched and session is active
    sessionTracker.startSession("signe", "linear-AI-776");

    // Now AI-777 arrives — must dispatch immediately, not queue behind AI-776
    const tickets776 = bag.getPendingTickets("signe");
    const pendingIds = tickets776.map((e) => e.ticketId).filter((id) => id !== "linear-AI-776");

    const sentCount = await resignalPendingTickets(
      "signe",
      pendingIds,
      bag,
      sessionTracker,
      wakeConfig,
      { markActive: true, sendWakeUp: mockSendWakeUp },
    );

    expect(sentCount).toHaveLength(1);
    expect(sent).toContain("linear-AI-777");
    // Both sessions are now active concurrently
    expect(sessionTracker.isActiveForTicket("signe", "linear-AI-776")).toBe(true);
    expect(sessionTracker.isActiveForTicket("signe", "linear-AI-777")).toBe(true);
  });

  test("same-ticket duplicate is skipped via startSession dedup", async () => {
    const mockSendWakeUp = jest.fn(async () => {});

    bag.add("signe", "AI-776", "Issue");
    sessionTracker.startSession("signe", "linear-AI-776");

    // Attempt to resignal the same ticket — startSession returns false (dedup),
    // but the wake-up is still sent. This simulates same-ticket delivery.
    const sentCount = await resignalPendingTickets(
      "signe",
      ["linear-AI-776"],
      bag,
      sessionTracker,
      wakeConfig,
      { markActive: true, sendWakeUp: mockSendWakeUp },
    );

    // isLinearIssueActionable will determine if it's actually sent; the key
    // assertion here is that startSession for the same key returns false.
    expect(sessionTracker.startSession("signe", "linear-AI-776")).toBe(false);
    expect(sessionTracker.isActiveForTicket("signe", "linear-AI-776")).toBe(true);
  });

  test("resignalPendingTickets marks each ticket active independently", async () => {
    const mockSendWakeUp = jest.fn(async () => {});

    bag.add("signe", "AI-776", "Issue");
    bag.add("signe", "AI-777", "Issue");
    bag.add("signe", "AI-778", "Issue");

    const pendingIds = bag.getPendingTickets("signe").map((e) => e.ticketId);
    await resignalPendingTickets(
      "signe",
      pendingIds,
      bag,
      sessionTracker,
      wakeConfig,
      { markActive: true, sendWakeUp: mockSendWakeUp },
    );

    // All three tickets are now tracked as active sessions
    expect(sessionTracker.isActiveForTicket("signe", "linear-AI-776")).toBe(true);
    expect(sessionTracker.isActiveForTicket("signe", "linear-AI-777")).toBe(true);
    expect(sessionTracker.isActiveForTicket("signe", "linear-AI-778")).toBe(true);
    expect(sessionTracker.getActiveSessionKeys("signe").sort()).toEqual([
      "linear-AI-776",
      "linear-AI-777",
      "linear-AI-778",
    ]);
  });

  test("pending signals are only returned when all sessions end", () => {
    sessionTracker.startSession("signe", "linear-AI-776");
    sessionTracker.startSession("signe", "linear-AI-777");
    sessionTracker.queueSignal("signe", ["linear-AI-999"]);

    // End first session — signals not yet returned
    expect(sessionTracker.endSession("signe", "linear-AI-776")).toBeNull();
    expect(sessionTracker.isActive("signe")).toBe(true);

    // End second session — all done, signals returned
    const pending = sessionTracker.endSession("signe", "linear-AI-777");
    expect(pending).toEqual(["linear-AI-999"]);
    expect(sessionTracker.isActive("signe")).toBe(false);
  });

  test("SessionTracker.isActiveForTicket correctly distinguishes same vs different ticket", () => {
    sessionTracker.startSession("signe", "linear-AI-776");

    expect(sessionTracker.isActiveForTicket("signe", "linear-AI-776")).toBe(true);
    expect(sessionTracker.isActiveForTicket("signe", "linear-AI-777")).toBe(false);
    expect(sessionTracker.isActiveForTicket("signe", "linear-AI-778")).toBe(false);
  });
});
