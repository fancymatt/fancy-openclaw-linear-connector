/**
 * Tests for StuckDelegateDetector (AI-1451).
 *
 * Covers the incident pattern: delegate posts a completion comment but
 * never runs the transition verb. The detector should:
 *   - Identify tickets in non-terminal states with delegate comments but no transitions
 *   - Build a re-prompt with the exact legal-command block
 *   - Send the re-prompt up to maxPrompts times per ticket
 *   - Skip tickets with active sessions (delegate not yet idle)
 *   - Skip tickets where a transition DID fire
 *   - Skip tickets where no delegate comment was posted
 *   - Log operational events for observability
 */

import fs from "fs";
import os from "os";
import path from "path";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { OperationalEventStore } from "../store/operational-event-store.js";
import {
  StuckDelegateDetector,
  PromptCounter,
  buildRePrompt,
  type StuckCandidate,
} from "./stuck-delegate-detector.js";
import type { WorkflowDef } from "../workflow-gate.js";
import type { AgentConfig } from "../agents.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stuck-delegate-test-"));
}

// Minimal workflow def for testing (matches canonical-dev-impl.yaml)
const TEST_WORKFLOW_DEF: WorkflowDef = {
  id: "dev-impl",
  version: 4,
  archetype: "single-task",
  entry_state: "intake",
  break_glass: { command: "escape", to: "escape", owner_role: "steward" },
  states: [
    {
      id: "intake",
      owner_role: "steward",
      kind: "normal",
      transitions: [
        { command: "accept", to: "implementation", assign: { mode: "required" } },
        { command: "demote", to: "__ad_hoc__" },
      ],
    },
    {
      id: "implementation",
      owner_role: "dev",
      kind: "normal",
      transitions: [{ command: "submit", to: "code-review" }],
    },
    {
      id: "code-review",
      owner_role: "code-review",
      kind: "normal",
      transitions: [
        { command: "approve", to: "deployment" },
        { command: "request-changes", to: "implementation", feedback: { required: true, category_enum: ["correctness"] } },
      ],
    },
    {
      id: "deployment",
      owner_role: "deployment",
      kind: "normal",
      transitions: [
        { command: "deploy", to: "done", requires_capability: "deploy:execute" },
        { command: "reject", to: "implementation" },
      ],
    },
    { id: "done", kind: "terminal" },
    { id: "escape", kind: "terminal" },
  ],
};

const TEST_AGENT: AgentConfig = {
  name: "igor",
  linearUserId: "linear-user-igor",
  openclawAgent: "igor",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
};

function setupDeps(dir: string) {
  const bag = new PendingWorkBag(path.join(dir, "bag.db"), 60_000);
  const sessionTracker = new SessionTracker(30_000);
  const operationalEventStore = new OperationalEventStore(path.join(dir, "events.db"));
  const deliveryConfig = { nodeBin: "node", hooksUrl: "", hooksToken: "" };
  return { bag, sessionTracker, operationalEventStore, deliveryConfig };
}

