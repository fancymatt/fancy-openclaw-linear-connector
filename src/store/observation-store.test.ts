import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObservationStore, REASON_CODES, type ReasonCode } from "./observation-store.js";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observation-store-test-"));
  return path.join(dir, "observations.db");
}

describe("ObservationStore", () => {
  let dbPath: string;
  let store: ObservationStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new ObservationStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("appends a single observation row with all fields populated", () => {
    const id = store.append({
      ticket: "AI-1378",
      workflow: "dev-impl",
      step: "code-review",
      fromBody: "igor",
      reviewerBody: "charles",
      reasonCode: "missing-tests",
      freeText: "No unit tests for the new function",
    });

    expect(id).toBeGreaterThan(0);

    const rows = store.query();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      ticket: "AI-1378",
      workflow: "dev-impl",
      step: "code-review",
      fromBody: "igor",
      reviewerBody: "charles",
      reasonCode: "missing-tests",
      freeText: "No unit tests for the new function",
    });
    expect(rows[0].createdAt).toBeTruthy();
  });

  it("appends rows with null freeText when not provided", () => {
    store.append({
      ticket: "AI-100",
      workflow: "dev-impl",
      step: "deployment",
      fromBody: "sage",
      reviewerBody: "hanzo",
      reasonCode: "correctness",
    });

    const [row] = store.query();
    expect(row.freeText).toBeNull();
  });

  it("is append-only: duplicate appends produce additional rows", () => {
    const input = {
      ticket: "AI-200",
      workflow: "dev-impl",
      step: "code-review",
      fromBody: "felix",
      reviewerBody: "charles",
      reasonCode: "style" as ReasonCode,
    };

    const id1 = store.append(input);
    const id2 = store.append(input);

    expect(id1).not.toBe(id2);
    expect(store.query()).toHaveLength(2);
  });

  it("queries by (workflow, step, reason_code)", () => {
    store.append({ ticket: "AI-1", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests" });
    store.append({ ticket: "AI-2", workflow: "dev-impl", step: "code-review", fromBody: "felix", reviewerBody: "charles", reasonCode: "style" });
    store.append({ ticket: "AI-3", workflow: "dev-impl", step: "deployment", fromBody: "sage", reviewerBody: "hanzo", reasonCode: "correctness" });
    store.append({ ticket: "AI-4", workflow: "other-wf", step: "code-review", fromBody: "noah", reviewerBody: "reviewer", reasonCode: "scope-creep" });

    // Filter by workflow + step
    const codeReview = store.query({ workflow: "dev-impl", step: "code-review" });
    expect(codeReview).toHaveLength(2);

    // Filter by reason_code
    const missingTests = store.query({ reasonCode: "missing-tests" });
    expect(missingTests).toHaveLength(1);
    expect(missingTests[0].ticket).toBe("AI-1");

    // Filter by workflow + step + reason_code
    const styled = store.query({ workflow: "dev-impl", step: "code-review", reasonCode: "style" });
    expect(styled).toHaveLength(1);
    expect(styled[0].ticket).toBe("AI-2");

    // Filter by ticket
    const byTicket = store.query({ ticket: "AI-3" });
    expect(byTicket).toHaveLength(1);
  });

  it("queries by time range (since, until)", () => {
    store.append({ ticket: "AI-1", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests", timestamp: "2026-06-01T10:00:00.000Z" });
    store.append({ ticket: "AI-2", workflow: "dev-impl", step: "code-review", fromBody: "felix", reviewerBody: "charles", reasonCode: "style", timestamp: "2026-06-03T10:00:00.000Z" });
    store.append({ ticket: "AI-3", workflow: "dev-impl", step: "code-review", fromBody: "sage", reviewerBody: "charles", reasonCode: "correctness", timestamp: "2026-06-05T10:00:00.000Z" });

    const midRange = store.query({ since: "2026-06-02T00:00:00.000Z", until: "2026-06-04T00:00:00.000Z" });
    expect(midRange).toHaveLength(1);
    expect(midRange[0].ticket).toBe("AI-2");
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      store.append({
        ticket: `AI-${i}`,
        workflow: "dev-impl",
        step: "code-review",
        fromBody: "igor",
        reviewerBody: "charles",
        reasonCode: "missing-tests",
      });
    }

    expect(store.query({ limit: 3 })).toHaveLength(3);
    expect(store.query({ limit: 100 })).toHaveLength(10);
  });

  it("defaults limit to 100 when not provided", () => {
    for (let i = 0; i < 150; i++) {
      store.append({
        ticket: `AI-${i}`,
        workflow: "dev-impl",
        step: "code-review",
        fromBody: "igor",
        reviewerBody: "charles",
        reasonCode: "missing-tests",
      });
    }

    // Default limit is 100
    expect(store.query()).toHaveLength(100);
  });

  it("clamps NaN limit to default (100)", () => {
    for (let i = 0; i < 150; i++) {
      store.append({
        ticket: `AI-${i}`,
        workflow: "dev-impl",
        step: "code-review",
        fromBody: "igor",
        reviewerBody: "charles",
        reasonCode: "missing-tests",
      });
    }

    // NaN propagates through Math.min/max, but our guard should clamp it to 100
    expect(store.query({ limit: Number.NaN })).toHaveLength(100);
    // Negative should also be clamped
    expect(store.query({ limit: -5 })).toHaveLength(100);
  });

  it("returns counts grouped by (workflow, step, reason_code)", () => {
    store.append({ ticket: "AI-1", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests" });
    store.append({ ticket: "AI-2", workflow: "dev-impl", step: "code-review", fromBody: "felix", reviewerBody: "charles", reasonCode: "missing-tests" });
    store.append({ ticket: "AI-3", workflow: "dev-impl", step: "code-review", fromBody: "sage", reviewerBody: "charles", reasonCode: "style" });
    store.append({ ticket: "AI-4", workflow: "dev-impl", step: "deployment", fromBody: "igor", reviewerBody: "hanzo", reasonCode: "correctness" });

    const counts = store.counts({ workflow: "dev-impl" });

    expect(counts).toHaveLength(3);

    const mt = counts.find((c) => c.reasonCode === "missing-tests" && c.step === "code-review");
    expect(mt?.count).toBe(2);

    const st = counts.find((c) => c.reasonCode === "style" && c.step === "code-review");
    expect(st?.count).toBe(1);

    const cr = counts.find((c) => c.reasonCode === "correctness" && c.step === "deployment");
    expect(cr?.count).toBe(1);
  });

  it("defaults createdAt to current time when not provided", () => {
    const before = new Date();
    store.append({
      ticket: "AI-1",
      workflow: "dev-impl",
      step: "code-review",
      fromBody: "igor",
      reviewerBody: "charles",
      reasonCode: "missing-tests",
    });
    const after = new Date();

    const [row] = store.query();
    const createdAt = new Date(row.createdAt);
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });
});

describe("ObservationStore — countsByBody", () => {
  let dbPath: string;
  let store: ObservationStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new ObservationStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("groups counts by (workflow, step, reason_code, from_body)", () => {
    store.append({ ticket: "AI-1", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests" });
    store.append({ ticket: "AI-2", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests" });
    store.append({ ticket: "AI-3", workflow: "dev-impl", step: "code-review", fromBody: "felix", reviewerBody: "charles", reasonCode: "missing-tests" });
    store.append({ ticket: "AI-4", workflow: "dev-impl", step: "deployment", fromBody: "igor", reviewerBody: "hanzo", reasonCode: "correctness" });

    const counts = store.countsByBody({ workflow: "dev-impl" });
    expect(counts).toHaveLength(3);

    const igorMT = counts.find((c) => c.fromBody === "igor" && c.step === "code-review");
    expect(igorMT?.count).toBe(2);

    const felixMT = counts.find((c) => c.fromBody === "felix" && c.step === "code-review");
    expect(felixMT?.count).toBe(1);

    const igorCorrect = counts.find((c) => c.fromBody === "igor" && c.step === "deployment");
    expect(igorCorrect?.count).toBe(1);
  });

  it("returns empty array for no observations", () => {
    const counts = store.countsByBody();
    expect(counts).toEqual([]);
  });

  it("filters by reasonCode", () => {
    store.append({ ticket: "AI-1", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests" });
    store.append({ ticket: "AI-2", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "style" });

    const counts = store.countsByBody({ reasonCode: "style" });
    expect(counts).toHaveLength(1);
    expect(counts[0].reasonCode).toBe("style");
  });
});

describe("ObservationStore — metrics", () => {
  let dbPath: string;
  let store: ObservationStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new ObservationStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("returns metric rollup with correct counts per (workflow, step, reason_code)", () => {
    store.append({ ticket: "AI-1", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests" });
    store.append({ ticket: "AI-2", workflow: "dev-impl", step: "code-review", fromBody: "felix", reviewerBody: "charles", reasonCode: "missing-tests" });
    store.append({ ticket: "AI-3", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "style" });
    store.append({ ticket: "AI-4", workflow: "dev-impl", step: "deployment", fromBody: "sage", reviewerBody: "hanzo", reasonCode: "correctness" });

    const rollup = store.metrics({ workflow: "dev-impl" });
    expect(rollup.items).toHaveLength(3); // 3 distinct (step, reason_code) combos

    const mt = rollup.items.find((i) => i.reasonCode === "missing-tests" && i.step === "code-review");
    expect(mt?.count).toBe(2);
    expect(mt?.exceedsThreshold).toBe(false); // no threshold set
  });

  it("includes body breakdown when includeBody is true", () => {
    store.append({ ticket: "AI-1", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests" });
    store.append({ ticket: "AI-2", workflow: "dev-impl", step: "code-review", fromBody: "felix", reviewerBody: "charles", reasonCode: "missing-tests" });

    const rollup = store.metrics({ workflow: "dev-impl", includeBody: true });
    expect(rollup.items).toHaveLength(2);
    expect(rollup.items[0].fromBody).toBeDefined();
    expect(rollup.items[1].fromBody).toBeDefined();
  });

  it("identifies reason codes crossing a threshold", () => {
    for (let i = 0; i < 5; i++) {
      store.append({ ticket: `AI-${i}`, workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests" });
    }
    store.append({ ticket: "AI-10", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "style" });

    const rollup = store.metrics({ workflow: "dev-impl", threshold: 3 });

    const mt = rollup.items.find((i) => i.reasonCode === "missing-tests");
    expect(mt?.exceedsThreshold).toBe(true);

    const style = rollup.items.find((i) => i.reasonCode === "style");
    expect(style?.exceedsThreshold).toBe(false);
  });

  it("populates summary with correct totals", () => {
    store.append({ ticket: "AI-1", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests" });
    store.append({ ticket: "AI-2", workflow: "dev-impl", step: "code-review", fromBody: "felix", reviewerBody: "charles", reasonCode: "style" });
    store.append({ ticket: "AI-3", workflow: "dev-impl", step: "deployment", fromBody: "sage", reviewerBody: "hanzo", reasonCode: "correctness" });

    const rollup = store.metrics();
    expect(rollup.summary.totalObservations).toBe(3);
    expect(rollup.summary.uniqueWorkflows).toBe(1);
    expect(rollup.summary.uniqueSteps).toBe(2);
  });

  it("identifies steps above threshold in summary", () => {
    for (let i = 0; i < 5; i++) {
      store.append({ ticket: `AI-${i}`, workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests" });
    }
    store.append({ ticket: "AI-10", workflow: "dev-impl", step: "deployment", fromBody: "igor", reviewerBody: "hanzo", reasonCode: "correctness" });

    const rollup = store.metrics({ threshold: 3 });
    expect(rollup.summary.stepsAboveThreshold).toHaveLength(1);
    expect(rollup.summary.stepsAboveThreshold[0]).toMatchObject({
      workflow: "dev-impl",
      step: "code-review",
      total: 5,
    });
  });

  it("returns clean empty result for no observations", () => {
    const rollup = store.metrics();
    expect(rollup.items).toEqual([]);
    expect(rollup.summary.totalObservations).toBe(0);
    expect(rollup.summary.uniqueWorkflows).toBe(0);
    expect(rollup.summary.uniqueSteps).toBe(0);
    expect(rollup.summary.stepsAboveThreshold).toEqual([]);
  });

  it("output is stable: same input produces same numbers", () => {
    store.append({ ticket: "AI-1", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests" });
    store.append({ ticket: "AI-2", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests" });

    const r1 = store.metrics({ workflow: "dev-impl" });
    const r2 = store.metrics({ workflow: "dev-impl" });

    expect(r1.items).toEqual(r2.items);
    expect(r1.summary).toEqual(r2.summary);
  });

  it("filters by time range (since, until)", () => {
    store.append({ ticket: "AI-1", workflow: "dev-impl", step: "code-review", fromBody: "igor", reviewerBody: "charles", reasonCode: "missing-tests", timestamp: "2026-06-01T10:00:00.000Z" });
    store.append({ ticket: "AI-2", workflow: "dev-impl", step: "code-review", fromBody: "felix", reviewerBody: "charles", reasonCode: "style", timestamp: "2026-06-03T10:00:00.000Z" });
    store.append({ ticket: "AI-3", workflow: "dev-impl", step: "code-review", fromBody: "sage", reviewerBody: "charles", reasonCode: "correctness", timestamp: "2026-06-05T10:00:00.000Z" });

    const rollup = store.metrics({ since: "2026-06-02T00:00:00.000Z", until: "2026-06-04T00:00:00.000Z" });
    expect(rollup.items).toHaveLength(1);
    expect(rollup.items[0].reasonCode).toBe("style");
  });
});

describe("ObservationStore — validateReasonCode", () => {
  it("accepts all valid reason codes", () => {
    const validCodes: string[] = [...REASON_CODES];
    for (const code of validCodes) {
      expect(ObservationStore.validateReasonCode(code)).toBe(code);
    }
  });

  it("rejects invalid reason codes", () => {
    expect(ObservationStore.validateReasonCode("typo")).toBeNull();
    expect(ObservationStore.validateReasonCode("")).toBeNull();
    expect(ObservationStore.validateReasonCode("MISSING-TESTS")).toBeNull();
    expect(ObservationStore.validateReasonCode("not-a-code")).toBeNull();
  });

  it("§16.1: accepts 'other' as a valid reason code", () => {
    expect(ObservationStore.validateReasonCode("other")).toBe("other");
  });
});

describe("ObservationStore — validateOtherHasFreeText (§16.1)", () => {
  it("allows non-'other' categories without free text", () => {
    expect(ObservationStore.validateOtherHasFreeText("missing-tests")).toBe(true);
    expect(ObservationStore.validateOtherHasFreeText("style", null)).toBe(true);
    expect(ObservationStore.validateOtherHasFreeText("correctness", "")).toBe(true);
  });

  it("rejects 'other' category without free text", () => {
    expect(ObservationStore.validateOtherHasFreeText("other")).toBe(false);
    expect(ObservationStore.validateOtherHasFreeText("other", null)).toBe(false);
    expect(ObservationStore.validateOtherHasFreeText("other", "")).toBe(false);
    expect(ObservationStore.validateOtherHasFreeText("other", "   ")).toBe(false);
  });

  it("allows 'other' category with non-empty free text", () => {
    expect(ObservationStore.validateOtherHasFreeText("other", "some reason")).toBe(true);
    expect(ObservationStore.validateOtherHasFreeText("other", "needs more investigation")).toBe(true);
  });

  it("isOtherCategory correctly identifies 'other'", () => {
    expect(ObservationStore.isOtherCategory("other")).toBe(true);
    expect(ObservationStore.isOtherCategory("missing-tests")).toBe(false);
    expect(ObservationStore.isOtherCategory("style")).toBe(false);
  });
});

describe("ObservationStore — 'other' category observations (§16.1)", () => {
  let dbPath: string;
  let store: ObservationStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new ObservationStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("§16.1 AC: 'other'-category feedback is stored and appears in counts", () => {
    store.append({
      ticket: "AI-1483",
      workflow: "dev-impl",
      step: "code-review",
      fromBody: "igor",
      reviewerBody: "charles",
      reasonCode: "other",
      freeText: "Unclear requirements — needs product clarification",
    });

    const rows = store.query({ reasonCode: "other" });
    expect(rows).toHaveLength(1);
    expect(rows[0].freeText).toBe("Unclear requirements — needs product clarification");

    // The 'other' category appears in the counts / metrics (mining pass)
    const counts = store.counts({ reasonCode: "other" });
    expect(counts).toHaveLength(1);
    expect(counts[0].count).toBe(1);

    const rollup = store.metrics({ reasonCode: "other" });
    expect(rollup.items).toHaveLength(1);
    expect(rollup.items[0].exceedsThreshold).toBe(false);
  });

  it("§16.1 AC: 'other'-category feedback appears in periodic mining pass metrics", () => {
    // Simulate multiple 'other' observations with free text
    for (let i = 0; i < 5; i++) {
      store.append({
        ticket: `AI-${i}`,
        workflow: "dev-impl",
        step: "code-review",
        fromBody: "igor",
        reviewerBody: "charles",
        reasonCode: "other",
        freeText: `Recurring reason ${i}: unclear API contract`,
      });
    }

    const rollup = store.metrics({ workflow: "dev-impl", threshold: 3 });
    const otherItem = rollup.items.find((i) => i.reasonCode === "other");
    expect(otherItem).toBeDefined();
    expect(otherItem!.count).toBe(5);
    expect(otherItem!.exceedsThreshold).toBe(true);
  });

  it("'other' observations are queryable with free text", () => {
    store.append({
      ticket: "AI-1",
      workflow: "dev-impl",
      step: "code-review",
      fromBody: "igor",
      reviewerBody: "charles",
      reasonCode: "other",
      freeText: "Missing design spec",
    });
    store.append({
      ticket: "AI-2",
      workflow: "dev-impl",
      step: "deployment",
      fromBody: "sage",
      reviewerBody: "hanzo",
      reasonCode: "other",
      freeText: "Environment config mismatch",
    });

    const allOther = store.query({ reasonCode: "other" });
    expect(allOther).toHaveLength(2);

    // Verify free text is preserved
    const freeTexts = allOther.map((r) => r.freeText);
    expect(freeTexts).toContain("Missing design spec");
    expect(freeTexts).toContain("Environment config mismatch");
  });
});

describe("ObservationStore — auto-creates data directory", () => {
  it("creates parent directory if it does not exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mkdir-test-"));
    const dbFile = path.join(dir, "sub", "dir", "obs.db");
    const s = new ObservationStore(dbFile);
    s.append({
      ticket: "AI-1",
      workflow: "dev-impl",
      step: "code-review",
      fromBody: "igor",
      reviewerBody: "charles",
      reasonCode: "missing-tests",
    });
    expect(fs.existsSync(dbFile)).toBe(true);
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
