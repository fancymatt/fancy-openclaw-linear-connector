/**
 * Tests for the department-roster routing functionary (AI-1479).
 *
 * Tests the pure `resolveRoute` function and the roster loader.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveRoute,
  loadRoster,
  resetRosterCache,
  getSteward,
  type DepartmentRoster,
} from "./department-roster.js";
import yaml from "js-yaml";

// ── Helpers ──────────────────────────────────────────────────────────────────

const SAMPLE_ROSTER: DepartmentRoster = {
  version: 1,
  steward: "astrid",
  departments: {
    AI: {
      name: "AI Team",
      defaultTarget: "igor",
      description: "Backend web dev",
    },
    ILL: {
      name: "ILL Team",
      defaultTarget: "charles",
      fallbackTarget: "yoshi",
    },
    FCY: {
      name: "FCY Team",
      defaultTarget: "ken",
      overrides: {
        Comment: "kana",
        AgentSessionEvent: "mika",
      },
    },
  },
};

// ── resolveRoute (pure function) ────────────────────────────────────────────

describe("resolveRoute", () => {
  it("routes by department prefix when identifier matches", () => {
    const result = resolveRoute("AI-1479", "Issue", SAMPLE_ROSTER, null);
    expect(result.target).toBe("igor");
    expect(result.reason).toBe("department-prefix");
    expect(result.escalated).toBe(false);
    expect(result.matchedPrefix).toBe("AI");
  });

  it("routes by department prefix case-insensitively", () => {
    const result = resolveRoute("ai-1479", "Issue", SAMPLE_ROSTER, null);
    expect(result.target).toBe("igor");
    expect(result.reason).toBe("department-prefix");
    expect(result.matchedPrefix).toBe("AI");
  });

  it("uses department override for specific event types", () => {
    const result = resolveRoute("FCY-42", "Comment", SAMPLE_ROSTER, null);
    expect(result.target).toBe("kana");
    expect(result.reason).toBe("department-override");
    expect(result.escalated).toBe(false);
  });

  it("uses department override for AgentSessionEvent", () => {
    const result = resolveRoute("FCY-42", "AgentSessionEvent", SAMPLE_ROSTER, null);
    expect(result.target).toBe("mika");
    expect(result.reason).toBe("department-override");
  });

  it("uses defaultTarget when no override matches event type", () => {
    const result = resolveRoute("FCY-42", "Issue", SAMPLE_ROSTER, null);
    expect(result.target).toBe("ken");
    expect(result.reason).toBe("department-prefix");
  });

  it("falls back to mechanical target when no department match", () => {
    const result = resolveRoute("XYZ-99", "Issue", SAMPLE_ROSTER, {
      name: "charles",
      reason: "delegate",
    });
    expect(result.target).toBe("charles");
    expect(result.reason).toBe("delegate");
    expect(result.escalated).toBe(false);
  });

  it("falls back to mechanical target when identifier is null", () => {
    const result = resolveRoute(null, "Issue", SAMPLE_ROSTER, {
      name: "igor",
      reason: "assignee",
    });
    expect(result.target).toBe("igor");
    expect(result.reason).toBe("assignee");
    expect(result.escalated).toBe(false);
  });

  it("escalates to steward when no department match and no mechanical target", () => {
    const result = resolveRoute("XYZ-99", "Issue", SAMPLE_ROSTER, null);
    expect(result.target).toBe("astrid");
    expect(result.reason).toBe("steward-escalation");
    expect(result.escalated).toBe(true);
  });

  it("escalates to steward when identifier is null and no mechanical target", () => {
    const result = resolveRoute(null, null, SAMPLE_ROSTER, null);
    expect(result.target).toBe("astrid");
    expect(result.reason).toBe("steward-escalation");
    expect(result.escalated).toBe(true);
  });

  it("defaults to 'astrid' steward when roster is null and no mechanical target", () => {
    const result = resolveRoute("AI-1", "Issue", null, null);
    expect(result.target).toBe("astrid");
    expect(result.reason).toBe("steward-escalation");
    expect(result.escalated).toBe(true);
  });

  it("prefers department prefix over mechanical target", () => {
    const result = resolveRoute("AI-1479", "Issue", SAMPLE_ROSTER, {
      name: "charles",
      reason: "delegate",
    });
    expect(result.target).toBe("igor");
    expect(result.reason).toBe("department-prefix");
  });

  it("returns null matchedPrefix when no department match", () => {
    const result = resolveRoute("XYZ-99", "Issue", SAMPLE_ROSTER, {
      name: "igor",
      reason: "mention",
    });
    expect(result.matchedPrefix).toBeUndefined();
  });

  it("handles roster with no departments", () => {
    const emptyRoster: DepartmentRoster = {
      version: 1,
      steward: "astrid",
      departments: {},
    };
    const result = resolveRoute("AI-1", "Issue", emptyRoster, {
      name: "igor",
      reason: "delegate",
    });
    expect(result.target).toBe("igor");
    expect(result.reason).toBe("delegate");
  });

  it("handles empty overrides map", () => {
    const roster: DepartmentRoster = {
      version: 1,
      steward: "astrid",
      departments: {
        AI: { name: "AI", defaultTarget: "igor", overrides: {} },
      },
    };
    const result = resolveRoute("AI-1", "Comment", roster, null);
    expect(result.target).toBe("igor");
    expect(result.reason).toBe("department-prefix");
  });
});

// ── loadRoster ───────────────────────────────────────────────────────────────

describe("loadRoster", () => {
  let rosterFile: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    resetRosterCache();
    originalEnv = process.env.DEPARTMENT_ROSTER_PATH;
  });

  afterEach(() => {
    resetRosterCache();
    if (originalEnv !== undefined) {
      process.env.DEPARTMENT_ROSTER_PATH = originalEnv;
    } else {
      delete process.env.DEPARTMENT_ROSTER_PATH;
    }
    if (rosterFile) {
      fs.rmSync(path.dirname(rosterFile), { recursive: true, force: true });
    }
  });

  it("loads a valid roster from disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-load-"));
    rosterFile = path.join(dir, "roster.yaml");
    fs.writeFileSync(rosterFile, yaml.dump(SAMPLE_ROSTER));
    process.env.DEPARTMENT_ROSTER_PATH = rosterFile;

    const roster = await loadRoster();
    expect(roster).not.toBeNull();
    expect(roster!.version).toBe(1);
    expect(roster!.steward).toBe("astrid");
    expect(Object.keys(roster!.departments)).toHaveLength(3);
  });

  it("returns null when file does not exist", async () => {
    process.env.DEPARTMENT_ROSTER_PATH = "/nonexistent/path/roster.yaml";
    const roster = await loadRoster();
    expect(roster).toBeNull();
  });

  it("returns null for invalid roster structure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-invalid-"));
    rosterFile = path.join(dir, "roster.yaml");
    fs.writeFileSync(rosterFile, "version: 1\n"); // missing departments and steward
    process.env.DEPARTMENT_ROSTER_PATH = rosterFile;

    const roster = await loadRoster();
    expect(roster).toBeNull();
  });

  it("caches the loaded roster", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-cache-"));
    rosterFile = path.join(dir, "roster.yaml");
    fs.writeFileSync(rosterFile, yaml.dump(SAMPLE_ROSTER));
    process.env.DEPARTMENT_ROSTER_PATH = rosterFile;

    const first = await loadRoster();
    const second = await loadRoster();
    expect(first).toBe(second); // Same reference — cached
  });
});

// ── getSteward ───────────────────────────────────────────────────────────────

describe("getSteward", () => {
  it("returns the roster steward when available", () => {
    expect(getSteward(SAMPLE_ROSTER)).toBe("astrid");
  });

  it("defaults to 'astrid' when roster is null", () => {
    expect(getSteward(null)).toBe("astrid");
  });
});
