/**
 * Tests for the steward-gated AC recapture path (AI-1776 AC3).
 *
 * recaptureAc(ticketId, authToken, callerBodyId, opts?) allows a steward
 * to (re)capture the AC of record from the current ticket description after
 * the accept transition. Non-steward callers are rejected. Overwriting an
 * existing record requires explicit force + leaves a Linear comment trail.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import {
  getAcRecord,
  captureAc,
  clearAcRecordStore,
  recaptureAc,
} from "./ac-record-store.js";
import { resetPolicyCache } from "./escalation-gate.js";

const POLICY_WITH_STEWARD = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass

containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: dev
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: dev
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: [dev]
`;

const DESCRIPTION_WITH_AC = `## Problem
Something broke.

## Acceptance Criteria

* AC1: The extractor works
* AC2: Tests pass

## Pointers
See the code.`;

const DESCRIPTION_WITHOUT_AC = `## Problem
Something broke with no AC section here.

## Notes
Just notes.`;

let tmpDir: string;
let tmpAcFile: string;
let policyFile: string;
let originalFetch: typeof globalThis.fetch;
let originalPolicyPath: string | undefined;
let originalAcPath: string | undefined;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `ac-recapture-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(tmpDir, { recursive: true });

  tmpAcFile = path.join(tmpDir, "ac-records.json");
  process.env.AC_RECORDS_PATH = tmpAcFile;
  originalAcPath = process.env.AC_RECORDS_PATH;

  policyFile = path.join(tmpDir, "capability-policy.yaml");
  fsSync.writeFileSync(policyFile, POLICY_WITH_STEWARD, "utf8");
  originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  clearAcRecordStore();
  resetPolicyCache();
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  clearAcRecordStore();
  resetPolicyCache();

  if (originalPolicyPath !== undefined) {
    process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
  } else {
    delete process.env.CAPABILITY_POLICY_PATH;
  }
  if (originalAcPath !== undefined) {
    process.env.AC_RECORDS_PATH = originalAcPath;
  } else {
    delete process.env.AC_RECORDS_PATH;
  }
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

function makeRecaptureFetch(opts: {
  description?: string;
  descriptionFetchFails?: boolean;
  commentFails?: boolean;
}): { fetch: typeof globalThis.fetch; commentBodies: string[] } {
  const commentBodies: string[] = [];

  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string };
    const query = parsed.query ?? "";

    if (query.includes("IssueDescription")) {
      if (opts.descriptionFetchFails) throw new Error("simulated description fetch failure");
      return new Response(
        JSON.stringify({ data: { issue: { description: opts.description ?? DESCRIPTION_WITH_AC } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("commentCreate")) {
      commentBodies.push(bodyText);
      if (opts.commentFails) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: false } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "recapture-comment-id" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected fetch query in recapture test: ${query.slice(0, 80)}`);
  };

  return { fetch: mockFetch, commentBodies };
}

describe("recaptureAc — AI-1776 AC3", () => {
  // ── Authorization ─────────────────────────────────────────────────────────

  describe("steward gating", () => {
    it("rejects a non-steward caller (dev body)", async () => {
      const { fetch: mock } = makeRecaptureFetch({});
      globalThis.fetch = mock;

      await expect(
        recaptureAc("AI-1776", "Bearer tok", "charles"),
      ).rejects.toThrow(/steward|unauthorized|not authorized/i);
    });

    it("rejects an unknown body ID", async () => {
      const { fetch: mock } = makeRecaptureFetch({});
      globalThis.fetch = mock;

      await expect(
        recaptureAc("AI-1776", "Bearer tok", "totally-unknown-body"),
      ).rejects.toThrow(/steward|unauthorized|not authorized/i);
    });

    it("allows a steward body (astrid)", async () => {
      const { fetch: mock } = makeRecaptureFetch({});
      globalThis.fetch = mock;

      await expect(
        recaptureAc("AI-1776", "Bearer tok", "astrid"),
      ).resolves.not.toThrow();
    });
  });

  // ── Create (no existing record) ───────────────────────────────────────────

  describe("create when no record exists", () => {
    it("captures AC from current description when no record exists", async () => {
      const { fetch: mock } = makeRecaptureFetch({
        description: DESCRIPTION_WITH_AC,
      });
      globalThis.fetch = mock;

      await recaptureAc("AI-1776", "Bearer tok", "astrid");

      const record = await getAcRecord("AI-1776");
      expect(record).not.toBeNull();
      expect(record!.verbatimAc).toContain("AC1: The extractor works");
      expect(record!.capturedBy).toBe("astrid");
      expect(record!.source).toBe("description");
    });

    it("does not post a comment trail when creating a fresh record (no existing record)", async () => {
      const { fetch: mock, commentBodies } = makeRecaptureFetch({
        description: DESCRIPTION_WITH_AC,
      });
      globalThis.fetch = mock;

      await recaptureAc("AI-1776", "Bearer tok", "astrid");

      expect(commentBodies).toHaveLength(0);
    });

    it("rejects when description has no AC header (no record to create)", async () => {
      const { fetch: mock } = makeRecaptureFetch({
        description: DESCRIPTION_WITHOUT_AC,
      });
      globalThis.fetch = mock;

      await expect(
        recaptureAc("AI-1776", "Bearer tok", "astrid"),
      ).rejects.toThrow(/no.*AC.*header|no.*acceptance.*criteria|AC.*section.*not found/i);
    });

    it("rejects when description fetch fails", async () => {
      const { fetch: mock } = makeRecaptureFetch({ descriptionFetchFails: true });
      globalThis.fetch = mock;

      await expect(
        recaptureAc("AI-1776", "Bearer tok", "astrid"),
      ).rejects.toThrow(/fetch.*fail|description.*unavailable|could not fetch/i);
    });
  });

  // ── Overwrite guard (existing record) ─────────────────────────────────────

  describe("overwrite protection", () => {
    beforeEach(async () => {
      await captureAc("AI-1776", {
        verbatimAc: "* Original AC: works as before",
        capturedAt: "2026-07-01T00:00:00Z",
        capturedBy: "original-steward",
        source: "description",
      });
    });

    it("rejects overwrite without force flag", async () => {
      const { fetch: mock } = makeRecaptureFetch({
        description: DESCRIPTION_WITH_AC,
      });
      globalThis.fetch = mock;

      await expect(
        recaptureAc("AI-1776", "Bearer tok", "astrid"),
      ).rejects.toThrow(/already exists|existing record|use force/i);
    });

    it("rejects overwrite with force: false explicitly", async () => {
      const { fetch: mock } = makeRecaptureFetch({
        description: DESCRIPTION_WITH_AC,
      });
      globalThis.fetch = mock;

      await expect(
        recaptureAc("AI-1776", "Bearer tok", "astrid", { force: false }),
      ).rejects.toThrow(/already exists|existing record|use force/i);
    });

    it("original record is untouched when force is not set", async () => {
      const { fetch: mock } = makeRecaptureFetch({
        description: DESCRIPTION_WITH_AC,
      });
      globalThis.fetch = mock;

      try {
        await recaptureAc("AI-1776", "Bearer tok", "astrid");
      } catch {
        // expected to throw
      }

      const record = await getAcRecord("AI-1776");
      expect(record!.verbatimAc).toBe("* Original AC: works as before");
      expect(record!.capturedBy).toBe("original-steward");
    });

    it("overwrites existing record when force: true", async () => {
      const { fetch: mock } = makeRecaptureFetch({
        description: DESCRIPTION_WITH_AC,
      });
      globalThis.fetch = mock;

      await recaptureAc("AI-1776", "Bearer tok", "astrid", { force: true });

      const record = await getAcRecord("AI-1776");
      expect(record).not.toBeNull();
      expect(record!.verbatimAc).toContain("AC1: The extractor works");
      expect(record!.capturedBy).toBe("astrid");
    });

    it("posts a Linear comment trail on forced overwrite", async () => {
      const { fetch: mock, commentBodies } = makeRecaptureFetch({
        description: DESCRIPTION_WITH_AC,
      });
      globalThis.fetch = mock;

      await recaptureAc("AI-1776", "Bearer tok", "astrid", { force: true });

      expect(commentBodies.length).toBeGreaterThanOrEqual(1);
      const commentPayload = JSON.parse(commentBodies[0]) as { query?: string; variables?: { body?: string } };
      expect(commentPayload.variables?.body).toMatch(/recaptur|force.*overwrite|AC.*updated/i);
    });

    it("comment trail on forced overwrite names the steward who forced it", async () => {
      const { fetch: mock, commentBodies } = makeRecaptureFetch({
        description: DESCRIPTION_WITH_AC,
      });
      globalThis.fetch = mock;

      await recaptureAc("AI-1776", "Bearer tok", "astrid", { force: true });

      const commentPayload = JSON.parse(commentBodies[0]) as { variables?: { body?: string } };
      expect(commentPayload.variables?.body).toContain("astrid");
    });
  });

  // ── Non-steward cannot force ───────────────────────────────────────────────

  it("non-steward is rejected even with force: true", async () => {
    await captureAc("AI-1776", {
      verbatimAc: "* original",
      capturedAt: "2026-07-01T00:00:00Z",
      capturedBy: "original-steward",
      source: "description",
    });

    const { fetch: mock } = makeRecaptureFetch({ description: DESCRIPTION_WITH_AC });
    globalThis.fetch = mock;

    await expect(
      recaptureAc("AI-1776", "Bearer tok", "charles", { force: true }),
    ).rejects.toThrow(/steward|unauthorized|not authorized/i);

    const record = await getAcRecord("AI-1776");
    expect(record!.verbatimAc).toBe("* original");
  });
});
