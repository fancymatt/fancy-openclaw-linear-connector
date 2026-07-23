import { describe, expect, it } from "@jest/globals";

import {
  buildManagingWakeMessage,
  isObserverTicket,
  OBSERVER_WORKFLOW_LABELS,
  STEWARD_OWNED_STATES,
} from "./managing-wake.js";

describe("OBSERVER_WORKFLOW_LABELS", () => {
  it("includes spawner and dev-sprint workflows", () => {
    expect(OBSERVER_WORKFLOW_LABELS.has("wf:sprint-spawner")).toBe(true);
    expect(OBSERVER_WORKFLOW_LABELS.has("wf:dev-sprint")).toBe(true);
  });
});

describe("STEWARD_OWNED_STATES", () => {
  it("includes spawner steward states", () => {
    expect(STEWARD_OWNED_STATES.has("evaluating")).toBe(true);
    expect(STEWARD_OWNED_STATES.has("scanning")).toBe(true);
    expect(STEWARD_OWNED_STATES.has("determining-scope")).toBe(true);
    expect(STEWARD_OWNED_STATES.has("scoping")).toBe(true);
    expect(STEWARD_OWNED_STATES.has("launching")).toBe(true);
    expect(STEWARD_OWNED_STATES.has("managing")).toBe(true);
    expect(STEWARD_OWNED_STATES.has("releasing")).toBe(true);
    expect(STEWARD_OWNED_STATES.has("retrospecting")).toBe(true);
  });

  it("includes dev-sprint steward states", () => {
    expect(STEWARD_OWNED_STATES.has("product-definition")).toBe(true);
    expect(STEWARD_OWNED_STATES.has("ac-definition")).toBe(true);
  });
});

describe("isObserverTicket", () => {
  it("returns false for a normal ticket with no labels", () => {
    expect(isObserverTicket({
      identifier: "AI-1",
      title: "T1",
      lastDispatchedAt: null,
    })).toBe(false);
  });

  it("returns false for a spawner ticket not in a steward state", () => {
    expect(isObserverTicket({
      identifier: "AI-2",
      title: "T2",
      lastDispatchedAt: null,
      labels: ["wf:sprint-spawner"],
      stateName: "in-progress",
    })).toBe(false);
  });

  it("returns true for a spawner ticket in a steward state", () => {
    expect(isObserverTicket({
      identifier: "GEN-203",
      title: "Gen loop",
      lastDispatchedAt: null,
      labels: ["wf:sprint-spawner"],
      stateName: "managing",
    })).toBe(true);
  });

  it("returns true for a dev-sprint ticket in a steward state", () => {
    expect(isObserverTicket({
      identifier: "GEN-216",
      title: "Sprint 1",
      lastDispatchedAt: null,
      labels: ["wf:dev-sprint", "something-else"],
      stateName: "product-definition",
    })).toBe(true);
  });

  it("is case-insensitive on the state name", () => {
    expect(isObserverTicket({
      identifier: "GEN-203",
      title: "Gen loop",
      lastDispatchedAt: null,
      labels: ["wf:sprint-spawner"],
      stateName: "Managing",
    })).toBe(true);
  });

  it("returns false when labels are empty", () => {
    expect(isObserverTicket({
      identifier: "AI-3",
      title: "T3",
      lastDispatchedAt: null,
      labels: [],
      stateName: "managing",
    })).toBe(false);
  });

  it("returns false when stateName is missing", () => {
    expect(isObserverTicket({
      identifier: "AI-4",
      title: "T4",
      lastDispatchedAt: null,
      labels: ["wf:sprint-spawner"],
    })).toBe(false);
  });
});

describe("buildManagingWakeMessage", () => {
  it("throws when given no tickets", () => {
    expect(() => buildManagingWakeMessage([])).toThrow();
  });

  it("formats a first-review ticket", () => {
    const msg = buildManagingWakeMessage(
      [{ identifier: "AI-1", title: "Wire up X", lastDispatchedAt: null }],
      1_000_000,
    );
    expect(msg).toContain("You are managing these tickets:");
    expect(msg).toContain("- AI-1: Wire up X (last reviewed: first review)");
    expect(msg).toContain("Check subtask state");
    expect(msg).toContain("delta-only note");
    expect(msg).toContain("Do not restate unchanged child status");
    expect(msg).toContain("Move tickets out of Managing");
    // Not observe-only — no observer caveat
    expect(msg).not.toContain("observe-only");
    expect(msg).not.toContain("OBSERVE-ONLY");
  });

  it("formats minute / hour / day relative timestamps", () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    const msg = buildManagingWakeMessage(
      [
        { identifier: "AI-1", title: "T1", lastDispatchedAt: now - 30 * 1000 },
        { identifier: "AI-2", title: "T2", lastDispatchedAt: now - 5 * 60 * 1000 },
        { identifier: "AI-3", title: "T3", lastDispatchedAt: now - 3 * 60 * 60 * 1000 },
        { identifier: "AI-4", title: "T4", lastDispatchedAt: now - 2 * 24 * 60 * 60 * 1000 },
      ],
      now,
    );
    expect(msg).toContain("30s ago");
    expect(msg).toContain("5m ago");
    expect(msg).toContain("3h ago");
    expect(msg).toContain("2d ago");
  });

  it("bundles multiple tickets into one message", () => {
    const msg = buildManagingWakeMessage(
      [
        { identifier: "AI-1", title: "First", lastDispatchedAt: null },
        { identifier: "AI-2", title: "Second", lastDispatchedAt: null },
      ],
      0,
    );
    const lines = msg.split("\n");
    const headerIdx = lines.indexOf("You are managing these tickets:");
    expect(headerIdx).toBe(0);
    expect(lines[1]).toMatch(/AI-1/);
    expect(lines[2]).toMatch(/AI-2/);
  });

  describe("observe-only tagging", () => {
    it("appends observe-only tag line for an observer ticket", () => {
      const msg = buildManagingWakeMessage(
        [{
          identifier: "GEN-203",
          title: "Gen loop",
          lastDispatchedAt: null,
          labels: ["wf:sprint-spawner"],
          stateName: "managing",
        }],
        0,
      );
      expect(msg).toContain("[observe-only]");
      expect(msg).toContain("OBSERVE-ONLY");
      expect(msg).toContain("steward-owned state");
      expect(msg).toContain("Do NOT author briefs");
      expect(msg).toContain("hand decisions back");
    });

    it("does not append observer caveat when mix includes no observer tickets", () => {
      const msg = buildManagingWakeMessage(
        [
          { identifier: "AI-1", title: "Regular task", lastDispatchedAt: null },
          { identifier: "AI-2", title: "Another task", lastDispatchedAt: null },
        ],
        0,
      );
      expect(msg).not.toContain("observe-only");
      expect(msg).not.toContain("OBSERVE-ONLY");
    });

    it("appends observer caveat when any ticket in the bundle is an observer ticket", () => {
      const msg = buildManagingWakeMessage(
        [
          { identifier: "AI-1", title: "Regular task", lastDispatchedAt: null },
          {
            identifier: "GEN-203",
            title: "Gen loop",
            lastDispatchedAt: null,
            labels: ["wf:sprint-spawner"],
            stateName: "managing",
          },
        ],
        0,
      );
      expect(msg).toContain("[observe-only]");
      expect(msg).toContain("OBSERVE-ONLY");
      expect(msg).toContain("Do NOT author briefs");
    });
  });
});
