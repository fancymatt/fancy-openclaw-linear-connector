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
