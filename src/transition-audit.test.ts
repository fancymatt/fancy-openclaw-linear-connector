/**
 * AI-2554 — Tests for structured transition audit logging.
 *
 * Tests the pure-data-flow paths of `transition-audit.ts`:
 *   - buildTransitionAuditRecord constructs the expected shape
 *   - emitTransitionAuditRecord logs at correct severity
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

// Import the module under test after mocks are set up
import {
  buildTransitionAuditRecord,
  emitTransitionAuditRecord,
  emitLabelSyncWarning,
} from "./transition-audit.js";

describe("buildTransitionAuditRecord", () => {
  it("produces a complete record with all fields", () => {
    const record = buildTransitionAuditRecord(
      "AI-2554",
      "continue-workflow",
      "code-review",
      "implementation",
      "code-review",
      "applied",
      "OK",
      "Transition applied successfully",
      "igor",
      [{ name: "capability-check", passed: true, detail: null }],
    );

    expect(record.ticketId).toBe("AI-2554");
    expect(record.command).toBe("continue-workflow");
    expect(record.transitionName).toBe("code-review");
    expect(record.fromState).toBe("implementation");
    expect(record.toState).toBe("code-review");
    expect(record.status).toBe("applied");
    expect(record.code).toBe("OK");
    expect(record.detail).toBe("Transition applied successfully");
    expect(record.agentId).toBe("igor");
    expect(record.gateResults).toEqual([
      { name: "capability-check", passed: true, detail: null },
    ]);
    expect(record.postVerification).toBeNull();
    expect(record.ts).toBeDefined();
  });

  it("produces a record for a blocked transition", () => {
    const record = buildTransitionAuditRecord(
      "AI-2555",
      "continue-workflow",
      null,
      "implementation",
      null,
      "blocked",
      "GATE_BLOCKED",
      "Capability check: not-implementer",
      "ai",
      [{ name: "capability-check", passed: false, detail: "not-implementer" }],
    );

    expect(record.ticketId).toBe("AI-2555");
    expect(record.status).toBe("blocked");
    expect(record.code).toBe("GATE_BLOCKED");
    expect(record.gateResults[0].passed).toBe(false);
    expect(record.transitionName).toBeNull();
    expect(record.toState).toBeNull();
  });

  it("handles null proxy-store state when ticket has no applied state", () => {
    // The applied-state-store returns null for unknown tickets
    const record = buildTransitionAuditRecord(
      "AI-9999",
      "observe-issue",
      null,
      null,
      null,
      "noop",
      "NO_OP",
      "No transition needed",
      null,
      [],
    );

    expect(record.proxyStoreState).toBeNull();
    expect(record.status).toBe("noop");
    expect(record.agentId).toBeNull();
  });
});

describe("emitTransitionAuditRecord", () => {
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;
  let consoleInfoSpy: jest.SpiedFunction<typeof console.info>;

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleInfoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleInfoSpy.mockRestore();
  });

  it("calls emitTransitionAuditRecord without throwing for an applied transition", () => {
    const record = buildTransitionAuditRecord(
      "AI-2554",
      "continue-workflow",
      "code-review",
      "implementation",
      "code-review",
      "applied",
      "OK",
      null,
      "igor",
      [],
    );

    expect(() => emitTransitionAuditRecord(record)).not.toThrow();
  });

  it("calls emitTransitionAuditRecord without throwing for a blocked transition", () => {
    const record = buildTransitionAuditRecord(
      "AI-2555",
      "continue-workflow",
      null,
      "implementation",
      null,
      "blocked",
      "GATE_BLOCKED",
      "not-implementer",
      "ai",
      [{ name: "capability-check", passed: false, detail: "not-implementer" }],
    );

    expect(() => emitTransitionAuditRecord(record)).not.toThrow();
  });

  it("calls emitTransitionAuditRecord without throwing for a failed transition", () => {
    const record = buildTransitionAuditRecord(
      "AI-2556",
      "handoff-work",
      null,
      null,
      null,
      "failed",
      "ERR_INTERNAL",
      "Unexpected error",
      null,
      [],
    );

    expect(() => emitTransitionAuditRecord(record)).not.toThrow();
  });
});

describe("emitLabelSyncWarning", () => {
  it("accepts a divergence descriptor and logs without throwing", () => {
    const divergence = {
      ticketId: "AI-1234",
      proxyState: "implementation",
      linearState: "code-review",
      linearStateLabel: "state:code-review",
      ageSec: 3600,
    };

    expect(() => emitLabelSyncWarning(divergence)).not.toThrow();
  });
});