describe("StuckDelegateDetector", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── PromptCounter ──────────────────────────────────────────────────────

  describe("PromptCounter", () => {
    test("tracks increment and get", () => {
      const counter = new PromptCounter();
      expect(counter.get("AI-1451")).toBe(0);
      expect(counter.increment("AI-1451")).toBe(1);
      expect(counter.increment("AI-1451")).toBe(2);
      expect(counter.get("AI-1451")).toBe(2);
    });

    test("clear resets count", () => {
      const counter = new PromptCounter();
      counter.increment("AI-1451");
      counter.increment("AI-1451");
      counter.clear("AI-1451");
      expect(counter.get("AI-1451")).toBe(0);
    });

    test("normalizes ticket IDs", () => {
      const counter = new PromptCounter();
      counter.increment("AI-1451");
      expect(counter.get("linear-AI-1451")).toBe(1);
    });
  });

  // ── buildRePrompt ──────────────────────────────────────────────────────

  describe("buildRePrompt", () => {
    test("builds re-prompt with legal commands for implementation state", () => {
      const prompt = buildRePrompt("AI-1451", "implementation", TEST_WORKFLOW_DEF);

      expect(prompt).toContain("AI-1451");
      expect(prompt).toContain("state:implementation");
      expect(prompt).toContain("`linear submit AI-1451`");
      expect(prompt).toContain("→ code-review");
      expect(prompt).toContain("`linear escape AI-1451`");
      expect(prompt).toContain("A comment is NOT a transition");
      expect(prompt).toContain("Do NOT reply HEARTBEAT_OK");
    });

    test("builds re-prompt with legal commands for code-review state", () => {
      const prompt = buildRePrompt("AI-1438", "code-review", TEST_WORKFLOW_DEF);

      expect(prompt).toContain("state:code-review");
      expect(prompt).toContain("`linear approve AI-1438`");
      expect(prompt).toContain("`linear request-changes AI-1438`");
      expect(prompt).toContain("→ deployment");
      expect(prompt).toContain("→ implementation");
    });

    test("handles terminal state gracefully", () => {
      const prompt = buildRePrompt("AI-999", "done", TEST_WORKFLOW_DEF);

      expect(prompt).toContain("AI-999");
      expect(prompt).toContain("done");
      expect(prompt).toContain("escape");
    });

    test("handles unknown state gracefully", () => {
      const prompt = buildRePrompt("AI-999", "unknown-state", TEST_WORKFLOW_DEF);

      expect(prompt).toContain("AI-999");
      expect(prompt).toContain("unknown-state");
    });
  });

  // ── StuckDelegateDetector.runCycle ────────────────────────────────────

  describe("runCycle", () => {
    test("detects stuck delegate: comment posted, no transition, idle session", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);
      const wakeCalls: Array<{ agent: string; ticket: string; prompt: string }> = [];

      // Candidate: implementation state, delegate comment, no transition
      const candidates: StuckCandidate[] = [
        {
          identifier: "AI-1451",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-08T19:00:00.000Z",
          delegateComments: [
            {
              id: "comment-1",
              createdAt: "2026-06-08T20:00:00.000Z",
              body: "## B-1 Complete\nAll tests pass.",
            },
          ],
          transitionsAfterEntry: [],
        },
      ];

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async (agent, ticket, prompt) => {
            wakeCalls.push({ agent, ticket, prompt });
            return true;
          },
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2 },
      );

      const result = await detector.runCycle();

      expect(result.agentsChecked).toBe(1);
      expect(result.candidatesChecked).toBe(1);
      expect(result.stuckFound).toBe(1);
      expect(result.rePromptsSent).toBe(1);

      // Wake was called with the re-prompt
      expect(wakeCalls).toHaveLength(1);
      expect(wakeCalls[0].agent).toBe("igor");
      expect(wakeCalls[0].ticket).toBe("AI-1451");
      expect(wakeCalls[0].prompt).toContain("linear submit AI-1451");

      // Operational event logged
      const events = operationalEventStore.query({ outcome: "stuck-delegate-reprompt" });
      expect(events).toHaveLength(1);
      expect(events[0].agent).toBe("igor");
      expect(events[0].detail).toMatchObject({
        currentState: "implementation",
        delegateComments: 1,
        promptNumber: 1,
      });

      // Ticket added to bag
      const pending = bag.getPendingTickets("igor");
      expect(pending.some((e) => e.ticketId === "linear-AI-1451")).toBe(true);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("respects maxPrompts cap", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);
      const wakeCalls: Array<{ agent: string; ticket: string; prompt: string }> = [];

      const candidates: StuckCandidate[] = [
        {
          identifier: "AI-1451",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-08T19:00:00.000Z",
          delegateComments: [
            { id: "c1", createdAt: "2026-06-08T20:00:00.000Z", body: "Complete" },
          ],
          transitionsAfterEntry: [],
        },
      ];

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async (agent, ticket, prompt) => {
            wakeCalls.push({ agent, ticket, prompt });
            return true;
          },
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2 },
      );

      // First cycle: prompt 1
      const r1 = await detector.runCycle();
      expect(r1.rePromptsSent).toBe(1);

      // Second cycle: prompt 2
      const r2 = await detector.runCycle();
      expect(r2.rePromptsSent).toBe(1);

      // Third cycle: capped
      const r3 = await detector.runCycle();
      expect(r3.rePromptsSent).toBe(0);
      expect(r3.skippedAlreadyPrompted).toBe(1);

      // Total 2 wake calls
      expect(wakeCalls).toHaveLength(2);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("skips when delegate has an active session", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);

      const candidates: StuckCandidate[] = [
        {
          identifier: "AI-1451",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-08T19:00:00.000Z",
          delegateComments: [
            { id: "c1", createdAt: "2026-06-08T20:00:00.000Z", body: "Complete" },
          ],
          transitionsAfterEntry: [],
        },
      ];

      // Simulate active session
      sessionTracker.startSession("igor", "linear-AI-1451");

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async () => true,
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2 },
      );

      const result = await detector.runCycle();

      // Should skip — session is active
      expect(result.stuckFound).toBe(0);
      expect(result.rePromptsSent).toBe(0);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("skips when transition was fired after comment", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);

      // Candidate has a transition after entry — NOT stuck
      const candidates: StuckCandidate[] = [
        {
          identifier: "AI-1451",
          currentState: "code-review",
          labels: ["wf:dev-impl", "state:code-review"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-08T19:00:00.000Z",
          delegateComments: [
            { id: "c1", createdAt: "2026-06-08T20:00:00.000Z", body: "Submitted for review" },
          ],
          transitionsAfterEntry: [
            { from: "implementation", to: "code-review", at: "2026-06-08T20:00:01.000Z" },
          ],
        },
      ];

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async () => true,
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2 },
      );

      const result = await detector.runCycle();

      expect(result.stuckFound).toBe(0);
      expect(result.rePromptsSent).toBe(0);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("skips when no delegate comment posted", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);

      // No delegate comments — not the stuck pattern
      const candidates: StuckCandidate[] = [
        {
          identifier: "AI-1451",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-08T19:00:00.000Z",
          delegateComments: [], // <-- no comments
          transitionsAfterEntry: [],
        },
      ];

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async () => true,
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2 },
      );

      const result = await detector.runCycle();

      expect(result.stuckFound).toBe(0);
      expect(result.rePromptsSent).toBe(0);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("respects idleGraceMs — waits before prompting", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);
      const wakeCalls: Array<{ agent: string; ticket: string; prompt: string }> = [];
      let mockNow = 1000_000;

      const candidates: StuckCandidate[] = [
        {
          identifier: "AI-1451",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-08T19:00:00.000Z",
          delegateComments: [
            { id: "c1", createdAt: "2026-06-08T20:00:00.000Z", body: "Complete" },
          ],
          transitionsAfterEntry: [],
        },
      ];

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          now: () => mockNow,
          sendWake: async (agent, ticket, prompt) => {
            wakeCalls.push({ agent, ticket, prompt });
            return true;
          },
        },
        { pollMs: 60_000, idleGraceMs: 5000, maxPrompts: 2 }, // 5s grace
      );

      // Cycle 1: first time seeing idle — records the timestamp, no prompt
      const r1 = await detector.runCycle();
      expect(r1.stuckFound).toBe(0);
      expect(r1.rePromptsSent).toBe(0);
      expect(wakeCalls).toHaveLength(0);

      // Cycle 2: only 2s elapsed — still within grace
      mockNow += 2000;
      const r2 = await detector.runCycle();
      expect(r2.stuckFound).toBe(0);
      expect(r2.rePromptsSent).toBe(0);
      expect(wakeCalls).toHaveLength(0);

      // Cycle 3: 6s total elapsed — grace expired, should prompt
      mockNow += 4000;
      const r3 = await detector.runCycle();
      expect(r3.stuckFound).toBe(1);
      expect(r3.rePromptsSent).toBe(1);
      expect(wakeCalls).toHaveLength(1);
      expect(wakeCalls[0].prompt).toContain("linear submit AI-1451");

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("clears prompt count when transition fires", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);

      // Start with a stuck candidate
      let candidates: StuckCandidate[] = [
        {
          identifier: "AI-1451",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-08T19:00:00.000Z",
          delegateComments: [
            { id: "c1", createdAt: "2026-06-08T20:00:00.000Z", body: "Complete" },
          ],
          transitionsAfterEntry: [],
        },
      ];

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async () => true,
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2 },
      );

      // First cycle: prompts the delegate
      const r1 = await detector.runCycle();
      expect(r1.rePromptsSent).toBe(1);

      // Now the delegate runs submit — transition fires
      candidates = [
        {
          identifier: "AI-1451",
          currentState: "code-review",
          labels: ["wf:dev-impl", "state:code-review"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-08T21:00:00.000Z",
          delegateComments: [
            { id: "c1", createdAt: "2026-06-08T20:00:00.000Z", body: "Complete" },
          ],
          transitionsAfterEntry: [
            { from: "implementation", to: "code-review", at: "2026-06-08T21:00:00.000Z" },
          ],
        },
      ];

      const r2 = await detector.runCycle();
      expect(r2.rePromptsSent).toBe(0);
      expect(r2.stuckFound).toBe(0);

      // Now delegate gets stuck AGAIN in code-review with a new comment
      candidates = [
        {
          identifier: "AI-1451",
          currentState: "code-review",
          labels: ["wf:dev-impl", "state:code-review"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-08T21:00:00.000Z",
          delegateComments: [
            { id: "c2", createdAt: "2026-06-08T22:00:00.000Z", body: "Looks good" },
          ],
          transitionsAfterEntry: [],
        },
      ];

      const r3 = await detector.runCycle();
      // Prompt counter was cleared when transition fired, so fresh count
      expect(r3.rePromptsSent).toBe(1);
      expect(r3.stuckFound).toBe(1);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("works across multiple agents and tickets", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);
      const wakeCalls: Array<{ agent: string; ticket: string }> = [];

      const igor: AgentConfig = {
        name: "igor",
        linearUserId: "uid-igor",
        openclawAgent: "igor",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
      };
      const noah: AgentConfig = {
        name: "noah",
        linearUserId: "uid-noah",
        openclawAgent: "noah",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
      };

      const igorCandidates: StuckCandidate[] = [
        {
          identifier: "AI-1451",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "uid-igor",
          stateEnteredAt: "2026-06-08T19:00:00.000Z",
          delegateComments: [
            { id: "c1", createdAt: "2026-06-08T20:00:00.000Z", body: "Done" },
          ],
          transitionsAfterEntry: [],
        },
        {
          identifier: "AI-1460",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "uid-igor",
          stateEnteredAt: "2026-06-08T18:00:00.000Z",
          delegateComments: [], // No comment — not stuck
          transitionsAfterEntry: [],
        },
      ];

      const noahCandidates: StuckCandidate[] = [
        {
          identifier: "AI-1455",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "uid-noah",
          stateEnteredAt: "2026-06-08T17:00:00.000Z",
          delegateComments: [
            { id: "c2", createdAt: "2026-06-08T19:00:00.000Z", body: "Implementation complete" },
          ],
          transitionsAfterEntry: [],
        },
      ];

      // Fetch returns different candidates per agent
      const candidateMap = new Map([
        [igor, igorCandidates],
        [noah, noahCandidates],
      ]);

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [igor, noah],
          fetchStuckCandidates: async (agent) => candidateMap.get(agent) ?? [],
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async (agent, ticket, _prompt) => {
            wakeCalls.push({ agent, ticket });
            return true;
          },
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2 },
      );

      const result = await detector.runCycle();

      expect(result.agentsChecked).toBe(2);
      expect(result.candidatesChecked).toBe(3);
      expect(result.stuckFound).toBe(2);
      expect(result.rePromptsSent).toBe(2);

      // Igor gets prompted for AI-1451 (not AI-1460 — no comment)
      expect(wakeCalls.some((w) => w.agent === "igor" && w.ticket === "AI-1451")).toBe(true);
      // Noah gets prompted for AI-1455
      expect(wakeCalls.some((w) => w.agent === "noah" && w.ticket === "AI-1455")).toBe(true);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    // ── AI-1650: ackTracker guard ─────────────────────────────────────────

    test("AI-1650: skips when ackTracker has a recent pending dispatch", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);

      const candidates: StuckCandidate[] = [
        {
          identifier: "AI-1650",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-22T15:00:00.000Z",
          delegateComments: [
            { id: "c1", createdAt: "2026-06-22T15:05:00.000Z", body: "Working on it" },
          ],
          transitionsAfterEntry: [],
        },
      ];

      // Mock: hasRecentPending returns true → session likely still active
      const mockAckTracker = { hasRecentPending: () => true } as any;

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          ackTracker: mockAckTracker,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async () => true,
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2, sessionActiveThresholdMs: 10 * 60 * 1000 },
      );

      const result = await detector.runCycle();

      expect(result.skippedSessionActive).toBe(1);
      expect(result.rePromptsSent).toBe(0);
      expect(result.stuckFound).toBe(0);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("AI-1650: allows re-prompt when no pending dispatch in ackTracker", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);
      const wakeCalls: string[] = [];

      const candidates: StuckCandidate[] = [
        {
          identifier: "AI-1650",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-22T15:00:00.000Z",
          delegateComments: [
            { id: "c1", createdAt: "2026-06-22T15:05:00.000Z", body: "Done" },
          ],
          transitionsAfterEntry: [],
        },
      ];

      // Mock: hasRecentPending returns false → no recent dispatch, proceed
      const mockAckTracker = { hasRecentPending: () => false } as any;

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          ackTracker: mockAckTracker,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async (_agent, ticket) => { wakeCalls.push(ticket); return true; },
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2, sessionActiveThresholdMs: 10 * 60 * 1000 },
      );

      const result = await detector.runCycle();

      expect(result.skippedSessionActive).toBe(0);
      expect(result.rePromptsSent).toBe(1);
      expect(wakeCalls).toContain("AI-1650");

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("AI-1650: allows re-prompt when pending dispatch exceeds threshold", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);

      const candidates: StuckCandidate[] = [
        {
          identifier: "AI-1650",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-22T14:00:00.000Z",
          delegateComments: [
            { id: "c1", createdAt: "2026-06-22T14:05:00.000Z", body: "Done" },
          ],
          transitionsAfterEntry: [],
        },
      ];

      // Dispatch was 20 min ago — older than 10-min threshold, so hasRecentPending = false
      const mockAckTracker = { hasRecentPending: () => false } as any;

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          ackTracker: mockAckTracker,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async () => true,
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2, sessionActiveThresholdMs: 10 * 60 * 1000 },
      );

      const result = await detector.runCycle();

      expect(result.skippedSessionActive).toBe(0);
      expect(result.rePromptsSent).toBe(1);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("AI-1650: backward compat — works without ackTracker", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);
      const wakeCalls: string[] = [];

      const candidates: StuckCandidate[] = [
        {
          identifier: "AI-1650",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-22T15:00:00.000Z",
          delegateComments: [
            { id: "c1", createdAt: "2026-06-22T15:05:00.000Z", body: "Done" },
          ],
          transitionsAfterEntry: [],
        },
      ];

      // No ackTracker provided — falls through to existing behavior
      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async (_agent, ticket) => { wakeCalls.push(ticket); return true; },
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2, sessionActiveThresholdMs: 10 * 60 * 1000 },
      );

      const result = await detector.runCycle();

      expect(result.skippedSessionActive).toBe(0);
      expect(result.rePromptsSent).toBe(1);
      expect(wakeCalls).toContain("AI-1650");

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("AI-1650: sessionActiveThresholdMs=0 disables the ackTracker guard", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);
      let hasRecentPendingCalled = false;

      const candidates: StuckCandidate[] = [
        {
          identifier: "AI-1650",
          currentState: "implementation",
          labels: ["wf:dev-impl", "state:implementation"],
          delegateId: "linear-user-igor",
          stateEnteredAt: "2026-06-22T15:00:00.000Z",
          delegateComments: [
            { id: "c1", createdAt: "2026-06-22T15:05:00.000Z", body: "Done" },
          ],
          transitionsAfterEntry: [],
        },
      ];

      const mockAckTracker = {
        hasRecentPending: () => { hasRecentPendingCalled = true; return true; },
      } as any;

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          ackTracker: mockAckTracker,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async () => true,
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2, sessionActiveThresholdMs: 0 },
      );

      const result = await detector.runCycle();

      // Guard disabled — ackTracker not consulted, re-prompt sent
      expect(hasRecentPendingCalled).toBe(false);
      expect(result.skippedSessionActive).toBe(0);
      expect(result.rePromptsSent).toBe(1);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("handles workflow def load failure gracefully", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          loadDef: async () => { throw new Error("YAML parse error"); },
          sendWake: async () => true,
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2 },
      );

      const result = await detector.runCycle();

      expect(result.errors).toBe(1);
      expect(result.rePromptsSent).toBe(0);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("handles candidate fetch failure gracefully", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => { throw new Error("API error"); },
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async () => true,
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2 },
      );

      const result = await detector.runCycle();

      expect(result.errors).toBe(1);
      expect(result.rePromptsSent).toBe(0);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    test("no agents configured — no-op", async () => {
      const { bag, sessionTracker, operationalEventStore, deliveryConfig } = setupDeps(dir);

      const detector = new StuckDelegateDetector(
        {
          sessionTracker,
          bag,
          operationalEventStore,
          deliveryConfig,
          listAgents: () => [],
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async () => true,
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2 },
      );

      const result = await detector.runCycle();

      expect(result.agentsChecked).toBe(0);
      expect(result.candidatesChecked).toBe(0);
      expect(result.stuckFound).toBe(0);

      detector.stop();
      bag.close();
      sessionTracker.close();
      operationalEventStore.close();
    });

    // ── AI-2129: barrier-held suppression ────────────────────────────────

    /** A wf:dev-sprint parent at state:validation with a delegate comment and no
     *  transition — the classic false-positive shape. `nonTerminalChildCount`
     *  varies per test to exercise the barrier. */
    function sprintParentCandidate(nonTerminalChildCount: number, totalChildren: number): StuckCandidate {
      return {
        identifier: "AI-2021",
        currentState: "validation",
        labels: ["wf:dev-sprint", "state:validation"],
        delegateId: "linear-user-igor",
        stateEnteredAt: "2026-07-10T05:00:00.000Z",
        delegateComments: [
          {
            id: "comment-fp",
            createdAt: "2026-07-10T06:20:00.000Z",
            body: "false positive — barrier still open, C6 in flight",
          },
        ],
        transitionsAfterEntry: [],
        workflowId: "dev-sprint",
        totalChildren,
        nonTerminalChildCount,
      };
    }

    function barrierDetector(
      candidates: StuckCandidate[],
      wakeCalls: Array<{ agent: string; ticket: string; prompt: string }>,
      deps: ReturnType<typeof setupDeps>,
    ): StuckDelegateDetector {
      return new StuckDelegateDetector(
        {
          sessionTracker: deps.sessionTracker,
          bag: deps.bag,
          operationalEventStore: deps.operationalEventStore,
          deliveryConfig: deps.deliveryConfig,
          listAgents: () => [TEST_AGENT],
          fetchStuckCandidates: async () => candidates,
          loadDef: async () => TEST_WORKFLOW_DEF,
          sendWake: async (agent, ticket, prompt) => {
            wakeCalls.push({ agent, ticket, prompt });
            return true;
          },
        },
        { pollMs: 60_000, idleGraceMs: 0, maxPrompts: 2 },
      );
    }

    test("AC1: barrier-held sprint parent with a non-terminal child is suppressed", async () => {
      const deps = setupDeps(dir);
      const wakeCalls: Array<{ agent: string; ticket: string; prompt: string }> = [];
      const detector = barrierDetector([sprintParentCandidate(1, 3)], wakeCalls, deps);

      const result = await detector.runCycle();

      expect(result.skippedBarrierHeld).toBe(1);
      expect(result.stuckFound).toBe(0);
      expect(result.rePromptsSent).toBe(0);
      expect(wakeCalls).toHaveLength(0);

      detector.stop();
      deps.bag.close();
      deps.sessionTracker.close();
      deps.operationalEventStore.close();
    });

    test("AC2: once all children are terminal, the sprint parent resumes dispatch", async () => {
      const deps = setupDeps(dir);
      const wakeCalls: Array<{ agent: string; ticket: string; prompt: string }> = [];
      const detector = barrierDetector([sprintParentCandidate(0, 3)], wakeCalls, deps);

      const result = await detector.runCycle();

      expect(result.skippedBarrierHeld).toBe(0);
      expect(result.stuckFound).toBe(1);
      expect(result.rePromptsSent).toBe(1);
      expect(wakeCalls).toHaveLength(1);
      expect(wakeCalls[0].ticket).toBe("AI-2021");

      detector.stop();
      deps.bag.close();
      deps.sessionTracker.close();
      deps.operationalEventStore.close();
    });

    test("AC3: ordinary stuck delegate (leaf ticket, no children) still fires", async () => {
      const deps = setupDeps(dir);
      const wakeCalls: Array<{ agent: string; ticket: string; prompt: string }> = [];
      // Leaf implementer ticket — no children fields at all (backward-compat path).
      const leaf: StuckCandidate = {
        identifier: "AI-1451",
        currentState: "implementation",
        labels: ["wf:dev-impl", "state:implementation"],
        delegateId: "linear-user-igor",
        stateEnteredAt: "2026-06-08T19:00:00.000Z",
        delegateComments: [
          { id: "c1", createdAt: "2026-06-08T20:00:00.000Z", body: "## B-1 Complete" },
        ],
        transitionsAfterEntry: [],
      };
      const detector = barrierDetector([leaf], wakeCalls, deps);

      const result = await detector.runCycle();

      expect(result.skippedBarrierHeld).toBe(0);
      expect(result.stuckFound).toBe(1);
      expect(result.rePromptsSent).toBe(1);
      expect(wakeCalls).toHaveLength(1);

      detector.stop();
      deps.bag.close();
      deps.sessionTracker.close();
      deps.operationalEventStore.close();
    });
  });
});
